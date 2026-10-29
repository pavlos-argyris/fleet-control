package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.util.*;

/** P0 schema gate: no malformed or ambiguously identified row reaches the archive. */
public final class StoreBillingProtocol {
    public static JSONArray setup(JSONObject raw)throws Exception{
        JSONArray shops=raw.getJSONArray("shops");JSONObject settings=raw.getJSONObject("settings");
        if(!(settings.get("chargeFixedOnZeroDays") instanceof Boolean)||shops.length()>2000)throw new IllegalArgumentException("Άγνωστο σχήμα καταστημάτων Ordexa.");
        boolean zero=settings.getBoolean("chargeFixedOnZeroDays");JSONArray result=new JSONArray();Set<String> seen=new HashSet<String>();
        for(int i=0;i<shops.length();i++){
            JSONObject shop=shops.getJSONObject(i);String id=OrdexaClient.identifier(shop.get("id"));
            if(!id.matches("[A-Za-z0-9_-]{1,100}")||!seen.add(id)||!(shop.get("name") instanceof String)||shop.getString("name").length()>300)throw new IllegalArgumentException("Μη έγκυρη ταυτότητα καταστήματος Ordexa.");
            if(shop.has("blocked")&&!(shop.get("blocked") instanceof Boolean))throw new IllegalArgumentException("Άγνωστη κατάσταση καταστήματος Ordexa.");
            result.put(new JSONObject().put("sourceShopId",id).put("name",shop.getString("name")).put("blocked",shop.optBoolean("blocked",false)).put("sourceTerms",StoreBillingEngine.sourceTerms(shop,zero)));
        }
        return result;
    }
    private static int integer(JSONObject raw,String key,int min,int max)throws Exception{
        Object value=raw.get(key);if(!(value instanceof Number))throw new IllegalArgumentException("Άγνωστη σελιδοποίηση Ordexa.");double n=((Number)value).doubleValue();if(n!=Math.floor(n)||n<min||n>max)throw new IllegalArgumentException("Μη έγκυρη σελιδοποίηση Ordexa.");return (int)n;
    }
    public static JSONObject page(JSONObject raw,int requested,String requestedShop,Set<String> known)throws Exception{
        int page=integer(raw,"page",1,10000),pages=integer(raw,"pages",0,10000),total=integer(raw,"total",0,10000000);
        JSONArray rows=raw.getJSONArray("rows"),result=new JSONArray();if(page!=requested||rows.length()>500||(pages==0&&total!=0)||(pages>0&&page>pages)||rows.length()==0&&total>0)throw new IllegalArgumentException("Μη πλήρης σελίδα παραγγελιών Ordexa.");
        Set<String> seen=new HashSet<String>();boolean needsFilter=false;long previous=Long.MIN_VALUE;
        for(int i=0;i<rows.length();i++){
            JSONObject row=rows.getJSONObject(i);String id=OrdexaClient.identifier(row.get("id")),at=row.getString("at");long instant=OrdexaClient.instant(at);
            if(!seen.add(id)||instant<previous)throw new IllegalArgumentException("Ασυνεπής σειρά παραγγελιών Ordexa.");previous=instant;
            String shop=requestedShop;
            if(row.has("shopId")&&!row.isNull("shopId")){String source=OrdexaClient.identifier(row.get("shopId"));if(shop!=null&&!shop.equals(source))throw new IllegalArgumentException("Η πηγή επέστρεψε διαφορετικό κατάστημα.");shop=source;}
            if(shop==null){needsFilter=true;continue;}
            if(!known.contains(shop))throw new IllegalArgumentException("Άγνωστη ταυτότητα καταστήματος στην παραγγελία.");
            JSONObject clean=new JSONObject().put("sourceOrderId",id).put("sourceShopId",shop).put("at",at).put("businessDay",StoreBillingEngine.businessDay(instant));
            // Status isn't assumed. When present, preserve it as evidence for review.
            if(row.has("status")&&!row.isNull("status")){if(!(row.get("status") instanceof String)||row.getString("status").length()>80)throw new IllegalArgumentException("Άγνωστη κατάσταση παραγγελίας.");clean.put("sourceStatus",row.getString("status"));}
            result.put(clean);
        }
        return new JSONObject().put("page",page).put("pages",Math.max(1,pages)).put("total",total).put("needsShopFilter",needsFilter).put("rows",result);
    }
}
