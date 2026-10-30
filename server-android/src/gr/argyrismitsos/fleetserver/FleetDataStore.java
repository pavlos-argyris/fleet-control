package gr.argyrismitsos.fleetserver;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;
import android.database.sqlite.SQLiteDoneException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class FleetDataStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "fleet-control-server.db";
    private static final int DB_VERSION = 2;
    private static final int MAX_HISTORY = 500;

    public FleetDataStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE bikes (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
        db.execSQL("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE applied_operations (id TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
        db.execSQL("CREATE TABLE system_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
        }
    }

    // A scalar statement uses SQLite's execute-for-string path, not a
    // CursorWindow. Existing JSON cells can therefore exceed window capacity.
    private static String readLargeText(SQLiteDatabase db, String sql, String... args) {
        SQLiteStatement statement = db.compileStatement(sql);
        try {
            for (int i = 0; i < args.length; i++) statement.bindString(i + 1, args[i]);
            return statement.simpleQueryForString();
        } catch (SQLiteDoneException missing) {
            return null;
        } finally {
            statement.close();
        }
    }

    private static JSONObject parseStoredObject(String value, String description) {
        try { return new JSONObject(value); }
        catch (JSONException error) {
            throw new IllegalStateException("Δεν διαβάστηκε " + description + ". Το αποθηκευμένο αντίγραφο διατηρήθηκε.", error);
        }
    }

    private JSONObject readOptionalObject(String sql, String description) {
        String value = readLargeText(getReadableDatabase(), sql);
        return value == null ? new JSONObject() : parseStoredObject(value, description);
    }

    public synchronized JSONObject getFleet() throws JSONException {
        JSONArray bikes = new JSONArray();
        SQLiteDatabase db = getReadableDatabase();
        // Only small identifiers enter the cursor; read each JSON as a scalar.
        Cursor cursor = db.rawQuery("SELECT id FROM bikes ORDER BY id COLLATE NOCASE", null);
        try {
            while (cursor.moveToNext()) {
                JSONObject bike = readBike(db, cursor.getString(0));
                if (bike == null) throw new IllegalStateException("Η καταχώρηση άλλαξε κατά την ανάγνωση. Δοκίμασε ξανά.");
                bikes.put(bike);
            }
        } finally {
            cursor.close();
        }
        return new JSONObject().put("bikes", bikes);
    }

    public synchronized JSONObject getStats() throws JSONException {
        JSONObject fleet = getFleet();
        JSONArray bikes = fleet.getJSONArray("bikes");
        int history = 0;
        for (int i = 0; i < bikes.length(); i++) {
            history += bikes.getJSONObject(i).optJSONArray("history") == null
                    ? 0 : bikes.getJSONObject(i).optJSONArray("history").length();
        }
        JSONObject result = new JSONObject();
        result.put("bikes", bikes.length());
        result.put("historyEntries", history);
        JSONObject system = getSystemExport();
        JSONObject workforce = system.optJSONObject("workforce");
        result.put("users", arrayLength(workforce, "app_users"));
        result.put("schedules", arrayLength(workforce, "schedules"));
        result.put("shifts", arrayLength(workforce, "shifts"));
        result.put("activeShifts", countValue(workforce, "shifts", "status", "active"));
        result.put("openAlerts", countValue(workforce, "system_alerts", "resolved", 0));
        result.put("payrollPeriods", arrayLength(workforce, "payroll_periods"));
        result.put("systemMirrorTime", getSystemUpdatedAt());
        return result;
    }

    private int arrayLength(JSONObject parent, String key) {
        if (parent == null || parent.optJSONArray(key) == null) return 0;
        return parent.optJSONArray(key).length();
    }

    private int countValue(JSONObject parent, String key, String field, Object expected) {
        if (parent == null || parent.optJSONArray(key) == null) return 0;
        JSONArray rows = parent.optJSONArray(key);
        int count = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            Object value = row.opt(field);
            if (expected instanceof Number && value instanceof Number) {
                if (((Number) expected).longValue() == ((Number) value).longValue()) count++;
            } else if (String.valueOf(expected).equals(String.valueOf(value))) {
                count++;
            }
        }
        return count;
    }

    public synchronized JSONObject getCanonicalSnapshot() {
        return readOptionalObject("SELECT value FROM system_state WHERE key='canonical_snapshot'", "το κανονικό στιγμιότυπο");
    }
    public synchronized void setCanonicalSnapshot(JSONObject value) {
        ContentValues data=new ContentValues();data.put("key","canonical_snapshot");data.put("value",value.toString());data.put("updated_at",isoNow());
        getWritableDatabase().insertWithOnConflict("system_state",null,data,SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject getLocalWorkState() {
        return readOptionalObject("SELECT value FROM system_state WHERE key='local_invoice_queue'", "η τοπική ουρά");
    }

    public synchronized JSONObject getOrdexaPayrollState() {
        return readOptionalObject("SELECT value FROM system_state WHERE key='ordexa_payroll_projection_v1'", "το τοπικό αποτέλεσμα μισθοδοσίας");
    }
    public synchronized void setOrdexaPayrollState(JSONObject value) {
        ContentValues data=new ContentValues();data.put("key","ordexa_payroll_projection_v1");data.put("value",value.toString());data.put("updated_at",isoNow());
        if(getWritableDatabase().insertWithOnConflict("system_state",null,data,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new IllegalStateException("Δεν αποθηκεύτηκε το τοπικό αποτέλεσμα μισθοδοσίας.");
    }
    public synchronized void setLocalWorkState(JSONObject value) {
        ContentValues data=new ContentValues();data.put("key","local_invoice_queue");data.put("value",value.toString());data.put("updated_at",isoNow());
        if(getWritableDatabase().insertWithOnConflict("system_state",null,data,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new IllegalStateException("Δεν αποθηκεύτηκε η τοπική ουρά.");
    }

    public synchronized void setSystemExport(JSONObject value) {
        if (value == null) return;
        ContentValues values = new ContentValues();
        values.put("key", "full_export");
        values.put("value", value.toString());
        values.put("updated_at", isoNow());
        getWritableDatabase().insertWithOnConflict("system_state", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject getSystemExport() {
        return readOptionalObject("SELECT value FROM system_state WHERE key='full_export' LIMIT 1", "το αντίγραφο προσωπικού/συστήματος");
    }

    public synchronized JSONObject getDirectSnapshot(String view,int offset,String city,String scope) {
        // Project in SQLite: login never materializes order/import/history JSON
        // in the Java heap. Data and age belong to the same SQLite snapshot.
        List<String> args=new ArrayList<String>();offset=Math.max(0,Math.min(100000,offset));
        String fields="'app_users',json(COALESCE(json_extract(s.value,'$.workforce.app_users'),'[]'))",page="NULL";
        if(view.equals("shifts")||view.equals("schedules")){
            String table=view.equals("shifts")?"ordexa_sessions":"schedules",sort=view.equals("shifts")?"in_at":"start_at";
            String where=view.equals("shifts")?" WHERE json_extract(j.value,'$.city_id')=?":"";
            if(view.equals("shifts"))args.add(city);args.add(String.valueOf(offset));
            fields+=",'"+table+"',json(COALESCE((SELECT json_group_array(json(t.value)) FROM (SELECT j.value FROM json_each(s.value,'$.workforce."+table+"') j"+where+" ORDER BY json_extract(j.value,'$."+sort+"') DESC,j.key DESC LIMIT 50 OFFSET ?) t),'[]'))";
            if(view.equals("shifts")){fields+=",'ordexa_riders',json(COALESCE(json_extract(s.value,'$.workforce.ordexa_riders'),'[]'))";args.add(city);}
            page="json_object('offset',"+offset+",'total',(SELECT COUNT(*) FROM json_each(s.value,'$.workforce."+table+"') j"+where+"))";
        }else if(view.equals("stores")){
            fields+=",'store_billing_records',json(COALESCE((SELECT json_group_array(json(j.value)) FROM json_each(s.value,'$.workforce.store_billing_records') j WHERE json_extract(j.value,'$.scope')=? AND json_extract(j.value,'$.kind') IN ('store','publication','day')),'[]'))";args.add(scope);
        }
        String sql="SELECT json_object('at',s.updated_at,'snapshot',json_object('sourceWorker',json_extract(s.value,'$.sourceWorker'),'workforce',json_object("+fields+"),'directPage',"+page+")) FROM system_state s WHERE s.key='full_export' LIMIT 1";
        String value=readLargeText(getReadableDatabase(),sql,args.toArray(new String[args.size()]));return value==null?new JSONObject():parseStoredObject(value,"το αντίγραφο εφεδρικής πρόσβασης");
    }

    public synchronized JSONObject getDirectFleet() {
        return readOptionalObject("SELECT json_object('bikes',json(COALESCE(json_group_array(json_object('id',id,'name',json_extract(data,'$.name'),'currentKm',json_extract(data,'$.currentKm'),'nextServiceKm',json_extract(data,'$.nextServiceKm'),'lastServiceKm',json_extract(data,'$.lastServiceKm'),'lastCheckedAt',json_extract(data,'$.lastCheckedAt'))),'[]'))) FROM bikes", "τη συνοπτική προβολή στόλου");
    }

    public synchronized String getSystemUpdatedAt() {
        Cursor cursor = getReadableDatabase().rawQuery("SELECT updated_at FROM system_state WHERE key = 'full_export' LIMIT 1", null);
        try {
            return cursor.moveToFirst() ? cursor.getString(0) : "";
        } finally {
            cursor.close();
        }
    }

    public synchronized JSONObject fullBackupPayload() throws JSONException {
        JSONObject stored = getSystemExport();
        JSONObject result = stored.length() == 0 ? new JSONObject() : new JSONObject(stored.toString());
        result.put("schemaVersion", 3);
        result.put("createdAt", isoNow());
        result.put("application", "Fleet Control Server");
        result.put("fleet", getFleet());
        try{result.put("storeBilling",new JSONObject().put("schemaVersion",1).put("cutoffHour",5).put("records",new StoreBillingStore(this).exportRows()));}
        catch(Exception e){throw new JSONException("Δεν ολοκληρώθηκε η ανάγνωση αρχείου καταστημάτων για backup.");}
        if (result.optJSONObject("workforce") == null) result.put("workforce", new JSONObject());
        return result;
    }

    public synchronized boolean wasApplied(String id) {
        Cursor cursor = getReadableDatabase().rawQuery("SELECT 1 FROM applied_operations WHERE id = ? LIMIT 1", new String[]{id});
        try {
            return cursor.moveToFirst();
        } finally {
            cursor.close();
        }
    }

    public synchronized void markApplied(String id) {
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("applied_at", isoNow());
        getWritableDatabase().insertWithOnConflict("applied_operations", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    public synchronized void mergeFleet(JSONObject incoming) throws JSONException {
        JSONArray requested = incoming.optJSONArray("bikes");
        if (requested == null) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; i < requested.length(); i++) {
                JSONObject next = requested.optJSONObject(i);
                if (next == null) continue;
                String id = next.optString("id", "").trim();
                if (id.length() == 0) continue;
                JSONObject current = readBike(db, id);
                JSONObject merged = current == null ? new JSONObject(next.toString()) : mergeBike(current, next);
                ContentValues values = new ContentValues();
                values.put("id", id);
                values.put("data", merged.toString());
                values.put("updated_at", merged.optString("updatedAt", isoNow()));
                db.insertWithOnConflict("bikes", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void replaceBike(JSONObject bike) throws JSONException {
        if (bike == null) return;
        String id = bike.optString("id", "").trim();
        if (id.length() == 0) return;
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("data", new JSONObject(bike.toString()).toString());
        values.put("updated_at", bike.optString("updatedAt", isoNow()));
        getWritableDatabase().insertWithOnConflict("bikes", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Adds a server-rendered invoice to the local canonical mirror before
     * the following server snapshot is sent back to Cloudflare. */
    public synchronized void attachServiceDocument(String bikeId, String entryId, JSONObject attachment) throws JSONException {
        if (bikeId == null || entryId == null || attachment == null) return;
        SQLiteDatabase db = getWritableDatabase();
        JSONObject bike = readBike(db, bikeId);
        if (bike == null) return;
        JSONArray history = bike.optJSONArray("history");
        if (history == null) return;
        for (int i = 0; i < history.length(); i++) {
            JSONObject entry = history.optJSONObject(i);
            if (entry == null || !entryId.equals(entry.optString("id", ""))) continue;
            JSONArray attachments = entry.optJSONArray("attachments");
            if (attachments == null) attachments = new JSONArray();
            JSONArray next = new JSONArray();
            String key = attachment.optString("key", "");
            for (int j = 0; j < attachments.length(); j++) {
                JSONObject item = attachments.optJSONObject(j);
                if (item != null && !key.equals(item.optString("key", "")) && !(attachment.optJSONObject("sourcePhoto")!=null && attachment.getJSONObject("sourcePhoto").optString("key").equals(item.optString("key")))) next.put(item);
            }
            next.put(new JSONObject(attachment.toString()));
            while (next.length() > 10) next.remove(0);
            String now = isoNow();
            entry.put("attachments", next);
            entry.put("updatedAt", now);
            bike.put("updatedAt", now);
            ContentValues values = new ContentValues();
            values.put("id", bikeId);
            values.put("data", bike.toString());
            values.put("updated_at", now);
            db.insertWithOnConflict("bikes", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            return;
        }
    }

    private JSONObject readBike(SQLiteDatabase db, String id) {
        String value = readLargeText(db, "SELECT data FROM bikes WHERE id = ? LIMIT 1", id);
        return value == null ? null : parseStoredObject(value, "το μηχανάκι");
    }

    private JSONObject mergeBike(JSONObject first, JSONObject second) throws JSONException {
        String firstUpdated = first.optString("updatedAt", "");
        String secondUpdated = second.optString("updatedAt", "");
        JSONObject latest = new JSONObject((secondUpdated.compareTo(firstUpdated) >= 0 ? second : first).toString());

        Set<String> deletedHistoryIds = new LinkedHashSet<String>();
        addDeletedHistory(deletedHistoryIds, first.optJSONArray("historyDeletedIds"));
        addDeletedHistory(deletedHistoryIds, second.optJSONArray("historyDeletedIds"));
        Map<String,String> restores = mergeLifecycle(first, second, "historyRestores");
        Map<String,String> deletes = mergeLifecycle(first, second, "historyDeletes");
        for (String id : restores.keySet()) if (!HistoryMergePolicy.deleted(id,restores,deletes)) deletedHistoryIds.remove(id);
        latest.put("historyRestores", lifecycleArray(restores));
        latest.put("historyDeletes", lifecycleArray(deletes));
        latest.put("serviceAppointments", mergeAppointments(first.optJSONArray("serviceAppointments"), second.optJSONArray("serviceAppointments")));
        latest.put("nextServiceNotes", NextServiceNotes.merge(first.optJSONArray("nextServiceNotes"), second.optJSONArray("nextServiceNotes")));
        Map<String, JSONObject> historyMap = new LinkedHashMap<String, JSONObject>();
        addHistory(historyMap, first.optJSONArray("history"));
        addHistory(historyMap, second.optJSONArray("history"));
        List<JSONObject> history = new ArrayList<JSONObject>(historyMap.values());
        Collections.sort(history, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject left, JSONObject right) {
                String a = left.optString("date", "") + "|" + left.optString("id", "");
                String b = right.optString("date", "") + "|" + right.optString("id", "");
                return b.compareTo(a);
            }
        });

        JSONArray mergedHistory = new JSONArray();
        long serviceKm = 0;
        long historyKm = 0;
        String lastCheckedAt = "";
        for (int i = 0; i < history.size() && i < MAX_HISTORY; i++) {
            JSONObject entry = history.get(i);
            if (deletedHistoryIds.contains(entry.optString("id", ""))) continue;
            mergedHistory.put(entry);
            historyKm = Math.max(historyKm, entry.optLong("km", 0));
            if ("service".equals(entry.optString("type")) && entry.optBoolean("oilChanged", false)) {
                serviceKm = Math.max(serviceKm, entry.optLong("km", 0));
            }
            if ("check".equals(entry.optString("type"))) {
                lastCheckedAt = max(lastCheckedAt, entry.optString("date", ""));
            }
        }

        String historyCorrectedAt = max(first.optString("historyCorrectedAt", ""), second.optString("historyCorrectedAt", ""));
        long odometerFloor = Math.max(first.optLong("odometerFloorKm", 0), second.optLong("odometerFloorKm", 0));
        long lastService = historyCorrectedAt.length() > 0
                ? serviceKm
                : Math.max(Math.max(first.optLong("lastServiceKm", 0), second.optLong("lastServiceKm", 0)), serviceKm);
        long current = historyCorrectedAt.length() > 0
                ? Math.max(Math.max(historyKm, lastService), odometerFloor)
                : Math.max(Math.max(first.optLong("currentKm", 0), second.optLong("currentKm", 0)), lastService);
        long interval = Math.max(1, latest.optLong("intervalKm", 1));
        latest.put("lastServiceKm", lastService);
        latest.put("currentKm", current);
        latest.put("nextServiceKm", lastService + interval);
        latest.put("lastCheckedAt", historyCorrectedAt.length() > 0
                ? lastCheckedAt
                : max(first.optString("lastCheckedAt", ""), second.optString("lastCheckedAt", "")));
        latest.put("createdAt", minNonEmpty(first.optString("createdAt", ""), second.optString("createdAt", "")));
        latest.put("updatedAt", max(firstUpdated, secondUpdated));
        latest.put("history", mergedHistory);
        JSONArray deleted = new JSONArray();
        int deletedCount = 0;
        for (String id : deletedHistoryIds) {
            if (deletedCount++ >= MAX_HISTORY) break;
            deleted.put(id);
        }
        latest.put("historyDeletedIds", deleted);
        latest.put("historyCorrectedAt", historyCorrectedAt);
        latest.put("odometerFloorKm", odometerFloor);
        return latest;
    }

    private static Map<String,String> mergeLifecycle(JSONObject first, JSONObject second, String field) {
        Map<String,String> result = new LinkedHashMap<String,String>();
        JSONObject[] sources = new JSONObject[]{first,second};
        for(JSONObject source:sources){JSONArray rows=source.optJSONArray(field);if(rows==null)continue;for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null)continue;String id=row.optString("id",""),at=row.optString("at","");if(id.length()==0||at.length()==0)continue;if(!result.containsKey(id)||result.get(id).compareTo(at)<0)result.put(id,at);}}
        return result;
    }
    private static JSONArray lifecycleArray(final Map<String,String> source) throws JSONException {
        List<String> keys=new ArrayList<String>(source.keySet());Collections.sort(keys,new Comparator<String>(){public int compare(String a,String b){return source.get(b).compareTo(source.get(a));}});JSONArray result=new JSONArray();int count=0;for(String id:keys){if(count++>=MAX_HISTORY)break;result.put(new JSONObject().put("id",id).put("at",source.get(id)));}return result;
    }
    private static JSONArray mergeAppointments(JSONArray first, JSONArray second) throws JSONException {
        Map<String,JSONObject> map=new LinkedHashMap<String,JSONObject>();
        for(JSONArray rows:new JSONArray[]{first,second}){if(rows==null)continue;for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null)continue;String id=row.optString("id","");JSONObject old=map.get(id);if(id.length()>0&&(old==null||row.optString("updatedAt","").compareTo(old.optString("updatedAt",""))>=0))map.put(id,row);}}
        List<JSONObject> sorted=new ArrayList<JSONObject>(map.values());Collections.sort(sorted,new Comparator<JSONObject>(){public int compare(JSONObject a,JSONObject b){return b.optString("updatedAt","").compareTo(a.optString("updatedAt",""));}});
        JSONArray result=new JSONArray();for(int i=0;i<sorted.size()&&i<200;i++)result.put(sorted.get(i));return result;
    }

    private static JSONArray preservePhotoBundles(JSONArray incoming,JSONArray previous) throws JSONException {
        JSONArray out=new JSONArray();java.util.Set<String> photoKeys=new java.util.HashSet<String>();
        if(incoming==null)return out;
        for(int i=0;i<incoming.length();i++){
            JSONObject file=incoming.optJSONObject(i);if(file==null)continue;file=new JSONObject(file.toString());
            if(previous!=null)for(int j=0;j<previous.length();j++){
                JSONObject old=previous.optJSONObject(j);if(old==null)continue;JSONObject photo=old.optJSONObject("sourcePhoto");
                if(photo!=null&&photo.optString("key").equals(file.optString("key"))){file=new JSONObject(old.toString());break;}
                if(old.optString("key").equals(file.optString("key"))&&file.optJSONObject("sourcePhoto")==null&&photo!=null)file.put("sourcePhoto",new JSONObject(photo.toString()));
            }
            JSONObject photo=file.optJSONObject("sourcePhoto");if(photo!=null)photoKeys.add(photo.optString("key"));out.put(file);
        }
        JSONArray result=new JSONArray();java.util.Set<String> seen=new java.util.HashSet<String>();
        for(int i=0;i<out.length();i++){JSONObject file=out.getJSONObject(i);String key=file.optString("key");if(!photoKeys.contains(key)&&seen.add(key))result.put(file);}return result;
    }

    private void addHistory(Map<String, JSONObject> map, JSONArray items) {
        if (items == null) return;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id", "").trim();
            if (id.length() == 0) continue;
            JSONObject current = map.get(id);
            if (current == null || historyStamp(item).compareTo(historyStamp(current)) >= 0) {
                if(current!=null&&item.optString("appointmentId","").length()==0&&current.optString("appointmentId","").length()>0){try{item.put("appointmentId",current.optString("appointmentId",""));}catch(JSONException ignored){}}
                if(current!=null){try{item.put("attachments",preservePhotoBundles(item.optJSONArray("attachments"),current.optJSONArray("attachments")));}catch(JSONException ignored){}}
                map.put(id,item);
            }
        }
    }

    private void addDeletedHistory(Set<String> target, JSONArray items) {
        if (items == null) return;
        for (int i = 0; i < items.length() && target.size() < MAX_HISTORY; i++) {
            String id = items.optString(i, "").trim();
            if (id.length() > 0) target.add(id);
        }
    }

    private String historyStamp(JSONObject entry) {
        String updated = entry.optString("updatedAt", "");
        if (updated.length() > 0) return updated;
        String created = entry.optString("createdAt", "");
        if (created.length() > 0) return created;
        return entry.optString("date", "") + "T00:00:00.000Z";
    }

    private String max(String first, String second) {
        return first.compareTo(second) >= 0 ? first : second;
    }

    private String minNonEmpty(String first, String second) {
        if (first.length() == 0) return second;
        if (second.length() == 0) return first;
        return first.compareTo(second) <= 0 ? first : second;
    }

    public synchronized String getSetting(String key, String fallback) {
        String value = readLargeText(getReadableDatabase(), "SELECT value FROM settings WHERE key = ? LIMIT 1", key);
        return value == null ? fallback : value;
    }

    public synchronized void setSetting(String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value == null ? "" : value);
        getWritableDatabase().insertWithOnConflict("settings", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static String isoNow() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }
}
