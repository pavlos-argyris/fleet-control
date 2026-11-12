package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import org.json.*;import java.net.*;import java.io.*;import java.util.*;

/** Readiness proof and mode live in the same SQLite transaction as the API receipt/audit. */
public final class IndependentReadiness {
 private IndependentReadiness(){}
 private static JSONArray query(SQLiteDatabase db,String text)throws Exception{return new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql",text)).getJSONArray("results");}
 static JSONObject probe(SQLiteDatabase db,JSONObject input,long now)throws Exception{
  db.execSQL("SAVEPOINT independent_probe");String marker=UUID.randomUUID().toString();try{db.execSQL("CREATE TABLE independent_rollback_probe(value TEXT)");db.execSQL("INSERT INTO independent_rollback_probe VALUES(?)",new Object[]{marker});if(!query(db,"SELECT value FROM independent_rollback_probe").getJSONObject(0).getString("value").equals(marker))throw new IOException("Probe mismatch");}finally{db.execSQL("ROLLBACK TO independent_probe");db.execSQL("RELEASE independent_probe");}
  if(query(db,"SELECT name FROM sqlite_master WHERE name='independent_rollback_probe'").length()!=0)throw new IOException("Probe rollback failed");
  JSONArray integrity=query(db,"PRAGMA quick_check");if(integrity.length()!=1||!integrity.getJSONObject(0).optString("quick_check").equals("ok")||query(db,"PRAGMA foreign_key_check").length()!=0)throw new IOException("Η βάση δεν είναι έγκυρη.");
  boolean external=input.optBoolean("external")&&IndependentPolicy.publicPeer(InetAddress.getByName(input.getString("peer")));String proof=IndependentConfig.random();
  if(external)db.execSQL("INSERT OR REPLACE INTO independent_readiness VALUES(1,?,?,?,?,?)",new Object[]{proof,input.getString("actorId"),input.getString("session"),BusinessRuntime.sha256(input.getString("peer").getBytes("UTF-8")),now});
  return new JSONObject().put("health",true).put("auth",true).put("read",true).put("writeRollback",true).put("databaseReady",true).put("externalVerified",external).put("proof",external?proof:"").put("message",external?"Ο έλεγχος ολοκληρώθηκε μέσω HTTPS. Επιβεβαίωσε ότι ο Client είναι σε δεδομένα κινητής πριν την ενεργοποίηση.":"Ο τοπικός έλεγχος πέρασε. Εκκρεμεί πραγματική δοκιμή από Client σε 4G/5G, εκτός Wi-Fi Nova.");
 }
 static JSONObject activate(SQLiteDatabase db,JSONObject input,String instance,boolean trusted,long now)throws Exception{
  JSONArray rows=query(db,"SELECT * FROM independent_readiness WHERE id=1");JSONObject evidence=rows.length()==1?rows.getJSONObject(0):new JSONObject();
  if(!input.optString("confirm").equals("ΕΝΕΡΓΟΠΟΙΗΣΗ")||!input.optBoolean("oldProductionStopped")||!input.optBoolean("mobileDataTested")||!evidence.optString("proof").equals(input.optString("proof"))||evidence.optString("proof").isEmpty()||!evidence.optString("actor_id").equals(input.optString("actorId"))||!evidence.optString("session_hash").equals(input.optString("session"))||now-evidence.optLong("created_at")>600000||now<evidence.optLong("created_at")||!trusted)throw new IOException("Απαιτούνται πρόσφατος έλεγχος HTTPS/4G, έγκυρο πιστοποιητικό και ρητή επιβεβαίωση ιδιοκτήτη.");
  new BusinessSqlite(db).call("sql.run",new JSONObject().put("sql","UPDATE independent_instance SET mode='primary',activated_at=?,activated_by=? WHERE id=1 AND instance_id=?").put("params",new JSONArray().put(now).put(input.getString("actorId")).put(instance)));
  JSONArray mode=query(db,"SELECT instance_id,mode FROM independent_instance WHERE id=1");if(mode.length()!=1||!mode.getJSONObject(0).getString("instance_id").equals(instance)||!mode.getJSONObject(0).getString("mode").equals("primary"))throw new IOException("Άλλαξε η δοκιμαστική εγκατάσταση.");
  db.execSQL("DELETE FROM independent_readiness");return new JSONObject().put("activated",true).put("mode","primary").put("cloudChanged",false);
 }
}
