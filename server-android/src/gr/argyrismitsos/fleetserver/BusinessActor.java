package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.util.Iterator;

/** File handles use current native session ownership; API permissions remain shared. */
public final class BusinessActor {
    private BusinessActor(){}
    public static String resolve(BusinessSqlite sql,JSONObject request,String pepper,boolean internal)throws Exception{
        if(internal)return "server";
        JSONObject headers=request.optJSONObject("headers");String authorization="",cookie="";
        if(headers!=null){Iterator<String> names=headers.keys();while(names.hasNext()){String key=names.next();if(key.equalsIgnoreCase("authorization"))authorization=headers.optString(key);if(key.equalsIgnoreCase("cookie"))cookie=headers.optString(key);}}
        String token=authorization.startsWith("Bearer ")?authorization.substring(7):"";
        if(token.isEmpty())for(String item:cookie.split(";")){String[] pair=item.trim().split("=",2);if(pair.length==2&&pair[0].equals("fc_auth"))token=pair[1];}
        if(token.isEmpty()||token.length()>1024)return "";
        String hash=BusinessRuntime.sha256((pepper+":auth:"+token).getBytes("UTF-8"));
        JSONObject value=sql.call("sql.query",new JSONObject().put("sql","SELECT s.user_id FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.active=1 AND u.login_enabled=1 AND u.deleted_at IS NULL AND s.created_at>=COALESCE(u.force_logout_after,0)").put("params",new JSONArray().put(hash).put(System.currentTimeMillis()/1000)).put("first",true));
        JSONArray rows=value.getJSONArray("results");return rows.length()==0?"":rows.getJSONObject(0).getString("user_id");
    }
}
