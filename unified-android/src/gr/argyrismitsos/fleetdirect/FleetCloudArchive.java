package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.database.Cursor;
import org.sqlite.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Project the Fleet domain from a verified private SQLite backup. */
final class FleetCloudArchive {
    private static final Set<String> MACHINE_FIELDS=new HashSet<>(Arrays.asList(
            "id","name","intervalKm","lastServiceKm","currentKm","nextServiceKm","lastCheckedAt","createdAt","updatedAt",
            "maintenancePlans","serviceAppointments","nextServiceNotes","historyRestores","historyDeletes","historyDeletedIds",
            "historyCorrectedAt","odometerFloorKm","hasMajorService","lastMajorServiceKm","lastMajorServiceMilestoneKm",
            "pendingMajorServiceKm","nextMajorServiceKm","majorServiceTargetKm","brand","model","notes","availability"));
    private static final Set<String> HISTORY_FIELDS=new HashSet<>(Arrays.asList(
            "id","type","km","date","notes","tasks","workshop","cost","serviceCost","oilChanged","majorService",
            "majorServiceMilestoneKm","reviewJournal","invoiceExpectation","kmAcknowledgments","attachments",
            "invoiceData","appointmentId","createdAt","updatedAt"));

    private FleetCloudArchive() { }

    static long stage(Context context,String backupId,String sourceSha,String generation,String epoch,boolean sourceDeltas,
                      FleetCloudBaseline.Transport transport) throws Exception {
        if (!ScopedContext.owns(context)||!backupId.matches("[a-f0-9-]{36}")||!generation.matches("[a-f0-9-]{36}")) {
            throw invalidSource();
        }
        JSONObject job=BackupJobs.load(context,backupId);
        JSONObject proof=job.getJSONObject("nativeProof");
        if (!"fleet-cloud-baseline".equals(job.optString("kind"))||!job.optBoolean("localOnly")||
                !proof.optBoolean("restoreVerified")||!proof.optBoolean("documentsVerified")||
                !sourceSha.equals(proof.optString("databaseSha256"))||!BackupJobs.localReady(context,job)) {
            throw invalidSource();
        }

        File workspace=new File(context.getCacheDir(),"fleet-cloud-transfer");
        cleanup(workspace);
        if (!workspace.mkdir()) throw invalidSource();
        File records=new File(workspace,"records.ndjson");
        try (NativeBackupReader.Prepared backup=open(context,job,generation,sourceSha,workspace);
             ZipFile documents=backup.documents==null?null:new ZipFile(backup.documents)) {
            List<FleetCloudBaseline.Document> files;
            long sourceCursor;
            try (SQLiteDatabase source=SQLiteDatabase.openDatabase(backup.database.getPath(),null,SQLiteDatabase.OPEN_READONLY);
                 OutputStream output=new BufferedOutputStream(new FileOutputStream(records))) {
                sourceCursor=FleetCloudSourceJournal.checkpoint(source,epoch,generation);
                Set<String> keys=project(source,output,generation);
                files=documents(backup.manifest,documents,output,keys);
            }
            if (sourceDeltas&&sourceCursor<0) throw invalidSource();
            FleetCloudBaseline.stage(epoch,sourceSha,sourceDeltas?sourceCursor:-1,records,files,transport);
            if (sourceDeltas) FleetCloudCatchUp.seed(context.getNoBackupFilesDir(),epoch,sourceSha,sourceCursor,records);
            return sourceCursor;
        } finally {
            cleanup(workspace);
        }
    }

    private static void cleanup(File directory) throws IOException {
        if (!directory.exists()) return;
        if (directory.isDirectory()&&!java.nio.file.Files.isSymbolicLink(directory.toPath())) {
            File[] children=directory.listFiles();
            if (children==null) throw invalidSource();
            for (File child:children) cleanup(child);
        }
        if (!directory.delete()&&directory.exists()) throw new IOException("Δεν καθαρίστηκε ο προσωρινός χώρος μεταφοράς Fleet.");
    }

