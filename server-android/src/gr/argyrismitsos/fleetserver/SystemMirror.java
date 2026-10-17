package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.util.*;
/** Complete mirrors are committed by the caller only after every page succeeds. */
public final class SystemMirror {
 public interface Progress{void stage(String message);}
 private static String now(){return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date());}
 public static JSONObject update(String base,Map<String,String> headers,JSONObject fleet,JSONObject previous,Progress progress)throws Exception{
  if(previous!=null&&previous.optJSONObject("mirror")!=null){JSONObject next=changes(base,headers,new JSONObject(previous.toString()),progress);if(next!=null)return next.put("fleet",fleet).put("createdAt",now());}
  return download(base,headers,fleet,progress);
 }
 public static JSONObject download(String base,Map<String,String> headers,JSONObject fleet,Progress progress)throws Exception{
  JSONObject manifest=FleetHttp.getJson(base+"/api/server/system-export/page",headers),workforce=new JSONObject(),allIds=new JSONObject();JSONArray tables=manifest.getJSONArray("tables");
  for(int i=0;i<tables.length();i++){
   String table=tables.getString(i);if(!table.matches("[a-z_]+"))throw new Exception("Μη έγκυρος πίνακας αντιγράφου.");
   JSONArray rows=new JSONArray(),ids=new JSONArray();long cursor=0;boolean done=false;
   for(int page=0;page<20000;page++){
    if(Thread.currentThread().isInterrupted())throw new InterruptedException();
    progress.stage("Αντίγραφο "+(i+1)+"/"+tables.length()+" · "+table+" · "+rows.length()+" εγγραφές");
    JSONObject response=FleetHttp.getJson(base+"/api/server/system-export/page?table="+table+"&cursor="+cursor+"&limit=50",headers);
    if(!table.equals(response.optString("table")))throw new Exception("Ασυμφωνία πίνακα.");
    JSONArray next=response.getJSONArray("rows"),nextIds=response.optJSONArray("rowIds");
    for(int j=0;j<next.length();j++){rows.put(next.getJSONObject(j));if(nextIds!=null)ids.put(nextIds.getLong(j));}
    if(!response.optBoolean("hasMore",false)){done=true;break;}
    long advanced=response.getLong("nextCursor");if(advanced<=cursor)throw new Exception("Το αντίγραφο δεν προχώρησε.");cursor=advanced;
   }
   if(!done)throw new Exception("Υπερβολικά πολλές σελίδες.");workforce.put(table,rows);allIds.put(table,ids);
  }
  JSONObject value=new JSONObject().put("schemaVersion",5).put("createdAt",now()).put("fleet",fleet).put("workforce",workforce),head=manifest.optJSONObject("mirror");
  if(head!=null){
   value.put("mirror",new JSONObject().put("epoch",head.getString("epoch")).put("cursor",head.getLong("cursor")).put("rowIds",allIds));
   JSONObject complete=changes(base,headers,value,progress);if(complete==null)throw new Exception("Το ιστορικό αλλαγών έληξε. Το προηγούμενο αντίγραφο διατηρήθηκε· θα ξαναδοκιμάσει.");return complete;
  }
  return value;
 }
 private static JSONObject changes(String base,Map<String,String> headers,JSONObject value,Progress progress)throws Exception{
  JSONObject mirror=value.getJSONObject("mirror"),workforce=value.getJSONObject("workforce"),allIds=mirror.getJSONObject("rowIds");String epoch=mirror.getString("epoch");
  if(!epoch.matches("[a-f0-9]{32}"))return null;long cursor=mirror.getLong("cursor"),until=-1;int count=0;
  for(int page=0;page<20000;page++){
   if(Thread.currentThread().isInterrupted())throw new InterruptedException();progress.stage("Διαφορικό αντίγραφο · "+count+" αλλαγές");
   JSONObject response=FleetHttp.getJson(base+"/api/server/system-export/delta?epoch="+epoch+"&cursor="+cursor+(until>=0?"&until="+until:""),headers);
   if(response.optBoolean("resetRequired",false))return null;if(!epoch.equals(response.getString("epoch")))throw new Exception("Άλλαξε η βάση αντιγράφου.");
   if(until<0)until=response.getLong("until");else if(until!=response.getLong("until"))throw new Exception("Άλλαξε το όριο της λήψης.");
   long next=response.getLong("nextCursor");if(next<cursor||next>until||response.optBoolean("hasMore",false)&&next==cursor)throw new Exception("Μη έγκυρη συνέχεια αντιγράφου.");
   JSONArray changes=response.getJSONArray("changes");Map<String,TreeMap<Long,JSONObject>> indexes=new HashMap<String,TreeMap<Long,JSONObject>>();
   for(int i=0;i<changes.length();i++){
    JSONObject change=changes.getJSONObject(i);String table=change.getString("table");if(!allIds.has(table)||!workforce.has(table))throw new Exception("Άγνωστος πίνακας αλλαγής.");
    TreeMap<Long,JSONObject> index=indexes.get(table);
    if(index==null){index=new TreeMap<Long,JSONObject>();JSONArray rows=workforce.getJSONArray(table),ids=allIds.getJSONArray(table);if(rows.length()!=ids.length())throw new Exception("Ασυμφωνία τοπικού αντιγράφου.");for(int j=0;j<rows.length();j++)index.put(ids.getLong(j),rows.getJSONObject(j));indexes.put(table,index);}
    long id=change.getLong("rowId");JSONObject row=change.optJSONObject("row");if(row==null)index.remove(id);else index.put(id,row);count++;
   }
   for(String table:indexes.keySet()){JSONArray rows=new JSONArray(),ids=new JSONArray();for(Map.Entry<Long,JSONObject> row:indexes.get(table).entrySet()){ids.put(row.getKey());rows.put(row.getValue());}workforce.put(table,rows);allIds.put(table,ids);}
   cursor=next;if(!response.optBoolean("hasMore",false)){mirror.put("cursor",cursor).put("lastChanges",count);return value;}
  }
  throw new Exception("Υπερβολικά πολλές αλλαγές. Το προηγούμενο αντίγραφο διατηρήθηκε.");
 }
}
