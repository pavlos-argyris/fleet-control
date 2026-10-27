package gr.argyrismitsos.fleetserver;
import java.util.*;

/** Only known, complete exports may cause older known exports to be pruned. */
public final class BackupRetention {
    public static final class Record {
        public final String stamp;public final boolean documents,complete;
        public Record(String stamp,boolean documents,boolean complete){this.stamp=stamp;this.documents=documents;this.complete=complete;}
    }
    private BackupRetention(){}
    public static List<String> obsolete(List<Record> records,Set<String> existing,int keep,Set<String> pending){
        SortedSet<String> complete=new TreeSet<String>(Collections.reverseOrder());
        for(Record record:records){
            String stamp=record.stamp;
            if(stamp==null||!stamp.matches("\\d{8}_\\d{6}")||!record.complete||pending.contains(stamp))continue;
            if(!existing.contains("FleetControl_backup_"+stamp+".fcbackup"))continue;
            if(record.documents&&!existing.contains("FleetControl_documents_"+stamp+".fcdocs"))continue;
            complete.add(stamp);
        }
        List<String> result=new ArrayList<String>();int count=0;
        for(String stamp:complete)if(++count>Math.max(1,keep))result.add(stamp);
        return result;
    }
}
