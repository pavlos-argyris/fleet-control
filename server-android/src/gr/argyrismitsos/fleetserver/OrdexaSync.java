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
import java.util.*;

/** Device-owned session: no password storage/export and no credentials in Worker. */
public final class OrdexaSync {
    private static final String PREFS="fleet_ordexa_secure",KEY="fleet.ordexa.session.v1";
    private static final java.util.concurrent.atomic.AtomicBoolean running=new java.util.concurrent.atomic.AtomicBoolean();
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    private static void begin()throws Exception{if(!running.compareAndSet(false,true))throw new Exception("Υπάρχει ήδη ενέργεια Ordexa σε εξέλιξη. Περίμενε να ολοκληρωθεί.");}
    private static javax.crypto.SecretKey key()throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(KEY)){KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());gen.generateKey();}
        return (javax.crypto.SecretKey)store.getKey(KEY,null);
    }
    private static String encryptedToken(String token)throws Exception{
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());JSONObject data=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("value",Base64.encodeToString(cipher.doFinal(token.getBytes("UTF-8")),Base64.NO_WRAP));
        return data.toString();
    }
    private static String token(Context c)throws Exception{
        String saved=prefs(c).getString("session","");if(saved.length()==0)return "";
        JSONObject data=new JSONObject(saved);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(data.getString("iv"),Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(data.getString("value"),Base64.NO_WRAP)),"UTF-8");
    }
    private static OrdexaClient client(Context c)throws Exception{OrdexaClient client=new OrdexaClient();client.token(token(c));return client;}
    public static JSONObject status(Context c)throws Exception{
        SharedPreferences p=prefs(c),main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);return new JSONObject().put("configured",p.contains("session")).put("account",p.getString("account","")).put("cityId",p.getString("city","")).put("enabled",p.getBoolean("enabled",false)).put("busy",running.get()).put("lastSuccess",p.getString("last_success","")).put("payrollLastSuccess",main.getString("ordexa_payroll_success","")).put("payrollError",main.getString("ordexa_payroll_error","")).put("stage",p.getString("stage","")).put("error",p.getString("error","")).put("cities",new JSONArray(p.getString("cities","[]")));
    }
    public static JSONObject login(Context c,JSONObject input)throws Exception{
        begin();try{
            OrdexaClient client=new OrdexaClient();String value=client.login(input.optString("username"),input.optString("password"));JSONArray cities=client.cities();String encrypted=encryptedToken(value);
            // Publish a complete new device session in one commit. Old city,
            // automatic mode and receipt caches cannot leak across accounts.
            if(!prefs(c).edit().clear().putString("session",encrypted).putString("cities",cities.toString()).putString("account",input.optString("username")).putString("generation",UUID.randomUUID().toString()).putBoolean("enabled",false).putString("stage","Σύνδεση επιβεβαιωμένη · επίλεξε πόλη").commit())throw new Exception("Δεν αποθηκεύτηκε η προστατευμένη συνεδρία Ordexa.");
            return status(c);
        }finally{running.set(false);}
    }
    public static JSONObject configure(Context c,JSONObject input)throws Exception{
        begin();try{
            SharedPreferences p=prefs(c);String city=input.optString("cityId");JSONArray cities=new JSONArray(p.getString("cities","[]"));boolean found=false;for(int i=0;i<cities.length();i++)if(city.equals(cities.getJSONObject(i).getString("id")))found=true;
            if(!p.contains("session")||!found)throw new Exception("Διάλεξε μία διαθέσιμη πόλη Ordexa μετά τη σύνδεση.");
            SharedPreferences.Editor edit=p.edit().putString("city",city).putBoolean("enabled",input.optBoolean("enabled",false)).putLong("attempt",0);
            if(!city.equals(p.getString("city","")))edit.remove("last_success").putString("stage","Πόλη Ordexa αποθηκευμένη · χρειάζεται συγχρονισμός");
            if(!edit.commit())throw new Exception("Δεν αποθηκεύτηκε η ρύθμιση Ordexa.");return status(c);
        }finally{running.set(false);}
    }
    public static JSONObject preview(Context c,JSONObject input)throws Exception{
        begin();try{String day=input.getString("day"),city=prefs(c).getString("city","");JSONObject report=client(c).report(city,day);JSONArray riders=report.getJSONObject("report").getJSONArray("riders"),names=new JSONArray();int count=0;for(int i=0;i<riders.length();i++){JSONObject r=riders.getJSONObject(i);int n=r.getJSONArray("sessions").length();count+=n;names.put(new JSONObject().put("name",r.getString("name")).put("riderId",r.get("riderId")).put("sessions",n));}return new JSONObject().put("day",day).put("riders",names).put("sessions",count).put("saved",false);}finally{running.set(false);}
    }
    public static JSONObject sync(Context c,JSONObject input)throws Exception{
        begin();
        boolean tracked=false;SharedPreferences p=null;
        try{
            if(!ServerWorkTracker.begin(c,"ordexa","Συγχρονισμός Ordexa","Προετοιμασία ημερήσιων αναφορών"))throw new Exception("Προετοιμάζεται ενημέρωση Server. Δοκίμασε μετά την ολοκλήρωσή της.");
            tracked=true;p=prefs(c);
            String from=input.getString("from"),to=input.getString("to");OrdexaClient.day(from);OrdexaClient.day(to);
            java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));long start=f.parse(from).getTime(),end=f.parse(to).getTime();
            if(end<start||end-start>=31L*86400000)throw new Exception("Διάλεξε περίοδο έως 31 ημέρες.");
            p.edit().putLong("attempt",System.currentTimeMillis()).apply();
            String city=p.getString("city","");OrdexaClient client=client(c);SharedPreferences main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);String base=workerBase(main),scope=receiptScope(p,main,base);int saved=0,unchanged=0;
            for(long time=start;time<=end;time+=86400000){
                if(OtaManager.shouldYieldForUpdate(c))throw new Exception("Παύση Ordexa για ενημέρωση. Οι αποθηκευμένες ημέρες διατηρούνται· επανάλαβε μετά.");
                String day=f.format(new Date(time)),stage="Ανάγνωση Ordexa · "+day;p.edit().putString("stage",stage).apply();ServerWorkTracker.stage("ordexa","Συγχρονισμός Ordexa",stage);
                JSONObject report=client.report(city,day);String hash=OrdexaClient.digest(report),receipt="receipt2:"+scope+":"+city+":"+day;
                if(!base.equals(workerBase(main))||!scope.equals(receiptScope(p,main,base)))throw new Exception("Οι ρυθμίσεις Server άλλαξαν κατά τον συγχρονισμό Ordexa. Επανάλαβε με τη νέα σύνδεση.");
                if(hash.equals(p.getString(receipt,""))&&!input.optBoolean("force",false)){p.edit().putString("checked2:"+scope+":"+city+":"+day,OrdexaClient.isoNow()).apply();unchanged++;continue;}
                p.edit().putString("stage","Αποθήκευση Fleet · "+day).apply();ServerWorkTracker.stage("ordexa","Συγχρονισμός Ordexa","Επιβεβαίωση αποθήκευσης · "+day);
                JSONObject result=FleetHttp.sendJson(base+"/api/server/ordexa/import","POST",report,SyncService.serverHeaders());
                if(!result.optBoolean("saved")||!result.optBoolean("accepted"))throw new Exception("Δεν επιβεβαιώθηκε η αποθήκευση της ημέρας "+day+". Επανάλαβε τον έλεγχο.");
                if(!p.edit().putString(receipt,hash).putString("checked2:"+scope+":"+city+":"+day,OrdexaClient.isoNow()).commit())throw new Exception("Δεν αποθηκεύτηκε η τοπική επιβεβαίωση Ordexa. Η ημέρα διατηρείται στο Fleet· επανάλαβε τον έλεγχο.");saved++;
            }
            // The native projection service computes payroll. No bulk
            // comparison or wage calculation is requested from the Worker.
            String payrollWarning="";int payrollPending=0;
            p.edit().putInt("sync_failures",0).putString("last_success",OrdexaClient.isoNow()).putString("stage",payrollPending>0?"Ολοκληρώθηκε ο συγχρονισμός · "+payrollPending+" βάρδιες προς απόφαση μισθοδοσίας":"Ολοκληρώθηκε ο συγχρονισμός Ordexa").putString("error",payrollWarning).commit();return new JSONObject().put("savedDays",saved).put("unchangedDays",unchanged).put("payrollWarning",payrollWarning).put("payrollPending",payrollPending).put("status",status(c));
        }catch(Exception e){if(p!=null)p.edit().putInt("sync_failures",Math.min(4,p.getInt("sync_failures",0)+1)).putString("error",safeError(e)).putString("stage","Χρειάζεται έλεγχος Ordexa").commit();throw new Exception(safeError(e));}
        finally{if(tracked)ServerWorkTracker.finish("ordexa");running.set(false);}
    }
    private static String workerBase(SharedPreferences main){return main.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");}
    private static String receiptScope(SharedPreferences p,SharedPreferences main,String base)throws Exception{return OrdexaClient.digest(new JSONObject().put("generation",p.getString("generation","legacy")).put("worker",base).put("epoch",main.getString("mirror_remote_epoch","")).put("ordexa",main.getString("ordexa_source_epoch","")));}
    private static String safeError(Exception e){String m=e.getMessage();return m!=null&&(m.contains("Ordexa")||m.contains("ημέρ")||m.contains("περίοδο")||m.contains("ενημέρωση"))?m.substring(0,Math.min(m.length(),300)):"Η σύνδεση ή ανάγνωση Ordexa απέτυχε. Έλεγξε σύνδεση και ρυθμίσεις· οι αποθηκευμένες παρουσίες διατηρούνται.";}
    /** Scoped provider checks, including unchanged reports. No credentials leave the device. */
    public static String checkedAt(Context c,String from,String to)throws Exception{
        SharedPreferences p=prefs(c),main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);String scope=receiptScope(p,main,workerBase(main)),city=p.getString("city","");
        java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));long a=f.parse(from).getTime(),b=f.parse(to).getTime();String oldest="";
        for(long t=a;t<=b;t+=86400000L){String checked=p.getString("checked2:"+scope+":"+city+":"+f.format(new Date(t)),"");if(checked.length()==0)return "";if(oldest.length()==0||checked.compareTo(oldest)<0)oldest=checked;}
        return oldest;
    }
    public static void tick(Context c){
        SharedPreferences p=prefs(c);long time=System.currentTimeMillis();if(!p.getBoolean("enabled",false)||running.get()||time-p.getLong("attempt",0)<Math.min(1200000L,300000L*(1L<<Math.min(2,p.getInt("sync_failures",0))))||OtaManager.shouldYieldForUpdate(c))return;
        try{Calendar day=Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"));java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(day.getTimeZone());String to=f.format(day.getTime());boolean full=time-p.getLong("week_attempt",0)>=3600000L;day.add(Calendar.DAY_OF_MONTH,full?-6:-1);sync(c,new JSONObject().put("from",f.format(day.getTime())).put("to",to));if(full)p.edit().putLong("week_attempt",time).apply();}catch(Exception ignored){}
    }
}
