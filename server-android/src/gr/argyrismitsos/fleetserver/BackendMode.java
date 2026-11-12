package gr.argyrismitsos.fleetserver;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.nio.channels.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/** Local control plane. The file lock fences both processes, including commits in flight. */
public final class BackendMode {
    public static final String CLOUD="https://fleet-control.pavlosargyris.workers.dev", DIRECT="https://fleet-control.duckdns.org";
    private static final ReentrantReadWriteLock gate=new ReentrantReadWriteLock(true);
    private static int readers;private static RandomAccessFile readerFile;private static FileLock readerLock;
    private static volatile Context application;
    private BackendMode(){}
    public static void initialize(Context c){application=c.getApplicationContext();}
    private static File file(Context c,String name){return new File(c.getApplicationInfo().dataDir,"files/backend-mode"+name);}
    public static JSONObject read(Context c)throws Exception{
        File file=file(c,".json");if(!file.exists())return new JSONObject().put("schema",1).put("revision",0).put("selectedMode","cloudflare").put("activeMode","cloudflare").put("cloudUrl",CLOUD).put("directUrl",DIRECT).put("updatedAt",0);
        try(InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[1024];int n;while((n=in.read(b))!=-1){if(out.size()+n>8192)throw new IOException("Invalid mode record");out.write(b,0,n);}JSONObject state=new JSONObject(new String(out.toByteArray(),"UTF-8"));
            if(state.getInt("schema")!=1||state.getLong("revision")<0||!valid(state.getString("activeMode"))||!valid(state.getString("selectedMode"))||!CLOUD.equals(state.getString("cloudUrl"))||!DIRECT.equals(state.getString("directUrl")))throw new IOException("Invalid mode record");return state;}
    }
    private static boolean valid(String mode){return "cloudflare".equals(mode)||"direct".equals(mode);}
    public static boolean direct(Context c){try{return "direct".equals(read(c).getString("activeMode"));}catch(Exception invalid){return true;/* Never resume cloud work on corrupt state. */}}
    public static final class Guard implements AutoCloseable {
        private boolean closed;private final boolean write;private RandomAccessFile file;private FileLock lock;
        private Guard(Context c,boolean write)throws Exception{this.write=write;
            if(write){gate.writeLock().lock();try{file=new RandomAccessFile(BackendMode.file(c,".lock"),"rw");lock=file.getChannel().lock();}catch(Exception e){if(file!=null)file.close();gate.writeLock().unlock();throw e;}}
            else{gate.readLock().lock();try{synchronized(BackendMode.class){if(readers==0){readerFile=new RandomAccessFile(BackendMode.file(c,".lock"),"rw");try{readerLock=readerFile.getChannel().lock(0,Long.MAX_VALUE,true);}catch(Exception e){readerFile.close();throw e;}}readers++;}}catch(Exception e){gate.readLock().unlock();throw e;}}
        }
        public void close()throws IOException{if(closed)return;closed=true;if(write){try{lock.release();}finally{try{file.close();}finally{gate.writeLock().unlock();}}}else{try{synchronized(BackendMode.class){if(--readers==0){try{readerLock.release();}finally{readerFile.close();readerLock=null;readerFile=null;}}}}finally{gate.readLock().unlock();}}}
    }
    public static Guard guard(Context c)throws Exception{return new Guard(c,false);}
    public static Guard cloudRequest()throws Exception{Context c=application;if(c==null)return null;Guard result=guard(c);try{if(direct(c))throw new IOException("Επιλεγμένος Direct Server. Η παλιά cloud ενέργεια δεν στάλθηκε.");return result;}catch(Exception e){result.close();throw e;}}
    public static JSONObject select(Context c,String mode,long expected,boolean ready,String reason)throws Exception{
        if(!valid(mode))throw new IOException("Μη έγκυρη λειτουργία.");
        try(Guard ignored=new Guard(c,true)){JSONObject state=read(c);if(state.getLong("revision")!=expected)throw new IOException("Η επιλογή άλλαξε. Ανανέωσε την κατάσταση.");
            String active=mode.equals("direct")&&!ready?state.getString("activeMode"):mode;
            state.put("selectedMode",mode).put("activeMode",active).put("pending",!active.equals(mode)).put("reason",reason).put("revision",expected+1).put("updatedAt",System.currentTimeMillis());
            File target=file(c,".json"),temporary=file(c,".new");try(FileOutputStream out=new FileOutputStream(temporary)){out.write(state.toString().getBytes("UTF-8"));out.getFD().sync();}if(!temporary.renameTo(target))throw new IOException("Η επιλογή δεν αποθηκεύτηκε.");
            java.io.FileDescriptor fd=android.system.Os.open(target.getParent(),android.system.OsConstants.O_RDONLY,0);try{android.system.Os.fsync(fd);}finally{android.system.Os.close(fd);}return state;
        }
    }
}
