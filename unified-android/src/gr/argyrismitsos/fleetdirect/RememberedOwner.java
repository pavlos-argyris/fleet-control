package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import org.json.JSONObject;
import java.io.IOException;

/** Device-only owner credentials. Every restored session is verified by real auth/roles. */
final class RememberedOwner {
    private static final String NAME="direct.remembered-owner.v1",ALIAS="fleet.direct.remembered-owner.v1";
    private static final String BACKUP="direct.remembered-backup.v1",BACKUP_ALIAS="fleet.direct.remembered-backup.v1";
    private static String token="",realm="";
    private RememberedOwner(){}
    private static void scope(Context c){if(!ScopedContext.owns(c))throw new SecurityException("Private Direct credentials only");}
    private static JSONObject saved(Context c)throws Exception{
        scope(c);
        return SealedLocalState.read(c,NAME,ALIAS);
    }
    static String username(Context c){try{return saved(c).optString("username");}catch(Exception unavailable){return "";}}
    static synchronized void clear(Context c)throws Exception{scope(c);SealedLocalState.remove(c,NAME);token="";realm="";}
    static String backupCode(Context c,String entered)throws Exception{scope(c);return entered!=null&&!entered.isEmpty()?entered:SealedLocalState.read(c,BACKUP,BACKUP_ALIAS).optString("password");}
    static void rememberBackupCode(Context c,String password)throws Exception{scope(c);if(password!=null&&!password.isEmpty())SealedLocalState.write(c,BACKUP,BACKUP_ALIAS,new JSONObject().put("password",password));}
    static void clearBackupCode(Context c)throws Exception{scope(c);SealedLocalState.remove(c,BACKUP);}
    static String importBackup(Context c,android.net.Uri uri,String password)throws Exception{JSONObject result=IndependentRestore.importBackup(c,uri,password);if(!result.optBoolean("imported"))return "Η εισαγωγή δεν επιβεβαιώθηκε.";rememberBackupCode(c,password);token="";realm="";return "Το πλήρες backup εισήχθη στη χωριστή βάση Direct. Τα στοιχεία ιδιοκτήτη μπορούν να αποθηκευτούν με έναν έλεγχο σύνδεσης.";}
    static synchronized JSONObject login(Context c,String username,String password)throws Exception{
        if(password==null||password.isEmpty()){
            JSONObject credentials=saved(c);
            if(username!=null&&!username.isEmpty()&&!username.equals(credentials.optString("username")))throw new IOException("Συμπλήρωσε μία φορά τον κωδικό του νέου ιδιοκτήτη.");
            return authenticate(c,credentials.optString("username"),credentials.optString("password"),false);
        }
        scope(c);
        return authenticate(c,username,password,true);
    }
    private static JSONObject authenticate(Context c,String username,String password,boolean remember)throws Exception{
        if(username==null||username.isEmpty()||password==null||password.isEmpty())throw new IOException("Συμπλήρωσε μία φορά τα στοιχεία ιδιοκτήτη. Θα αποθηκευτούν προστατευμένα σε αυτή τη συσκευή.");
        IndependentRuntime runtime=IndependentRuntime.get(c);
        JSONObject response=runtime.localLogin(username,password),body=new JSONObject(response.getString("body"));
        if(response.getInt("status")!=200||!body.getJSONObject("user").optString("role").equals("owner")){
            token="";realm="";
            if(!remember&&(response.getInt("status")==401||response.getInt("status")==403))SealedLocalState.remove(c,NAME);
            throw new IOException("Η σύνδεση ιδιοκτήτη χρειάζεται έλεγχο. Ενημέρωσε τα αποθηκευμένα στοιχεία.");
        }
        if(remember)SealedLocalState.write(c,NAME,ALIAS,new JSONObject().put("username",username).put("password",password));
        token=body.getString("token");realm=runtime.realm();return body;
    }
    static synchronized String session(Context c)throws Exception{
        IndependentRuntime runtime=IndependentRuntime.get(c);
        if(!token.isEmpty()&&realm.equals(runtime.realm())){
            JSONObject result=runtime.external(new JSONObject().put("url",realm+"/api/auth/me").put("method","GET").put("headers",new JSONObject().put("Authorization","Bearer "+token)));
            if(result.getInt("status")==200&&new JSONObject(result.getString("body")).getJSONObject("user").optString("role").equals("owner"))return token;
            token="";realm="";
        }
        JSONObject credentials=saved(c);
        return authenticate(c,credentials.optString("username"),credentials.optString("password"),false).getString("token");
    }
}
