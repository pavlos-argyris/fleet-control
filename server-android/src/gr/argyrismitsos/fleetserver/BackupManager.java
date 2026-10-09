package gr.argyrismitsos.fleetserver;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class BackupManager {
    private static final String BACKUP_MAGIC = "FCB2\n";
    private static final int MAX_BACKUP_BYTES = 50 * 1024 * 1024;
    public static final String PREFS = "fleet_server_preferences";
    public static final String KEY_FOLDER_URI = "backup_folder_uri";
    public static final String KEY_RETENTION = "backup_retention";
    public static final String KEY_HOUR = "backup_hour";
    public static final String KEY_FREQUENCY = "backup_frequency";
    public static final String KEY_LAST_DAY = "last_backup_day";
    public static final String KEY_LAST_TIME = "last_backup_time";
    public static final String KEY_LAST_RESULT = "last_backup_result";

    private BackupManager() {
    }

    public static synchronized String createBackup(Context context, FleetDataStore store) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String folderValue = preferences.getString(KEY_FOLDER_URI, "");
        if (folderValue == null || folderValue.length() == 0) throw new IllegalStateException("Δεν έχει επιλεγεί φάκελος Google Drive.");

        Uri treeUri = Uri.parse(folderValue);
        ContentResolver resolver = context.getContentResolver();
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        String fileName = "FleetControl_backup_" + stamp + ".fcbackup";
        JSONObject export = store.fullBackupPayload();
        JSONObject settings = new JSONObject();
        settings.put("workerUrl", preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL));
        settings.put("syncSeconds", preferences.getInt("sync_seconds", 30));
        settings.put("backupHour", preferences.getInt(KEY_HOUR, 3));
        settings.put("backupRetention", preferences.getInt(KEY_RETENTION, 30));
        settings.put("backupFrequency", preferences.getString(KEY_FREQUENCY, "daily"));
        settings.put("automaticBackup", preferences.getBoolean("automatic_backup", true));
        settings.put("automaticStart", preferences.getBoolean("automatic_start", true));
        export.put("settings", settings);
        final byte[] backupBytes = encrypt(export.toString(2).getBytes(Charset.forName("UTF-8")));
        Uri parentDocument = DocumentsContract.buildDocumentUriUsingTree(
                treeUri, DocumentsContract.getTreeDocumentId(treeUri));
        Uri document = DocumentsContract.createDocument(resolver, parentDocument, "application/octet-stream", fileName);
        if (document == null) throw new IllegalStateException("Δεν ήταν δυνατή η δημιουργία του backup.");
        try {
            OutputStream output = resolver.openOutputStream(document, "w");
            if (output == null) throw new IllegalStateException("Ο φάκελος backup δεν είναι διαθέσιμος.");
            try {
                output.write(backupBytes);
                output.flush();
            } finally {
                output.close();
            }
        } catch (Exception error) {
            try { resolver.delete(document, null, null); } catch (Exception ignored) {}
            throw error;
        }

        byte[] documents = ServiceDocumentStore.createArchive(context, export.optJSONObject("fleet"));
        if (documents.length > 22) {
            String documentsName = "FleetControl_documents_" + stamp + ".fcdocs";
            Uri documentsUri = DocumentsContract.createDocument(resolver, parentDocument, "application/octet-stream", documentsName);
            if (documentsUri != null) {
                try {
                    OutputStream documentsOutput = resolver.openOutputStream(documentsUri, "w");
                    if (documentsOutput == null) throw new IllegalStateException("Ο φάκελος backup δεν είναι διαθέσιμος.");
                    try { documentsOutput.write(encrypt(documents)); documentsOutput.flush(); }
                    finally { documentsOutput.close(); }
                } catch (Exception error) {
                    try { resolver.delete(documentsUri, null, null); } catch (Exception ignored) {}
                    throw error;
                }
            }
        }

        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        preferences.edit()
                .putString(KEY_LAST_DAY, day)
                .putString(KEY_LAST_TIME, isoNow())
                .putString(KEY_LAST_RESULT, "Επιτυχία")
                .apply();
        cleanupOldBackups(context, treeUri, Math.max(1, preferences.getInt(KEY_RETENTION, 30)));
        return fileName;
    }

    public static void maybeAutomatic(Context context, FleetDataStore store) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean("automatic_backup", true)) return;
        String folder = preferences.getString(KEY_FOLDER_URI, "");
        if (folder == null || folder.length() == 0) return;
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        int desiredHour = preferences.getInt(KEY_HOUR, 3);
        String frequency = preferences.getString(KEY_FREQUENCY, "daily");
        int dayOfWeek = calendar.get(java.util.Calendar.DAY_OF_WEEK);
        if ("weekdays".equals(frequency) && (dayOfWeek == java.util.Calendar.SATURDAY || dayOfWeek == java.util.Calendar.SUNDAY)) return;
        if ("weekly".equals(frequency) && dayOfWeek != java.util.Calendar.MONDAY) return;
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        if (calendar.get(java.util.Calendar.HOUR_OF_DAY) < desiredHour || today.equals(preferences.getString(KEY_LAST_DAY, ""))) return;
        try {
            createBackup(context, store);
        } catch (Exception error) {
            preferences.edit().putString(KEY_LAST_RESULT, error.getMessage()).apply();
        }
    }

    public static synchronized JSONObject restoreBackup(Context context, FleetDataStore store, Uri uri) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        InputStream input = context.getContentResolver().openInputStream(uri);
        if (input == null) throw new IllegalArgumentException("Το αρχείο backup δεν είναι διαθέσιμο.");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (output.size() + read > MAX_BACKUP_BYTES) {
                    throw new IllegalArgumentException("Το αρχείο backup είναι πολύ μεγάλο.");
                }
                output.write(buffer, 0, read);
            }
        } finally {
            input.close();
        }
        JSONObject root = new JSONObject(new String(decryptIfNeeded(output.toByteArray()), Charset.forName("UTF-8")));
        JSONObject fleet = root.optJSONObject("fleet");
        if (fleet == null && root.optJSONArray("bikes") != null) fleet = root;
        if (fleet == null || fleet.optJSONArray("bikes") == null) {
            throw new IllegalArgumentException("Το αρχείο δεν είναι έγκυρο Fleet Control backup.");
        }
        createPreRestoreBackup(context, store);
        if (root.optJSONObject("workforce") == null) {
            JSONObject upgraded = store.fullBackupPayload();
            upgraded.put("fleet", fleet);
            upgraded.put("createdAt", root.optString("createdAt", isoNow()));
            root = upgraded;
        }
        root.put("schemaVersion", 3);
        JSONObject settings = root.optJSONObject("settings");
        if (settings != null) {
            String workerUrl = settings.optString("workerUrl", preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL));
            String frequency = settings.optString("backupFrequency", "daily");
            if (!"weekdays".equals(frequency) && !"weekly".equals(frequency)) frequency = "daily";
            preferences.edit()
                    .putString("worker_url", workerUrl)
                    .putInt("sync_seconds", Math.max(10, Math.min(300, settings.optInt("syncSeconds", 30))))
                    .putInt(KEY_HOUR, Math.max(0, Math.min(23, settings.optInt("backupHour", 3))))
                    .putInt(KEY_RETENTION, Math.max(1, Math.min(90, settings.optInt("backupRetention", 30))))
                    .putString(KEY_FREQUENCY, frequency)
                    .putBoolean("automatic_backup", settings.optBoolean("automaticBackup", true))
                    .putBoolean("automatic_start", settings.optBoolean("automaticStart", true))
                    .apply();
        }
        JSONObject documentRestore = restoreSiblingDocuments(context, fleet, uri);
        root.put("documentRestore", documentRestore);
        store.mergeFleet(fleet);
        store.setSystemExport(root);
        return root;
    }

    private static JSONObject restoreSiblingDocuments(Context context, JSONObject fleet, Uri backupUri) {
        JSONObject unavailable = new JSONObject();
        try {
            int expected = countAttachments(fleet);
            unavailable.put("available", false).put("expected", expected).put("restored", 0).put("documents", new org.json.JSONArray());
            Uri documentsUri = findSiblingDocumentsArchive(context, backupUri);
            if (documentsUri == null) return unavailable.put("message", "Δεν βρέθηκε συνοδευτικό αρχείο τιμολογίων.");
            InputStream input = context.getContentResolver().openInputStream(documentsUri);
            if (input == null) return unavailable.put("message", "Το συνοδευτικό αρχείο τιμολογίων δεν είναι διαθέσιμο.");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (output.size() + read > MAX_BACKUP_BYTES) throw new IllegalArgumentException("Το αρχείο τιμολογίων είναι πολύ μεγάλο.");
                    output.write(buffer, 0, read);
                }
            } finally { input.close(); }
            JSONObject restored = ServiceDocumentStore.restoreArchive(context, fleet, decryptIfNeeded(output.toByteArray()));
            restored.put("archiveName", queryDisplayName(context, documentsUri));
            return restored;
        } catch (Exception error) {
            try { unavailable.put("message", error.getMessage() == null ? "Δεν ήταν δυνατή η επαναφορά των τιμολογίων." : error.getMessage()); } catch (Exception ignored) {}
            return unavailable;
        }
    }

    private static int countAttachments(JSONObject fleet) {
        int count = 0;
        org.json.JSONArray bikes = fleet == null ? null : fleet.optJSONArray("bikes");
        if (bikes == null) return 0;
        for (int i = 0; i < bikes.length(); i++) {
            JSONObject bike = bikes.optJSONObject(i);
            org.json.JSONArray history = bike == null ? null : bike.optJSONArray("history");
            if (history == null) continue;
            for (int j = 0; j < history.length(); j++) {
                JSONObject entry = history.optJSONObject(j);
                org.json.JSONArray attachments = entry == null ? null : entry.optJSONArray("attachments");
                if (attachments != null) count += attachments.length();
            }
        }
        return count;
    }

    private static Uri findSiblingDocumentsArchive(Context context, Uri backupUri) {
        try {
            String backupName = queryDisplayName(context, backupUri);
            Matcher matcher = Pattern.compile("FleetControl_backup_(\\d{8}_\\d{6})\\.fcbackup", Pattern.CASE_INSENSITIVE).matcher(backupName);
            if (!matcher.find()) return null;
            String expected = "FleetControl_documents_" + matcher.group(1) + ".fcdocs";
            SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String folderValue = preferences.getString(KEY_FOLDER_URI, "");
            if (folderValue == null || folderValue.length() == 0) return null;
            Uri treeUri = Uri.parse(folderValue);
            String documentId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
            Cursor cursor = null;
            try {
                cursor = context.getContentResolver().query(children, new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME
                }, null, null, null);
                if (cursor == null) return null;
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    if (expected.equals(name)) return DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(0));
                }
            } finally { if (cursor != null) cursor.close(); }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String queryDisplayName(Context context, Uri uri) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null);
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : "";
        } catch (Exception ignored) {
            return "";
        } finally { if (cursor != null) cursor.close(); }
    }

    private static void createPreRestoreBackup(Context context, FleetDataStore store) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String folder = preferences.getString(KEY_FOLDER_URI, "");
        if (folder != null && folder.length() > 0) {
            createBackup(context, store);
            return;
        }
        File directory = new File(context.getFilesDir(), "pre-restore");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Δεν ήταν δυνατή η δημιουργία backup πριν την επαναφορά.");
        File file = new File(directory, "FleetControl_pre_restore.fcbackup");
        FileOutputStream output = new FileOutputStream(file, false);
        try {
            output.write(encrypt(store.fullBackupPayload().toString(2).getBytes(Charset.forName("UTF-8"))));
            output.flush();
        } finally {
            output.close();
        }
    }

    private static byte[] encryptionKey() throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return digest.digest(("FleetControlBackupV2:" + ServerConfig.SERVER_KEY).getBytes(Charset.forName("UTF-8")));
    }

    private static byte[] encrypt(byte[] plain) throws Exception {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(encryptionKey(), "AES"), new GCMParameterSpec(128, iv));
        byte[] encrypted = cipher.doFinal(plain);
        byte[] combined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
        String encoded = BACKUP_MAGIC + Base64.encodeToString(combined, Base64.NO_WRAP);
        return encoded.getBytes(Charset.forName("UTF-8"));
    }

    private static byte[] decryptIfNeeded(byte[] data) throws Exception {
        String value = new String(data, Charset.forName("UTF-8"));
        if (!value.startsWith(BACKUP_MAGIC)) return data;
        byte[] combined = Base64.decode(value.substring(BACKUP_MAGIC.length()), Base64.DEFAULT);
        if (combined.length < 29) throw new IllegalArgumentException("Το κρυπτογραφημένο backup δεν είναι έγκυρο.");
        byte[] iv = new byte[12];
        byte[] encrypted = new byte[combined.length - iv.length];
        System.arraycopy(combined, 0, iv, 0, iv.length);
        System.arraycopy(combined, iv.length, encrypted, 0, encrypted.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(encryptionKey(), "AES"), new GCMParameterSpec(128, iv));
        return cipher.doFinal(encrypted);
    }

    private static void cleanupOldBackups(Context context, Uri treeUri, int keep) {
        Cursor cursor = null;
        try {
            ContentResolver resolver = context.getContentResolver();
            String documentId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
            cursor = resolver.query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
            }, null, null, null);
            if (cursor == null) return;
            List<BackupDocument> files = new ArrayList<BackupDocument>();
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                if (name != null && name.startsWith("FleetControl_") && (name.endsWith(".fcbackup") || name.endsWith(".fcdocs") || name.endsWith(".json"))) {
                    files.add(new BackupDocument(cursor.getString(0), cursor.getLong(2)));
                }
            }
            Collections.sort(files, new Comparator<BackupDocument>() {
                @Override
                public int compare(BackupDocument left, BackupDocument right) {
                    return left.modified == right.modified ? 0 : (left.modified > right.modified ? -1 : 1);
                }
            });
            for (int i = keep; i < files.size(); i++) {
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, files.get(i).documentId);
                try { DocumentsContract.deleteDocument(resolver, uri); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private static String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static final class BackupDocument {
        final String documentId;
        final long modified;

        BackupDocument(String documentId, long modified) {
            this.documentId = documentId;
            this.modified = modified;
        }
    }
}
