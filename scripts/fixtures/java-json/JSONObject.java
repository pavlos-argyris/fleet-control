package org.json;
import java.util.*;
/** Test-only JSON value facade. Serialization retains a deep copy for round-trip tests. */
public class JSONObject {
 public static final Object NULL=new Object(){public String toString(){return "null";}};
 static final Map<String,Object> snapshots=new HashMap<String,Object>();
 final Map<String,Object> values=new LinkedHashMap<String,Object>();
 public JSONObject(){}
 public JSONObject(String s){if("{}".equals(s))return;Object copy=cloneValue(snapshots.get(s));if(!(copy instanceof JSONObject))throw new IllegalArgumentException("No test fixture JSON: "+s);values.putAll(((JSONObject)copy).values);}
 public JSONObject put(String k,Object v){values.put(k,v==null?NULL:v);return this;}
 public Object opt(String k){return values.get(k);}public Object get(String k){if(!values.containsKey(k))throw new IllegalArgumentException(k);return values.get(k);}
 public boolean has(String k){return values.containsKey(k);}public boolean isNull(String k){return !has(k)||get(k)==NULL;}
 public Iterator<String> keys(){return values.keySet().iterator();}
 public JSONObject getJSONObject(String k){return (JSONObject)get(k);}public JSONObject optJSONObject(String k){return opt(k) instanceof JSONObject?(JSONObject)opt(k):null;}
 public JSONArray getJSONArray(String k){return (JSONArray)get(k);}public JSONArray optJSONArray(String k){return opt(k) instanceof JSONArray?(JSONArray)opt(k):null;}
 public String getString(String k){return String.valueOf(get(k));}public String optString(String k){return optString(k,"");}public String optString(String k,String d){return isNull(k)?d:String.valueOf(opt(k));}
 public long getLong(String k){return Long.parseLong(getString(k));}public long optLong(String k){return optLong(k,0);}public long optLong(String k,long d){try{return getLong(k);}catch(Exception e){return d;}}
 public int optInt(String k){return optInt(k,0);}public int optInt(String k,int d){return (int)optLong(k,d);}
 public boolean optBoolean(String k){return optBoolean(k,false);}public boolean optBoolean(String k,boolean d){return has(k)?Boolean.parseBoolean(getString(k)):d;}
 static Object cloneValue(Object v){if(v instanceof JSONObject){JSONObject c=new JSONObject();for(Map.Entry<String,Object> e:((JSONObject)v).values.entrySet())c.put(e.getKey(),cloneValue(e.getValue()));return c;}if(v instanceof JSONArray){JSONArray a=new JSONArray();for(Object e:((JSONArray)v).values)a.put(cloneValue(e));return a;}return v;}
 static String quote(String s){return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r")+"\"";}
 static String json(Object v){if(v==null||v==NULL)return "null";if(v instanceof String)return quote((String)v);if(v instanceof JSONObject){StringBuilder b=new StringBuilder("{");for(Map.Entry<String,Object> e:((JSONObject)v).values.entrySet()){if(b.length()>1)b.append(',');b.append(quote(e.getKey())).append(':').append(json(e.getValue()));}return b.append('}').toString();}if(v instanceof JSONArray){StringBuilder b=new StringBuilder("[");for(Object e:((JSONArray)v).values){if(b.length()>1)b.append(',');b.append(json(e));}return b.append(']').toString();}return String.valueOf(v);}
 public String toString(){String s=json(this);snapshots.put(s,cloneValue(this));return s;}
}
