package gr.argyrismitsos.fleetserver;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import java.security.MessageDigest;
import java.nio.charset.Charset;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Keeps a local mirror of invoice files received from the private Worker storage. */
public final class ServiceDocumentStore {
    private ServiceDocumentStore() {}

    static JSONArray invoiceFiles(JSONArray invoices) {
        JSONArray result=new JSONArray();if(invoices==null)return result;
        for(int i=0;i<invoices.length();i++){JSONObject file=invoices.optJSONObject(i);if(file==null)continue;result.put(file);JSONObject photo=file.optJSONObject("sourcePhoto");if(photo!=null)result.put(photo);}return result;
    }

    public interface SyncControl {boolean pause();void stage(String name,int done);}
    public static int syncFromFleet(Context context,JSONObject fleet,String workerUrl,Map<String,String> headers){return syncFromFleet(context,fleet,workerUrl,headers,null);}
    public static int syncFromFleet(Context context, JSONObject fleet, String workerUrl, Map<String, String> headers,SyncControl control) {
        if (fleet == null) return 0;
        int downloaded = 0;
        JSONArray bikes = fleet.optJSONArray("bikes");
        if (bikes == null) return 0;
        File root = new File(context.getFilesDir(), "service-documents");
        for (int i = 0; i < bikes.length(); i++) {
            JSONObject bike = bikes.optJSONObject(i);
            JSONArray history = bike == null ? null : bike.optJSONArray("history");
            if (history == null) continue;
            for (int j = 0; j < history.length(); j++) {
                JSONObject entry = history.optJSONObject(j);
                JSONArray attachments = invoiceFiles(entry == null ? null : entry.optJSONArray("attachments"));
                if (attachments == null) continue;
                for (int k = 0; k < attachments.length(); k++) {
                    if(Thread.currentThread().isInterrupted()||(control!=null&&control.pause()))return downloaded;
                    JSONObject attachment = attachments.optJSONObject(k);
                    String key = attachment == null ? "" : attachment.optString("key", "");
                    if (key.length() == 0 || !key.startsWith("service-documents/")) continue;
                    File local = new File(root, sha256(key) + extension(attachment.optString("name", "")));
                    if (local.exists() && local.length() > 0) continue;
                    if(control!=null)control.stage(attachment.optString("name","τιμολόγιο"),downloaded);
                    try {
                        FleetHttp.downloadToFile(workerUrl + "/api/service-documents/" + encodePath(key), local, headers);
                        downloaded++;
                    } catch (Exception ignored) {
                        if (local.exists()) local.delete();
                    }
                }
            }
        }
        return downloaded;
    }

