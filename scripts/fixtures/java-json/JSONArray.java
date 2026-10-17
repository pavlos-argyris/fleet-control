package org.json;import java.util.*;
public class JSONArray{
 final List<Object> values=new ArrayList<Object>();public JSONArray(){}
 public JSONArray put(Object v){values.add(v==null?JSONObject.NULL:v);return this;}public int length(){return values.size();}
 public Object get(int i){return values.get(i);}public JSONObject getJSONObject(int i){return (JSONObject)get(i);}public JSONObject optJSONObject(int i){return i>=0&&i<length()&&get(i) instanceof JSONObject?(JSONObject)get(i):null;}
 public String getString(int i){return String.valueOf(get(i));}public long getLong(int i){return Long.parseLong(getString(i));}
 public String toString(){String s=JSONObject.json(this);JSONObject.snapshots.put(s,JSONObject.cloneValue(this));return s;}
}
