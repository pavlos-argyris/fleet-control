package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.IOException;
import java.util.*;

/** Rebuilds a private isolated SQLite file from one immutable Cloudflare point.
 * No live phone tables are touched and all values retain their SQLite type. */
public final class CloudBackupDatabase {
    public interface Reader{JSONArray rows(String table,String after)throws Exception;}
    public interface Progress{void stage(String table,long done,long total)throws Exception;}
    private CloudBackupDatabase(){}
    public static void copy(SQLiteDatabase db,JSONObject point,Reader reader,Progress progress)throws Exception{
        JSONArray tables=point.getJSONArray("tables");if(point.getInt("schema")!=1||tables.length()<20||tables.length()>200)throw new IOException("Μη έγκυρο πλήρες σημείο Cloudflare.");Set<String> names=new HashSet<String>();
        for(int i=0;i<tables.length();i++){JSONObject t=tables.getJSONObject(i);String name=t.getString("name"),sql=t.getString("sql").trim().replaceAll(";$","");CloudReturnSnapshot.q(name);if(!names.add(name)||!(CloudReturnSnapshot.transferable(name)||name.equals("fleet_mirror_state")||name.equals("fleet_mirror_changes"))||!sql.matches("(?is)^CREATE TABLE(?: IF NOT EXISTS)? [\"`\\[]?"+name+"[\"`\\]]?\\s*\\(.*\\)\\s*$")||sql.matches("(?s).*;.*")||sql.contains("--")||sql.contains("/*"))throw new IOException("Μη συμβατό σχήμα backup Cloudflare.");db.execSQL(sql);}
        for(int i=0;i<tables.length();i++){JSONObject t=tables.getJSONObject(i);String name=t.getString("name"),after=null;long copied=0;
            while(copied<t.getLong("rows")){JSONArray batch=reader.rows(name,after);if(batch.length()<1||batch.length()>64)throw new IOException("Ελλιπής σελίδα backup.");db.beginTransaction();try{
                for(int j=0;j<batch.length();j++){JSONObject row=batch.getJSONObject(j);String rowid=row.getString("rowid");try{Long.parseLong(rowid);if(after!=null&&Long.parseLong(rowid)<=Long.parseLong(after))throw new NumberFormatException();}catch(NumberFormatException error){throw new IOException("Μη έγκυρη ταυτότητα εγγραφής backup.");}
                    JSONArray values=row.getJSONArray("values"),columns=t.getJSONArray("columns");if(values.length()!=columns.length()||!CloudReturnSnapshot.rowHash(name,rowid,values).equals(row.getString("hash")))throw new IOException("Δεν συμφωνούν οι τύποι και το αποτύπωμα εγγραφής.");
                    List<Object> args=new ArrayList<Object>();StringBuilder fields=new StringBuilder("rowid"),expressions=new StringBuilder(rowid);
                    for(int k=0;k<columns.length();k++){fields.append(',').append(CloudReturnSnapshot.q(columns.getString(k)));expressions.append(',');JSONArray cell=values.getJSONArray(k);String type=cell.getString(0);if(type.equals("null")&&cell.isNull(1)){expressions.append("NULL");continue;}String value=cell.getString(1);
                        if(type.equals("blob")&&value.matches("(?:[A-F0-9]{2})*"))expressions.append("X'").append(value).append('\'');
                        else if(type.equals("integer")&&value.matches("-?(?:0|[1-9][0-9]*)")){try{Long.parseLong(value);}catch(NumberFormatException e){throw new IOException("Μη έγκυρος64bit ακέραιος backup.");}expressions.append("CAST(? AS INTEGER)");args.add(value);}
                        else if(type.equals("real")&&!Double.isInfinite(Double.parseDouble(value))&&!Double.isNaN(Double.parseDouble(value))){expressions.append("CAST(? AS REAL)");args.add(value);}
                        else if(type.equals("text")){expressions.append("CAST(? AS TEXT)");args.add(value);}else throw new IOException("Μη έγκυρος τύπος κελιού backup.");
                    }
                    db.execSQL("INSERT INTO "+CloudReturnSnapshot.q(name)+"("+fields+") VALUES("+expressions+")",args.toArray());JSONObject stored=CloudReturnSnapshot.next(db,t,after);if(stored==null||!stored.getString("hash").equals(row.getString("hash")))throw new IOException("Άλλαξε εγγραφή κατά την ανακατασκευή SQLite.");after=rowid;copied++;
                }db.setTransactionSuccessful();
            }finally{db.endTransaction();}progress.stage(name,copied,t.getLong("rows"));}
            if(copied!=t.getLong("rows"))throw new IOException("Δεν συμφωνεί το πλήθος εγγραφών backup.");
        }
        JSONArray sequences=point.optJSONArray("sequences");if(sequences!=null)for(int i=0;i<sequences.length();i++){JSONObject seq=sequences.getJSONObject(i);if(names.contains(seq.getString("name")))db.execSQL("UPDATE sqlite_sequence SET seq=CAST(? AS INTEGER) WHERE name=?",new Object[]{seq.getString("seq"),seq.getString("name")});}
        db.execSQL("UPDATE fleet_settings SET value='' WHERE key='runtime_schema_version'");
    }
}
