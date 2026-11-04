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

/** Device-owned, Keystore-encrypted session and optional reconnect credentials. Never exported. */
public final class OrdexaSync {
    private static final String PREFS="fleet_ordexa_secure",KEY="fleet.ordexa.session.v1";
    private static final java.util.concurrent.atomic.AtomicBoolean running=new java.util.concurrent.atomic.AtomicBoolean();
    private static final Object authLock=new Object();
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
        return decrypted(saved);
    }
    private static String decrypted(String saved)throws Exception{
        JSONObject data=new JSONObject(saved);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(data.getString("iv"),Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(data.getString("value"),Base64.NO_WRAP)),"UTF-8");
    }
    private static boolean hasCity(JSONArray cities,String city)throws Exception{for(int i=0;i<cities.length();i++)if(city.equals(cities.getJSONObject(i).getString("id")))return true;return false;}
    private static void sameSession(SharedPreferences p,String generation)throws Exception{if(!generation.equals(p.getString("generation","legacy")))throw new Exception("Η σύνδεση Ordexa άλλαξε. Επανάλαβε.");}
    private static String authMessage(SharedPreferences p){return p.getString("auth_error","Χρειάζεται έλεγχος σύνδεσης Ordexa.");}
    private static String renew(Context c,String generation,String expired)throws Exception{
        synchronized(authLock){
            SharedPreferences p=prefs(c);sameSession(p,generation);
            if(p.getBoolean("auth_blocked",false)||System.currentTimeMillis()<p.getLong("auth_retry_at",0))throw new Exception(authMessage(p));
            String current=token(c);if(current.length()>0&&!current.equals(expired))return current;
            if(!p.getBoolean("auto_reconnect",false)||!p.contains("credentials")){
                String message="Η συνεδρία Ordexa έληξε. Καταχώρισε μία φορά τα στοιχεία σύνδεσης για αυτόματη επανασύνδεση.";
                p.edit().putString("auth_state","credentials_required").putString("auth_error",message).putBoolean("auth_blocked",true).commit();throw new Exception(message);
            }
            p.edit().putString("auth_state","reconnecting").apply();
            try{
                JSONObject saved;
                try{saved=new JSONObject(decrypted(p.getString("credentials","")));}catch(Exception e){throw new IllegalArgumentException("Τα προστατευμένα στοιχεία Ordexa δεν είναι διαθέσιμα. Καταχώρισέ τα ξανά.");}
                if(!saved.getString("username").equals(p.getString("account","")))throw new IllegalArgumentException("Τα στοιχεία Ordexa άλλαξαν. Καταχώρισέ τα ξανά.");
                OrdexaClient loginClient=new OrdexaClient();String value=loginClient.login(saved.getString("username"),saved.getString("password"));JSONArray cities=loginClient.cities();
                String city=p.getString("city","");if(city.length()>0&&!hasCity(cities,city))throw new IllegalArgumentException("Ο λογαριασμός Ordexa δεν έχει πλέον πρόσβαση στην επιλεγμένη πόλη. Έλεγξε τα στοιχεία σύνδεσης.");
                String encrypted=encryptedToken(value);sameSession(p,generation);
                // Refresh in place: keep city, enabled mode, source generation,
                // receipts, payroll and store jobs bound to the same account.
                if(!p.edit().putString("session",encrypted).putString("cities",cities.toString()).putString("auth_state","connected").putString("auth_error","").putString("error","").putString("last_auth",OrdexaClient.isoNow()).putBoolean("auth_blocked",false).putInt("auth_failures",0).putLong("auth_retry_at",0).commit())throw new Exception("Δεν αποθηκεύτηκε η νέα συνεδρία Ordexa. Θα γίνει νέα προσπάθεια.");
                return value;
            }catch(Exception e){
                sameSession(p,generation);boolean blocked=e instanceof IllegalArgumentException||e instanceof OrdexaClient.HttpFailure&&(((OrdexaClient.HttpFailure)e).statusCode==401||((OrdexaClient.HttpFailure)e).statusCode==403);
                int failures=Math.min(6,p.getInt("auth_failures",0)+1);long delay=Math.min(900000L,30000L*(1L<<(failures-1)));
                String message=blocked?"Η αυτόματη επανασύνδεση Ordexa απορρίφθηκε. Έλεγξε κωδικό και πρόσβαση λογαριασμού.":"Η αυτόματη επανασύνδεση Ordexa δεν ολοκληρώθηκε. Θα επαναληφθεί αυτόματα.";
                p.edit().putString("auth_state",blocked?"blocked":"waiting").putString("auth_error",message).putBoolean("auth_blocked",blocked).putInt("auth_failures",failures).putLong("auth_retry_at",System.currentTimeMillis()+delay).commit();throw new Exception(message);
            }
        }
    }
    private static OrdexaClient client(final Context c)throws Exception{
        final String generation=prefs(c).getString("generation","legacy");OrdexaClient client=new OrdexaClient();
        client.session(new OrdexaClient.Session(){
            public String currentToken()throws Exception{SharedPreferences p=prefs(c);sameSession(p,generation);if(p.getBoolean("auth_blocked",false)||System.currentTimeMillis()<p.getLong("auth_retry_at",0))throw new Exception(authMessage(p));return token(c);}
            public String renew(String expired)throws Exception{return OrdexaSync.renew(c,generation,expired);}
            public void rejected()throws Exception{SharedPreferences p=prefs(c);sameSession(p,generation);p.edit().putString("auth_state","blocked").putString("auth_error","Η νέα συνεδρία Ordexa απορρίφθηκε. Έλεγξε τα στοιχεία σύνδεσης.").putBoolean("auth_blocked",true).commit();}
        });return client;
    }
    static JSONObject storesContext(Context c)throws Exception{
        SharedPreferences p=prefs(c),main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);String city=p.getString("city",""),worker=workerBase(main);
        String scope=OrdexaClient.digest(new JSONObject().put("account",p.getString("account","").trim().toLowerCase(Locale.ROOT)).put("city",city).put("worker",worker));
        return new JSONObject().put("scope",scope).put("cityId",city).put("worker",worker).put("generation",p.getString("generation","legacy")).put("generationAt",p.getLong("generation_at",1)).put("configured",p.contains("session")&&city.length()>0).put("enabled",p.getBoolean("enabled",false)&&p.contains("session")&&city.length()>0);
    }
    static JSONObject storesRead(Context c,JSONObject expected,boolean setup,String from,String to,int page,String shop)throws Exception{
        begin();try{
            JSONObject current=storesContext(c);if(!current.getString("scope").equals(expected.getString("scope"))||!current.getString("generation").equals(expected.getString("generation")))throw new Exception("Η σύνδεση Ordexa άλλαξε. Επανάλαβε.");
            OrdexaClient client=client(c);return setup?client.storesSetup(current.getString("cityId")):client.storesOrders(current.getString("cityId"),from,to,page,shop);
        }finally{running.set(false);}
    }
    public static JSONObject status(Context c)throws Exception{
        SharedPreferences p=prefs(c),main=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);return new JSONObject().put("configured",p.contains("session")).put("account",p.getString("account","")).put("cityId",p.getString("city","")).put("enabled",p.getBoolean("enabled",false)).put("busy",running.get()).put("autoReconnect",p.getBoolean("auto_reconnect",false)).put("reconnectAvailable",p.contains("credentials")).put("authState",p.getString("auth_state",p.contains("session")?"saved":"unconfigured")).put("authError",p.getString("auth_error","")).put("authRetryAt",p.getLong("auth_retry_at",0)).put("lastAuth",p.getString("last_auth","")).put("lastSuccess",p.getString("last_success","")).put("payrollLastSuccess",main.getString("ordexa_payroll_success","")).put("payrollError",main.getString("ordexa_payroll_error","")).put("stage",p.getString("stage","")).put("error",p.getString("error","")).put("cities",new JSONArray(p.getString("cities","[]")));
    }
    public static JSONObject login(Context c,JSONObject input)throws Exception{
        begin();try{
            String username=input.optString("username").trim(),password=input.optString("password");boolean reconnect=input.optBoolean("autoReconnect",true);
            OrdexaClient client=new OrdexaClient();String value=client.login(username,password);JSONArray cities=client.cities();String encrypted=encryptedToken(value),credentials=reconnect?encryptedToken(new JSONObject().put("username",username).put("password",password).toString()):"";
            SharedPreferences p=prefs(c);boolean same=username.equals(p.getString("account",""));String city=p.getString("city","");
            SharedPreferences.Editor edit=p.edit();if(!same)edit.clear().putString("generation",UUID.randomUUID().toString()).putLong("generation_at",System.currentTimeMillis()).putBoolean("enabled",false);
            else if(city.length()>0&&!hasCity(cities,city))throw new Exception("Η επιλεγμένη πόλη δεν είναι διαθέσιμη στον λογαριασμό Ordexa. Δεν άλλαξαν οι ρυθμίσεις.");
            edit.putString("session",encrypted).putString("cities",cities.toString()).putString("account",username).putBoolean("auto_reconnect",reconnect).putString("auth_state","connected").putString("auth_error","").putString("error","").putString("last_auth",OrdexaClient.isoNow()).putBoolean("auth_blocked",false).putLong("auth_retry_at",0).putInt("auth_failures",0).putInt("sync_failures",0).putLong("attempt",0).putString("stage",same&&city.length()>0?"Σύνδεση Ordexa επιβεβαιωμένη":"Σύνδεση επιβεβαιωμένη · επίλεξε πόλη");
            if(reconnect)edit.putString("credentials",credentials);else edit.remove("credentials");
            if(!edit.commit())throw new Exception("Δεν αποθηκεύτηκε η προστατευμένη συνεδρία Ordexa.");
            return status(c);
        }finally{running.set(false);}
    }
    public static JSONObject configure(Context c,JSONObject input)throws Exception{
        begin();try{
            SharedPreferences p=prefs(c);String city=input.optString("cityId");JSONArray cities=new JSONArray(p.getString("cities","[]"));boolean found=false;for(int i=0;i<cities.length();i++)if(city.equals(cities.getJSONObject(i).getString("id")))found=true;
            if(!p.contains("session")||!found)throw new Exception("Διάλεξε μία διαθέσιμη πόλη Ordexa μετά τη σύνδεση.");
            boolean reconnect=input.optBoolean("autoReconnect",p.getBoolean("auto_reconnect",false));if(reconnect&&!p.contains("credentials"))throw new Exception("Καταχώρισε μία φορά τα στοιχεία Ordexa στην ενότητα Στοιχεία σύνδεσης για αυτόματη επανασύνδεση.");
            SharedPreferences.Editor edit=p.edit().putString("city",city).putBoolean("enabled",input.optBoolean("enabled",false)).putLong("attempt",0);
            edit.putBoolean("auto_reconnect",reconnect);
            if(!city.equals(p.getString("city","")))edit.remove("last_success").putString("stage","Πόλη Ordexa αποθηκευμένη · χρειάζεται συγχρονισμός");
            if(!edit.commit())throw new Exception("Δεν αποθηκεύτηκε η ρύθμιση Ordexa.");return status(c);
        }finally{running.set(false);}
    }
    public static JSONObject checkConnection(Context c)throws Exception{
        begin();try{JSONArray cities=client(c).cities();SharedPreferences p=prefs(c);String city=p.getString("city","");if(city.length()>0&&!hasCity(cities,city))throw new Exception("Η πόλη Ordexa δεν είναι διαθέσιμη στον λογαριασμό.");if(!p.edit().putString("cities",cities.toString()).putString("auth_state","connected").putString("auth_error","").putString("last_auth",OrdexaClient.isoNow()).commit())throw new Exception("Δεν αποθηκεύτηκε ο έλεγχος Ordexa.");return status(c);}finally{running.set(false);}
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
