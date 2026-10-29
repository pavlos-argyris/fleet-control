package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.util.*;
import java.text.SimpleDateFormat;
import java.math.BigDecimal;

/** Store billing only. Provider/order day changes at 05:00 Athens; payroll is independent. */
public final class StoreBillingEngine {
    public static final int VERSION=1;
    private static final TimeZone ATHENS=TimeZone.getTimeZone("Europe/Athens");
    public static String businessDay(long instant){
        Calendar c=Calendar.getInstance(ATHENS,Locale.US);c.setTimeInMillis(instant);
        if(c.get(Calendar.HOUR_OF_DAY)<5)c.add(Calendar.DAY_OF_MONTH,-1);
        return dayFormat().format(c.getTime());
    }
    public static String addDay(String day,int delta)throws Exception{
        OrdexaClient.day(day);Calendar c=Calendar.getInstance(ATHENS,Locale.US);c.setTime(dayFormat().parse(day));c.add(Calendar.DAY_OF_MONTH,delta);return dayFormat().format(c.getTime());
    }
    public static String monday(long instant)throws Exception{
        String day=businessDay(instant);Calendar c=Calendar.getInstance(ATHENS,Locale.US);c.setTime(dayFormat().parse(day));return addDay(day,-((c.get(Calendar.DAY_OF_WEEK)+5)%7));
    }
    private static SimpleDateFormat dayFormat(){SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(ATHENS);f.setLenient(false);return f;}
    public static long cents(Object value)throws Exception{
        if(!(value instanceof Number)&&!(value instanceof String))throw new IllegalArgumentException("Μη έγκυρη τιμή καταστήματος.");
        String s=String.valueOf(value);if(!s.matches("[0-9]+(?:\\.[0-9]{1,2})?"))throw new IllegalArgumentException("Η τιμή καταστήματος πρέπει να έχει έως δύο δεκαδικά.");
        long n=new BigDecimal(s).movePointRight(2).longValueExact();if(n<0||n>100000000)throw new IllegalArgumentException("Μεγάλη τιμή καταστήματος.");return n;
    }
    /** Sanitized bootstrap terms. Unsupported types remain visible, never silently zero. */
    public static JSONArray sourceTerms(JSONObject shop,boolean cityZero)throws Exception{
        JSONArray versions=shop.getJSONArray("versions"),result=new JSONArray();if(versions.length()>100)throw new IllegalArgumentException("Πολλές εκδόσεις όρων καταστήματος.");
        Set<String> days=new HashSet<String>();
        for(int i=0;i<versions.length();i++){
            JSONObject v=versions.getJSONObject(i),t=v.getJSONObject("terms");String from=v.isNull("from")?"":v.getString("from");if(from.length()>0)OrdexaClient.day(from);if(!days.add(from))throw new IllegalArgumentException("Διπλή ημερομηνία όρων καταστήματος.");
            String method=t.getString("method");boolean supported="fixed".equals(method)||"dailyMin".equals(method);
            JSONObject clean=new JSONObject().put("effectiveDay",from).put("origin","ordexa-bootstrap").put("supported",supported).put("method",method);
            if(t.has("zeroDays")&&!t.isNull("zeroDays")&&!(t.get("zeroDays") instanceof Boolean))throw new IllegalArgumentException("Άγνωστη πολιτική μηδενικών ημερών.");
            clean.put("chargeOnZero",t.isNull("zeroDays")?cityZero:t.getBoolean("zeroDays"));
            if(supported){long price=cents(t.get("perOrder")),minimum=0;
                if("dailyMin".equals(method)){Object n=t.get("minOrders");if(!(n instanceof Number)||new BigDecimal(n.toString()).signum()<0)throw new IllegalArgumentException("Μη έγκυρο ελάχιστο παραγγελιών.");minimum=new BigDecimal(n.toString()).multiply(BigDecimal.valueOf(price)).longValueExact();if(minimum>100000000)throw new IllegalArgumentException("Μεγάλο ημερήσιο ελάχιστο.");}
                clean.put("unitPriceCents",price).put("dailyMinimumCents",minimum);
            }
            result.put(clean);
        }
        return result;
    }
    public static JSONObject termsFor(JSONArray versions,String day)throws Exception{
        OrdexaClient.day(day);JSONObject selected=null;String last="";
        for(int i=0;i<versions.length();i++){JSONObject v=versions.getJSONObject(i);String from=v.getString("effectiveDay");if((from.length()==0||from.compareTo(day)<=0)&&(selected==null||from.compareTo(last)>=0)){selected=v;last=from;}}
        return selected;
    }
    public static JSONObject day(String store,String businessDay,long count,JSONObject terms,String sourceAt,int retained,int reviews)throws Exception{
        OrdexaClient.day(businessDay);if(count<0||count>10000000)throw new IllegalArgumentException("Μη έγκυρο πλήθος παραγγελιών.");
        JSONObject r=new JSONObject().put("storeId",store).put("businessDay",businessDay).put("orderCount",count).put("sourceLastSuccessAt",sourceAt).put("retainedOrders",retained).put("reviewCount",reviews).put("engineVersion",VERSION).put("cutoffHour",5).put("timeZone","Europe/Athens");
        if(terms==null||!terms.optBoolean("supported",true)||!terms.has("unitPriceCents"))return r.put("billingState","needs_terms").put("termsId",terms==null?"":terms.optString("id")).put("orderChargeCents",JSONObject.NULL).put("minimumTopUpCents",JSONObject.NULL).put("totalChargeCents",JSONObject.NULL);
        long price=terms.getLong("unitPriceCents"),minimum=terms.getLong("dailyMinimumCents");if(price<0||minimum<0||price>100000000||minimum>100000000)throw new IllegalArgumentException("Μη έγκυροι όροι Fleet.");
        // Bounds above keep the product below 10^15 (also exact in JSON/JS).
        long base=count*price,top=(count>0||terms.getBoolean("chargeOnZero"))?Math.max(0,minimum-base):0;
        return r.put("billingState",reviews>0?"review":"ready").put("termsId",terms.getString("id")).put("unitPriceCents",price).put("dailyMinimumCents",minimum).put("chargeOnZero",terms.getBoolean("chargeOnZero")).put("orderChargeCents",base).put("minimumTopUpCents",top).put("totalChargeCents",base+top);
    }
}
