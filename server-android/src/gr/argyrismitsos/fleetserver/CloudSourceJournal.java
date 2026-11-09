package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;
/** Source-only dirty revisions. Unchanged observations and money never enter it. */
public final class CloudSourceJournal {
    private CloudSourceJournal(){}
    private static final String KINDS="'store','terms','fleet_terms','ordexa_terms','policy','order','observation','local_day','coverage','cash_source_coverage','cash_rider_alias'";
    private static String allowed(String a){return "("+a+".kind IN ("+KINDS+") OR "+a+".kind='meta' AND "+a+".id IN ('meta:store-billing','meta:cash-sync'))";}
    public static void install(SQLiteDatabase db){
        db.execSQL("CREATE TABLE IF NOT EXISTS cloud_source_dirty(id TEXT PRIMARY KEY,deleted INTEGER NOT NULL,kind TEXT NOT NULL,revision TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS cloud_source_requests(id TEXT PRIMARY KEY,request_id TEXT NOT NULL)");
        for(String event:new String[]{"INSERT","UPDATE","DELETE"}){
            String source=event.equals("DELETE")?"OLD":"NEW",old=event.equals("INSERT")?"":(" OR "+allowed("OLD")),condition="("+allowed(source)+old+")";if(event.equals("UPDATE"))condition+=" AND (OLD.kind<>NEW.kind OR OLD.scope<>NEW.scope OR OLD.store_id<>NEW.store_id OR OLD.day<>NEW.day OR "+CloudStoreProof.compared("OLD")+"<>"+CloudStoreProof.compared("NEW")+")";
            String deleted=event.equals("DELETE")?"1":("CASE WHEN "+allowed("NEW")+" THEN 0 ELSE 1 END");
            String kind=event.equals("UPDATE")?("CASE WHEN "+allowed("NEW")+" THEN NEW.kind ELSE OLD.kind END"):source+".kind";
            db.execSQL("CREATE TRIGGER IF NOT EXISTS cloud_source_"+event.toLowerCase(java.util.Locale.US)+" AFTER "+event+" ON store_billing_local WHEN "+condition+" BEGIN INSERT INTO cloud_source_dirty(id,deleted,kind,revision) VALUES("+source+".id,"+deleted+","+kind+",lower(hex(randomblob(16)))) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,kind=excluded.kind,revision=excluded.revision; END;");
        }
    }
}
