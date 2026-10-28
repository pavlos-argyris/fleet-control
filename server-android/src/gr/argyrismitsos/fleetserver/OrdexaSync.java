package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.*;

/** Device-owned session: no password storage/export and no credentials in Worker. */
public final class OrdexaSync {
    private static final String PREFS="fleet_ordexa_secure",KEY="fleet.ordexa.session.v1";
    private static final java.util.concurrent.atomic.AtomicBoolean running=new java.util.concurrent.atomic.AtomicBoolean();
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    private static javax.crypto.SecretKey key()throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(KEY)){KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());gen.generateKey();}
        return (javax.crypto.SecretKey)store.getKey(KEY,null);
    }
    private static void token(Context c,String token)throws Exception{
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());JSONObject data=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("value",Base64.encodeToString(cipher.doFinal(token.getBytes("UTF-8")),Base64.NO_WRAP));
        if(!prefs(c).edit().putString("session",data.toString()).commit())throw new Exception("Δεν αποθηκεύτηκε η προστατευμένη συνεδρία Ordexa.");
    }
    private static String token(Context c)throws Exception{
        String saved=prefs(c).getString("session","");if(saved.length()==0)return "";
        JSONObject data=new JSONObject(saved);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(data.getString("iv"),Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(data.getString("value"),Base64.NO_WRAP)),"UTF-8");
    }
    private static OrdexaClient client(Context c)throws Exception{OrdexaClient client=new OrdexaClient();client.token(token(c));return client;}
    public static JSONObject status(Context c)throws Exception{
        SharedPreferences p=prefs(c);return new JSONObject().put("configured",p.contains("session")).put("cityId",p.getString("city","")).put("enabled",p.getBoolean("enabled",false)).put("busy",running.get()).put("lastSuccess",p.getString("last_success","")).put("stage",p.getString("stage","")).put("error",p.getString("error","")).put("cities",new JSONArray(p.getString("cities","[]")));
    }
    public static JSONObject login(Context c,JSONObject input)throws Exception{
        OrdexaClient client=new OrdexaClient();String value=client.login(input.optString("username"),input.optString("password"));JSONArray cities=client.cities();token(c,value);prefs(c).edit().putString("cities",cities.toString()).putString("error","").commit();return status(c);
    }
    public static JSONObject configure(Context c,JSONObject input)throws Exception{
        String city=input.optString("cityId");JSONArray cities=new JSONArray(prefs(c).getString("cities","[]"));boolean found=false;for(int i=0;i<cities.length();i++)if(city.equals(cities.getJSONObject(i).getString("id")))found=true;
        if(!found)throw new Exception("Διάλεξε μία διαθέσιμη πόλη Ordexa.");
        if(!prefs(c).edit().putString("city",city).putBoolean("enabled",input.optBoolean("enabled",false)).commit())throw new Exception("Δεν αποθηκεύτηκε η ρύθμιση Ordexa.");return status(c);
    }
    public static JSONObject preview(Context c,JSONObject input)throws Exception{
        String day=input.getString("day"),city=prefs(c).getString("city","");JSONObject report=client(c).report(city,day);JSONArray riders=report.getJSONObject("report").getJSONArray("riders"),names=new JSONArray();int count=0;for(int i=0;i<riders.length();i++){JSONObject r=riders.getJSONObject(i);int n=r.getJSONArray("sessions").length();count+=n;names.put(new JSONObject().put("name",r.getString("name")).put("riderId",r.get("riderId")).put("sessions",n));}return new JSONObject().put("day",day).put("riders",names).put("sessions",count).put("saved",false);
    }
    public static JSONObject sync(Context c,JSONObject input)throws Exception{
        if(!running.compareAndSet(false,true))throw new Exception("Ο συγχρονισμός Ordexa είναι ήδη σε εξέλιξη.");
        if(!ServerWorkTracker.begin(c,"ordexa","Συγχρονισμός Ordexa","Προετοιμασία ημερήσιων αναφορών")){running.set(false);throw new Exception("Προετοιμάζεται ενημέρωση Server. Δοκίμασε μετά την ολοκλήρωσή της.");}
        SharedPreferences p=prefs(c);
        try{
            String from=input.getString("from"),to=input.getString("to");OrdexaClient.day(from);OrdexaClient.day(to);
            java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));long start=f.parse(from).getTime(),end=f.parse(to).getTime();
            if(end<start||end-start>31L*86400000)throw new Exception("Διάλεξε περίοδο έως 31 ημέρες.");
            String city=p.getString("city","");OrdexaClient client=client(c);SharedPreferences main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);String base=main.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");int saved=0,unchanged=0;
            for(long time=start;time<=end;time+=86400000){
                if(OtaManager.shouldYieldForUpdate(c))throw new Exception("Παύση Ordexa για ενημέρωση. Οι αποθηκευμένες ημέρες διατηρούνται· επανάλαβε μετά.");
                String day=f.format(new Date(time)),stage="Ανάγνωση Ordexa · "+day;p.edit().putString("stage",stage).apply();ServerWorkTracker.stage("ordexa","Συγχρονισμός Ordexa",stage);
                JSONObject report=client.report(city,day);JSONObject check=new JSONObject(report.toString());check.remove("capturedAt");byte[] digest=MessageDigest.getInstance("SHA-256").digest(check.toString().getBytes("UTF-8"));String hash=Base64.encodeToString(digest,Base64.NO_WRAP),receipt="receipt:"+city+":"+day;
                if(hash.equals(p.getString(receipt,""))&&!input.optBoolean("force",false)){unchanged++;continue;}
                p.edit().putString("stage","Αποθήκευση Fleet · "+day).apply();ServerWorkTracker.stage("ordexa","Συγχρονισμός Ordexa","Επιβεβαίωση αποθήκευσης · "+day);
                JSONObject result=FleetHttp.sendJson(base+"/api/server/ordexa/import","POST",report,SyncService.serverHeaders());
                if(!result.optBoolean("saved")||!result.optBoolean("accepted"))throw new Exception("Δεν επιβεβαιώθηκε η αποθήκευση της ημέρας "+day+". Επανάλαβε τον έλεγχο.");
                p.edit().putString(receipt,hash).commit();saved++;
            }
            p.edit().putString("last_success",OrdexaClient.isoNow()).putString("stage","Ολοκληρώθηκε ο συγχρονισμός Ordexa").putString("error","").commit();return new JSONObject().put("savedDays",saved).put("unchangedDays",unchanged).put("status",status(c));
        }catch(Exception e){p.edit().putString("error",safeError(e)).putString("stage","Χρειάζεται έλεγχος Ordexa").commit();throw new Exception(safeError(e));}
        finally{ServerWorkTracker.finish("ordexa");running.set(false);}
    }
    private static String safeError(Exception e){String m=e.getMessage();return m!=null&&(m.contains("Ordexa")||m.contains("ημέρ")||m.contains("περίοδο")||m.contains("ενημέρωση"))?m.substring(0,Math.min(m.length(),300)):"Η σύνδεση ή ανάγνωση Ordexa απέτυχε. Έλεγξε σύνδεση και ρυθμίσεις· οι αποθηκευμένες παρουσίες διατηρούνται.";}
    public static void tick(Context c){
        SharedPreferences p=prefs(c);long time=System.currentTimeMillis();if(!p.getBoolean("enabled",false)||running.get()||time-p.getLong("attempt",0)<3600000L||OtaManager.shouldYieldForUpdate(c))return;
        p.edit().putLong("attempt",time).apply();try{Calendar day=Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"));java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(day.getTimeZone());String to=f.format(day.getTime());day.add(Calendar.DAY_OF_MONTH,-6);sync(c,new JSONObject().put("from",f.format(day.getTime())).put("to",to));}catch(Exception ignored){}
    }
}
