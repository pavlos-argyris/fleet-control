package gr.argyrismitsos.fleetserver;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Map;
/** Bounded authenticated table pages; only publish a complete local mirror. */
public final class SystemMirror {
    public interface Progress { void stage(String message); }
    public static JSONObject download(String base, Map<String,String> headers, JSONObject fleet, Progress progress) throws Exception {
        JSONObject manifest = FleetHttp.getJson(base + "/api/server/system-export/page", headers);
        JSONArray tables = manifest.getJSONArray("tables");
        JSONObject workforce = new JSONObject();
        for (int i=0; i<tables.length(); i++) {
            String table = tables.getString(i);
            if (!table.matches("[a-z_]+")) throw new Exception("Μη έγκυρος πίνακας αντιγράφου.");
            JSONArray rows = new JSONArray(); long cursor = 0L; boolean done = false;
            for (int page=0; page<20000; page++) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                progress.stage("Αντίγραφο " + (i+1) + "/" + tables.length() + " · " + table + " · " + rows.length() + " εγγραφές");
                JSONObject result = FleetHttp.getJson(base + "/api/server/system-export/page?table=" + table + "&cursor=" + cursor + "&limit=50",headers);
                if (!table.equals(result.optString("table"))) throw new Exception("Ασυμφωνία πίνακα αντιγράφου.");
                JSONArray next = result.getJSONArray("rows");
                for (int j=0;j<next.length();j++) rows.put(next.getJSONObject(j));
                if (!result.optBoolean("hasMore",false)) { done=true; break; }
                long advanced = result.getLong("nextCursor");
                if (advanced<=cursor) throw new Exception("Το αντίγραφο δεν προχώρησε. Θα ξαναδοκιμάσει.");
                cursor=advanced;
            }
            if (!done) throw new Exception("Το αντίγραφο υπερέβη το όριο σελίδων.");
            workforce.put(table,rows);
        }
        return new JSONObject().put("schemaVersion",5).put("createdAt",new java.text.SimpleDateFormat("yyyy-MM-dd\'T\'HH:mm:ss.SSSXXX",java.util.Locale.US).format(new java.util.Date())).put("fleet",fleet).put("workforce",workforce);
    }
}
