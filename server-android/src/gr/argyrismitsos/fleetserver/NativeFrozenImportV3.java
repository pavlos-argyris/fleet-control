package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Set;

/**
 * Transactional, non-authoritative SQLite staging for a Worker frozen D1 export.
 * It NEVER switches primary authority, updates business tables or accepts writes.
 * The existing writer fence and a separately verified recovery/activation protocol
 * are mandatory before a staged candidate can become an authoritative database.
 */
public final class NativeFrozenImportV3 {
    public interface PageReader {
        JSONObject read(String table, long after, int limit) throws Exception;
    }
    public interface Progress {
        void update(String table, long imported, long expected) throws Exception;
    }
    private static final String PREFIX = "server_primary_frozen_v3_";
    private static final String META = "server_primary_frozen_v3_meta";
    private static final int PAGE_LIMIT = 10;
    private static final long MAX_SAFE = 9007199254740991L;
    private NativeFrozenImportV3() {}
    static String candidateName(String original)throws IOException{return PREFIX+name(original);}
    static String metadataTable(){return META;}


    private static IOException invalid(String what) {
        return new IOException("Frozen SQLite v3 import rejected: " + what);
    }
    private static String name(String raw) throws IOException {
        if (raw == null || !raw.matches("[A-Za-z_][A-Za-z0-9_]{0,90}")
            || raw.equalsIgnoreCase("rowid") || raw.equalsIgnoreCase("_rowid_")
            || raw.equalsIgnoreCase("oid") || raw.equalsIgnoreCase("_fleet_source_rowid"))
            throw invalid("unsafe SQL identifier");
        return raw;
    }
    private static String quote(String name) { return "\"" + name + "\""; }
    private static long safe(Object value, String field) throws IOException {
        if (!(value instanceof Number) || value instanceof Double || value instanceof Float)
            throw invalid(field);
        try {
            long n = Long.parseLong(value.toString());
            if (n < 0 || n > MAX_SAFE) throw invalid(field);
            return n;
        } catch (NumberFormatException e) { throw invalid(field); }
    }
    private static String required(JSONObject json, String field) throws IOException {
        Object value = json.opt(field);
        if (!(value instanceof String) || ((String)value).isEmpty()) throw invalid(field);
        return (String)value;
    }
    private static void checkVersion(JSONObject json) throws IOException {
        if (safe(json.opt("schemaVersion"), "schemaVersion") != 3) throw invalid("schemaVersion");
    }
    private static void progress(Progress callback, String table, long imported, long expected) throws Exception {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Frozen import cancelled");
        if (callback != null) callback.update(table, imported, expected);
    }
    private static String sha256(String data) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(data.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte b : bytes) {
            hex.append(Character.forDigit((b >>> 4) & 15, 16));
            hex.append(Character.forDigit(b & 15, 16));
        }
        return hex.toString();
    }
    private static long scalar(SQLiteDatabase db, String sql, String[] args) {
        Cursor cursor = db.rawQuery(sql, args);
        try { return cursor.moveToFirst() ? cursor.getLong(0) : -1; }
        finally { cursor.close(); }
    }
    private static String text(SQLiteDatabase db, String sql, String[] args) {
        Cursor cursor = db.rawQuery(sql, args);
        try { return cursor.moveToFirst() ? cursor.getString(0) : ""; }
        finally { cursor.close(); }
    }
    private static String storageClass(Object value) {
        if (value == null) return "null";
        if (value instanceof byte[]) return "blob";
        if (value instanceof String) return "text";
        if (value instanceof Double) return "real";
        if (value instanceof Long) return "integer";
        throw new IllegalArgumentException("Unsupported frozen SQLite type");
    }
    private static void checkStoredTypes(SQLiteDatabase db, String table, long rowid,
                                         LinkedHashMap<String,Object> values) throws IOException {
        String[] args = {Long.toString(rowid)};
        for (java.util.Map.Entry<String,Object> entry : values.entrySet()) {
            String actual = text(db, "SELECT typeof(" + quote(entry.getKey()) + ") FROM "
                + quote(table) + " WHERE _fleet_source_rowid=?", args);
            if (!storageClass(entry.getValue()).equals(actual))
                throw invalid("SQLite storage-class conversion: " + table + "." + entry.getKey());
            Object expected = entry.getValue();
            if (expected instanceof Long) {
                String stored = text(db, "SELECT CAST(" + quote(entry.getKey())
                    + " AS TEXT) FROM " + quote(table) + " WHERE _fleet_source_rowid=?", args);
                if (!expected.toString().equals(stored))
                    throw invalid("SQLite INTEGER changed: " + table + "." + entry.getKey());
            } else if (expected instanceof Double) {
                String stored = text(db, "SELECT printf('%!.17g'," + quote(entry.getKey())
                    + ") FROM " + quote(table) + " WHERE _fleet_source_rowid=?", args);
                double value;
                try { value = Double.parseDouble(stored); }
                catch (NumberFormatException e) { throw invalid("SQLite REAL changed"); }
                if (Double.doubleToLongBits((Double)expected) != Double.doubleToLongBits(value))
                    throw invalid("SQLite REAL bits changed: " + table + "." + entry.getKey());
            } else if (expected instanceof String || expected instanceof byte[]) {
                byte[] bytes = expected instanceof String
                    ? ((String)expected).getBytes(StandardCharsets.UTF_8) : (byte[])expected;
                long length = scalar(db, "SELECT length(CAST(" + quote(entry.getKey())
                    + " AS BLOB)) FROM " + quote(table) + " WHERE _fleet_source_rowid=?", args);
                if (length != bytes.length)
                    throw invalid("SQLite cell byte length: " + table + "." + entry.getKey());
                for (int offset = 0; offset < bytes.length; offset += 32768) {
                    if (Thread.currentThread().isInterrupted())
                        throw new InterruptedIOException("Frozen import cancelled");
                    int count = Math.min(32768, bytes.length - offset);
                    String hex = text(db, "SELECT hex(substr(CAST(" + quote(entry.getKey())
                        + " AS BLOB),?,?)) FROM " + quote(table)
                        + " WHERE _fleet_source_rowid=?",
                        new String[]{Integer.toString(offset + 1), Integer.toString(count), args[0]});
                    if (hex.length() != count * 2) throw invalid("SQLite cell chunk length");
                    for (int i = 0; i < count; i++) {
                        int a = Character.digit(hex.charAt(i * 2), 16);
                        int b = Character.digit(hex.charAt(i * 2 + 1), 16);
                        if (a < 0 || b < 0 || (byte)((a << 4) | b) != bytes[offset + i])
                            throw invalid("SQLite cell bytes changed: " + table + "." + entry.getKey());
                    }
                }
            }
        }
    }
    /**
     * All staging DDL, decoded rows, checks and candidate metadata commit atomically.
     * A failure, interruption, duplicate row, missing page or changed generation
     * rolls back the entire attempt and preserves the preceding candidate.
     *
     * Inventory must come from the fenced Worker /api/primary/inventory endpoint.
     * This function does not itself authenticate a Worker or activate authority.
     */
    public static JSONObject stage(SQLiteDatabase db, JSONObject inventory,
                                   PageReader pages, NativeFrozenExportV3.CellReader cells,
                                   Progress callback) throws Exception {
        if (db == null || inventory == null || pages == null) throw invalid("missing input");
        checkVersion(inventory);
        String generation = required(inventory, "generation");
        if (generation.length() > 128) throw invalid("generation length");
        JSONArray tables = inventory.optJSONArray("tables");
        if (tables == null || tables.length() == 0 || tables.length() > 256)
            throw invalid("table inventory");
        Set<String> names = new HashSet<>();
        long totalExpected = 0;
        // Preflight every table/column before the first SQLite mutation.
        for (int t = 0; t < tables.length(); t++) {
            JSONObject table = tables.optJSONObject(t);
            if (table == null) throw invalid("table definition");
            String tableName = name(required(table, "name"));
            if (!names.add(tableName.toLowerCase(Locale.ROOT))) throw invalid("duplicate table");
            long expected = safe(table.opt("rows"), "table count");
            long last = safe(table.opt("lastRow"), "last rowid");
            if ((expected == 0) != (last == 0) || expected > last || totalExpected > MAX_SAFE - expected)
                throw invalid("table count/lastRow");
            totalExpected += expected;
            JSONArray columns = table.optJSONArray("columns");
            if (columns == null || columns.length() == 0 || columns.length() > 256)
                throw invalid("column inventory");
            Set<String> columnNames = new HashSet<>();
            for (int i = 0; i < columns.length(); i++) {
                JSONObject definition = columns.optJSONObject(i);
                if (definition == null) throw invalid("column definition");
                String column = name(required(definition, "name"));
                if (!columnNames.add(column.toLowerCase(Locale.ROOT)))
                    throw invalid("duplicate column");
            }
        }
        synchronized (db) {
            db.beginTransaction();
            try {
                db.execSQL("CREATE TABLE IF NOT EXISTS " + META
                    + "(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,"
                    + "inventory_sha256 TEXT NOT NULL,rows_count INTEGER NOT NULL,"
                    + "tables_count INTEGER NOT NULL,staged_at INTEGER NOT NULL,"
                    + "business_writes_enabled INTEGER NOT NULL DEFAULT 0 CHECK(business_writes_enabled=0))");
                if(scalar(db,"SELECT COUNT(*) FROM pragma_table_info('"+META+"') WHERE name='content_sha256'",null)==0)db.execSQL("ALTER TABLE "+META+" ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT ''");
                MessageDigest content=NativeFrozenDigest.start();
                long total = 0;
                for (int t = 0; t < tables.length(); t++) {
                    JSONObject definition = tables.getJSONObject(t);
                    String original = name(required(definition, "name"));
                    String target = PREFIX + original;
                    JSONArray columns = definition.getJSONArray("columns");
                    long expected = safe(definition.opt("rows"), "table count");
                    long lastRow = safe(definition.opt("lastRow"), "last rowid");
                    db.execSQL("DROP TABLE IF EXISTS " + quote(target));
                    StringBuilder ddl = new StringBuilder("CREATE TABLE ").append(quote(target))
                        .append("(_fleet_source_rowid INTEGER PRIMARY KEY");
                    StringBuilder insert = new StringBuilder("INSERT INTO ").append(quote(target))
                        .append("(_fleet_source_rowid");
                    StringBuilder binds = new StringBuilder(" VALUES (?");
                    for (int i = 0; i < columns.length(); i++) {
                        String column = name(required(columns.getJSONObject(i), "name"));
                        // No affinity in this isolated candidate: SQLite must not
                        // silently coerce source REAL 1.0 to INTEGER or BLOB to TEXT.
                        ddl.append(",").append(quote(column));
                        insert.append(",").append(quote(column));
                        binds.append(",?");
                    }
                    db.execSQL(ddl.append(")").toString());
                    String sql = insert.append(")").append(binds).append(")").toString();
                    long after = 0, count = 0;
                    for (;;) {
                        progress(callback, original, count, expected);
                        JSONObject page = pages.read(original, after, PAGE_LIMIT);
                        if (page == null) throw invalid("missing page");
                        checkVersion(page);
                        if (!generation.equals(required(page, "generation"))
                            || !original.equals(required(page, "table"))) throw invalid("page identity");
                        JSONArray rows = page.optJSONArray("rows");
                        if (rows == null || rows.length() > PAGE_LIMIT
                            || !(page.opt("hasMore") instanceof Boolean))
                            throw invalid("page shape");
                        boolean more = page.getBoolean("hasMore");
                        if (more && rows.length() == 0) throw invalid("empty continuation");
                        for (int r = 0; r < rows.length(); r++) {
                            JSONObject row = rows.optJSONObject(r);
                            if (row == null) throw invalid("row");
                            long rowid = safe(row.opt("_primaryRowid"), "rowid");
                            if (rowid <= after || rowid > lastRow || count >= expected)
                                throw invalid("row order/extent");
                            LinkedHashMap<String,Object> decoded =
                                NativeFrozenExportV3.decode(inventory, definition, page, row, cells);
                            Object[] args = new Object[decoded.size() + 1];
                            args[0] = rowid;
                            int index = 1;
                            for (Object value : decoded.values()) args[index++] = value;
                            db.execSQL(sql, args);
                            checkStoredTypes(db, target, rowid, decoded);
                            NativeFrozenDigest.row(content,original,rowid,decoded);
                            after = rowid;
                            count++;
                        }
                        long next = safe(page.opt("next"), "page cursor");
                        if (next != after) throw invalid("page cursor mismatch");
                        if (!more) break;
                        if (count >= expected) throw invalid("extra page");
                    }
                    if (count != expected || (expected > 0 && after != lastRow)
                        || scalar(db, "SELECT COUNT(*) FROM " + quote(target), null) != expected)
                        throw invalid("incomplete table: " + original);
                    total += count;
                    progress(callback, original, count, expected);
                }
                if (total != totalExpected) throw invalid("total count");
                if (!"ok".equals(text(db, "PRAGMA quick_check", null)))
                    throw invalid("SQLite integrity");
                String hash = sha256(inventory.toString());
                db.execSQL("INSERT OR REPLACE INTO " + META
                    + "(id,generation,inventory_sha256,rows_count,tables_count,staged_at,business_writes_enabled)"
                    + " VALUES(1,?,?,?,?,?,0)",
                    new Object[]{generation,hash,total,tables.length(),System.currentTimeMillis()});
                String contentSha256=NativeFrozenDigest.finish(content);
                db.execSQL("UPDATE "+META+" SET content_sha256=? WHERE id=1",new Object[]{contentSha256});
                JSONObject result = new JSONObject().put("generation",generation).put("contentSha256",contentSha256)
                    .put("inventorySha256",hash).put("tables",tables.length())
                    .put("rows",total).put("businessWritesEnabled",false)
                    .put("contentRevalidationRequired",true).put("restoreProbeRequired",true);
                db.setTransactionSuccessful();
                return result;
            } finally {
                db.endTransaction();
            }
        }
    }
}
