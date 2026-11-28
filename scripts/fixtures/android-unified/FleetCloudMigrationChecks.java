package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import org.sqlite.database.sqlite.SQLiteDatabase;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.Set;

/** Exercises the compiled transfer and replica code on Android's bundled SQLite. */
final class FleetCloudMigrationChecks {
    private FleetCloudMigrationChecks() { }

    static void checkFleetCloudInvoiceWriter(Context context, File cache, JSONObject config) throws Exception {
        File directory=new File(cache,"fleet-cloud-working-copy");
        check(directory.mkdirs(),"Open a separate SQLite database for the active schema");
        String code=IndependentRuntime.asset(context,"business-runtime/runtime.js");
        String hash=new JSONObject(IndependentRuntime.asset(context,"business-runtime/manifest.json")).getString("bundleSha256");
        try (SQLiteDatabase database=SQLiteDatabase.openDatabase(new File(directory,"direct.db").getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY);
             NativeBusinessEngine engine=new NativeBusinessEngine(database,new File(directory,"objects"),new File(directory,"transfers"),
                     config,code,hash,new NativeBusinessEngine.Authority(){
                 public void beforeRequest(JSONObject request,boolean internal) { }
                 public void beforeCommit(JSONObject response,boolean internal) { }
             },(command,value,objects)->{
                 if (command.equals("health.snapshot")) return new JSONObject();
                 throw new IOException("Unexpected outbound FleetCloud test capability");
             })) {
            String realm=config.getString("realm");
            JSONArray receipts=FleetCloudInvoiceChecks.run(engine,database,directory,realm);
            checkInvoiceDelivery(directory,engine,realm,receipts);
            FleetCloudSourceJournalChecks.run(database,directory);
            checkSourceCatchUp(directory,config.getString("generation"));
        }
    }

