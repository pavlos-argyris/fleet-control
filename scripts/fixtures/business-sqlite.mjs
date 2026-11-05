import fs from 'node:fs';
import path from 'node:path';
/** Android API adapters backed by a persistent real SQLite connection. */
export function businessSqliteFixture(dir){
 const write=(name,text)=>fs.writeFileSync(path.join(dir,name),text);
 write('sqlite_rpc.py',String.raw`import sys,json,sqlite3,base64
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,isolation_level=None) if len(sys.argv)>2 and sys.argv[2]=='ro' else sqlite3.connect(sys.argv[1],isolation_level=None)
for line in sys.stdin:
 try:
  q=json.loads(line);r=c.execute(q['sql'],q.get('args',[]))
  rows=[[{'$blob':base64.b64encode(v).decode()} if isinstance(v,bytes) else v for v in row] for row in r.fetchall()]
  print(json.dumps({'rows':rows,'columns':[v[0] for v in r.description] if r.description else []},ensure_ascii=False),flush=True)
 except Exception as e:print(json.dumps({'error':str(e)}),flush=True)
`);
 write('Cursor.java',String.raw`package android.database;import org.json.*;public class Cursor{
 public static final int FIELD_TYPE_NULL=0,FIELD_TYPE_INTEGER=1,FIELD_TYPE_FLOAT=2,FIELD_TYPE_STRING=3,FIELD_TYPE_BLOB=4;public static int opened,largeRows;protected final JSONArray rows,columns;protected int at=-1;
 public Cursor(JSONObject result){rows=result.getJSONArray("rows");columns=result.getJSONArray("columns");opened++;}
 public String[] getColumnNames(){String[] c=new String[columns.length()];for(int i=0;i<c.length;i++)c[i]=columns.getString(i);return c;}
 public int getColumnCount(){return columns.length();}public int getCount(){return rows.length();}
 public boolean moveToFirst(){at=-1;return moveToNext();}public boolean moveToNext(){if(++at>=rows.length())return false;long bytes=0;JSONArray row=rows.getJSONArray(at);for(int i=0;i<row.length();i++)bytes+=String.valueOf(row.get(i)).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;if(bytes>2*1024*1024){largeRows++;throw new android.database.sqlite.SQLiteException("Row too big to fit into CursorWindow");}return true;}
 private Object value(int i){return rows.getJSONArray(at).get(i);}public int getType(int i){Object v=value(i);return v==JSONObject.NULL?0:v instanceof Float||v instanceof Double?2:v instanceof Number?1:v instanceof JSONObject?4:3;}
 public String getString(int i){Object v=value(i);return v==JSONObject.NULL?null:String.valueOf(v);}public long getLong(int i){return ((Number)value(i)).longValue();}public double getDouble(int i){return ((Number)value(i)).doubleValue();}public byte[] getBlob(int i){return java.util.Base64.getDecoder().decode(((JSONObject)value(i)).getString("$blob"));}public void close(){opened--;}
}`);
 write('SQLiteException.java','package android.database.sqlite;public class SQLiteException extends RuntimeException{public SQLiteException(String s){super(s);}}');
 write('SQLiteCursorDriver.java','package android.database.sqlite;public interface SQLiteCursorDriver{}');
 write('SQLiteQuery.java',String.raw`package android.database.sqlite;import org.json.*;public class SQLiteQuery{final SQLiteDatabase db;final String sql;final JSONArray args=new JSONArray();SQLiteQuery(SQLiteDatabase d,String s){db=d;sql=s;}public void bindNull(int i){args.put(i-1,JSONObject.NULL);}public void bindLong(int i,long v){args.put(i-1,v);}public void bindDouble(int i,double v){args.put(i-1,v);}public void bindString(int i,String v){args.put(i-1,v);}JSONObject result(){return db.query(sql,args);}}`);
 write('SQLiteCursor.java','package android.database.sqlite;public class SQLiteCursor extends android.database.Cursor{public SQLiteCursor(SQLiteCursorDriver d,String t,SQLiteQuery q){super(q.result());}}');
 write('SQLiteDatabase.java',String.raw`package android.database.sqlite;import java.io.*;import org.json.*;import android.database.Cursor;public class SQLiteDatabase{
 public static final int OPEN_READWRITE=0,OPEN_READONLY=1;public static SQLiteDatabase openDatabase(String path,CursorFactory factory,int flags)throws Exception{return new SQLiteDatabase(path,flags==OPEN_READONLY);}
 public interface CursorFactory{Cursor newCursor(SQLiteDatabase d,SQLiteCursorDriver driver,String table,SQLiteQuery q);}private final Process child;private final BufferedReader input;private final BufferedWriter output;private boolean transaction,success;public int queries;
 public SQLiteDatabase(String path)throws Exception{this(path,false);}
 public SQLiteDatabase(String path,boolean readonly)throws Exception{child=new ProcessBuilder("python3","-u",System.getProperty("fixture.rpc"),path,readonly?"ro":"rw").redirectError(ProcessBuilder.Redirect.INHERIT).start();input=new BufferedReader(new InputStreamReader(child.getInputStream(),"UTF-8"));output=new BufferedWriter(new OutputStreamWriter(child.getOutputStream(),"UTF-8"));}
 public synchronized JSONObject query(String sql,JSONArray args){try{queries++;output.write(new JSONObject().put("sql",sql).put("args",args).toString());output.newLine();output.flush();JSONObject r=new JSONObject(input.readLine());if(r.has("error"))throw new SQLiteException(r.getString("error"));return r;}catch(IOException e){throw new SQLiteException(e.toString());}}
 public Cursor rawQueryWithFactory(CursorFactory f,String sql,String[] args,String editTable){return f.newCursor(this,new SQLiteCursorDriver(){},editTable,new SQLiteQuery(this,sql));}
 public void execSQL(String sql){query(sql,new JSONArray());}public void execSQL(String sql,Object[] args){query(sql,new JSONArray(args));}
 public boolean inTransaction(){return transaction;}public void beginTransaction(){execSQL("BEGIN IMMEDIATE");transaction=true;success=false;}public void setTransactionSuccessful(){success=true;}public void endTransaction(){try{execSQL(success?"COMMIT":"ROLLBACK");}finally{transaction=false;success=false;}}
 public void close()throws Exception{output.close();input.close();child.waitFor();}
}`);
 return fs.readdirSync(dir).filter(n=>n.endsWith('.java')).map(n=>path.join(dir,n));
}