    private static NativeBackupReader.Prepared open(Context context,JSONObject job,String generation,String sourceSha,File workspace) throws Exception {
        File manifest=new File(workspace,"manifest.json");
        try (BackupEnvelope envelope=BackupEnvelope.open(context)) {
            try (PushbackInputStream input=new PushbackInputStream(backupPart(context,job,"data"),5)) {
                byte[] magic=new byte[5];
                for (int i=0;i<magic.length;i++) {
                    int next=input.read();
                    if (next<0) throw invalidSource();
                    magic[i]=(byte)next;
                }
                if (!"FCB3\n".equals(new String(magic,StandardCharsets.US_ASCII))) throw invalidSource();
                input.unread(magic);
                envelope.decrypt(input,manifest,"data",null);
            }
            JSONObject root=ServiceDocumentArchive.readJson(manifest);
            root.put("_portableAuthenticated",true);
            if (!sourceSha.equals(root.getJSONObject("nativeDatabase").getString("sha256"))||
                    !generation.equals(root.getJSONObject("nativeRecovery").getString("sourceGeneration"))) throw invalidSource();
            return NativeBackupReader.open(root,workspace,kind->backupPart(context,job,kind),
                    (input,destination,kind)->envelope.decrypt(input,destination,kind,null));
        } finally { manifest.delete(); }
    }

    private static InputStream backupPart(Context context,JSONObject job,String kind) throws Exception {
        String field="documents".equals(kind)?"docsPath":kind+"Path";
        String name=job.getString(field);
        if (!name.matches("[a-zA-Z0-9_.-]+")||name.contains("..")) throw invalidSource();
        return new FileInputStream(new File(new File(context.getFilesDir(),"safe-backups"),name));
    }

    static Set<String> project(SQLiteDatabase source,OutputStream output,String generation) throws Exception {
        return project(source,generation,row->emit(output,row));
    }

    interface RecordSink { void write(JSONObject row) throws Exception; }

    static Set<String> project(SQLiteDatabase source,String generation,RecordSink records) throws Exception {
        Set<String> referenced=new HashSet<>();
        try (Cursor row=source.rawQuery("SELECT version,updated_at FROM fleet_snapshot WHERE id=1 AND json_type(data,'$.bikes')='array'",null)) {
            if (!row.moveToFirst()) throw invalidSource();
            records.write(new JSONObject().put("kind","snapshot").put("version",row.getLong(0)).put("updatedAt",row.getString(1)));
        }
        exportRows(source,"SELECT json_extract(b.value,'$.id') bike_id,json_remove(b.value,'$.history') payload "+
                "FROM fleet_snapshot s,json_each(s.data,'$.bikes') b WHERE s.id=1 ORDER BY bike_id",(row)->{
            JSONObject bike=machine(new JSONObject(row.getString(1)),generation);
            records.write(record("machine",identifier(row.getString(0)),null,bike));
        });
        exportRows(source,"SELECT bike_id,name,odometer,status,version,updated_at FROM vehicle_registry ORDER BY bike_id",(row)->{
            JSONObject registry=new JSONObject().put("name",row.getString(1)).put("odometer",row.getLong(2))
                    .put("status",row.getString(3)).put("version",row.getLong(4)).put("updatedAt",row.getString(5));
            records.write(record("machine-registry",row.getString(0),null,registry));
        });
        exportRows(source,"SELECT json_extract(b.value,'$.id') bike_id,h.value payload "+
                "FROM fleet_snapshot s,json_each(s.data,'$.bikes') b,json_each(b.value,'$.history') h "+
                "WHERE s.id=1 ORDER BY bike_id,h.key",(row)->{
            JSONObject history=history(new JSONObject(row.getString(1)),generation,referenced);
            records.write(record("history",identifier(row.getString(0)),history.getString("id"),history));
        });
        exportRows(source,"SELECT bike_id,json_remove(snapshot_json,'$.history'),name,odometer,original_status,active,"+
                "archived_at,reason,restored_at,restore_reason FROM vehicle_archives ORDER BY bike_id",(row)->{
            JSONObject archive=new JSONObject().put("machine",machine(new JSONObject(row.getString(1)),generation))
                    .put("name",row.getString(2)).put("odometer",row.getLong(3)).put("status",row.getString(4))
                    .put("active",row.getInt(5)!=0).put("archivedAt",row.getString(6)).put("reason",row.getString(7))
                    .put("restoredAt",row.getString(8)).put("restoreReason",row.getString(9));
            records.write(record("machine-archive",row.getString(0),null,archive));
        });
        exportRows(source,"SELECT a.bike_id,h.value FROM vehicle_archives a,json_each(a.snapshot_json,'$.history') h "+
                "ORDER BY a.bike_id,h.key",(row)->{
            JSONObject history=history(new JSONObject(row.getString(1)),generation,referenced);
            records.write(record("archived-history",row.getString(0),history.getString("id"),history));
        });
        exportRows(source,"SELECT id,payload,record_id,label,reason,deleted_at,restored_at,restore_reason "+
                "FROM deleted_records WHERE record_type='fleet_history' ORDER BY id",(row)->{
            JSONObject trash=new JSONObject(row.getString(1));
            JSONObject entry=history(trash.getJSONObject("entry"),generation,referenced);
            JSONObject restored=new JSONObject().put("entry",entry).put("recordId",historyId(row.getString(2),generation))
                    .put("label",row.getString(3)).put("reason",row.getString(4)).put("deletedAt",row.getString(5))
                    .put("restoredAt",row.getString(6)).put("restoreReason",row.getString(7));
            records.write(record("history-trash",identifier(trash.get("bikeId")),row.getString(0),restored));
        });
        exportRows(source,"SELECT id,type,payload,status,created_at FROM fleet_operations "+
                "WHERE type IN ('service_document_render','service_document_reprocess_batch') AND status IN ('pending','error') ORDER BY id",(row)->{
            JSONObject payload=new JSONObject(row.getString(2));
            JSONObject pending=new JSONObject().put("type",row.getString(1)).put("status",row.getString(3)).put("createdAt",row.getString(4))
                    .put("input",payload);
            records.write(record("invoice-job",null,row.getString(0),pending));
        });
        exportRows(source,"SELECT id,status,data,created_at,updated_at FROM invoice_import_drafts "+
                "WHERE status IN ('processing','ready','committing','error') ORDER BY id",(row)->{
            JSONObject draft=new JSONObject().put("status",row.getString(1)).put("draft",new JSONObject(row.getString(2)))
                    .put("createdAt",row.getString(3)).put("updatedAt",row.getString(4));
            records.write(record("invoice-draft",null,row.getString(0),draft));
        });
        return referenced;
    }

