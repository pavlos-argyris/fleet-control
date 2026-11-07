package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.util.Iterator;

/** Compact JSON without a payload-sized String or UTF-8 byte array. */
public final class BackupJsonWriter {
    public interface Progress { void bytes(long bytes) throws IOException; }
    private BackupJsonWriter() {}

    private static void value(Writer writer,Object object,int depth) throws Exception {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η προετοιμασία backup διακόπηκε.");
        if(depth>128)throw new IOException("Το αντίγραφο περιέχει υπερβολικά βαθιά δομή δεδομένων.");
        if(object==null||object==JSONObject.NULL){writer.write("null");return;}
        if(object instanceof JSONObject){
            writer.write('{');boolean first=true;JSONObject json=(JSONObject)object;Iterator<String> keys=json.keys();
            while(keys.hasNext()){String key=keys.next();if(!first)writer.write(',');first=false;writer.write(JSONObject.quote(key));writer.write(':');value(writer,json.get(key),depth+1);}
            writer.write('}');return;
        }
        if(object instanceof JSONArray){
            JSONArray array=(JSONArray)object;writer.write('[');
            for(int i=0;i<array.length();i++){if(i>0)writer.write(',');value(writer,array.get(i),depth+1);}
            writer.write(']');return;
        }
        if(object instanceof String){writer.write(JSONObject.quote((String)object));return;}
        if(object instanceof Number){writer.write(JSONObject.numberToString((Number)object));return;}
        if(object instanceof Boolean){writer.write(object.toString());return;}
        throw new IOException("Μη υποστηριζόμενο πεδίο στο αντίγραφο.");
    }

    public static long write(File destination,JSONObject root,final long limit,final Progress progress) throws Exception {
        final long[] bytes={0};boolean complete=false;
        FileOutputStream disk=new FileOutputStream(destination);
        FilterOutputStream bounded=new FilterOutputStream(disk){
            @Override public void write(int b) throws IOException {write(new byte[]{(byte)b},0,1);}
            @Override public void write(byte[] b,int start,int length) throws IOException {
                if(length>limit-bytes[0])throw new IOException("Τα δεδομένα υπερβαίνουν το όριο συμβατού backup 50 MB. Το προηγούμενο αντίγραφο διατηρείται.");
                out.write(b,start,length);bytes[0]+=length;if(progress!=null)progress.bytes(bytes[0]);
            }
        };
        Writer writer=new BufferedWriter(new OutputStreamWriter(bounded,"UTF-8"),32768);
        try{if(progress!=null)progress.bytes(0);value(writer,root,0);writer.flush();disk.getFD().sync();complete=true;return bytes[0];}
        finally{try{writer.close();}finally{if(!complete)destination.delete();}}
    }
}
