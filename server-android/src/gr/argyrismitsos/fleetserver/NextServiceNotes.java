package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Per-reminder merge, independent of the bike's odometer/history clock. */
public final class NextServiceNotes {
    private NextServiceNotes() {}

    private static String text(JSONObject row, String key, int limit) {
        String value = row.optString(key, "").trim();
        return value.length() > limit ? value.substring(0, limit) : value;
    }
    private static String stamp(JSONObject row) {
        String status = row.optString("status", "pending");
        int rank = "removed".equals(status) ? 2 : "completed".equals(status) ? 1 : 0;
        return row.optString("updatedAt", "") + "|" + rank + "|" + row.optString("text", "") + "|" + row.optString("sourceEntryId", "") + "|" + row.optString("completedEntryId", "");
    }
    public static JSONArray merge(JSONArray first, JSONArray second) throws JSONException {
        Map<String, JSONObject> map = new LinkedHashMap<String, JSONObject>();
        for (JSONArray rows : new JSONArray[]{first, second}) {
            if (rows == null) continue;
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                String id = text(row, "id", 100), body = text(row, "text", 240), status = row.optString("status", ""), at = row.optString("updatedAt", "");
                if (id.length() == 0 || body.length() == 0 || !at.matches("\\d{4}-\\d{2}-\\d{2}T.*") || !("pending".equals(status) || "completed".equals(status) || "removed".equals(status))) continue;
                JSONObject item = new JSONObject().put("id", id).put("text", body).put("status", status)
                    .put("createdAt", row.optString("createdAt", at)).put("updatedAt", at)
                    .put("sourceEntryId", text(row, "sourceEntryId", 100)).put("completedEntryId", text(row, "completedEntryId", 100));
                JSONObject old = map.get(id);
                if (old == null || stamp(old).compareTo(stamp(item)) < 0) map.put(id, item);
            }
        }
        List<JSONObject> sorted = new ArrayList<JSONObject>(map.values());
        Collections.sort(sorted, new Comparator<JSONObject>() {
            public int compare(JSONObject a, JSONObject b) {
                int byDate = a.optString("createdAt", "").compareTo(b.optString("createdAt", ""));
                return byDate != 0 ? byDate : a.optString("id", "").compareTo(b.optString("id", ""));
            }
        });
        JSONArray result = new JSONArray();
        for (JSONObject row : sorted) result.put(row);
        return result;
    }
    public static boolean needsPublish(JSONArray local, JSONArray remote) {
        Map<String, JSONObject> saved = new LinkedHashMap<String, JSONObject>();
        if (remote != null) for (int i = 0; i < remote.length(); i++) {
            JSONObject row = remote.optJSONObject(i);
            if (row != null) saved.put(row.optString("id", ""), row);
        }
        if (local != null) for (int i = 0; i < local.length(); i++) {
            JSONObject row = local.optJSONObject(i);
            if (row == null) continue;
            JSONObject old = saved.get(row.optString("id", ""));
            if (old == null || stamp(old).compareTo(stamp(row)) < 0) return true;
        }
        return false;
    }
}
