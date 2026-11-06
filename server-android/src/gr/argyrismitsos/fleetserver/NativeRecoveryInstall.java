package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import org.json.*;import java.io.*;

/** Actual cold-installed data verification; reaches recovering, never active. */
public final class NativeRecoveryInstall {
    private NativeRecoveryInstall(){}
    public static void prepare(File database,File documents,JSONObject manifest,JSONObject identity)throws Exception{
        SQLiteDatabase read=SQLiteDatabase.openDatabase(database.getPath(),null,SQLiteDatabase.OPEN_READONLY);JSONObject state;try{state=NativePrimaryState.read(read);}finally{read.close();}
        if(state.optString("phase").equals("needs_recovery"))NativeDatabaseSnapshot.verifyReadOnly(database,manifest);
        else NativeDatabaseSnapshot.verifyRecovering(database,manifest,identity.getString("realm"),identity.getString("generation"));
        JSONArray objects=manifest.getJSONArray("objects");for(int i=0;i<objects.length();i++){JSONObject object=objects.getJSONObject(i);String name=object.getString("local_name");if(!BusinessObjects.validLocalName(name))throw new IOException("Μη έγκυρο όνομα ιδιωτικού αρχείου ανάκτησης.");File file=new File(documents,name);if(!file.isFile()||file.length()!=object.getLong("size")||!NativeDatabaseSnapshot.digest(file).equals(object.getString("sha256")))throw new IOException("Λείπει ή άλλαξε ιδιωτικό τιμολόγιο ανάκτησης.");}
        SQLiteDatabase writable=SQLiteDatabase.openDatabase(database.getPath(),null,SQLiteDatabase.OPEN_READWRITE);try{
            BusinessSqlite sql=new BusinessSqlite(writable);JSONArray owner=sql.call("sql.query",new JSONObject().put("sql","SELECT id FROM app_users WHERE id=? AND role='owner' AND active=1 AND login_enabled=1 AND deleted_at IS NULL").put("params",new JSONArray().put(identity.getString("ownerId")))).getJSONArray("results");if(owner.length()!=1)throw new IOException("Ο επιλεγμένος ιδιοκτήτης δεν είναι ενεργός στο backup.");
            if(state.optString("phase").equals("needs_recovery"))NativePrimaryState.phase(writable,"recovering",identity.getString("realm"),identity.getString("generation"),identity.getString("ownerId"),manifest.getString("sha256"));
        }finally{writable.close();}
    }
}
