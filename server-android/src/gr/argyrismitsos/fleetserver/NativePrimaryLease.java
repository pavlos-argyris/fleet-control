package gr.argyrismitsos.fleetserver;

import java.io.IOException;
import java.util.*;

/**
 * Authority expires from request-send time, never delayed ACK receive time.
 * Production Clock MUST use SystemClock.elapsedRealtime (includes deep sleep).
 */
public final class NativePrimaryLease {
    public interface Clock{long now();}
    public static final long MAX_TTL_MS=30000;
    private final Clock clock;
    private final LinkedHashMap<String,Long> pending=new LinkedHashMap<String,Long>();
    private String epoch="",generation="";
    private long connectedAt,deadline,lastClock=-1;
    private boolean awaitingReady;
    public NativePrimaryLease(Clock clock){if(clock==null)throw new IllegalArgumentException("Missing monotonic clock");this.clock=clock;}
    private long now(){long value=clock.now();if(value<0||value<lastClock){invalidate();lastClock=value;return -1;}lastClock=value;return value;}
    private void invalidate(){epoch="";generation="";deadline=0;awaitingReady=false;pending.clear();}
    public synchronized String connecting(String generation)throws IOException{
        long sent=now();if(sent<0||generation==null||!generation.matches("[a-f0-9-]{36}"))throw new IOException("Invalid primary lease context");
        invalidate();this.generation=generation;epoch=UUID.randomUUID().toString();connectedAt=sent;awaitingReady=true;return epoch;
    }
    private boolean context(String epoch,String generation){if(!this.epoch.equals(epoch)||epoch.isEmpty())return false;if(!this.generation.equals(generation)){invalidate();return false;}return true;}
    private boolean grant(long sent,long ttl,long received){
        if(received<0||ttl<=0||ttl>MAX_TTL_MS||sent<0||sent>Long.MAX_VALUE-ttl||sent>received||sent+ttl<=received)return false;
        deadline=Math.max(deadline,sent+ttl);return true;
    }
    public synchronized boolean ready(String epoch,String generation,long ttl){
        long time=now();if(!context(epoch,generation)||!awaitingReady)return false;awaitingReady=false;return grant(connectedAt,ttl,time);
    }
    /** Call immediately before sending the corresponding heartbeat on this socket. */
    public synchronized String renewal(String epoch)throws IOException{
        long time=now();if(time<0||!this.epoch.equals(epoch)||epoch.isEmpty())throw new IOException("The primary connection changed");
        Iterator<Map.Entry<String,Long>> entries=pending.entrySet().iterator();while(entries.hasNext())if(time-entries.next().getValue()>=MAX_TTL_MS)entries.remove();
        while(pending.size()>=4)pending.remove(pending.keySet().iterator().next());
        String nonce=UUID.randomUUID().toString();pending.put(nonce,time);return nonce;
    }
    public synchronized boolean acknowledge(String epoch,String generation,String nonce,long ttl){
        long time=now();if(!context(epoch,generation))return false;Long sent=pending.remove(nonce);return sent!=null&&grant(sent,ttl,time);
    }
    public synchronized boolean valid(String epoch,String generation){long time=now();return time>=0&&context(epoch,generation)&&deadline>time;}
    public synchronized void require(String epoch,String generation)throws IOException{if(!valid(epoch,generation))throw new IOException("Η άδεια κύριου Server έληξε. Η αποθήκευση δεν επιβεβαιώθηκε· έλεγξε τη σύνδεση και επανάλαβε.");}
    public synchronized long remaining(String epoch,String generation){long time=now();return time>=0&&context(epoch,generation)?Math.max(0,deadline-time):0;}
    public synchronized void close(String epoch){if(this.epoch.equals(epoch))invalidate();}
}
