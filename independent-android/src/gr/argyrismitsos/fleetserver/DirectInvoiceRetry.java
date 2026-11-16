package gr.argyrismitsos.fleetserver;
import java.io.*;import java.net.*;import java.util.concurrent.*;

/** Direct policy: six total starts, durable waits, no retry of invalid inputs. */
public final class DirectInvoiceRetry {
 private DirectInvoiceRetry(){}
 public static final int MAX_ATTEMPTS=6;
 private static final long[] DELAYS={10000,30000,60000,120000,300000};
 public static long delay(int attempts){return attempts>=1&&attempts<MAX_ATTEMPTS?DELAYS[attempts-1]:Long.MAX_VALUE;}
 public static final class InvalidInput extends IOException {public InvalidInput(String message){super(message);}}
 public static boolean transientFailure(Throwable error){
  for(Throwable e=error;e!=null;e=e.getCause()){
   if(e instanceof InvalidInput||e instanceof FileNotFoundException||e instanceof IllegalArgumentException)return false;
   if(e instanceof FleetHttp.HttpStatusException){int status=((FleetHttp.HttpStatusException)e).statusCode;return status==408||status==429||status>=500&&status<=599;}
   if(e instanceof SocketTimeoutException||e instanceof ConnectException||e instanceof UnknownHostException||e instanceof TimeoutException)return true;
  }
  return error instanceof IOException;
 }
 public static int parallelism(String thermal,double temperature,long availableBytes){return temperature>=42||availableBytes<32L*1024*1024||java.util.Arrays.asList("moderate","severe","critical","emergency","shutdown").contains(thermal)?1:2;}
}
