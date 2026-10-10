package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public final class FleetSnapshotSync {
    private FleetSnapshotSync() {}

    // The Server mirrors canonical data. Send only newer local/recovery data,
    // never normalize and merge all forty histories in one Worker request.
    public static JSONArray bikesToPublish(JSONObject local, JSONObject remote) {
        Map<String, JSONObject> online = byId(remote.optJSONArray("bikes"));
        Set<String> archived = strings(remote.optJSONArray("archivedBikeIds"));
        JSONArray result = new JSONArray();
        JSONArray bikes = local.optJSONArray("bikes");
        if (bikes == null) return result;
        for (int i = 0; i < bikes.length(); i++) {
            JSONObject bike = bikes.optJSONObject(i);
            if (bike == null || archived.contains(bike.optString("id", ""))) continue;
            if (needsPublish(bike, online.get(bike.optString("id", "")))) result.put(bike);
        }
        return result;
    }

    private static boolean needsPublish(JSONObject local, JSONObject remote) {
        if (remote == null) return true;
        if (local.optString("updatedAt", "").compareTo(remote.optString("updatedAt", "")) > 0) return true;
        if (local.optString("historyCorrectedAt", "").compareTo(remote.optString("historyCorrectedAt", "")) > 0) return true;
        if (local.optLong("currentKm", 0) > remote.optLong("currentKm", 0)) return true;
        Set<String> deleted = strings(remote.optJSONArray("historyDeletedIds"));
        if (!deleted.containsAll(strings(local.optJSONArray("historyDeletedIds")))) return true;
        Map<String, JSONObject> history = byId(remote.optJSONArray("history"));
        JSONArray items = local.optJSONArray("history");
        if (items == null) return false;
        for (int i = 0; i < items.length(); i++) {
            JSONObject entry = items.optJSONObject(i);
            if (entry == null) continue;
            String id = entry.optString("id", "");
            if (deleted.contains(id)) continue;
            JSONObject saved = history.get(id);
            if (saved == null || stamp(entry).compareTo(stamp(saved)) > 0) return true;
        }
        return false;
    }

    private static String stamp(JSONObject value) {
        return value.optString("updatedAt", value.optString("createdAt", value.optString("date", "")));
    }

    private static Map<String, JSONObject> byId(JSONArray values) {
        Map<String, JSONObject> result = new HashMap<String, JSONObject>();
        if (values != null) for (int i=0; i<values.length(); i++) {
            JSONObject value = values.optJSONObject(i);
            if (value != null) result.put(value.optString("id", ""), value);
        }
        return result;
    }

    private static Set<String> strings(JSONArray values) {
        Set<String> result = new HashSet<String>();
        if (values != null) for (int i=0; i<values.length(); i++) result.add(values.optString(i, ""));
        return result;
    }
}
