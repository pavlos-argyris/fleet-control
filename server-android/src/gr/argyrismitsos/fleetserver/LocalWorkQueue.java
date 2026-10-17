package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.util.*;
/** Every transition is saved before the processing loop returns. */
public final class LocalWorkQueue {
 public interface Storage {JSONObject read();void write(JSONObject value);}
 private final Storage storage;
 public LocalWorkQueue(Storage storage){this.storage=storage;}
 private JSONArray rows(){JSONArray value=storage.read().optJSONArray("jobs");return value==null?new JSONArray():value;}
 private void save(JSONArray rows)throws Exception{storage.write(new JSONObject().put("jobs",rows));}
 public synchronized JSONArray known(){JSONArray result=new JSONArray(),rows=rows();for(int i=0;i<rows.length();i++)result.put(rows.optJSONObject(i).optString("id"));return result;}
 public synchronized JSONArray acknowledgements(){JSONArray result=new JSONArray(),rows=rows();for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row.optBoolean("localComplete",false))result.put(row.optString("id"));}return result;}
 public synchronized boolean hasWork(){JSONArray rows=rows();for(int i=0;i<rows.length();i++)if(!rows.optJSONObject(i).optBoolean("localComplete",false)&&rows.optJSONObject(i).optLong("retryAt",0)!=Long.MAX_VALUE)return true;return false;}
 public synchronized void reconcile(JSONArray incoming,JSONArray known,JSONArray acknowledged)throws Exception{
  LinkedHashMap<String,JSONObject> map=new LinkedHashMap<String,JSONObject>();JSONArray rows=rows();
  for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);map.put(row.getString("id"),row);}
  if(known!=null)for(int i=0;i<known.length();i++){JSONObject row=known.getJSONObject(i);if(!"pending".equals(row.optString("status")))map.remove(row.getString("id"));}
  if(acknowledged!=null)for(int i=0;i<acknowledged.length();i++)map.remove(acknowledged.getString(i));
  if(incoming!=null)for(int i=0;i<incoming.length();i++){
   JSONObject row=incoming.getJSONObject(i),old=map.get(row.getString("id"));
   if(old!=null){row.put("localComplete",old.optBoolean("localComplete",false)).put("retryAt",old.optLong("retryAt",0));if(old.has("localResult"))row.put("localResult",old.getJSONObject("localResult"));}
   map.put(row.getString("id"),row);
  }
  JSONArray result=new JSONArray();for(JSONObject row:map.values())result.put(row);save(result);
 }
 public synchronized JSONArray ready(long now)throws Exception{
  JSONArray result=new JSONArray(),rows=rows();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(!row.optBoolean("localComplete",false)&&row.optLong("retryAt",0)<=now)result.put(row);}return result;
 }
 public synchronized void update(String id,String field,Object value)throws Exception{JSONArray rows=rows();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(id.equals(row.optString("id")))row.put(field,value);}save(rows);}
}
