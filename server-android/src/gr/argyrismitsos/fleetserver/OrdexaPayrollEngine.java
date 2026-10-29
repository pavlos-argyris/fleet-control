package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.security.MessageDigest;
import java.util.*;

/** Pure, deterministic payroll computation. No network, database or provider writes. */
public final class OrdexaPayrollEngine {
    public static final int VERSION=1;
    private static final long MINUTE=60000L, HALF=30*MINUTE, DAY=24*60*MINUTE;
    private static final Map<String,Long> TIMES=new LinkedHashMap<String,Long>(256,0.75f,true){protected boolean removeEldestEntry(Map.Entry<String,Long> entry){return size()>8192;}};
    private final SimpleDateFormat dayFormat=new SimpleDateFormat("yyyy-MM-dd",Locale.US);
    private final JSONObject input;
    private final long now;
    private final TimeZone zone;
    private final String week,endDate;
    private final Map<String,JSONObject> people=new LinkedHashMap<String,JSONObject>();
    private final Map<String,JSONObject> riders=new HashMap<String,JSONObject>();
    private final Map<String,JSONObject> vehicles=new HashMap<String,JSONObject>();
    private final Map<String,JSONObject> legacyDecisions=new HashMap<String,JSONObject>();
    private final Map<String,JSONObject> edits=new HashMap<String,JSONObject>();
    private final Map<String,List<JSONObject>> plans=new HashMap<String,List<JSONObject>>();
    private final List<Group> groups=new ArrayList<Group>();
    private final JSONObject settings=new JSONObject();
    private int gap=0,startCutoff=15,endMiddle=21,endNext=47,lateMinutes=20,earlyMinutes=15,endDeviation=30;
    private String lateMode="up";
    private boolean gapConfigured=false;

