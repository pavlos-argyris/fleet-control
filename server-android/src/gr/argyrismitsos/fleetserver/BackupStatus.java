package gr.argyrismitsos.fleetserver;

import android.content.Context;
import org.json.JSONObject;

/** Small durable progress record; business data is never stored in this status. */
public final class BackupStatus {
    private static final String KEY="backup_live_state";
    private BackupStatus(){}
    public static synchronized JSONObject get(Context c){try{JSONObject value=new JSONObject(c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).getString(KEY,"{}"));long now=value.optLong("endedAt",System.currentTimeMillis()),changed=value.optLong("lastProgressAt",now);value.put("stageSeconds",Math.max(0,(now-value.optLong("stageStartedAt",now))/1000)).put("idleSeconds",Math.max(0,(now-changed)/1000)).put("elapsedSeconds",Math.max(0,(now-value.optLong("startedAt",now))/1000));return value;}catch(Exception e){return new JSONObject();}}
    public static synchronized void start(Context c,String id,String kind){try{long now=System.currentTimeMillis();save(c,new JSONObject().put("id",id).put("kind",kind).put("state","preparing").put("stage","Προετοιμασία αντιγράφου").put("percent",0).put("startedAt",now).put("stageStartedAt",now).put("lastProgressAt",now).put("localReady",false));}catch(Exception ignored){}}
    public static synchronized void progress(Context c,String id,String state,String stage,int percent,int done,int total,long bytes,long byteTotal,String name){try{
        JSONObject value=get(c);if(!id.equals(value.optString("id")))return;long now=System.currentTimeMillis();boolean changed=!stage.equals(value.optString("stage")),moved=changed||done!=value.optInt("filesDone")||bytes!=value.optLong("bytesDone")||!String.valueOf(name).equals(value.optString("fileName"));if(!changed&&now-value.optLong("updatedAt",0)<250)return;
        value.put("state",state).put("stage",stage).put("percent",Math.max(0,Math.min(100,percent))).put("filesDone",done).put("filesTotal",total).put("bytesDone",bytes).put("bytesTotal",byteTotal).put("fileName",name==null?"":name).put("updatedAt",now);
        if(changed)value.put("stageStartedAt",now);if(moved)value.put("lastProgressAt",now);save(c,value);
    }catch(Exception ignored){}}
    public static synchronized void localReady(Context c,String id,int expected,int included,String fileName,boolean workforceIncluded){try{JSONObject value=get(c);if(!id.equals(value.optString("id")))return;value.put("localReady",true).put("workforceIncluded",workforceIncluded).put("expectedDocuments",expected).put("includedDocuments",included).put("missingDocuments",Math.max(0,expected-included)).put("backupName",fileName).put("localReadyAt",System.currentTimeMillis());save(c,value);}catch(Exception ignored){}}
    public static synchronized void failure(Context c,String id,String message,boolean paused){try{JSONObject value=get(c);if(!id.equals(value.optString("id")))return;value.put("state",paused?"paused":"failed").put("error",message).put("endedAt",System.currentTimeMillis()).put("updatedAt",System.currentTimeMillis());save(c,value);}catch(Exception ignored){}}
    public static synchronized void complete(Context c,String id){try{JSONObject value=get(c);if(!id.equals(value.optString("id")))return;value.put("state","completed").put("stage","Το αντίγραφο αποθηκεύτηκε στον επιλεγμένο φάκελο").put("percent",100).put("endedAt",System.currentTimeMillis()).put("completedAt",System.currentTimeMillis()).put("error","");save(c,value);}catch(Exception ignored){}}
    public static boolean active(Context c){String state=get(c).optString("state");return "preparing".equals(state)||"exporting".equals(state);}
    private static void save(Context c,JSONObject value){c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString(KEY,value.toString()).apply();}
}
