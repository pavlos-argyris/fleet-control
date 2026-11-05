package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.*;
import org.json.*;
import java.io.*;
import java.util.*;

/** D1-shaped operations on actual Android SQLite. SQL comes only from bundled handlers. */
public final class BusinessSqlite {
    private final SQLiteDatabase db;
    public BusinessSqlite(SQLiteDatabase db){this.db=db;}
    private static Object[] values(JSONArray input)throws Exception {
        Object[] result=new Object[input==null?0:input.length()];
        for(int i=0;i<result.length;i++){Object value=input.get(i);if(value==JSONObject.NULL)value=null;if(value instanceof Boolean)value=((Boolean)value)?1L:0L;if(value!=null&&!(value instanceof String)&&!(value instanceof Number))throw new IllegalArgumentException("Invalid SQL parameter");result[i]=value;}
        return result;
    }
    private Cursor query(final String sql,final Object[] args){
        return db.rawQueryWithFactory(new SQLiteDatabase.CursorFactory(){public Cursor newCursor(SQLiteDatabase database,SQLiteCursorDriver driver,String table,SQLiteQuery statement){
            for(int i=0;i<args.length;i++){Object value=args[i];if(value==null)statement.bindNull(i+1);else if(value instanceof Float||value instanceof Double)statement.bindDouble(i+1,((Number)value).doubleValue());else if(value instanceof Number)statement.bindLong(i+1,((Number)value).longValue());else statement.bindString(i+1,(String)value);}
            return new SQLiteCursor(driver,table,statement);
        }},sql,null,null);
    }
    private static Object cell(Cursor cursor,int column)throws Exception {
        switch(cursor.getType(column)){
            case Cursor.FIELD_TYPE_NULL:return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:return cursor.getLong(column);
            case Cursor.FIELD_TYPE_FLOAT:return cursor.getDouble(column);
            case Cursor.FIELD_TYPE_BLOB:return new JSONArray(cursor.getBlob(column));
            default:return cursor.getString(column);
        }
    }
    private JSONArray rows(String sql,Object[] args,boolean first,boolean raw)throws Exception {
        Cursor cursor=query(sql,args);String[] columns=cursor.getColumnNames();JSONArray rows=new JSONArray();
        try{
            while(cursor.moveToNext()){
                if(rows.length()>=50000)throw new IOException("Η προβολή είναι πολύ μεγάλη. Επίλεξε μικρότερο διάστημα.");
                if(raw){JSONArray row=new JSONArray();for(int i=0;i<columns.length;i++)row.put(cell(cursor,i));rows.put(row);}
                else {JSONObject row=new JSONObject();for(int i=0;i<columns.length;i++)row.put(columns[i],cell(cursor,i));rows.put(row);}
                if(first)break;
            }
            return rows;
        }catch(SQLiteException error){
            // CursorWindow cannot carry a large historical cell. Re-read the same
            // snapshot into a private indexed result and retrieve bounded slices.
            if(!String.valueOf(error.getMessage()).matches("(?is).*(CursorWindow|Row too big|too big to fit).*"))throw error;
            cursor.close();cursor=null;return largeRows(sql,args,columns,first,raw);
        }finally{if(cursor!=null)cursor.close();}
    }
    private Object scalar(String sql,Object[] args)throws Exception {Cursor c=query(sql,args);try{return c.moveToFirst()?cell(c,0):JSONObject.NULL;}finally{c.close();}}
    private JSONArray largeRows(String sql,Object[] args,String[] columns,boolean first,boolean raw)throws Exception {
        boolean owned=!db.inTransaction();if(owned)db.beginTransaction();String table="__fleet_query_"+UUID.randomUUID().toString().replace("-","");
        try{
            StringBuilder fields=new StringBuilder(),names=new StringBuilder();for(int i=0;i<columns.length;i++){fields.append(",c").append(i);if(i>0)names.append(',');names.append('c').append(i);}
            db.execSQL("CREATE TEMP TABLE "+table+"(__ordinal INTEGER PRIMARY KEY"+fields+")");
            db.execSQL("INSERT INTO "+table+"("+names+") "+sql.replaceFirst(";\\s*$",""),args);
            int count=((Number)scalar("SELECT COUNT(*) FROM "+table,new Object[0])).intValue();if(count>50000)throw new IOException("Η προβολή είναι πολύ μεγάλη. Επίλεξε μικρότερο διάστημα.");if(first)count=Math.min(1,count);
            JSONArray result=new JSONArray();
            for(int row=1;row<=count;row++){
                JSONObject object=new JSONObject();JSONArray array=new JSONArray();
                for(int column=0;column<columns.length;column++){
                    String field="c"+column;String type=String.valueOf(scalar("SELECT typeof("+field+") FROM "+table+" WHERE __ordinal=?",new Object[]{row}));Object value;
                    if(type.equals("null"))value=JSONObject.NULL;
                    else if(type.equals("integer")||type.equals("real"))value=scalar("SELECT "+field+" FROM "+table+" WHERE __ordinal=?",new Object[]{row});
                    else {
                        long length=((Number)scalar("SELECT length(CAST("+field+" AS BLOB)) FROM "+table+" WHERE __ordinal=?",new Object[]{row})).longValue();if(length>50L*1024*1024)throw new IOException("Η εγγραφή υπερβαίνει το επιτρεπόμενο μέγεθος.");
                        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                        for(long start=0;start<length;start+=32768){String hex=String.valueOf(scalar("SELECT hex(substr(CAST("+field+" AS BLOB),?,32768)) FROM "+table+" WHERE __ordinal=?",new Object[]{start+1,row}));bytes.write(BusinessPrimitives.unhex(hex));}
                        value=type.equals("blob")?new JSONArray(bytes.toByteArray()):new String(bytes.toByteArray(),"UTF-8");
                    }
                    if(raw)array.put(value);else object.put(columns[column],value);
                }
                result.put(raw?array:object);
            }
            db.execSQL("DROP TABLE "+table);if(owned)db.setTransactionSuccessful();return result;
        }finally{try{db.execSQL("DROP TABLE IF EXISTS "+table);}finally{if(owned)db.endTransaction();}}
    }
    private JSONObject run(String sql,Object[] args)throws Exception {
        db.execSQL(sql,args);JSONArray rows=rows("SELECT changes() changes,last_insert_rowid() last_row_id",new Object[0],true,false);
        return new JSONObject().put("success",true).put("results",new JSONArray()).put("meta",rows.getJSONObject(0));
    }
    public synchronized JSONObject call(String command,JSONObject value)throws Exception {
        long started=System.nanoTime();String sql=value.optString("sql");Object[] args=values(value.optJSONArray("params"));
        if(command.equals("sql.query"))return new JSONObject().put("success",true).put("results",rows(sql,args,value.optBoolean("first"),false));
        if(command.equals("sql.raw"))return new JSONObject().put("rows",rows(sql,args,false,true));
        if(command.equals("sql.run"))return run(sql,args);
        if(command.equals("sql.batch")||command.equals("sql.exec")){
            boolean owned=!db.inTransaction();String savepoint="fleet_batch_"+UUID.randomUUID().toString().replace("-","");if(owned)db.beginTransaction();else db.execSQL("SAVEPOINT "+savepoint);
            boolean complete=false;
            try{
                JSONArray results=new JSONArray();int count=0;
                if(command.equals("sql.exec")){for(String line:sql.split("\\r?\\n")){line=line.trim();if(!line.isEmpty()){db.execSQL(line);count++;}}}
                else {JSONArray queries=value.getJSONArray("queries");for(int i=0;i<queries.length();i++){JSONObject q=queries.getJSONObject(i);String statement=q.getString("sql");Object[] params=values(q.optJSONArray("params"));if(statement.trim().matches("(?is)^(SELECT|PRAGMA|EXPLAIN)\\b.*"))results.put(new JSONObject().put("success",true).put("results",rows(statement,params,false,false)));else results.put(run(statement,params));count++;}}
                if(owned)db.setTransactionSuccessful();else db.execSQL("RELEASE SAVEPOINT "+savepoint);complete=true;return new JSONObject().put("results",results).put("count",count).put("duration",(System.nanoTime()-started)/1000000.0);
            }finally{if(owned)db.endTransaction();else if(!complete){db.execSQL("ROLLBACK TO SAVEPOINT "+savepoint);db.execSQL("RELEASE SAVEPOINT "+savepoint);}}
        }
        return null;
    }
}