    private static final class Group {
        String id,employeeId,name,workDate,fingerprint,startFingerprint,endFingerprint;
        long start,end,paidStart,paidEnd,normalMinutes,specialMinutes,baseCents,specialCents;
        boolean open,active,sourcePending,midnightCap,oneAmCap,locked,skip,excluded,adjusted,accepted,startApproved,endApproved;
        JSONObject plan,edit,publicRow,frozenSource;
        int editRevision;
        final JSONArray legacy=new JSONArray();
        final List<JSONObject> events=new ArrayList<JSONObject>();
        final List<String> reasons=new ArrayList<String>();
        String night0="auto",night1="auto";
        void reason(String value){if(!reasons.contains(value))reasons.add(value);}
    }
    private OrdexaPayrollEngine(JSONObject input,long now)throws Exception {
        this.input=input;this.now=now;week=input.getString("weekStart");
        zone=TimeZone.getTimeZone(input.optString("timeZone","Europe/Athens"));dayFormat.setTimeZone(zone);dayFormat.setLenient(false);endDate=addDays(week,6);
        JSONArray values=array("settings");for(int i=0;i<values.length();i++){JSONObject r=values.getJSONObject(i);settings.put(r.getString("key"),r.optString("value"));}
        try{JSONObject p=new JSONObject(settings.optString("ordexa_policy","{}"));if(p.has("gapMinutes")){gap=Math.max(0,Math.min(240,p.getInt("gapMinutes")));gapConfigured=true;}}catch(Exception ignored){}
        try{JSONObject p=new JSONObject(settings.optString("ordexa_pay_policy","{}"));startCutoff=bounded(p.optInt("startCutoff",15),1,29);endMiddle=bounded(p.optInt("endMiddleFrom",21),1,29);endNext=bounded(p.optInt("endNextFrom",47),31,59);lateMinutes=bounded(p.optInt("lateStartMinutes",20),1,120);earlyMinutes=bounded(p.optInt("earlyStartMinutes",15),1,120);endDeviation=bounded(p.optInt("endDeviationMinutes",30),1,240);lateMode=p.optString("lateStartMode","up");}catch(Exception ignored){}
        index(array("employees"),people,"id");index(array("vehicles"),vehicles,"bike_id");index(array("adjustments"),edits,"id");index(array("legacyDecisions"),legacyDecisions,"id");
        JSONArray links=array("riders");for(int i=0;i<links.length();i++){JSONObject r=links.getJSONObject(i);riders.put(r.optString("city_id")+"\n"+r.optString("rider_id"),r);}
        JSONArray schedule=array("schedules");for(int i=0;i<schedule.length();i++){JSONObject p=schedule.getJSONObject(i);if("cancelled".equals(p.optString("status")))continue;String id=p.optString("employee_id");if(!plans.containsKey(id))plans.put(id,new ArrayList<JSONObject>());plans.get(id).add(p);}
    }
    private static int bounded(int value,int min,int max){return Math.max(min,Math.min(max,value));}
    private JSONArray array(String key){JSONArray a=input.optJSONArray(key);return a==null?new JSONArray():a;}
    private static void index(JSONArray rows,Map<String,JSONObject> target,String key)throws Exception{for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);target.put(r.getString(key),r);}}
    public static JSONObject build(JSONObject input,long now)throws Exception{return new OrdexaPayrollEngine(input,now).build();}
    public static String hash(String value)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8")))out.append(String.format(Locale.US,"%02x",b&255));return out.toString();}
    public static String iso(long time){SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));return f.format(new Date(time));}
    public static synchronized long time(String value)throws Exception{
        if(value==null||value.length()==0||"null".equals(value))return 0;
        Long cached=TIMES.get(value);if(cached!=null)return cached;
        java.util.regex.Matcher m=java.util.regex.Pattern.compile("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,3}))?(Z|[+-]\\d{2}:\\d{2})$").matcher(value);
        if(!m.matches())throw new Exception("Μη έγκυρη ώρα υπολογισμού.");String fraction=m.group(2)==null?"000":(m.group(2)+"000").substring(0,3);
        SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));f.setLenient(false);long result=f.parse(m.group(1)+"."+fraction).getTime();String offset=m.group(3);if(!"Z".equals(offset)){int h=Integer.parseInt(offset.substring(1,3)),n=Integer.parseInt(offset.substring(4,6));if(h>23||n>59)throw new Exception("Μη έγκυρη ζώνη ώρας.");result-=(offset.charAt(0)=='+'?1:-1)*(h*60L+n)*MINUTE;}TIMES.put(value,result);return result;
    }
    private Calendar calendar(long value){Calendar c=Calendar.getInstance(zone,Locale.US);c.setTimeInMillis(value);return c;}
    private String day(long value){return dayFormat.format(new Date(value));}
    private String addDays(String value,int count)throws Exception{Calendar c=calendar(dayFormat.parse(value).getTime());c.add(Calendar.DAY_OF_MONTH,count);return day(c.getTimeInMillis());}
    private int hour(long value){return calendar(value).get(Calendar.HOUR_OF_DAY);}
    private int minute(long value){return calendar(value).get(Calendar.MINUTE);}
    private long round(long value,boolean start){Calendar c=calendar(value);double m=c.get(Calendar.MINUTE)+c.get(Calendar.SECOND)/60.0+c.get(Calendar.MILLISECOND)/60000.0;int target=start?(m<startCutoff?0:m<30+startCutoff?30:60):(m<endMiddle?0:m<endNext?30:60);return Math.round(value+(target-m)*MINUTE);}
    private long floorHalf(long value){Calendar c=calendar(value);return value-(c.get(Calendar.MINUTE)%30)*MINUTE-c.get(Calendar.SECOND)*1000L-c.get(Calendar.MILLISECOND);}
    private static String employee(JSONObject r){return r==null||r.isNull("employee_id")?"":r.optString("employee_id","");}
    private void group()throws Exception{
        List<JSONObject> events=new ArrayList<JSONObject>();JSONArray source=array("sessions");for(int i=0;i<source.length();i++)events.add(source.getJSONObject(i));
        Collections.sort(events,new Comparator<JSONObject>(){public int compare(JSONObject a,JSONObject b){try{JSONObject ar=riders.get(a.optString("city_id")+"\n"+a.optString("rider_id")),br=riders.get(b.optString("city_id")+"\n"+b.optString("rider_id"));int v=employee(ar).compareTo(employee(br));if(v!=0)return v;v=Long.compare(time(a.optString("in_at")),time(b.optString("in_at")));return v!=0?v:a.optString("id").compareTo(b.optString("id"));}catch(Exception e){throw new IllegalArgumentException(e);}}});
        Group last=null;
        for(JSONObject event:events){
            JSONObject rider=riders.get(event.optString("city_id")+"\n"+event.optString("rider_id"));String id=employee(rider);long start=time(event.optString("in_at")),end=time(event.optString("out_at"));
            boolean clean=event.optInt("ignored",0)==0&&event.optString("review_reason","").length()==0&&event.isNull("missing_since")&&(end==0||event.optInt("review",0)==0);
            if(last!=null&&!last.excluded&&id.length()>0&&id.equals(last.employeeId)&&!last.open&&clean&&last.reasons.isEmpty()&&start-last.end<=gap*MINUTE&&Math.max(start,end)-last.start<=DAY){last.events.add(event);if(end==0){last.end=0;last.open=true;}else last.end=Math.max(last.end,end);continue;}
            Group g=new Group();g.id="ordexa:"+event.getString("id");g.employeeId=id;g.start=start;g.end=end;g.open=end==0;g.events.add(event);JSONObject person=people.get(id);g.name=person!=null?person.optString("full_name"):rider!=null?rider.optString("name"):"Χωρίς αντιστοίχιση";
            g.excluded=event.optInt("ignored",0)==1;g.skip=g.excluded;
            if(id.length()==0)g.reason("Χωρίς αντιστοίχιση εργαζομένου Ordexa");if(!clean&&(!g.excluded||event.optInt("review",0)==1))g.reason("Χρειάζεται έλεγχος αρχικής καταγραφής Ordexa");if(start<=0||end>0&&end<start)g.reason("Μη έγκυρες αρχικές ώρες");
            groups.add(g);last=g;
        }
    }
    private void selectPlan(Group g)throws Exception{
        List<JSONObject> candidates=plans.get(g.employeeId);if(candidates==null)return;double best=Double.MAX_VALUE,second=Double.MAX_VALUE;
        for(JSONObject p:candidates){long a=time(p.optString("start_at")),b=time(p.optString("end_at"));if(Math.abs(a-g.start)>12*60*MINUTE)continue;double score=Math.abs(a-g.start)+(g.end>0?Math.abs(g.end-b)/4.0:0);if(score<best){second=best;best=score;g.plan=p;}else second=Math.min(second,score);}
        if(g.plan!=null){long a=time(g.plan.optString("start_at")),b=time(g.plan.optString("end_at"));if(Math.abs(a-g.start)>4*60*MINUTE&&!(g.end>0&&g.start<b&&g.end>a))g.plan=null;else if(second-best<30*MINUTE)g.reason("Αμφίβολη αντιστοίχιση προγράμματος");}
    }
    private String fingerprint(Group g)throws Exception{
        StringBuilder value=new StringBuilder(g.id).append('\n').append(g.employeeId);
        for(JSONObject e:g.events)value.append('\n').append(e.optString("id")).append('|').append(e.optInt("revision",1)).append('|').append(e.optString("in_at")).append('|').append(e.optString("out_at")).append('|').append(e.optInt("review",0)).append('|').append(e.optString("missing_since"));
        if(g.plan!=null)value.append('\n').append(g.plan.optString("id")).append('|').append(g.plan.optString("start_at")).append('|').append(g.plan.optString("end_at")).append('|').append(g.plan.optString("vehicle_id"));
        value.append('\n').append(zone.getID()).append('|').append(gap).append('|').append(startCutoff).append('|').append(endMiddle).append('|').append(endNext).append('|').append(lateMinutes).append('|').append(earlyMinutes).append('|').append(endDeviation).append('|').append(lateMode).append("|rates:600,1000,1500|v1");return hash(value.toString());
    }
    private void resolve(Group g)throws Exception{
        selectPlan(g);g.workDate=day(g.start);g.fingerprint=fingerprint(g);g.startFingerprint=hash(g.id+"|"+g.employeeId+"|"+g.start+"|"+(g.plan==null?"":g.plan.optString("id")+g.plan.optString("start_at"))+"|"+startCutoff+"|"+zone.getID());g.endFingerprint=hash(g.id+"|"+g.employeeId+"|"+g.end+"|"+(g.plan==null?"":g.plan.optString("id")+g.plan.optString("end_at"))+"|"+endMiddle+"|"+endNext+"|"+zone.getID());g.edit=edits.get(g.id);g.editRevision=g.edit==null?0:g.edit.optInt("revision",0);if(g.edit!=null&&!g.employeeId.equals(g.edit.optString("employee_id"))){g.reason("Άλλαξε η αντιστοίχιση εργαζομένου · η προηγούμενη διόρθωση δεν μεταφέρεται");g.edit=null;}g.paidStart=round(g.start,true);
        long planEnd=g.plan==null?0:time(g.plan.optString("end_at")),actualEnd=g.end;
        long planStart=g.plan==null?0:time(g.plan.optString("start_at"));if(g.plan!=null&&g.start-planStart>=lateMinutes*MINUTE&&"up".equals(lateMode)){long floor=floorHalf(g.start);g.paidStart=g.start==floor?floor:floor+HALF;}
        if(g.plan!=null&&hour(planEnd)==0&&minute(planEnd)==0&&planEnd>=g.start&&planEnd<=now&&(actualEnd==0||actualEnd>planEnd)){actualEnd=planEnd;g.midnightCap=true;}
        if(g.plan!=null&&hour(planEnd)==1&&minute(planEnd)==0&&actualEnd>planEnd&&actualEnd<planEnd+21*MINUTE){actualEnd=planEnd;g.oneAmCap=true;}
        g.paidEnd=actualEnd>0?round(actualEnd,false):floorHalf(now);g.sourcePending=g.open&&!g.midnightCap||g.end>now;
        if(g.sourcePending)g.reason("Εκκρεμεί τελικό clock out");
        if(g.start>now){g.reason("Η αρχική είσοδος είναι στο μέλλον");g.skip=true;}
        if(g.paidEnd-g.paidStart>DAY){g.reason("Παρουσία χωρίς ασφαλή τελική έξοδο πάνω από 24 ώρες");g.skip=true;}
        if(g.end>now){g.reason("Η αρχική έξοδος είναι στο μέλλον");g.paidEnd=floorHalf(now);}
        if(g.edit!=null){
            g.adjusted=true;g.accepted=g.fingerprint.equals(g.edit.optString("source_fingerprint"))&&g.edit.optInt("acknowledged",0)==1;
            g.startApproved=g.startFingerprint.equals(g.edit.optString("start_fingerprint"));g.endApproved=g.endFingerprint.equals(g.edit.optString("end_fingerprint"));
            if(!g.edit.isNull("paid_start"))g.paidStart=time(g.edit.optString("paid_start"));if(!g.edit.isNull("paid_end"))g.paidEnd=time(g.edit.optString("paid_end"));
            g.night0=g.edit.optString("night_00_mode","auto");g.night1=g.edit.optString("night_01_mode","auto");
            if(g.accepted){g.reasons.clear();if(!g.edit.isNull("paid_end")&&g.paidEnd<=now)g.sourcePending=false;if(!g.excluded&&g.paidEnd>=g.paidStart&&g.paidEnd-g.paidStart<=36*60*MINUTE&&g.start<=now)g.skip=false;}
            else{if(!g.edit.isNull("paid_start")&&!g.startApproved)g.reason("Η διόρθωση έναρξης χρειάζεται επανέλεγχο με τα νέα δεδομένα");if(!g.edit.isNull("paid_end")&&!g.endApproved)g.reason("Η διόρθωση λήξης χρειάζεται επανέλεγχο με τα νέα δεδομένα");}
        }
        if(g.paidEnd>now&&g.open){g.reason("Η χειροκίνητη πληρωτέα λήξη είναι στο μέλλον");g.sourcePending=true;g.paidEnd=floorHalf(now);}
        if(g.paidEnd<g.paidStart)g.paidEnd=g.paidStart;
        if(g.sourcePending)g.reason("Εκκρεμεί τελικό clock out");
        if(g.midnightCap&&!g.accepted&&((g.end==0?now:g.end)-planEnd>=endDeviation*MINUTE))g.reason("Όριο πληρωμής 00:00 βάσει προγράμματος · επιβεβαίωσε ή διόρθωσε τη συγκεκριμένη βάρδια");
        boolean eligibleExtension=g.plan!=null&&hour(planEnd)==1&&minute(planEnd)==0&&(g.open?now:actualEnd)<planEnd+81*MINUTE;
        if(g.sourcePending&&g.plan!=null&&now>planEnd+21*MINUTE&&!eligibleExtension)g.reason("Πέρασε η προγραμματισμένη λήξη χωρίς τελικό clock out");
        if(g.plan!=null&&!g.accepted){long deviation=g.start-planStart;if(!g.startApproved){if(deviation>=lateMinutes*MINUTE)g.reason("Καθυστερημένο clock in "+(deviation/MINUTE)+" λεπτά");else if(-deviation>=earlyMinutes*MINUTE)g.reason("Πρόωρο clock in "+(-deviation/MINUTE)+" λεπτά");}if(!g.endApproved&&g.end>0&&!g.midnightCap&&!eligibleExtension&&Math.abs(g.end-planEnd)>=endDeviation*MINUTE)g.reason("Απόκλιση clock out από πρόγραμμα "+(Math.abs(g.end-planEnd)/MINUTE)+" λεπτά");}
        // A midnight source that was never closed is an explicit exception,
        // not evidence that its rider is still working the next morning.
        g.active=g.open&&!g.midnightCap&&g.start<=now&&now-g.start<=DAY&&!g.skip;
        if(g.edit!=null&&!g.edit.isNull("paid_end")&&time(g.edit.optString("paid_end"))<=now)g.active=false;
        if(g.midnightCap&&g.edit!=null&&!g.edit.isNull("paid_end")&&time(g.edit.optString("paid_end"))>now)g.active=true;
        for(JSONObject event:g.events){JSONObject old=legacyDecisions.get("ordexa:"+event.getString("id"));if(old!=null)g.legacy.put(old);}
        if(g.legacy.length()>0&&!g.accepted&&!g.excluded)g.reason("Προηγούμενη απόφαση προγράμματος/clock · επιβεβαίωσε τις πληρωτέες ώρες στο νέο προφίλ");
        if(g.excluded){g.active=false;g.sourcePending=false;g.paidEnd=g.paidStart;boolean reviewed=true;for(JSONObject event:g.events)reviewed=reviewed&&event.optInt("review",0)==0;if(reviewed)g.reasons.clear();}
        JSONArray paid=array("paid");for(int i=0;i<paid.length();i++){JSONObject item=paid.getJSONObject(i),source=new JSONObject(item.getString("source_row"));JSONArray ids=source.optJSONArray("sourceSessionIds");if(ids==null)continue;boolean match=false;for(int j=0;j<ids.length();j++)for(JSONObject e:g.events)if(ids.getString(j).equals(e.optString("id")))match=true;if(match){g.locked=true;g.frozenSource=source;if(!week.equals(item.optString("start_date"))||!endDate.equals(item.optString("end_date"))){g.skip=true;g.reason("Η παρουσία έχει ήδη πληρωθεί σε άλλη κλειδωμένη περίοδο");}break;}}
    }
    private boolean special(Group g,int h,long instant)throws Exception{
        String choice=h==0?g.night0:g.night1;if("normal".equals(choice))return false;if("special".equals(choice))return true;
        if(g.accepted&&g.edit!=null&&!g.edit.isNull("paid_end")&&(g.plan==null||g.paidEnd>time(g.plan.optString("end_at"))))return true;
        if(g.plan==null)return false;long end=time(g.plan.optString("end_at"));int e=hour(end);return minute(end)==0&&(e==1||e==2)&&day(instant).equals(day(end));
    }
    private void price()throws Exception{
        Map<Long,List<Group>> nightSlots=new HashMap<Long,List<Group>>();
        Map<String,Group> charged=new HashMap<String,Group>();
        for(Group g:groups){if(g.skip||g.employeeId.length()==0)continue;
            for(long t=g.paidStart;t<g.paidEnd;t+=HALF){String slotKey=g.employeeId+"/"+t;Group previous=charged.get(slotKey);if(previous!=null){previous.reason("Επικαλυπτόμενες παρουσίες του ίδιου εργαζομένου · χρειάζεται έλεγχος χωρίς διπλή χρέωση");g.reason("Επικαλυπτόμενες παρουσίες του ίδιου εργαζομένου · χρειάζεται έλεγχος χωρίς διπλή χρέωση");continue;}charged.put(slotKey,g);long duration=Math.min(HALF,g.paidEnd-t)/MINUTE;int h=hour(t);boolean premium=(h==0||h==1)&&special(g,h,t);long rate=premium?(h==0?1000:1500):600;
                if(premium){g.specialMinutes+=duration;g.specialCents+=Math.round(rate*duration/60.0);if(!nightSlots.containsKey(t))nightSlots.put(t,new ArrayList<Group>());nightSlots.get(t).add(g);}else{g.normalMinutes+=duration;g.baseCents+=Math.round(rate*duration/60.0);}
                if((h==0||h==1)&&g.plan==null&&!g.accepted)g.reason("Νυχτερινή παρουσία χωρίς επιβεβαιωμένο δικαιούχο προγράμματος");
            }
        }
        for(Map.Entry<Long,List<Group>> slot:nightSlots.entrySet()){List<Group> rows=slot.getValue();int limit=hour(slot.getKey())==0?3:2;if(rows.size()<=limit)continue;boolean accepted=true;for(Group g:rows)accepted=accepted&&g.accepted;if(!accepted)for(Group g:rows)g.reason("Υπέρβαση νυχτερινού ορίου "+limit+" ατόμων · χρειάζεται απόφαση για κάθε εργαζόμενο");}
        if(hour(now)==1&&minute(now)>=21){List<Group> live=new ArrayList<Group>();for(Group g:groups)if(g.active&&!g.skip&&special(g,1,now))live.add(g);if(live.size()>2){boolean accepted=true;for(Group g:live)accepted=accepted&&g.accepted;if(!accepted)for(Group g:live)g.reason("Υπέρβαση νυχτερινού ορίου 2 ατόμων · χρειάζεται απόφαση για κάθε εργαζόμενο");}}
    }
    private JSONObject row(Group g)throws Exception{
        JSONArray ids=new JSONArray(),reasons=new JSONArray();for(JSONObject e:g.events)ids.put(e.getString("id"));for(String r:g.reasons)reasons.put(r);
        String vehicleId=g.plan==null?"":g.plan.optString("vehicle_id","");if("null".equals(vehicleId))vehicleId="";JSONObject vehicle=vehicles.get(vehicleId);
        JSONObject r=new JSONObject().put("id",g.id).put("source","ordexa").put("employeeId",g.employeeId).put("employeeName",g.name).put("workDate",g.workDate).put("actualClockIn",iso(g.start)).put("actualClockOut",g.open?JSONObject.NULL:iso(g.end)).put("payableClockIn",iso(g.paidStart)).put("payableClockOut",iso(g.paidEnd)).put("payableHours",(g.normalMinutes+g.specialMinutes)/60.0).put("payableMinutes",g.normalMinutes+g.specialMinutes).put("normalMinutes",g.normalMinutes).put("specialMinutes",g.specialMinutes).put("basePayCents",g.baseCents).put("specialPayCents",g.specialCents).put("totalPayCents",g.baseCents+g.specialCents).put("sourceSessionIds",ids).put("fingerprint",g.fingerprint).put("startFingerprint",g.startFingerprint).put("endFingerprint",g.endFingerprint).put("adjustmentRevision",g.editRevision).put("adjusted",g.adjusted).put("adjustedBy",g.edit==null?"":g.edit.optString("updated_by_name")).put("adjustedAt",g.edit==null?JSONObject.NULL:g.edit.optString("updated_at")).put("night00Mode",g.night0).put("night01Mode",g.night1).put("reasons",reasons).put("sourcePending",g.sourcePending).put("midnightCap",g.midnightCap).put("oneAmCap",g.oneAmCap).put("excluded",g.excluded).put("missingClockOut",g.open).put("active",g.active).put("payrollLocked",g.locked).put("status",g.active?"active":"completed").put("vehicleId",vehicleId).put("vehicleName",vehicle==null?vehicleId:vehicle.optString("name")).put("schedule",g.plan==null?JSONObject.NULL:g.plan);
        if(g.legacy.length()>0)r.put("legacyDecisions",g.legacy);
        if(g.frozenSource!=null){r.put("payableHours",g.frozenSource.has("payableMinutes")?g.frozenSource.optDouble("payableMinutes",0)/60.0:JSONObject.NULL).put("payableMinutes",g.frozenSource.opt("payableMinutes")).put("payableClockIn",g.frozenSource.opt("payableStart")).put("payableClockOut",g.frozenSource.opt("payableEnd"));if(g.frozenSource.has("basePayCents")){r.put("basePayCents",g.frozenSource.optLong("basePayCents")).put("specialPayCents",g.frozenSource.optLong("specialPayCents")).put("totalPayCents",g.frozenSource.optLong("basePayCents")+g.frozenSource.optLong("specialPayCents"));}else{r.put("basePayCents",JSONObject.NULL).put("specialPayCents",JSONObject.NULL).put("totalPayCents",JSONObject.NULL);}}
        g.publicRow=r;return r;
    }
    private JSONObject employeeSummary(String id,String name)throws Exception{return new JSONObject().put("employeeId",id).put("employeeName",name).put("shifts",0).put("normalHours",0).put("specialHours",0).put("payableHours",0).put("kilometers",0).put("basePayCents",0).put("specialPayCents",0).put("bonusCents",0).put("deductionCents",0).put("advanceCents",0).put("finalCents",0).put("pendingOvertime",0).put("overtimeApprovals",new JSONArray()).put("sourceRows",new JSONArray()).put("hoursSource","ordexa");}
    private static void plus(JSONObject o,String key,long amount)throws Exception{o.put(key,o.optLong(key,0)+amount);}
    private JSONObject liveRow(JSONObject r)throws Exception{JSONObject safe=new JSONObject();for(String k:new String[]{"id","employeeId","employeeName","workDate","actualClockIn","actualClockOut","active","sourcePending","midnightCap","missingClockOut","vehicleId","vehicleName","status"})safe.put(k,r.opt(k));safe.put("out_of_schedule",r.isNull("schedule"));return safe;}
    private JSONObject reviewRow(JSONObject r)throws Exception{JSONObject safe=new JSONObject();for(String k:new String[]{"id","employeeId","employeeName","workDate","actualClockIn","actualClockOut","payableClockIn","payableClockOut","reasons"})safe.put(k,r.opt(k));return safe;}
    private long localMidnight(String value)throws Exception{SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(zone);return f.parse(value).getTime();}
    private JSONObject coverage()throws Exception{
        JSONArray days=new JSONArray();long under=0,over=0,upcoming=0,plannedTotal=0,covered=0;
        for(String date=week;date.compareTo(endDate)<=0;date=addDays(date,1)){JSONArray buckets=new JSONArray();long last=localMidnight(addDays(date,1));for(long t=localMidnight(date);t<last;t+=HALF){Set<String> scheduled=new LinkedHashSet<String>(),actual=new LinkedHashSet<String>();
            for(List<JSONObject> list:plans.values())for(JSONObject p:list)if(time(p.optString("start_at"))<t+HALF&&time(p.optString("end_at"))>t){JSONObject person=people.get(p.optString("employee_id"));scheduled.add(person==null?p.optString("employee_id"):person.optString("full_name"));}
            for(Group g:groups){long end=g.open?now:g.end;if((g.midnightCap||g.oneAmCap)&&g.plan!=null)end=time(g.plan.optString("end_at"));if(g.accepted&&g.edit!=null&&!g.edit.isNull("paid_end"))end=Math.min(now,time(g.edit.optString("paid_end")));if(!g.skip&&g.start<t+HALF&&end>t&&t<now)actual.add(g.name);}
            String status=t>=now?"planned":actual.size()<scheduled.size()?"under":actual.size()>scheduled.size()?"over":"covered";
            if(t<now){plannedTotal+=scheduled.size();covered+=Math.min(scheduled.size(),actual.size());if("under".equals(status))under++;if("over".equals(status))over++;}else if(!scheduled.isEmpty())upcoming++;
            JSONArray p=new JSONArray(),a=new JSONArray();for(String name:scheduled)p.put(name);for(String name:actual)a.put(name);buckets.put(new JSONObject().put("time",String.format(Locale.US,"%02d:%02d",hour(t),minute(t))).put("planned",scheduled.size()).put("actual",actual.size()).put("plannedEmployees",p).put("actualEmployees",a).put("status",status));}
            days.put(new JSONObject().put("date",date).put("buckets",buckets));}
        return new JSONObject().put("days",days).put("startDate",week).put("endDate",endDate).put("summary",new JSONObject().put("coveragePercent",plannedTotal==0?100:Math.round(100.0*covered/plannedTotal)).put("undercoveredSlots",under).put("overcoveredSlots",over).put("upcomingSlots",upcoming));
    }
    private JSONObject build()throws Exception{
        group();for(Group g:groups)resolve(g);price();
        JSONArray shifts=new JSONArray(),reviews=new JSONArray(),blockers=new JSONArray(),active=new JSONArray(),pendingOut=new JSONArray(),missing=new JSONArray(),daily=new JSONArray();
        Map<String,JSONObject> summaries=new LinkedHashMap<String,JSONObject>();Set<String> activeVehicles=new LinkedHashSet<String>(),activePeople=new LinkedHashSet<String>(),seenPlans=new HashSet<String>();
        for(Group g:groups){JSONObject r=row(g);shifts.put(r);if(g.plan!=null&&!g.excluded&&g.start<=now&&(g.open||g.end>time(g.plan.optString("start_at"))))seenPlans.add(g.plan.optString("id"));if(g.open&&g.midnightCap)pendingOut.put(liveRow(r));
            if(g.active){active.put(liveRow(r));activePeople.add(g.employeeId.length()>0?g.employeeId:g.events.get(0).optString("city_id")+"/"+g.events.get(0).optString("rider_id"));String v=r.optString("vehicleId");if(v.length()>0&&!v.startsWith("__own_vehicle__:"))activeVehicles.add(v);}
            boolean inWeek=g.workDate.compareTo(week)>=0&&g.workDate.compareTo(endDate)<=0;
            if(!inWeek)continue;if((!g.locked||g.skip)&&!g.reasons.isEmpty()){boolean actionable=false;for(String reason:g.reasons){blockers.put(new JSONObject().put("id",g.id).put("reason",reason));if(!reason.equals("Εκκρεμεί τελικό clock out"))actionable=true;}if(actionable)reviews.put(reviewRow(r));}
            if(g.skip||g.employeeId.length()==0)continue;JSONObject s=summaries.get(g.employeeId);if(s==null){s=employeeSummary(g.employeeId,g.name);summaries.put(g.employeeId,s);}
            plus(s,"shifts",1);plus(s,"basePayCents",g.baseCents);plus(s,"specialPayCents",g.specialCents);s.put("normalHours",s.optDouble("normalHours",0)+g.normalMinutes/60.0).put("specialHours",s.optDouble("specialHours",0)+g.specialMinutes/60.0).put("payableHours",s.optDouble("payableHours",0)+(g.normalMinutes+g.specialMinutes)/60.0);
            s.getJSONArray("sourceRows").put(new JSONObject().put("id",g.id).put("start",iso(g.start)).put("end",g.open?JSONObject.NULL:iso(g.end)).put("payableStart",iso(g.paidStart)).put("payableEnd",iso(g.paidEnd)).put("payableMinutes",g.normalMinutes+g.specialMinutes).put("basePayCents",g.baseCents).put("specialPayCents",g.specialCents).put("sourceSessionIds",r.getJSONArray("sourceSessionIds")).put("ordexaSchedule",g.plan==null?JSONObject.NULL:g.plan).put("ordexaTimeZone",zone.getID()).put("adjustedBy",r.optString("adjustedBy")));
        }
        if(!gapConfigured)blockers.put(new JSONObject().put("reason","Όρισε το όριο συνέχειας αποσυνδέσεων Ordexa"));
        if(input.has("coverage")){Set<String> coverage=new HashSet<String>(),cities=new HashSet<String>();JSONArray rows=array("coverage");for(int i=0;i<rows.length();i++){JSONObject c=rows.getJSONObject(i);coverage.add(c.optString("city_id")+"/"+c.optString("day"));}for(JSONObject r:riders.values())if(employee(r).length()>0)cities.add(r.optString("city_id"));if(cities.isEmpty())blockers.put(new JSONObject().put("reason","Δεν υπάρχουν αντιστοιχισμένοι εργαζόμενοι Ordexa"));for(String city:cities)for(String date=week;date.compareTo(endDate)<=0&&date.compareTo(day(now))<=0;date=addDays(date,1))if(!coverage.contains(city+"/"+date))blockers.put(new JSONObject().put("reason","Λείπει ημερήσιος συγχρονισμός "+date+" · "+city));}
        JSONArray adjustments=array("payrollAdjustments");for(int i=0;i<adjustments.length();i++){JSONObject a=adjustments.getJSONObject(i);String id=a.optString("employee_id");JSONObject s=summaries.get(id),p=people.get(id);if(s==null){s=employeeSummary(id,p==null?id:p.optString("full_name"));summaries.put(id,s);}String kind=a.optString("kind");if("bonus".equals(kind))plus(s,"bonusCents",a.optLong("amount_cents",0));else if("deduction".equals(kind))plus(s,"deductionCents",a.optLong("amount_cents",0));else if("advance".equals(kind))plus(s,"advanceCents",a.optLong("amount_cents",0));else if("hours".equals(kind)){double minutes=a.optDouble("minutes",0);if(minutes%30!=0)blockers.put(new JSONObject().put("reason","Παλιά προσαρμογή ωρών εκτός βαθμίδας μισάωρου"));s.put("payableHours",s.optDouble("payableHours",0)+minutes/60.0);plus(s,"basePayCents",Math.round(minutes*600/60.0));}}
        JSONObject totals=new JSONObject().put("employees",summaries.size()).put("payableHours",0).put("kilometers",0).put("basePayCents",0).put("specialPayCents",0).put("bonusCents",0).put("deductionCents",0).put("advanceCents",0).put("finalCents",0).put("pendingOvertime",0).put("approvedOvertime",0);JSONArray employees=new JSONArray();
        for(JSONObject s:summaries.values()){s.put("finalCents",s.optLong("basePayCents",0)+s.optLong("specialPayCents",0)+s.optLong("bonusCents",0)-s.optLong("deductionCents",0)-s.optLong("advanceCents",0));for(String key:new String[]{"basePayCents","specialPayCents","bonusCents","deductionCents","advanceCents","finalCents"})plus(totals,key,s.optLong(key,0));totals.put("payableHours",totals.optDouble("payableHours",0)+s.optDouble("payableHours",0));employees.put(s);}
        String today=day(now);for(List<JSONObject> list:plans.values())for(JSONObject p:list){long start=time(p.optString("start_at")),end=time(p.optString("end_at"));JSONObject person=people.get(p.optString("employee_id")),v=vehicles.get(p.optString("vehicle_id"));JSONObject copy=new JSONObject(p.toString()).put("employee_name",person==null?p.optString("employee_id"):person.optString("full_name")).put("vehicle_name",v==null?"":v.optString("name"));if(day(start).equals(today)||start<=now&&end>now)daily.put(copy);if(start+20*MINUTE<=now&&end>now&&!seenPlans.contains(p.optString("id")))missing.put(copy);}
        JSONArray bikes=new JSONArray();for(String id:activeVehicles){JSONObject v=vehicles.get(id);bikes.put(new JSONObject().put("id",id).put("name",v==null?id:v.optString("name")));}
        JSONObject period=new JSONObject().put("startDate",week).put("endDate",endDate).put("status","open").put("hoursSource","ordexa");
        JSONObject payroll=new JSONObject().put("period",period).put("hoursSource","ordexa").put("employees",employees).put("totals",totals).put("blockers",blockers).put("ordexaReviews",reviews).put("serverComputed",true);
        int fleetCount=0;for(JSONObject v:vehicles.values())if(!"inactive".equals(v.optString("status")))fleetCount++;
        JSONObject dashboard=new JSONObject().put("workingNow",activePeople.size()).put("activeShifts",active).put("missingClockIns",missing).put("vehiclesInUse",bikes).put("totalVehicles",fleetCount).put("pendingClockOuts",pendingOut).put("dailySchedule",daily).put("payableHours",totals.optDouble("payableHours",0)).put("payrollCents",totals.optLong("finalCents",0)).put("reviewCount",reviews.length()).put("weekStart",week).put("weekEnd",endDate).put("coverage",coverage());
        return new JSONObject().put("engineVersion",VERSION).put("shifts",shifts).put("payroll",payroll).put("reviews",reviews).put("dashboard",dashboard);
    }
}
