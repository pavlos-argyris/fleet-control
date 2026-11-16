package gr.argyrismitsos.fleetserver;
import java.util.concurrent.*;import java.util.concurrent.atomic.AtomicLong;

/** One SQLite/Rhino writer, bounded priorities and reserved interactive capacity. */
final class IndependentWorkQueue extends ThreadPoolExecutor {
 private static final AtomicLong sequence=new AtomicLong();
 private static final class Task<T> extends FutureTask<T> implements Comparable<Task<?>> {
  final int priority;final long order=sequence.incrementAndGet();
  Task(Callable<T> call,int priority){super(call);this.priority=priority;}
  public int compareTo(Task<?> other){int rank=Integer.compare(priority,other.priority);return rank!=0?rank:Long.compare(order,other.order);}
 }
 private static final class Queue extends PriorityBlockingQueue<Runnable> {
  @Override public synchronized boolean offer(Runnable value){int priority=value instanceof Task?((Task<?>)value).priority:0,maximum=priority>=2?24:priority==1?28:32;return size()<maximum&&super.offer(value);}
 }
 IndependentWorkQueue(){super(1,1,0,TimeUnit.MILLISECONDS,new Queue());}
 <T>Future<T> submit(Callable<T> call,int priority){if(priority<0||priority>2)throw new IllegalArgumentException("Invalid work priority");Task<T> task=new Task<T>(call,priority);execute(task);return task;}
}
