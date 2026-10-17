package gr.argyrismitsos.fleetserver;
/** Unknown hints and explicit backup/repair always retain the safe download path. */
public final class MirrorPollPolicy {
 public static boolean mirror(boolean force,boolean known,String localEpoch,long localCursor,String remoteEpoch,long remoteCursor,long now,long lastSuccess){
  return force||!known||localEpoch==null||!localEpoch.equals(remoteEpoch)||localCursor!=remoteCursor||now-lastSuccess>3600000L;
 }
 public static boolean rules(boolean force,boolean known,boolean cached,String local,String remote){return force||!known||!cached||!local.equals(remote);}
}