    private interface RowSink { void accept(Cursor row) throws Exception; }

    private static void exportRows(SQLiteDatabase source,String sql,RowSink sink) throws Exception {
        try (Cursor row=source.rawQuery(sql,null)) {
            while (row.moveToNext()) {
                if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException();
                sink.accept(row);
            }
        }
    }

    private static JSONObject record(String kind,String machineId,String recordId,JSONObject payload) throws Exception {
        JSONObject result=new JSONObject().put("kind",kind).put("data",payload);
        if (machineId!=null) result.put("machineId",identifier(machineId));
        if (recordId!=null) result.put("recordId",recordId);
        return result;
    }

    private static JSONObject machine(JSONObject value,String generation) throws Exception {
        Iterator<String> fields=value.keys();
        while (fields.hasNext()) if (!MACHINE_FIELDS.contains(fields.next())) throw invalidSource();
        JSONArray ids=value.optJSONArray("historyDeletedIds");
        if (ids!=null) {
            JSONArray projected=new JSONArray();
            for (int i=0;i<ids.length();i++) projected.put(historyId(identifier(ids.get(i)),generation));
            value.put("historyDeletedIds",projected);
        }
        for (String field:new String[]{"historyDeletes","historyRestores"}) {
            JSONArray values=value.optJSONArray(field);
            if (values==null) continue;
            for (int i=0;i<values.length();i++) {
                JSONObject event=values.getJSONObject(i);
                event.put("id",historyId(identifier(event.get("id")),generation));
            }
        }
        return value;
    }

