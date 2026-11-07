package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.util.*;

/** P0 schema gate: no malformed or ambiguously identified row reaches the archive. */
public final class StoreBillingProtocol {
    // Process-local key is never exported or persisted. Equal proof tags can
    // correlate two observations without disclosing names, source IDs or tokens.
    private static final byte[] EVIDENCE_KEY=new byte[32];
    private static final String EVIDENCE_SESSION=UUID.randomUUID().toString();
    static{new java.security.SecureRandom().nextBytes(EVIDENCE_KEY);}
    private static boolean evidenceKey(String key){return key.matches("[A-Za-z_][A-Za-z0-9_]{0,59}")&&!key.toLowerCase(Locale.ROOT).matches(".*(token|secret|password|authorization|cookie|session|header|address|phone|email|customer|comment|note|latitude|longitude|location|url).*");}
    private static String type(Object value){return value==null||value==JSONObject.NULL?"null":value instanceof JSONObject?"object":value instanceof JSONArray?"array":value instanceof Boolean?"boolean":value instanceof Number?"number":"string";}
    private static String proofTag(String scope,Object value)throws Exception{
        javax.crypto.Mac mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new javax.crypto.spec.SecretKeySpec(EVIDENCE_KEY,"HmacSHA256"));
        byte[] bytes=mac.doFinal((scope+"\u0000"+String.valueOf(value)).getBytes("UTF-8"));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.US,"%02x",b&255));return out.toString();
    }
    /** Observes the existing read. It never chooses a rider field or authorizes money. */
    public static JSONObject observeOrders(String scope,JSONObject raw,JSONObject http,int requestedPage)throws Exception{
        JSONObject frame=new JSONObject().put("observedAt",OrdexaClient.isoNow()).put("processSession",EVIDENCE_SESSION).put("requestedPage",requestedPage).put("transportObserved",http!=null&&http.optBoolean("transportObserved",false));
        if(http!=null)for(String name:new String[]{"status","durationMs","responseBytes"}){Object n=http.opt(name);if(n instanceof Number&&((Number)n).longValue()>=0)frame.put(name,n);}
        frame.put("method","GET").put("route","/api/cities/{cityId}/orders").put("contentType",http!=null&&"application/json".equals(http.optString("contentType"))?"application/json":"unknown");
        JSONObject envelope=new JSONObject();List<String> keys=new ArrayList<String>();Iterator<String> it=raw.keys();while(it.hasNext()){String key=it.next();if(evidenceKey(key))keys.add(key);}Collections.sort(keys);
        for(int i=0;i<Math.min(24,keys.size());i++)envelope.put(keys.get(i),type(raw.opt(keys.get(i))));frame.put("envelopeTypes",envelope).put("envelopeTruncated",keys.size()>24);
        JSONObject pagination=new JSONObject();for(String key:new String[]{"page","pages","total"}){Object n=raw.opt(key);if(n instanceof Number){double d=((Number)n).doubleValue();if(d>=0&&d<=10000000&&d==Math.floor(d))pagination.put(key,(long)d);}}frame.put("pagination",pagination);
        JSONArray source=raw.optJSONArray("rows"),samples=new JSONArray();frame.put("rowsFieldObserved",source!=null).put("rowsOnPage",source==null?JSONObject.NULL:source.length());
        if(source!=null)for(int index=0;index<Math.min(2,source.length());index++){
            JSONObject row=source.optJSONObject(index);if(row==null)continue;JSONObject sample=new JSONObject();keys.clear();it=row.keys();while(it.hasNext()){String key=it.next();if(evidenceKey(key))keys.add(key);}Collections.sort(keys);
            for(int i=0;i<Math.min(24,keys.size());i++){String key=keys.get(i);Object value=row.opt(key);String kind=type(value);JSONObject detail=new JSONObject().put("type",kind);
                if(!kind.equals("object")&&!kind.equals("array")&&!kind.equals("null")&&String.valueOf(value).length()<=512)detail.put("valueProof",proofTag(scope,value));
                if(kind.equals("string")){boolean instant=false;try{OrdexaClient.instant((String)value);instant=true;}catch(Exception ignored){}detail.put("fullTimestampWithZone",instant);}
                sample.put(key,detail);
            }samples.put(new JSONObject().put("fields",sample).put("truncated",keys.size()>24));
        }
        return frame.put("samples",samples).put("automaticWritesEnabled",false).put("semanticsVerified",false);
    }
    /** Rebuild the allowlist on export, including after an untrusted restore. */
    public static JSONObject evidenceView(JSONObject source)throws Exception{
        if(source==null||source.optInt("schemaVersion")!=1)return null;
        JSONObject out=new JSONObject().put("schemaVersion",1).put("automaticWritesEnabled",false).put("semanticsVerified",false);String observed=source.optString("observedAt","");OrdexaClient.instant(observed);out.put("observedAt",observed);
        JSONArray input=source.optJSONArray("frames"),frames=new JSONArray();if(input==null)return null;
        for(int i=Math.max(0,input.length()-2);i<input.length();i++){
            JSONObject frame=input.getJSONObject(i),safe=new JSONObject().put("automaticWritesEnabled",false).put("semanticsVerified",false).put("method","GET").put("route","/api/cities/{cityId}/orders");
            String stamp=frame.optString("observedAt","");OrdexaClient.instant(stamp);safe.put("observedAt",stamp).put("transportObserved",frame.optBoolean("transportObserved",false)).put("contentType","application/json".equals(frame.optString("contentType"))?"application/json":"unknown");
            String session=frame.optString("processSession","");if(session.matches("[a-f0-9-]{36}"))safe.put("processSession",session);
            for(String key:new String[]{"requestedPage","status","durationMs","responseBytes","rowsOnPage","readerPass"}){Object value=frame.opt(key);if(value instanceof Number){double n=((Number)value).doubleValue();if(n>=0&&n<=10000000&&n==Math.floor(n))safe.put(key,(long)n);}}
            safe.put("filteredByShop",frame.optBoolean("filteredByShop",false));safe.put("rowsFieldObserved",frame.optBoolean("rowsFieldObserved",false)).put("envelopeTruncated",frame.optBoolean("envelopeTruncated",false));JSONObject pagination=new JSONObject(),inPage=frame.optJSONObject("pagination");if(inPage!=null)for(String key:new String[]{"page","pages","total"}){Object value=inPage.opt(key);if(value instanceof Number){double n=((Number)value).doubleValue();if(n>=0&&n<=10000000&&n==Math.floor(n))pagination.put(key,(long)n);}}safe.put("pagination",pagination);
            JSONObject envelope=new JSONObject(),inEnvelope=frame.optJSONObject("envelopeTypes");if(inEnvelope!=null){Iterator<String> names=inEnvelope.keys();while(names.hasNext()&&envelope.length()<24){String key=names.next(),kind=inEnvelope.optString(key);if(evidenceKey(key)&&Arrays.asList("null","object","array","number","string","boolean").contains(kind))envelope.put(key,kind);}}safe.put("envelopeTypes",envelope);
            JSONArray samples=new JSONArray(),inSamples=frame.optJSONArray("samples");if(inSamples!=null)for(int j=0;j<Math.min(2,inSamples.length());j++){JSONObject row=inSamples.getJSONObject(j),fields=new JSONObject(),inFields=row.optJSONObject("fields");if(inFields!=null){Iterator<String> names=inFields.keys();while(names.hasNext()&&fields.length()<24){String key=names.next();JSONObject value=inFields.optJSONObject(key);if(!evidenceKey(key)||value==null)continue;String kind=value.optString("type");if(!Arrays.asList("null","object","array","number","string","boolean").contains(kind))continue;JSONObject field=new JSONObject().put("type",kind);String tag=value.optString("valueProof","");if(tag.matches("[a-f0-9]{64}"))field.put("valueProof",tag);if(value.has("fullTimestampWithZone"))field.put("fullTimestampWithZone",value.optBoolean("fullTimestampWithZone",false));fields.put(key,field);}}samples.put(new JSONObject().put("fields",fields).put("truncated",row.optBoolean("truncated",false)));}safe.put("samples",samples);frames.put(safe);
        }
        return out.put("frames",frames);
    }
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
