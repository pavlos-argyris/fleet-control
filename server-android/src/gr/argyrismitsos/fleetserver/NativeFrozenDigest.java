package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Exact typed content digest, including bounded reads of large SQLite cells. */
public final class NativeFrozenDigest {
    private NativeFrozenDigest(){}
    static String identifier(String value)throws IOException{
        if(value==null||!value.matches("[A-Za-z_][A-Za-z0-9_]{0,120}"))throw new IOException("Unsafe migration identifier");return '"'+value+'"';
    }
    public static MessageDigest start()throws Exception{MessageDigest hash=MessageDigest.getInstance("SHA-256");hash.update("fleet-frozen-content-v1\0".getBytes(StandardCharsets.US_ASCII));return hash;}
    private static void number(MessageDigest hash,long value){for(int shift=56;shift>=0;shift-=8)hash.update((byte)(value>>>shift));}
    private static void bytes(MessageDigest hash,byte[] value){number(hash,value.length);hash.update(value);}
    private static void text(MessageDigest hash,String value){bytes(hash,value.getBytes(StandardCharsets.UTF_8));}
    private static void header(MessageDigest hash,String table,long id){text(hash,table);number(hash,id);}
    public static void row(MessageDigest hash,String table,long rowid,LinkedHashMap<String,Object> row)throws Exception{
        header(hash,table,rowid);
        for(Map.Entry<String,Object> entry:row.entrySet()){
            text(hash,entry.getKey());Object value=entry.getValue();
            if(value==null){text(hash,"null");number(hash,0);}
            else if(value instanceof Long){text(hash,"integer");number(hash,8);number(hash,(Long)value);}
            else if(value instanceof Double){text(hash,"real");number(hash,8);number(hash,Double.doubleToLongBits((Double)value));}
            else if(value instanceof String){text(hash,"text");bytes(hash,((String)value).getBytes(StandardCharsets.UTF_8));}
            else if(value instanceof byte[]){text(hash,"blob");bytes(hash,(byte[])value);}
            else throw new IOException("Unsupported frozen value type");
        }
    }
    private static String scalar(SQLiteDatabase db,String sql,String...parameters){Cursor cursor=db.rawQuery(sql,parameters);try{return cursor.moveToFirst()?cursor.getString(0):null;}finally{cursor.close();}}
    private static void databaseRow(MessageDigest hash,SQLiteDatabase db,String original,String actual,long id,JSONArray columns,boolean candidate)throws Exception{
        header(hash,original,id);String where=" FROM "+identifier(actual)+" WHERE "+(candidate?"_fleet_source_rowid":"rowid")+"=?";
        for(int c=0;c<columns.length();c++){
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Frozen content verification interrupted");
            String name=columns.getJSONObject(c).getString("name"),column=identifier(name),kind=scalar(db,"SELECT typeof("+column+")"+where,Long.toString(id));text(hash,name);text(hash,kind);
            if("null".equals(kind)){number(hash,0);continue;}
            if("integer".equals(kind)){number(hash,8);number(hash,Long.parseLong(scalar(db,"SELECT CAST("+column+" AS TEXT)"+where,Long.toString(id))));continue;}
            if("real".equals(kind)){
                double value=Double.parseDouble(scalar(db,"SELECT printf('%!.17g',"+column+")"+where,Long.toString(id)));
                if(!Double.isFinite(value))throw new IOException("Non-finite migration value");number(hash,8);number(hash,Double.doubleToLongBits(value));continue;
            }
            if(!"text".equals(kind)&&!"blob".equals(kind))throw new IOException("Unsupported migration storage class");
            long size=Long.parseLong(scalar(db,"SELECT length(CAST("+column+" AS BLOB))"+where,Long.toString(id)));if(size<0||size>NativeFrozenExportV3.MAX_CELL_BYTES)throw new IOException("Migration cell exceeds its verified bound");number(hash,size);
            for(long offset=0;offset<size;offset+=32768){
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Frozen content verification interrupted");
                int length=(int)Math.min(32768,size-offset);String hex=scalar(db,"SELECT hex(substr(CAST("+column+" AS BLOB),?,?))"+where,Long.toString(offset+1),Integer.toString(length),Long.toString(id));
                if(hex==null||hex.length()!=length*2)throw new IOException("Incomplete frozen content slice");
                for(int i=0;i<length;i++){int a=Character.digit(hex.charAt(i*2),16),b=Character.digit(hex.charAt(i*2+1),16);if(a<0||b<0)throw new IOException("Invalid frozen content slice");hash.update((byte)((a<<4)|b));}
            }
        }
    }
    /** Table order and column order are the authenticated inventory order. */
    public static String database(SQLiteDatabase db,JSONObject inventory,boolean candidate,NativeFrozenImportV3.Progress progress)throws Exception{
        MessageDigest hash=start();JSONArray tables=inventory.getJSONArray("tables");
        for(int i=0;i<tables.length();i++){
            JSONObject table=tables.getJSONObject(i);String original=table.getString("name"),actual=candidate?NativeFrozenImportV3.candidateName(original):original,key=candidate?"_fleet_source_rowid":"rowid";long after=0,count=0;
            for(;;){
                List<Long> ids=new ArrayList<Long>();Cursor cursor=db.rawQuery("SELECT "+key+" FROM "+identifier(actual)+" WHERE "+key+">? ORDER BY "+key+" LIMIT 100",new String[]{Long.toString(after)});
                try{while(cursor.moveToNext())ids.add(cursor.getLong(0));}finally{cursor.close();}if(ids.isEmpty())break;
                for(long id:ids){databaseRow(hash,db,original,actual,id,table.getJSONArray("columns"),candidate);after=id;count++;}
                if(progress!=null)progress.update(original,count,table.getLong("rows"));
            }
            if(count!=table.getLong("rows")||count>0&&after!=table.getLong("lastRow"))throw new IOException("Frozen content table extent changed: "+original);
        }
        return finish(hash);
    }
    public static String finish(MessageDigest hash){StringBuilder result=new StringBuilder();for(byte b:hash.digest()){result.append(Character.forDigit((b>>>4)&15,16));result.append(Character.forDigit(b&15,16));}return result.toString();}
}
