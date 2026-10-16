package gr.argyrismitsos.fleetserver;
import java.util.Map;
/** Deletion tombstones remain durable, except for a newer explicit restore. */
public final class HistoryMergePolicy {
 public static boolean deleted(String id, Map<String,String> restores, Map<String,String> deletes){
  String restored=restores.get(id);if(restored==null)return true;String deleted=deletes.get(id);return deleted!=null&&deleted.compareTo(restored)>0;
 }
 private HistoryMergePolicy(){}
}