    private static JSONObject history(JSONObject value,String generation,Set<String> references) throws Exception {
        String id=identifier(value.get("id")),type=value.optString("type");
        if (!"service".equals(type)&&!"check".equals(type)) throw invalidSource();
        if (id.startsWith("shift-")) {
            if (!"check".equals(type)) throw invalidSource();
            JSONObject mileage=new JSONObject().put("id",historyId(id,generation)).put("type",type);
            for (String key:new String[]{"km","date","createdAt","updatedAt"}) if (value.has(key)) mileage.put(key,value.get(key));
            return mileage;
        }
        Iterator<String> fields=value.keys();
        while (fields.hasNext()) if (!HISTORY_FIELDS.contains(fields.next())) throw invalidSource();
        JSONArray attachments=value.optJSONArray("attachments");
        if (attachments!=null) for (int i=0;i<attachments.length();i++) {
            JSONObject file=attachments.getJSONObject(i);
            references.add(file.getString("key"));
            JSONObject original=file.optJSONObject("sourcePhoto");
            if (original!=null) references.add(original.getString("key"));
        }
        value.put("id",id);
        return value;
    }

    private static String identifier(Object value) throws IOException {
        if (!(value instanceof String)&&!(value instanceof Integer)&&!(value instanceof Long)) throw invalidSource();
        String id=String.valueOf(value);
        if (id.isEmpty()||id.length()>160||!id.equals(id.trim())) throw invalidSource();
        return id;
    }

    private static String historyId(String id,String generation) throws Exception {
        return id.startsWith("shift-")?"check:"+FleetCloudBaseline.digest((generation+":"+id).getBytes(StandardCharsets.UTF_8)):id;
    }

    private static List<FleetCloudBaseline.Document> documents(JSONObject manifest,ZipFile zip,OutputStream output,
                                                                Set<String> referenced) throws Exception {
        List<FleetCloudBaseline.Document> files=new ArrayList<>();
        JSONArray listed=manifest.getJSONArray("objects");
        Map<String,String> names=zip==null?new HashMap<>():archiveNames(zip);
        Set<String> keys=new HashSet<>();
        for (int i=0;i<listed.length();i++) {
            JSONObject object=listed.getJSONObject(i);
            String key=object.getString("key");
            if (!key.startsWith("service-documents/")) continue;
            if (!keys.add(key)) throw invalidSource();
            String name=names.get(key);
            ZipEntry entry=zip==null||name==null?null:zip.getEntry(name);
            long size=object.getLong("size");
            if (entry==null||entry.isDirectory()||entry.getSize()!=size) throw invalidSource();
            String sha=object.getString("sha256"),type=object.getString("content_type");
            files.add(new FleetCloudBaseline.Document(sha,type,size,()->zip.getInputStream(entry)));
            emit(output,document(key,object.getString("name"),type,size,sha));
        }
        if (!keys.containsAll(referenced)) throw invalidSource();
        return files;
    }

    static JSONObject document(String key,String name,String type,long size,String sha) throws Exception {
        return record("document",null,key,new JSONObject().put("name",name).put("contentType",type).put("size",size).put("sha256",sha));
    }

    private static Map<String,String> archiveNames(ZipFile zip) throws Exception {
        ZipEntry index=zip.getEntry("fleet-control-documents.json");
        if (index==null) throw invalidSource();
        byte[] buffer=new byte[8192];
        ByteArrayOutputStream data=new ByteArrayOutputStream();
        try (InputStream input=zip.getInputStream(index)) {
            for (int count;(count=input.read(buffer))!=-1;) {
                if (data.size()+count>16*1024*1024) throw invalidSource();
                data.write(buffer,0,count);
            }
        }
        JSONArray catalogue=new JSONArray(new String(data.toByteArray(),StandardCharsets.UTF_8));
        Map<String,String> entries=new HashMap<>();
        for (int i=0;i<catalogue.length();i++) {
            JSONObject object=catalogue.getJSONObject(i);
            if (entries.put(object.getString("key"),object.getString("zipName"))!=null) throw invalidSource();
        }
        return entries;
    }

    private static void emit(OutputStream output,JSONObject value) throws IOException {
        output.write(value.toString().getBytes(StandardCharsets.UTF_8));
        output.write('\n');
    }

    private static IOException invalidSource() {
        return new IOException("Δεν επιβεβαιώθηκε η ιδιωτική πηγή της δοκιμαστικής μεταφοράς Fleet.");
    }
}
