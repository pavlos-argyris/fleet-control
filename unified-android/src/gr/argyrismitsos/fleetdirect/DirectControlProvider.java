package gr.argyrismitsos.fleetdirect;

import android.content.*;import android.database.Cursor;import android.net.Uri;import android.os.*;import org.json.*;
import gr.argyrismitsos.fleetserver.BackendMode;

/** Private same-UID IPC, never a network admin API. No Cloudflare request is involved. */
public final class DirectControlProvider extends ContentProvider {
    private Context scope;
    @Override public boolean onCreate(){scope=new ScopedContext(getContext());return true;}
    private void initialize()throws Exception{DirectHost.startup(scope);}
    @Override public Bundle call(String method,String argument,Bundle extras){
        if(Binder.getCallingUid()!=android.os.Process.myUid())throw new SecurityException("Private Direct control");
        Bundle result=new Bundle();try{
            if(method.equals("status")||method.equals("dashboard")){
                JSONObject state=BackendMode.read(scope);JSONObject config=IndependentConfig.read(scope);state.put("backupVerified",config.has("backupSha256")).put("hostname",config.optString("hostname"));
                SharedPreferences ui=scope.getSharedPreferences("independent_ui",Context.MODE_PRIVATE);
                for(String key:new String[]{"runtime","network","certificate","listener","listenerError","ipv4"})state.put(key,ui.getString(key,""));
                boolean online=IndependentService.listenerOnline();state.put("listenerActive",online).put("listenerPort",8443).put("listener",online?"HTTPS listener ενεργός · θύρα 8443":"HTTPS listener ανενεργός · θύρα 8443");
                if(method.equals("dashboard")&&config.has("backupSha256")){initialize();state.put("stats",IndependentRuntime.get(scope).dashboard()).put("ota",OtaManager.state(scope));}
                result.putString("json",state.toString());result.putBoolean("ok",true);return result;
            }
            if(method.equals("startControl")){
                JSONObject config=IndependentConfig.read(scope);
                if(config.has("backupSha256")&&scope.getSharedPreferences(BackupManager.PREFS,0).getBoolean("automatic_start",true))IndependentService.start(scope);
                result.putBoolean("ok",true);return result;
            }
            initialize();IndependentRuntime runtime=IndependentRuntime.get(scope);
            if(method.equals("login")){
                JSONObject reply=runtime.localLogin(extras.getString("username",""),extras.getString("password",""));
                if(reply.getInt("status")!=200)throw new Exception("Η τοπική σύνδεση ιδιοκτήτη δεν επιβεβαιώθηκε.");
                JSONObject body=new JSONObject(reply.getString("body"));if(!body.getJSONObject("user").optString("role").equals("owner"))throw new Exception("Απαιτείται λογαριασμός ιδιοκτήτη.");
                result.putString("token",body.getString("token"));
            }else if(method.equals("check")){
                // Fresh local auth is checked even when the public listener/router is offline.
                String token=extras.getString("token","");JSONObject auth=runtime.external(new JSONObject().put("url",runtime.realm()+"/api/auth/me").put("method","GET").put("headers",new JSONObject().put("Authorization","Bearer "+token)));
                if(auth.getInt("status")!=200||!new JSONObject(auth.getString("body")).getJSONObject("user").optString("role").equals("owner"))throw new Exception("Συνδέσου ξανά ως ιδιοκτήτης.");
                result.putBoolean("authenticated",true);
                if("direct".equals(argument)){
                    if(DirectHost.paused(scope))throw new Exception("Εκκρεμεί ενημέρωση ή ανάκτηση Direct. Ολοκλήρωσέ την πριν την εναλλαγή.");
                    JSONObject config=IndependentConfig.read(scope);if(!BackendMode.DIRECT.equals(runtime.realm())||!IndependentTls.valid(scope,config.optString("hostname")))throw new Exception("Εκκρεμεί έγκυρο HTTPS για fleet-control.duckdns.org.");
                    SharedPreferences ui=scope.getSharedPreferences("independent_ui",Context.MODE_PRIVATE);
                    if(!IndependentService.listenerOnline())throw new Exception("Ο HTTPS listener δεν έχει επιβεβαιωθεί ενεργός στη θύρα 8443.");
                    JSONObject proof=runtime.switchReadiness();if(!proof.optBoolean("ready"))throw new Exception("Εκκρεμεί πρόσφατος επιτυχής έλεγχος σύνδεσης από Client σε 4G/5G.");
                }
            }else throw new IllegalArgumentException("Unknown Direct control command");
            result.putBoolean("ok",true);
        }catch(Exception error){result.putBoolean("ok",false);String message=error.getMessage();result.putString("error",message!=null&&message.startsWith("Ε")||message!=null&&message.startsWith("Σ")||message!=null&&message.startsWith("Α")||message!=null&&message.startsWith("Η")||message!=null&&message.startsWith("Ο")?message:"Η τοπική λειτουργία δεν επιβεβαιώθηκε. Τα δεδομένα διατηρούνται.");}
        return result;
    }
    @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){throw new UnsupportedOperationException();}
    @Override public String getType(Uri u){return null;}
    @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
    @Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