    /** Stores the PDF produced by the Server APK under the same deterministic
     * local name used by the normal R2 mirror. This keeps a local copy even
     * when the next sync has not downloaded the object yet. */
    public static File cacheLocalCopy(Context context, String key, File source, String name) throws IOException {
        if (context == null || key == null || key.length() == 0 || source == null || !source.exists()) {
            throw new IOException("Δεν βρέθηκε το προσωρινό PDF του τιμολογίου.");
        }
        File root = new File(context.getFilesDir(), "service-documents");
        if (!root.exists() && !root.mkdirs()) throw new IOException("Δεν δημιουργήθηκε ο φάκελος τιμολογίων.");
        File target = new File(root, sha256(key) + extension(name));
        if (target.exists() && target.length() > 0) return target;
        File temporary = new File(target.getPath() + ".part");
        FileInputStream input = new FileInputStream(source);
        FileOutputStream output = new FileOutputStream(temporary, false);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        } finally {
            try { input.close(); } catch (IOException ignored) {}
            try { output.close(); } catch (IOException ignored) {}
        }
        if (!temporary.renameTo(target)) {
            if (target.exists()) target.delete();
            if (!temporary.renameTo(target)) throw new IOException("Δεν αποθηκεύτηκε το τιμολόγιο στον Server.");
        }
        return target;
    }

    public static File localFile(Context context, String key, String name) {
        return new File(new File(context.getFilesDir(), "service-documents"), sha256(key) + extension(name));
    }

    public static byte[] createArchive(Context context, JSONObject fleet) throws Exception {
        JSONArray manifest = new JSONArray();
        List<JSONObject> documents = new ArrayList<JSONObject>();
        java.util.Set<String> includedKeys = new java.util.HashSet<String>();
        JSONArray bikes = fleet == null ? null : fleet.optJSONArray("bikes");
        if (bikes != null) for (int i = 0; i < bikes.length(); i++) {
            JSONObject bike = bikes.optJSONObject(i);
            JSONArray history = bike == null ? null : bike.optJSONArray("history");
            if (history == null) continue;
            for (int j = 0; j < history.length(); j++) {
                JSONObject entry = history.optJSONObject(j);
                JSONArray attachments = invoiceFiles(entry == null ? null : entry.optJSONArray("attachments"));
                if (attachments == null) continue;
                for (int k = 0; k < attachments.length(); k++) {
                    JSONObject attachment = attachments.optJSONObject(k);
                    if (attachment == null) continue;
                    String key = attachment.optString("key", "");
                    if (key.length() == 0) continue;
                    File local = localFile(context, key, attachment.optString("name", ""));
                    if (!local.exists() || local.length()==0 || includedKeys.contains(key)) continue;
                    includedKeys.add(key);
                    String zipName = "documents/" + documents.size() + extension(attachment.optString("name", ""));
                    JSONObject metadata = new JSONObject();
                    metadata.put("zipName", zipName);
                    metadata.put("bikeId", bike.optString("id", ""));
                    metadata.put("entryId", entry.optString("id", ""));
                    metadata.put("key", key);
                    metadata.put("name", attachment.optString("name", "τιμολόγιο"));
                    metadata.put("originalName", attachment.optString("originalName", ""));
                    metadata.put("contentType", attachment.optString("contentType", "application/pdf"));
                    metadata.put("size", local.length());
                    MessageDigest contentDigest=MessageDigest.getInstance("SHA-256");
                    FileInputStream checksumInput=new FileInputStream(local);
                    try { byte[] checkBuffer=new byte[65536];int count;while((count=checksumInput.read(checkBuffer))!=-1)contentDigest.update(checkBuffer,0,count); }
                    finally { checksumInput.close(); }
                    metadata.put("sha256",BackupArchiveVerifier.hex(contentDigest.digest()));
                    metadata.put("qrValue", attachment.optString("qrValue", ""));
                    metadata.put("qrUrl", attachment.optString("qrUrl", ""));
                    metadata.put("renderJobId", attachment.optString("renderJobId", ""));
                    manifest.put(metadata);
                    documents.add(metadata);
                }
            }
        }
        if (documents.isEmpty()) return new byte[0];
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ZipOutputStream zip = new ZipOutputStream(bytes);
        ZipEntry manifestEntry = new ZipEntry("fleet-control-documents.json");
        zip.putNextEntry(manifestEntry);
        zip.write(manifest.toString().getBytes(Charset.forName("UTF-8")));
        zip.closeEntry();
        for (JSONObject metadata : documents) {
            String key = metadata.optString("key", "");
            File local = localFile(context, key, metadata.optString("name", ""));
            ZipEntry item = new ZipEntry(metadata.optString("zipName", "documents/invoice.pdf"));
            zip.putNextEntry(item);
            FileInputStream input = new FileInputStream(local);
            try {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) zip.write(buffer, 0, read);
            } finally { input.close(); }
            zip.closeEntry();
        }
        zip.finish();
        zip.close();
        return bytes.toByteArray();
    }

    public static JSONObject restoreArchive(Context context, JSONObject fleet, byte[] archive) throws Exception {
        if(archive==null||archive.length==0)return new JSONObject().put("available",false).put("expected",0).put("restored",0).put("documents",new JSONArray());
        return restoreArchive(context,fleet,new java.io.ByteArrayInputStream(archive));
    }
    public static JSONObject restoreArchive(Context context, JSONObject fleet, InputStream archive) throws Exception {
        JSONObject result = new JSONObject();
        JSONArray documents = new JSONArray();
        if (archive == null) return result.put("available", false).put("expected", 0).put("restored", 0).put("documents", documents);
        File root = new File(context.getFilesDir(), "service-documents");
        if (!root.exists() && !root.mkdirs()) throw new IOException("Δεν δημιουργήθηκε ο φάκελος τιμολογίων.");
        Map<String, JSONObject> manifestByZipName = new HashMap<String, JSONObject>();
        Map<String, File> restoredFiles = new HashMap<String, File>();
        ZipInputStream zip = new ZipInputStream(archive);
        try {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) { zip.closeEntry(); continue; }
                String name = entry.getName();
                if ("fleet-control-documents.json".equals(name)) {
                    String manifestText = new String(readEntry(zip, 1024 * 1024), Charset.forName("UTF-8"));
                    JSONArray list = new JSONArray(manifestText);
                    for (int i = 0; i < list.length(); i++) {
                        JSONObject metadata = list.optJSONObject(i);
                        if (metadata == null) continue;
                        String zipName = metadata.optString("zipName", "");
                        String key = metadata.optString("key", "");
                        if (zipName.length() == 0 || key.length() == 0) continue;
                        manifestByZipName.put(zipName, metadata);
                        documents.put(metadata);
                    }
                } else {
                    JSONObject metadata = manifestByZipName.get(name);
                    if (metadata != null) {
                        byte[] content = readEntry(zip, 15 * 1024 * 1024);
                        File target = localFile(context, metadata.optString("key", ""), metadata.optString("name", ""));
                        writeLocalBytes(target, content);
                        restoredFiles.put(metadata.optString("key", ""), target);
                    }
                }
                zip.closeEntry();
            }
        } finally { zip.close(); }
        int restored = 0;
        JSONArray outputDocuments = new JSONArray();
        for (int i = 0; i < documents.length(); i++) {
            JSONObject metadata = documents.optJSONObject(i);
            if (metadata == null) continue;
            String key = metadata.optString("key", "");
            File local = restoredFiles.get(key);
            JSONObject copy = new JSONObject(metadata.toString());
            boolean exists = local != null && local.exists() && local.length() > 0;
            copy.put("restored", exists);
            if (exists) restored++;
            outputDocuments.put(copy);
        }
        result.put("available", true).put("expected", documents.length()).put("restored", restored).put("documents", outputDocuments);
        return result;
    }

    public static JSONObject uploadRestoredDocuments(Context context, JSONObject restoreInfo, String workerUrl, Map<String, String> headers) throws Exception {
        JSONObject result = new JSONObject();
        JSONArray documents = restoreInfo == null ? null : restoreInfo.optJSONArray("documents");
        int uploaded = 0;
        int missing = 0;
        JSONArray errors = new JSONArray();
        if (documents != null) for (int i = 0; i < documents.length(); i++) {
            JSONObject metadata = documents.optJSONObject(i);
            if (metadata == null) continue;
            String key = metadata.optString("key", "");
            File local = localFile(context, key, metadata.optString("name", ""));
            if (key.length() == 0 || !local.exists() || local.length() == 0) { missing++; continue; }
            String url = workerUrl.replaceAll("/+$", "") + "/api/server/service-documents/restore?" + query("key", key)
                    + "&" + query("bikeId", metadata.optString("bikeId", ""))
                    + "&" + query("entryId", metadata.optString("entryId", ""))
                    + "&" + query("name", metadata.optString("name", "invoice.pdf"))
                    + "&" + query("qrValue", metadata.optString("qrValue", ""))
                    + "&" + query("qrUrl", metadata.optString("qrUrl", ""));
            try {
                FleetHttp.putStream(url, new FileInputStream(local), local.length(), metadata.optString("contentType", "application/pdf"), headers);
                uploaded++;
            } catch (Exception error) {
                errors.put(new JSONObject().put("key", key).put("error", error.getMessage() == null ? "Αποτυχία μεταφόρτωσης" : error.getMessage()));
            }
        }
        return result.put("uploaded", uploaded).put("missing", missing).put("errors", errors).put("expected", documents == null ? 0 : documents.length());
    }

    private static byte[] readEntry(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > limit) throw new IOException("Το αρχείο τιμολογίου είναι πολύ μεγάλο.");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static void writeLocalBytes(File target, byte[] bytes) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Δεν δημιουργήθηκε ο φάκελος τιμολογίων.");
        File temporary = new File(target.getPath() + ".restore");
        FileOutputStream output = new FileOutputStream(temporary, false);
        try { output.write(bytes); output.flush(); } finally { output.close(); }
        if (!temporary.renameTo(target)) {
            if (target.exists()) target.delete();
            if (!temporary.renameTo(target)) throw new IOException("Δεν αποθηκεύτηκε το τιμολόγιο από το backup.");
        }
    }

    private static String query(String name, String value) throws Exception {
        return URLEncoder.encode(name, "UTF-8") + "=" + URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }

    private static String encodePath(String value) {
        String[] parts = value.split("/", -1);
        StringBuilder result = new StringBuilder();
        for (String part : parts) {
            if (result.length() > 0) result.append('/');
            try { result.append(java.net.URLEncoder.encode(part, "UTF-8").replace("+", "%20")); }
            catch (Exception ignored) { result.append(part); }
        }
        return result.toString();
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8"));
            StringBuilder output = new StringBuilder();
            for (byte b : bytes) output.append(String.format("%02x", b));
            return output.toString();
        } catch (Exception error) { return Integer.toHexString(value.hashCode()); }
    }

    private static String extension(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".pdf")) return ".pdf";
        if (lower.endsWith(".png")) return ".png";
        if (lower.endsWith(".webp")) return ".webp";
        return ".jpg";
    }

}
