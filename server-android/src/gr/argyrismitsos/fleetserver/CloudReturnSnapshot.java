package gr.argyrismitsos.fleetserver;

import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;

/** Typed, bounded export from a frozen authority. No JSON Number conversion of
 * SQLite INTEGER64/REAL/BLOB and no whole-database JSON materialization. */
public final class CloudReturnSnapshot {
    private static final Set<String> EXCLUDED=new HashSet<String>(Arrays.asList("bikes","settings","system_state","applied_operations","fleet_releases","fleet_primary_fence","fleet_primary_cancellations","d1_migrations","fleet_mirror_changes","fleet_mirror_state","native_primary_state","native_objects","native_file_transfers","native_object_gc","native_backup_pins","native_event_outbox","native_migration_rows","native_migration_inventory"));
    public interface Progress{void stage(String table,long copied,long total)throws Exception;}
    private CloudReturnSnapshot(){}
    public static String q(String name)throws IOException{if(name==null||!name.matches("[A-Za-z_][A-Za-z0-9_]{0,120}"))throw new IOException("Μη έγκυρο όνομα πίνακα μεταφοράς.");return "\""+name+"\"";}
    public static boolean transferable(String name){return name.matches("[A-Za-z_][A-Za-z0-9_]{0,120}")&&!EXCLUDED.contains(name)&&!name.matches("(?i)(?:_cf_|__cf|sqlite_|server_|_cloud_|cloud_source_).*?");}
    private static JSONArray rows(SQLiteDatabase db,String query,Object...args)throws Exception{return new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql",query).put("params",new JSONArray(Arrays.asList(args)))).getJSONArray("results");}
    private static String hex(byte[] data){StringBuilder s=new StringBuilder();for(byte b:data){s.append(Character.forDigit((b>>>4)&15,16));s.append(Character.forDigit(b&15,16));}return s.toString();}
    public static String rowHash(String table,String rowid,JSONArray values)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");digest.update((table+"\0"+rowid+"\0").getBytes("UTF-8"));
        for(int i=0;i<values.length();i++){JSONArray cell=values.getJSONArray(i);byte[] value=(cell.isNull(1)?"":cell.getString(1)).getBytes("UTF-8");digest.update((cell.getString(0)+"\0"+value.length+"\0").getBytes("UTF-8"));digest.update(value);}return hex(digest.digest());
    }
    public static JSONObject next(SQLiteDatabase db,JSONObject table,String after)throws Exception{
        JSONArray cols=table.getJSONArray("columns");StringBuilder query=new StringBuilder("SELECT CAST(_rowid_ AS TEXT) _source_row");
        for(int i=0;i<cols.length();i++){String c=q(cols.getString(i));query.append(",typeof(").append(c).append(") t").append(i).append(",CASE typeof(").append(c).append(") WHEN 'null' THEN NULL WHEN 'blob' THEN hex(").append(c).append(") WHEN 'real' THEN printf('%!.17g',").append(c).append(") ELSE CAST(").append(c).append(" AS TEXT) END v").append(i);}
        query.append(" FROM ").append(q(table.getString("name")));if(after!=null)query.append(" WHERE _rowid_>CAST(? AS INTEGER)");query.append(" ORDER BY _rowid_ LIMIT 1");
        JSONArray found=after==null?rows(db,query.toString()):rows(db,query.toString(),after);if(found.length()==0)return null;JSONObject raw=found.getJSONObject(0);JSONArray values=new JSONArray();
        for(int i=0;i<cols.length();i++){String type=raw.getString("t"+i);values.put(new JSONArray().put(type).put(type.equals("null")?JSONObject.NULL:raw.getString("v"+i)));}
        String id=raw.getString("_source_row");return new JSONObject().put("rowid",id).put("values",values).put("hash",rowHash(table.getString("name"),id,values));
    }
    public static JSONArray tables(SQLiteDatabase db,Progress progress)throws Exception{
        JSONArray schema=rows(db,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");Map<String,JSONObject> tables=new TreeMap<String,JSONObject>();Map<String,Set<String>> parents=new HashMap<String,Set<String>>();
        for(int i=0;i<schema.length();i++){JSONObject raw=schema.getJSONObject(i);String name=raw.getString("name");if(!transferable(name))continue;JSONArray columns=new JSONArray(),info=rows(db,"PRAGMA table_xinfo("+q(name)+")");
            for(int j=0;j<info.length();j++){JSONObject c=info.getJSONObject(j);if(c.optInt("hidden")!=0||Arrays.asList("rowid","_rowid_","oid").contains(c.getString("name").toLowerCase(Locale.US)))throw new IOException("Μη συμβατή κρυφή στήλη μεταφοράς.");columns.put(c.getString("name"));}
            if(columns.length()<1||columns.length()>99)throw new IOException("Μη συμβατό πλήθος στηλών μεταφοράς.");
            long count=rows(db,"SELECT COUNT(*) n FROM "+q(name)).getJSONObject(0).getLong("n");JSONObject t=new JSONObject().put("name",name).put("sql",raw.getString("sql")).put("columns",columns).put("rows",count);String chain="0000000000000000000000000000000000000000000000000000000000000000",after=null;long copied=0;
            for(;;){JSONObject row=next(db,t,after);if(row==null)break;chain=BusinessRuntime.sha256((chain+":"+row.getString("hash")).getBytes("UTF-8"));after=row.getString("rowid");if(++copied%64==0)progress.stage(name,copied,count);}
            if(copied!=count)throw new IOException("Άλλαξε ο πίνακας κατά την απογραφή.");t.put("contentHash",chain);tables.put(name,t);Set<String> p=new HashSet<String>();JSONArray keys=rows(db,"PRAGMA foreign_key_list("+q(name)+")");for(int j=0;j<keys.length();j++){String parent=keys.getJSONObject(j).getString("table");if(!name.equals(parent))p.add(parent);}parents.put(name,p);
        }
        JSONArray sorted=new JSONArray();Set<String> added=new HashSet<String>();while(added.size()<tables.size()){boolean advanced=false;for(String name:tables.keySet())if(!added.contains(name)){Set<String> p=new HashSet<String>(parents.get(name));p.retainAll(tables.keySet());if(added.containsAll(p)){sorted.put(tables.get(name));added.add(name);advanced=true;}}if(!advanced)throw new IOException("Κυκλικές σχέσεις απαιτούν έλεγχο πριν από τη μεταφορά.");}return sorted;
    }
    public static JSONObject nextObject(SQLiteDatabase db,String after)throws Exception{
        JSONArray found=after==null?rows(db,"SELECT key,local_name,size,sha256,http_metadata,custom_metadata FROM native_objects WHERE deleted_at IS NULL ORDER BY key LIMIT 1"):rows(db,"SELECT key,local_name,size,sha256,http_metadata,custom_metadata FROM native_objects WHERE deleted_at IS NULL AND key>? ORDER BY key LIMIT 1",after);
        if(found.length()==0)return null;JSONObject r=found.getJSONObject(0),metadata=new JSONObject().put("httpMetadata",new JSONObject(r.getString("http_metadata"))).put("customMetadata",new JSONObject(r.getString("custom_metadata")));
        return new JSONObject().put("key",r.getString("key")).put("localName",r.getString("local_name")).put("size",r.getLong("size")).put("sha256",r.getString("sha256")).put("metadataJson",metadata.toString());
    }
    public static String objectHash(JSONObject object)throws Exception{return BusinessRuntime.sha256((object.getString("key")+"\0"+object.getLong("size")+"\0"+object.getString("sha256")+"\0"+object.getString("metadataJson")).getBytes("UTF-8"));}
    public static JSONObject manifest(SQLiteDatabase db,JSONObject identity,Progress progress)throws Exception{
        JSONArray tables=tables(db,progress);String after=null,chain="0000000000000000000000000000000000000000000000000000000000000000";long count=0;for(;;){JSONObject o=nextObject(db,after);if(o==null)break;chain=BusinessRuntime.sha256((chain+":"+objectHash(o)).getBytes("UTF-8"));after=o.getString("key");count++;}
        JSONArray sequences=new JSONArray();Set<String> names=new HashSet<String>();for(int i=0;i<tables.length();i++)names.add(tables.getJSONObject(i).getString("name"));if(rows(db,"SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").length()>0){JSONArray all=rows(db,"SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence ORDER BY name");for(int i=0;i<all.length();i++)if(names.contains(all.getJSONObject(i).getString("name")))sequences.put(all.getJSONObject(i));}
        return new JSONObject().put("sequences",sequences).put("tables",tables).put("objects",new JSONObject().put("count",count).put("contentHash",chain)).put("ownerId",identity.getString("ownerId")).put("authPepperSha256",BusinessRuntime.sha256(identity.getString("authPepper").getBytes("UTF-8")));
    }
}
