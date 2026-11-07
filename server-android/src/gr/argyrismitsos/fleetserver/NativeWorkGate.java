package gr.argyrismitsos.fleetserver;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/** Pipelines finish their current durable step before a migration/restore begins. */
public final class NativeWorkGate {
    private static final ReentrantReadWriteLock lock=new ReentrantReadWriteLock(true);
    private NativeWorkGate(){}
    public interface Check{void check()throws Exception;}
    public static void pipeline(Runnable work){lock.readLock().lock();try{work.run();}finally{lock.readLock().unlock();}}
    public static void exclusive(Check check)throws Exception{while(!lock.writeLock().tryLock(1,TimeUnit.SECONDS))check.check();try{check.check();}catch(Exception error){lock.writeLock().unlock();throw error;}}
    public static void release(){lock.writeLock().unlock();}
}
