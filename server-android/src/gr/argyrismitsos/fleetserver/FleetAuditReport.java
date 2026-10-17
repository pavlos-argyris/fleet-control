package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.util.*;
import java.math.BigDecimal;
import java.text.SimpleDateFormat;

/** Read-only report of one canonical version; never changes fleet records. */
public final class FleetAuditReport {
 private static JSONArray array(JSONObject o,String key){JSONArray a=o.optJSONArray(key);return a==null?new JSONArray():a;}
 public static Long cents(Object value){
  if(value==null||value==JSONObject.NULL)return null;
  String s=String.valueOf(value).replaceAll("(?i)EUR|ευρώ|[€\\s\\u00a0]","");
  if(!s.matches("-?\\d+(?:[.,]\\d+)*"))return null;
  int comma=s.lastIndexOf(','),dot=s.lastIndexOf('.'),pos=Math.max(comma,dot);
  if(comma>=0&&dot>=0){char sep=s.charAt(pos),other=sep==','?'.':',';
   if(s.length()-pos-1!=2||!s.matches("-?\\d{1,3}(?:"+java.util.regex.Pattern.quote(""+other)+"\\d{3})*"+java.util.regex.Pattern.quote(""+sep)+"\\d{2}"))return null;
   s=s.replace(""+other,"").replace(sep,'.');
  }else if(pos>=0){char sep=s.charAt(pos);int tail=s.length()-pos-1;
   if(tail==3&&s.matches("-?\\d{1,3}(?:"+java.util.regex.Pattern.quote(""+sep)+"\\d{3})+"))s=s.replace(""+sep,"");
   else if((tail==1||tail==2)&&s.indexOf(sep)==pos)s=s.replace(sep,'.');else return null;
  }
  try{long n=new BigDecimal(s).movePointRight(2).longValueExact();return Math.abs(n)<=9007199254740991L?n:null;}catch(Exception e){return null;}
 }
 private static String date(String s){
  if(s.matches("\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}")){String[] p=s.split("[/.]");s=String.format(Locale.US,"%s-%02d-%02d",p[2],Integer.parseInt(p[1]),Integer.parseInt(p[0]));}
  if(!s.matches("\\d{4}-\\d{2}-\\d{2}"))return "";
  try{SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setLenient(false);return f.format(f.parse(s)).equals(s)?s:"";}catch(Exception e){return "";}
 }
 private static long km(JSONObject o,String key){try{String s=o.optString(key,"");if(!s.matches("\\d+(?:\\.0+)?"))return -1;long n=new BigDecimal(s).longValueExact();return n>=0&&n<=2000000000L?n:-1;}catch(Exception e){return -1;}}
 private static JSONObject invoice(JSONObject f)throws Exception{JSONObject d=new JSONObject();for(String key:new String[]{"qrData","ocr"}){JSONObject part=f.optJSONObject(key);if(part!=null){Iterator<String> keys=part.keys();while(keys.hasNext()){String k=keys.next();d.put(k,part.opt(k));}}}return d;}
 private static void issue(JSONArray issues,String kind,JSONObject bike,JSONObject entry,String detail)throws Exception{
  if(issues.length()<500)issues.put(new JSONObject().put("kind",kind).put("bikeId",bike.optString("id")).put("bike",bike.optString("name")).put("entryId",entry.optString("id")).put("date",entry.optString("date")).put("detail",detail));
 }
 public static JSONObject build(JSONObject snapshot)throws Exception{
  JSONArray bikes=array(snapshot,"bikes"),rows=new JSONArray(),issues=new JSONArray();Set<String> seenKeys=new HashSet<String>(),identities=new HashSet<String>();
  long total=0;int services=0,documents=0,unknown=0,missing=0,mileage=0,duplicates=0,differences=0;
  for(int b=0;b<bikes.length();b++){
   JSONObject bike=bikes.getJSONObject(b);JSONArray history=array(bike,"history");long sum=0;int bikeServices=0,bikeDocs=0,bikeUnknown=0,bikeMissing=0;
   TreeMap<String,List<JSONObject>> days=new TreeMap<String,List<JSONObject>>();
   for(int h=0;h<history.length();h++){
    JSONObject e=history.getJSONObject(h);String day=date(e.optString("date"));long odometer=km(e,"km");
    if(day.length()>0&&odometer>=0){if(!days.containsKey(day))days.put(day,new ArrayList<JSONObject>());days.get(day).add(e);}
    if("check".equals(e.optString("type")))continue;services++;bikeServices++;
    JSONArray files=array(e,"attachments");boolean hasFile=false;
    for(int f=0;f<files.length();f++)if(files.getJSONObject(f).optString("key").length()>0)hasFile=true;
    JSONObject expectation=e.optJSONObject("invoiceExpectation"),pending=e.optJSONObject("invoiceData");
    boolean queued=pending!=null&&pending.optString("qrUrl").length()>0&&!Arrays.asList("completed","failed","error","cancelled","superseded").contains(pending.optString("qrProcessingStatus"));
    if(!hasFile&&!queued&&(expectation==null||!"not_expected".equals(expectation.optString("status")))){missing++;bikeMissing++;issue(issues,"missing",bike,e,"Δεν έχει συνδεθεί τιμολόγιο.");}
    if(files.length()==0){Long cost=cents(e.opt("cost"));if(cost==null){unknown++;bikeUnknown++;}else sum+=cost;}
    for(int f=0;f<files.length();f++){
     JSONObject file=files.getJSONObject(f),data=invoice(file);String key=file.optString("key");
     if(key.length()>0&&!seenKeys.add(key)){duplicates++;issue(issues,"duplicate",bike,e,"Το ίδιο αρχείο έχει συνδεθεί περισσότερες φορές. Το κόστος μετρήθηκε μία φορά.");continue;}
     documents++;bikeDocs++;Long cost=cents(data.opt("totalAmount"));if(cost==null){unknown++;bikeUnknown++;}else sum+=cost;
     String mark=data.optString("mark",data.optString("invoiceMark")),number=data.optString("invoiceNumber").trim(),supplier=data.optString("supplier").trim().toLowerCase(Locale.ROOT),invoiceDate=date(data.optString("invoiceDate"));
     String identity=mark.length()>0?"mark:"+mark:(number.length()>0&&supplier.length()>0&&invoiceDate.length()>0?supplier+"|"+number+"|"+invoiceDate:"");
     if(identity.length()>0&&!identities.add(identity)){duplicates++;issue(issues,"duplicate",bike,e,"Ίδια στοιχεία παραστατικού: "+number+" · "+invoiceDate+". Χρειάζεται έλεγχος, δεν αφαιρέθηκε κόστος αυτόματα.");}
     String raw=data.optString("odometerKm").replaceAll("[^0-9]","");long read=-1;try{if(raw.length()>0)read=Long.parseLong(raw);}catch(Exception ignored){}
     if(read>=0&&odometer>=0&&read!=odometer){differences++;boolean accepted=data.optString("confirmedAt").length()>0&&Arrays.asList("keep","apply").contains(data.optString("mileageResolution"))&&e.optString("id").equals(data.optString("mileageResolutionEntryId"))&&data.optLong("mileageResolutionRead",-1)==read&&data.optLong("mileageResolutionServiceKm",-1)==odometer;
      issue(issues,"invoice-km",bike,e,"Service: "+odometer+" km · Τιμολόγιο: "+read+" km"+(accepted?" · Ελέγχθηκε από χρήστη.":" · Χρειάζεται έλεγχος."));}
    }
   }
   JSONObject previous=null;
   for(Map.Entry<String,List<JSONObject>> group:days.entrySet()){
    Collections.sort(group.getValue(),new Comparator<JSONObject>(){public int compare(JSONObject a,JSONObject b){long d=km(b,"km")-km(a,"km");return d==0?a.optString("id").compareTo(b.optString("id")):(d>0?1:-1);}});
    if(previous!=null)for(JSONObject e:group.getValue())if(km(e,"km")<km(previous,"km")){
     String signature=new JSONArray().put(previous.optString("id")).put(date(previous.optString("date"))).put(km(previous,"km")).put(e.optString("id")).put(group.getKey()).put(km(e,"km")).toString();
     boolean accepted=false;JSONArray acknowledgments=array(e,"kmAcknowledgments");for(int a=0;a<acknowledgments.length();a++){JSONObject ack=acknowledgments.getJSONObject(a);if(signature.equals(ack.optString("signature"))&&ack.optString("reason").length()>0&&ack.optString("at").length()>0)accepted=true;}
     if(!accepted){mileage++;issue(issues,"mileage",bike,e,km(e,"km")+" km μετά από "+km(previous,"km")+" km στις "+date(previous.optString("date"))+".");}
    }
    previous=group.getValue().get(0);
   }
   total+=sum;rows.put(new JSONObject().put("id",bike.optString("id")).put("name",bike.optString("name")).put("costCents",sum).put("services",bikeServices).put("documents",bikeDocs).put("unknownCosts",bikeUnknown).put("missingInvoices",bikeMissing));
  }
  return new JSONObject().put("schema",1).put("snapshotVersion",snapshot.optLong("version",0)).put("generatedAt",new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.US).format(new Date()))
   .put("bikes",rows).put("issues",issues).put("services",services).put("documents",documents).put("costCents",total).put("unknownCosts",unknown).put("missingInvoices",missing).put("mileageWarnings",mileage).put("possibleDuplicates",duplicates).put("invoiceKmDifferences",differences).put("truncated",missing+mileage+duplicates+differences>issues.length());
 }
}
