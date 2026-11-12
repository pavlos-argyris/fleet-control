package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.security.SecureRandom;import java.util.*;

/** Distinct application sandbox and Android Keystore; never reads production preferences. */
public final class IndependentConfig {
    static final String PACKAGE="gr.argyrismitsos.fleetserver.independent",NAME="independent.configuration",ALIAS="fleet.independent.configuration.v1";
    private IndependentConfig(){}
    static void require(Context c){if(!PACKAGE.equals(c.getPackageName()))throw new SecurityException("Independent runtime requires its own installation");}
    static JSONObject read(Context c)throws Exception{require(c);return SealedLocalState.read(c,NAME,ALIAS);}
    static void save(Context c,JSONObject value)throws Exception{require(c);SealedLocalState.write(c,NAME,ALIAS,value);}
    static String random(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    static String realm(JSONObject value){return value.optString("hostname").isEmpty()?"https://fleet-independent.invalid":"https://"+value.optString("hostname");}
    static JSONObject fresh(JSONObject backup)throws Exception{
        JSONObject recovery=backup.getJSONObject("nativeRecovery");
        return new JSONObject().put("instanceId",UUID.randomUUID().toString()).put("generation",UUID.randomUUID().toString()).put("mode","test").put("sourceScopeRealm",backup.getJSONObject("settings").optString("sourceScopeRealm",recovery.getString("realm"))).put("authPepper",recovery.getString("authPepper")).put("serverKey",random()).put("eventSigningKey",random()).put("recoveryToken",random()).put("ownerId",recovery.getString("ownerId")).put("backupSha256",backup.getJSONObject("nativeDatabase").getString("sha256")).put("backupCreatedAt",backup.optString("createdAt")).put("restoredAt",System.currentTimeMillis()).put("testOrdexa",false);
    }
}
