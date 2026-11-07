package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/** Manual, bounded observation only. No Fleet database, scheduler or financial capability. */
public final class OrdexaDiagnosticSession {
    interface Factory { OrdexaClient create(); }
    public interface Progress { void update(int requestNumber); }
    private final Factory factory;
    private long generation;
    private OrdexaClient current;
    private JSONArray cities;
    private String scope;
    private boolean reading;

    public OrdexaDiagnosticSession(){this(new Factory(){public OrdexaClient create(){return new OrdexaClient();}});}
    OrdexaDiagnosticSession(Factory factory){this.factory=factory;}
    public synchronized void clear(){
        generation++;if(current!=null)current.token("");current=null;cities=null;scope=null;reading=false;
    }
    private synchronized void same(long expected)throws IOException{
        if(generation!=expected)throw new IOException("Ο έλεγχος ακυρώθηκε. Συνδέσου ξανά.");
    }
    public JSONArray login(String username,String password)throws Exception{
        final long expected; synchronized(this){clear();expected=generation;}
        OrdexaClient reader=factory.create();
        try{
            reader.login(username,password);same(expected);
            JSONArray available=reader.cities();
            synchronized(this){same(expected);current=reader;cities=new JSONArray(available.toString());scope=UUID.randomUUID().toString();}
            return new JSONArray(available.toString());
        }catch(Exception error){reader.token("");throw error;}
    }
    public JSONObject capture(String city,String from,String to,Progress progress)throws Exception{
        OrdexaClient.day(from);OrdexaClient.day(to);
        SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd",Locale.US);format.setTimeZone(TimeZone.getTimeZone("UTC"));
        long span=format.parse(to).getTime()-format.parse(from).getTime();
        if(span<0||span>86400000L)throw new IllegalArgumentException("Επίλεξε δείγμα έως δύο διαδοχικών ημερομηνιών.");
        final long expected;final OrdexaClient reader;final String proofScope;
        synchronized(this){
            if(current==null||reading)throw new IOException("Συνδέσου πρώτα ή περίμενε τον τρέχοντα έλεγχο.");
            boolean known=false;for(int i=0;i<cities.length();i++)if(city.equals(cities.getJSONObject(i).getString("id")))known=true;
            if(!known)throw new IllegalArgumentException("Επίλεξε πόλη από τον συνδεδεμένο λογαριασμό.");
            reading=true;expected=generation;reader=current;proofScope=scope+":"+city;
        }
        JSONObject result=new JSONObject().put("report","Fleet Ordexa manual diagnostic").put("schemaVersion",1)
            .put("diagnosticVersion","0.1.0").put("automaticWritesEnabled",false).put("semanticsVerified",false)
            .put("coverageVerified",false).put("completeSnapshot",false).put("queryFrom",from).put("queryTo",to);
        JSONArray reads=new JSONArray();int requestedPage=1;
        try{
            for(int request=1;request<=3;request++){
                same(expected);if(progress!=null)progress.update(request);
                JSONObject raw=reader.storesOrders(city,from,to,requestedPage,null);same(expected);
                JSONObject frame=StoreBillingProtocol.observeOrders(proofScope,raw,reader.ordersHttpObservation(),requestedPage);
                JSONObject evidence=StoreBillingProtocol.evidenceView(new JSONObject().put("schemaVersion",1)
                    .put("observedAt",frame.getString("observedAt")).put("frames",new JSONArray().put(frame)));
                reads.put(new JSONObject().put("purpose",request==1?"first-page":request==2?"repeat-first-page":"second-page")
                    .put("evidence",evidence));
                if(request==2){
                    // The existing reader uses pages. Unknown envelopes are reported,
                    // never guessed or traversed as complete pagination.
                    Object pages=raw.opt("pages");
                    if(!(pages instanceof Number))break;
                    double pageCount=((Number)pages).doubleValue();
                    if(Double.isNaN(pageCount)||Double.isInfinite(pageCount)||pageCount!=Math.floor(pageCount)||pageCount<2||pageCount>10000000)break;
                    requestedPage=2;
                }
            }
            same(expected);result.put("outcome","sample-read");
        }catch(OrdexaClient.HttpFailure error){
            same(expected);result.put("outcome","http-error").put("httpStatus",error.statusCode)
                .put("failedRequestedPage",requestedPage).put("failedHttp",reader.ordersHttpObservation());
            if(error.statusCode==401||error.statusCode==403){synchronized(this){reader.token("");current=null;cities=null;scope=null;}}
        }finally{synchronized(this){if(generation==expected)reading=false;}}
        same(expected);result.put("reads",reads).put("observedAt",OrdexaClient.isoNow());
        if(result.toString().getBytes("UTF-8").length>65536)throw new IOException("Το διαγνωστικό ξεπερνά το ασφαλές όριο. Δεν έγινε περικοπή ή αντιγραφή.");
        return result;
    }
}
