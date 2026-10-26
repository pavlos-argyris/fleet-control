package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.util.*;

/** Read-only view of work actually running in this process. */
public final class ServerWorkTracker {
    private static final Map<String,JSONObject> tasks=new LinkedHashMap<String,JSONObject>();
    private ServerWorkTracker(){}
    public static synchronized boolean begin(android.content.Context c,String lane,String title,String detail){if(OtaManager.shouldYieldForUpdate(c))return false;tasks.put(lane,new JSONObject());stage(lane,title,detail);return true;}
    public static synchronized boolean busy(){return !tasks.isEmpty();}
    public static synchronized void stage(String lane,String title,String detail){if(!tasks.containsKey(lane))return;try{long now=System.currentTimeMillis();JSONObject old=tasks.get(lane);JSONObject value=new JSONObject().put("lane",lane).put("title",title).put("detail",detail).put("startedAt",old==null?now:old.optLong("startedAt",now)).put("stageAt",old!=null&&detail.equals(old.optString("detail"))?old.optLong("stageAt",now):now);tasks.put(lane,value);}catch(Exception ignored){}}
    public static synchronized void finish(String lane){tasks.remove(lane);}
    public static synchronized JSONArray get(){JSONArray rows=new JSONArray();long now=System.currentTimeMillis();for(JSONObject task:tasks.values())try{rows.put(new JSONObject(task.toString()).put("elapsedSeconds",Math.max(0,(now-task.optLong("startedAt",now))/1000)).put("stageSeconds",Math.max(0,(now-task.optLong("stageAt",now))/1000)));}catch(Exception ignored){}return rows;}
}
