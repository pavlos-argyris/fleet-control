package gr.argyrismitsos.fleetdirect;

import org.json.JSONArray;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteDatabase;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.Collections;
import java.util.Set;

/** Exercises the compiled transfer and replica code on Android's bundled SQLite. */
final class FleetCloudMigrationChecks {
    private FleetCloudMigrationChecks() { }

    static void checkFleetBaselineScope(SQLiteDatabase db,String generation) throws Exception {
        String shiftId="shift-private-fixture-workforce-id";
        String machineId="Μηχανή / 7";
        JSONObject service=new JSONObject().put("id",728013).put("type","service").put("km",9300)
                .put("notes","Διατηρημένες εργασίες").put("date","2026-11-20").put("cost","30,00")
                .put("attachments",new JSONArray().put(new JSONObject().put("key","service-documents/probe")));
        JSONObject shift=new JSONObject().put("id",shiftId).put("type","check").put("km",9500).put("date","2026-11-21")
                .put("notes","secret synthetic shift detail");
        JSONObject machine=new JSONObject().put("id",machineId).put("name","Μηχανάκι").put("history",new JSONArray().put(service).put(shift))
                .put("historyDeletedIds",new JSONArray().put(shiftId));
        JSONObject fixture=new JSONObject().put("bikes",new JSONArray().put(machine)).put("payroll","secret synthetic salary");
        ByteArrayOutputStream staged=new ByteArrayOutputStream();
        db.beginTransaction();
        try {
            db.execSQL("UPDATE fleet_snapshot SET data=? WHERE id=1",new Object[]{fixture.toString()});
            db.execSQL("INSERT INTO vehicle_registry(bike_id,name,odometer,status,active_shift_id,version,updated_at) "+
                    "VALUES (?,?,?,'in_use',?,2,'2026-11-21')",new Object[]{machineId,"Μηχανάκι",9500,shiftId});
            Set<String> selected=FleetCloudArchive.project(db,staged,generation);
            check(selected.equals(Collections.singleton("service-documents/probe")),"Exact source attachment associated with staged service");
        } finally { db.endTransaction(); }
        String contents=staged.toString("UTF-8");
        boolean exactServiceId=false;
        for (String line:contents.split("\n")) {
            JSONObject row=new JSONObject(line);
            if (row.optString("kind").equals("history")&&row.optString("recordId").equals("728013")) {
                exactServiceId=row.getString("machineId").equals(machineId);
            }
        }
        check(exactServiceId,"The scope export retains the complete machine and original numeric service identifiers");
        check(contents.contains("Διατηρημένες εργασίες")&&contents.contains("9300")&&contents.contains("30,00"),"Real SQLite export preserves service details");
        check(contents.contains("machine-registry")&&contents.contains("in_use"),"Fleet registry status survives projection");
        check(contents.contains("9500")&&contents.contains("check:")&&!contents.contains(shiftId)&&!contents.contains("secret synthetic"),
                "Shift mileage crosses the boundary without workforce identifiers, notes or salary");
    }

    static void checkFleetReplica(File cache) throws Exception {
        String epoch="1234567890abcdef1234567890abcdef";
        String legacyMachineId="Μηχανή / 7";
        File location=new File(cache,"fleet-replica-fixture.db");
        JSONObject data=new JSONObject().put("name","Συνθετικό μηχανάκι").put("currentKm",9400);
        JSONObject machine=new JSONObject().put("kind","machine").put("machineId",legacyMachineId)
                .put("recordId",legacyMachineId).put("serviceId","").put("revision",1).put("cursor",2)
                .put("deleted",false).put("data",data);
        JSONObject page=new JSONObject().put("epoch",epoch).put("hasMore",false)
                .put("changes",new JSONArray().put(machine)).put("nextCursor",2);
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            FleetCloudReplica.initialize(stored,epoch);
            check(FleetCloudReplica.apply(stored,epoch,0L,page)==2L,"A real SQLite transaction advances to the exact cloud cursor");
            check(legacyMachineId.equals(IndependentSqlite.text(stored,"SELECT machine_id FROM fleet_cloud_replica")),
                    "SQLite preserves the legacy Fleet ID exactly");
        }
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
            JSONObject update=new JSONObject(machine.toString()).put("revision",2).put("cursor",3);
            JSONObject wrong=new JSONObject(machine.toString()).put("revision",4).put("cursor",4);
            page.put("changes",new JSONArray().put(update).put(wrong)).put("nextCursor",4);
            try {
                FleetCloudReplica.apply(stored,epoch,2L,page);
                throw new AssertionError("A partial schema/revision conflict was accepted");
            } catch (IOException expected) { }
            check(IndependentSqlite.text(stored,"SELECT cursor FROM fleet_cloud_checkpoint").equals("2")&&
                    IndependentSqlite.text(stored,"SELECT revision FROM fleet_cloud_replica").equals("1"),
                    "The malformed page leaves no partial record, and restart retains the last cursor");
            page.put("changes",new JSONArray().put(update)).put("nextCursor",3);
            check(FleetCloudReplica.apply(stored,epoch,2L,page)==3L,"Correct journal page resumes after rollback");
            try {
                FleetCloudReplica.initialize(stored,"fedcba0987654321fedcba0987654321");
                throw new AssertionError("A different epoch was accepted");
            } catch (IOException expected) { }
        }
    }
    private static void check(boolean value,String message) {
        if (!value) throw new AssertionError(message);
    }
}
