package gr.argyrismitsos.fleetserver;
public final class SyncPollPolicy {
 public static int seconds(int configured,boolean busy,int idleCycles,int failures){
  if(failures>0)return Math.min(120,15*(1<<Math.min(3,failures-1)));
  if(busy)return 10;if(idleCycles>=2)return 60;return Math.max(10,Math.min(60,configured));
 }
}
