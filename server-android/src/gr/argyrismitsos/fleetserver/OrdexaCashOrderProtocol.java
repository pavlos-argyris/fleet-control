package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.util.*;

/** Identity fields observed in the owner's real HTTP diagnostic on 2026-11-07.
 * This adapter deliberately cannot decide payment, cancellation or timestamp meaning. */
public final class OrdexaCashOrderProtocol {
    public static final String REVISION="ordexa-order-identities-20261107-v1";
    private static String numberId(Object value)throws Exception{
        if(!(value instanceof Number))throw new IllegalArgumentException("Μη επαληθευμένος τύπος ID παραγγελίας Ordexa.");
        return OrdexaClient.identifier(value);
    }
    public static JSONObject page(JSONObject raw,JSONObject validated)throws Exception{
        JSONArray input=raw.getJSONArray("rows"),orders=validated.getJSONArray("rows"),result=new JSONArray();
        Map<String,JSONObject> byId=new HashMap<String,JSONObject>();
        for(int i=0;i<input.length();i++){JSONObject row=input.getJSONObject(i);byId.put(OrdexaClient.identifier(row.get("id")),row);}
        int unresolved=0;
        for(int i=0;i<orders.length();i++){
            JSONObject normalized=orders.getJSONObject(i),row=byId.get(normalized.getString("sourceOrderId"));
            JSONObject output=new JSONObject().put("sourceOrderId",normalized.getString("sourceOrderId"))
                .put("sourceShopId",normalized.getString("sourceShopId")).put("at",normalized.getString("at"))
                .put("businessDay",normalized.getString("businessDay")).put("identityVerified",false);
            try{
                if(row==null||!numberId(row.get("id")).equals(output.getString("sourceOrderId"))||!numberId(row.get("shopId")).equals(output.getString("sourceShopId")))throw new IllegalArgumentException("Η ταυτότητα παραγγελίας δεν συμφωνεί.");
                String rider=null;if(!row.has("riderId"))throw new IllegalArgumentException("Δεν υπάρχει riderId.");
                if(!row.isNull("riderId"))rider=numberId(row.get("riderId"));
                String nickname="";if(row.has("rider")&&!row.isNull("rider")){if(!(row.get("rider") instanceof String)||row.getString("rider").length()>200)throw new IllegalArgumentException("Άγνωστο όνομα διανομέα.");nickname=row.getString("rider");}
                OrdexaClient.instant(output.getString("at"));
                output.put("sourceRiderId",rider==null?JSONObject.NULL:rider).put("nickname",nickname)
                    .put("identityVerified",true).put("riderUnassigned",rider==null)
                    .put("statusFieldObserved",row.has("status")&&!row.isNull("status"));
                // Nickname changes do not create new order identities or tariffs.
                JSONObject identity=new JSONObject().put("id",output.getString("sourceOrderId"))
                    .put("shopId",output.getString("sourceShopId")).put("riderId",rider==null?JSONObject.NULL:rider)
                    .put("at",output.getString("at"));
                output.put("fingerprint",OrdexaClient.digest(identity));
            }catch(Exception unverified){
                unresolved++;output.put("identityVerified",false).put("reason","unverified-identity-shape");
            }
            // charge/income/riderCost/zeroCharge/straight/tooFar are never financial inputs here.
            result.put(output);
        }
        return new JSONObject().put("revision",REVISION).put("identityVerified",unresolved==0)
            .put("unresolved",unresolved).put("rows",result).put("automaticWritesEnabled",false)
            .put("timeSemanticsVerified",false).put("cancellationSemanticsVerified",false);
    }
}
