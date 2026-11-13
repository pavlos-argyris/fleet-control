package gr.argyrismitsos.fleetcontrol;
import android.content.*;import org.json.*;
import gr.argyrismitsos.fleetupdates.BackendPolicy;

/** Endpoint selection contains no session or business data. Legacy accounts stay cloud-scoped. */
public final class BackendSelection {
    static final String DIRECT="https://fleet-control.duckdns.org";
    private BackendSelection(){}
    static String read(Context c){String saved=c.getSharedPreferences("fleet_backend_selection",Context.MODE_PRIVATE).getString("selection","");if(!BackendPolicy.DIRECT_ONLY)return saved;try{JSONObject state;try{state=new JSONObject(saved);}catch(Exception empty){state=new JSONObject();}return state.put("schema",1).put("revision",Math.max(0,state.optLong("revision"))).put("activeMode","direct").put("selectedMode","direct").put("directOnly",true).put("localRecovery",false).put("cloudUrl","https://fleet-control.pavlosargyris.workers.dev").put("directUrl",DIRECT).toString();}catch(Exception invalid){throw new IllegalStateException("Direct selection unavailable",invalid);}}
    static boolean direct(Context c){if(BackendPolicy.DIRECT_ONLY)return true;try{return new JSONObject(read(c)).optString("activeMode").equals("direct");}catch(Exception ignored){return false;}}
    static void save(Context c,String text)throws Exception{JSONObject s=new JSONObject(text);if(s.getInt("schema")!=1||s.getLong("revision")<0||!s.getString("activeMode").matches("direct|cloudflare")||!s.getString("directUrl").equals(DIRECT)||!s.getString("cloudUrl").equals("https://fleet-control.pavlosargyris.workers.dev"))throw new SecurityException("Invalid backend selection");if(BackendPolicy.DIRECT_ONLY&&!s.getString("activeMode").equals("direct"))throw new SecurityException("Cloudflare selection is temporarily disabled");if(!c.getSharedPreferences("fleet_backend_selection",Context.MODE_PRIVATE).edit().putString("selection",text).commit())throw new IllegalStateException("Selection not saved");}
    static String apiBase(Context c){return direct(c)?DIRECT:"https://fleet-control.pavlosargyris.workers.dev";}
    static long revision(Context c){try{return new JSONObject(read(c)).getLong("revision");}catch(Exception ignored){return 0;}}
    static String tokenKey(Context c){return direct(c)?"auth_token_direct":"auth_token";}
}
