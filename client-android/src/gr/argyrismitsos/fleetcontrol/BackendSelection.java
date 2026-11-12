package gr.argyrismitsos.fleetcontrol;
import android.content.*;import org.json.*;

/** Endpoint selection contains no session or business data. Legacy accounts stay cloud-scoped. */
public final class BackendSelection {
    static final String DIRECT="https://fleet-control.duckdns.org";
    private BackendSelection(){}
    static String read(Context c){return c.getSharedPreferences("fleet_backend_selection",Context.MODE_PRIVATE).getString("selection","");}
    static boolean direct(Context c){try{return new JSONObject(read(c)).optString("activeMode").equals("direct");}catch(Exception ignored){return false;}}
    static void save(Context c,String text)throws Exception{JSONObject s=new JSONObject(text);if(s.getInt("schema")!=1||s.getLong("revision")<0||!s.getString("activeMode").matches("direct|cloudflare")||!s.getString("directUrl").equals(DIRECT)||!s.getString("cloudUrl").equals("https://fleet-control.pavlosargyris.workers.dev"))throw new SecurityException("Invalid backend selection");if(!c.getSharedPreferences("fleet_backend_selection",Context.MODE_PRIVATE).edit().putString("selection",text).commit())throw new IllegalStateException("Selection not saved");}
    static String apiBase(Context c){return direct(c)?DIRECT:"https://fleet-control.pavlosargyris.workers.dev";}
    static long revision(Context c){try{return new JSONObject(read(c)).getLong("revision");}catch(Exception ignored){return 0;}}
    static String tokenKey(Context c){return direct(c)?"auth_token_direct":"auth_token";}
}