    private static void checkSourceCatchUp(File directory,String generation) throws Exception {
        String epoch="6789abcdef0123456789abcdef012345",source=FleetCloudBaseline.digest("synthetic backup".getBytes(StandardCharsets.UTF_8));
        String journalId="019239abcdef0123456789abcdef0123";
        String machineId="Μηχανή / 8",key="service-documents/added.pdf";
        byte[] pdf="%PDF-1.4\nPost-backup synthetic file\n%%EOF".getBytes(StandardCharsets.UTF_8);
        String sha=FleetCloudBaseline.digest(pdf),localName=sha+"-"+sha+".pdf";
        File objects=new File(directory,"source-objects");
        check(objects.mkdir(),"Separate synthetic source attachments");
        try (SQLiteDatabase db=SQLiteDatabase.openDatabase(new File(directory,"source-live.sqlite").getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            for (String statement:new String[]{"fleet_snapshot(id INTEGER PRIMARY KEY,version,data,updated_at)",
                    "vehicle_registry(bike_id TEXT PRIMARY KEY,name,odometer,status,version,updated_at)",
                    "vehicle_archives(bike_id TEXT PRIMARY KEY,snapshot_json,name,odometer,original_status,active,archived_at,reason,restored_at,restore_reason)",
                    "deleted_records(id TEXT PRIMARY KEY,record_type,record_id,payload,label,reason,deleted_at,restored_at,restore_reason)",
                    "fleet_operations(id TEXT PRIMARY KEY,type,payload,status,created_at)",
                    "invoice_import_drafts(id TEXT PRIMARY KEY,status,data,created_at,updated_at)",
                    "native_objects(key TEXT PRIMARY KEY,local_name,name,content_type,size,sha256,updated_at,deleted_at)"}) {
                db.execSQL("CREATE TABLE "+statement);
            }
            JSONObject service=new JSONObject().put("id",728014).put("type","service").put("date","2026-11-20").put("km",9300)
                    .put("notes","Αρχικό σέρβις").put("tasks",new JSONArray().put("Λάδια"));
            JSONObject fixture=new JSONObject().put("bikes",new JSONArray().put(new JSONObject().put("id",machineId)
                    .put("name","Μηχανάκι").put("history",new JSONArray().put(service)))).put("payroll","unrelated synthetic salary");
            db.execSQL("INSERT INTO fleet_snapshot VALUES(1,1,?,'2026-11-20')",new Object[]{fixture.toString()});
            db.execSQL("INSERT INTO fleet_operations VALUES('legacy-job','service_document_render','{}','error','2026-11-20')");
            FleetCloudSourceJournal.arm(db,journalId,generation);
            File baseline=new File(directory,"source-baseline.ndjson");
            try (java.io.FileOutputStream output=new java.io.FileOutputStream(baseline)) { FleetCloudArchive.project(db,output,generation); }
            FleetCloudCatchUp.seed(directory,epoch,source,0,baseline);
            DeltaReceipts noChange=new DeltaReceipts(false,pdf);
            FleetCloudCatchUp.capture(directory,db,objects,epoch,journalId,source,generation,0);
            check(!FleetCloudCatchUp.send(directory,epoch,source,0,noChange).getBoolean("acknowledged")&&noChange.manifest==null,
                    "Unmodified SQLite starts no Cloud transaction");
            service.put("notes","Σημείωση μετά το αντίγραφο").put("attachments",new JSONArray().put(new JSONObject().put("key",key)));
            db.execSQL("UPDATE fleet_snapshot SET data=?,version=2 WHERE id=1",new Object[]{fixture.toString()});
            db.execSQL("UPDATE fleet_operations SET status='completed' WHERE id='legacy-job'");
            Files.write(new File(objects,localName).toPath(),pdf);
            db.execSQL("INSERT INTO native_objects VALUES(?,?,?,?,?,?,'2026-11-21',NULL)",new Object[]{key,localName,"added.pdf","application/pdf",pdf.length,sha});
            FleetCloudCatchUp.capture(directory,db,objects,epoch,journalId,source,generation,0);
            long older=FleetCloudSourceJournal.checkpoint(db,journalId,generation);
            DeltaReceipts receiver=new DeltaReceipts(true,pdf);
            try {
                FleetCloudCatchUp.send(directory,epoch,source,0,receiver);
                throw new AssertionError("A lost seal acknowledgement was accepted");
            } catch (java.io.InterruptedIOException expected) { }
            service.put("notes","Η πιο πρόσφατη σημείωση");
            db.execSQL("UPDATE fleet_snapshot SET data=?,version=3 WHERE id=1",new Object[]{fixture.toString()});
            FleetCloudCatchUp.capture(directory,db,objects,epoch,journalId,source,generation,0);
            check(FleetCloudCatchUp.send(directory,epoch,source,0,receiver).getLong("cursor")==older&&receiver.uploads==1,
                    "The durable pending batch resumes before staging later changes and does not upload the same file twice");
            JSONObject staged=new JSONObject(receiver.change("history",machineId,"728014").getString("record"));
            JSONObject data=staged.getJSONObject("data");
            check(machineId.equals(staged.getString("machineId"))&&data.getString("id").equals("728014")&&
                    data.getInt("km")==9300&&data.getString("date").equals("2026-11-20")&&
                    data.getString("notes").equals("Σημείωση μετά το αντίγραφο")&&
                    receiver.change("invoice-job","","legacy-job").isNull("record")&&
                    !receiver.records.contains("unrelated synthetic salary"),
                    "Only expected Fleet data and the original stable IDs are staged");
            FleetCloudCatchUp.capture(directory,db,objects,epoch,journalId,source,generation,0);
            DeltaReceipts newer=new DeltaReceipts(false,pdf);
            check(FleetCloudCatchUp.send(directory,epoch,source,0,newer).getLong("cursor")>older&&newer.uploads==0&&
                    newer.manifest.getLong("afterCursor")==older&&new JSONObject(newer.change("history",machineId,"728014").getString("record"))
                        .getJSONObject("data").getString("notes").equals("Η πιο πρόσφατη σημείωση"),
                    "The next batch follows the committed cursor without resending unchanged attachments");
        }
    }

    private static final class DeltaReceipts implements FleetCloudBaseline.Transport {
        private final byte[] pdf;
        private boolean lose;
        private boolean sealed;
        int uploads;
        JSONObject manifest;
        JSONObject fileReceipt=emptyReceipt(),recordReceipt=emptyReceipt();
        String records="";

        DeltaReceipts(boolean lose,byte[] pdf) { this.lose=lose; this.pdf=pdf; }

        JSONObject change(String kind,String machine,String record) throws Exception {
            for (String line:records.split("\n")) {
                JSONObject change=new JSONObject(line);
                JSONArray key=change.optJSONArray("key");
                if (key!=null&&kind.equals(key.getString(0))&&machine.equals(key.getString(1))&&record.equals(key.getString(2))) return change;
            }
            throw new AssertionError("Expected Fleet record is missing from the transfer");
        }

        @Override public JSONObject putFile(String sha,String type,long size,InputStream input) throws Exception {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            byte[] buffer=new byte[1024];
            for (int n;(n=input.read(buffer))!=-1;) bytes.write(buffer,0,n);
            check(Arrays.equals(pdf,bytes.toByteArray())&&FleetCloudBaseline.digest(pdf).equals(sha),"Exact prepared attachment bytes");
            uploads++;
            return new JSONObject().put("size",size).put("sha256",sha).put("verified",true);
        }

        @Override public JSONObject send(String path,JSONObject payload) throws Exception {
            if (path.endsWith("/begin")) {
                if (manifest==null) manifest=payload;
                else check(manifest.toString().equals(payload.toString()),"A restart uses the exact same pending manifest");
            } else if (path.endsWith("/records")) {
                byte[] bytes=Base64.decode(payload.getString("data"),Base64.DEFAULT);
                records+=new String(bytes,StandardCharsets.UTF_8);
                return advance(recordReceipt,bytes.length,payload.getString("sha256"));
            } else if (path.endsWith("/files")) {
                long bytes=payload.getLong("size");
                return advance(fileReceipt,bytes,FleetCloudBaseline.digest((payload.getString("sha256")+":"+bytes).getBytes(StandardCharsets.UTF_8)));
            } else if (path.endsWith("/seal")) {
                sealed=true;
                if (lose) { lose=false; throw new java.io.InterruptedIOException("synthetic lost seal acknowledgement"); }
            } else throw new AssertionError("Unexpected catch-up endpoint");
            return new JSONObject().put("manifest",manifest).put("phase",sealed?"staged":"copying")
                    .put("epoch","6789abcdef0123456789abcdef012345").put("records",recordReceipt).put("files",fileReceipt);
        }

        private static JSONObject emptyReceipt() {
            try { return new JSONObject().put("next",0).put("bytes",0)
                    .put("chain","0000000000000000000000000000000000000000000000000000000000000000"); }
            catch (org.json.JSONException unexpected) { throw new AssertionError(unexpected); }
        }

        private static JSONObject advance(JSONObject receipt,long bytes,String hash) throws Exception {
            return receipt.put("chain",FleetCloudBaseline.digest((receipt.getString("chain")+":"+hash).getBytes(StandardCharsets.UTF_8)))
                    .put("bytes",receipt.getLong("bytes")+bytes).put("next",receipt.getInt("next")+1);
        }
    }

    private static void checkInvoiceDelivery(File directory,NativeBusinessEngine engine,String realm,JSONArray receipts) throws Exception {
        JSONObject valid=receipts.getJSONObject(0),missing=receipts.getJSONObject(1);
        String epoch=valid.getString("epoch");
        JSONObject applied=valid.getJSONObject("change"),review=missing.getJSONObject("change").put("cursor",9);
        JSONObject baseline=new JSONObject(applied.toString()).put("cursor",10).put("recordId","previous-confirmed-document")
                .put("operationId","baseline:synthetic-confirmed-attachment");
        JSONObject page=new JSONObject().put("epoch",epoch).put("hasMore",false).put("nextCursor",10)
                .put("changes",new JSONArray().put(applied).put(review).put(baseline));
        File replica=new File(directory,"journal.db"),documents=new File(directory,"replica-documents");
        byte[] bytes=Files.readAllBytes(new File(directory,"synthetic-different.pdf").toPath());
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(replica.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            FleetCloudReplica.initialize(stored,epoch);
            FleetCloudReplica.apply(stored,epoch,0,page,documents,(sha,size,output)->output.write(bytes));
            check(IndependentSqlite.text(stored,"SELECT cursor FROM fleet_cloud_checkpoint").equals("10")&&
                    IndependentSqlite.text(stored,"SELECT count(*) FROM fleet_cloud_invoice_delivery WHERE status='pending'").equals("2"),
                    "The same transaction keeps the journal and both delivery receipts, with the original confirmed file skipped");
            try {
                FleetCloudReplica.deliverInvoices(stored,epoch,documents,(mutation,pdf)->{
                    JSONObject receipt=engine.applyFleetCloudInvoice(realm,mutation,pdf);
                    check(new JSONObject(receipt.getString("body")).optBoolean("reused"),"Direct received the original operation");
                    throw new java.io.InterruptedIOException("lost replication receipt");
                });
                throw new AssertionError("A lost acknowledgement was treated as a completed delivery");
            } catch (java.io.InterruptedIOException expected) { }
        }
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(replica.getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
            check(FleetCloudReplica.deliverInvoices(stored,epoch,documents,(mutation,pdf)->engine.applyFleetCloudInvoice(realm,mutation,pdf))==2,
                    "Resume delivery after the receiver committed and the sender missed the response");
            check(IndependentSqlite.text(stored,"SELECT count(*) FROM fleet_cloud_invoice_delivery WHERE status='applied'").equals("1")&&
                    IndependentSqlite.text(stored,"SELECT reason FROM fleet_cloud_invoice_delivery WHERE status='review'").equals("invoice_target_missing"),
                    "Safe replay records the confirmation and retains the unverified target and its specific reason");
            check(FleetCloudReplica.deliverInvoices(stored,epoch,documents,(mutation,pdf)->{throw new AssertionError("A delivered invoice was repeated");})==0,
                    "The apply loop skips confirmed and review receipts on subsequent automatic runs");
        }
    }

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
        File documents=new File(cache,"fleet-replica-documents");
        FleetCloudReplica.DocumentPull noFiles=(sha,size,output)->{throw new AssertionError("Unexpected document");};
        JSONObject data=new JSONObject().put("name","Συνθετικό μηχανάκι").put("currentKm",9400);
        JSONObject machine=new JSONObject().put("kind","machine").put("machineId",legacyMachineId)
                .put("recordId",legacyMachineId).put("serviceId","").put("revision",1).put("cursor",2)
                .put("deleted",false).put("data",data);
        JSONObject page=new JSONObject().put("epoch",epoch).put("hasMore",false)
                .put("changes",new JSONArray().put(machine)).put("nextCursor",2);
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY)) {
            FleetCloudReplica.initialize(stored,epoch);
            check(FleetCloudReplica.apply(stored,epoch,0L,page,documents,noFiles)==2L,
                    "A real SQLite transaction advances to the exact cloud cursor");
            check(legacyMachineId.equals(IndependentSqlite.text(stored,"SELECT machine_id FROM fleet_cloud_replica")),
                    "SQLite preserves the legacy Fleet ID exactly");
        }
        try (SQLiteDatabase stored=SQLiteDatabase.openDatabase(location.getPath(),null,SQLiteDatabase.OPEN_READWRITE)) {
            JSONObject update=new JSONObject(machine.toString()).put("revision",2).put("cursor",3);
            JSONObject wrong=new JSONObject(machine.toString()).put("revision",4).put("cursor",4);
            page.put("changes",new JSONArray().put(update).put(wrong)).put("nextCursor",4);
            try {
                FleetCloudReplica.apply(stored,epoch,2L,page,documents,noFiles);
                throw new AssertionError("A partial schema/revision conflict was accepted");
            } catch (IOException expected) { }
            check(IndependentSqlite.text(stored,"SELECT cursor FROM fleet_cloud_checkpoint").equals("2")&&
                    IndependentSqlite.text(stored,"SELECT revision FROM fleet_cloud_replica").equals("1"),
                    "The malformed page leaves no partial record, and restart retains the last cursor");
            page.put("changes",new JSONArray().put(update)).put("nextCursor",3);
            check(FleetCloudReplica.apply(stored,epoch,2L,page,documents,noFiles)==3L,"Correct journal page resumes after rollback");
            try {
                FleetCloudReplica.initialize(stored,"fedcba0987654321fedcba0987654321");
                throw new AssertionError("A different epoch was accepted");
            } catch (IOException expected) { }
            byte[] pdf="%PDF-1.4\nSynthetic invoice\n%%EOF".getBytes(StandardCharsets.UTF_8);
            byte[] photo="Synthetic original Greek photo".getBytes(StandardCharsets.UTF_8);
            String invoiceSha=FleetCloudBaseline.digest(pdf),photoSha=FleetCloudBaseline.digest(photo);
            JSONObject invoice=new JSONObject().put("kind","invoice").put("machineId",legacyMachineId).put("recordId","fixture-invoice")
                    .put("serviceId","fixture-service").put("revision",1).put("cursor",4).put("deleted",false)
                    .put("data",new JSONObject().put("sha256",invoiceSha).put("size",pdf.length).put("sourceSha256",photoSha));
            page.put("changes",new JSONArray().put(invoice)).put("nextCursor",4);
            try {
                FleetCloudReplica.apply(stored,epoch,3L,page,documents,(sha,size,output)->{
                    if (sha.equals(invoiceSha)) output.write(pdf);
                    else output.write(new byte[]{1,2,3});
                });
                throw new AssertionError("An invalid original was accepted");
            } catch (IOException expected) { }
            check(IndependentSqlite.text(stored,"SELECT cursor FROM fleet_cloud_checkpoint").equals("3")&&
                    IndependentSqlite.text(stored,"SELECT count(*) FROM fleet_cloud_replica WHERE kind='invoice'").equals("0"),
                    "An invalid original leaves the invoice and cursor unapplied");
            check(new File(documents,invoiceSha).isFile()&&!new File(documents,photoSha).exists(),
                    "Previously verified bytes remain reusable after a different file fails");
            check(FleetCloudReplica.apply(stored,epoch,3L,page,documents,(sha,size,output)->{
                check(sha.equals(photoSha)&&size==0,"Only the unfinished original is downloaded again");
                output.write(photo);
            })==4L,"Invoice fields and cursor commit after the two files verify");
            check(Arrays.equals(Files.readAllBytes(new File(documents,invoiceSha).toPath()),pdf)&&
                    Arrays.equals(Files.readAllBytes(new File(documents,photoSha).toPath()),photo),
                    "The private Android replica preserves exact PDF and original photograph bytes");
        }
    }
    private static void check(boolean value,String message) {
        if (!value) throw new AssertionError(message);
    }
}
