import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-frozen-v3-'));
try {
 fs.writeFileSync(path.join(dir,'FrozenV3Test.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.util.*;import java.io.*;
public class FrozenV3Test {
 static void ok(boolean b,String message){if(!b)throw new AssertionError(message);}
 static void fail(RunnableChecked r,String message)throws Exception{boolean rejected=false;try{r.run();}catch(Exception expected){rejected=true;}ok(rejected,message);}
 interface RunnableChecked{void run()throws Exception;}
 static JSONObject inventory()throws Exception{return new JSONObject().put("schemaVersion",3).put("generation","gen-1");}
 static JSONObject table()throws Exception{return new JSONObject().put("name","cash_fixture").put("columns",new JSONArray()
  .put(new JSONObject().put("name","big").put("notnull",1))
  .put(new JSONObject().put("name","blob").put("notnull",1))
  .put(new JSONObject().put("name","empty").put("notnull",1))
  .put(new JSONObject().put("name","nullable").put("notnull",0))
  .put(new JSONObject().put("name","unicode").put("notnull",1))
  .put(new JSONObject().put("name","safe").put("notnull",1))
  .put(new JSONObject().put("name","real").put("notnull",1))); }
 static JSONObject page()throws Exception{return new JSONObject().put("schemaVersion",3).put("generation","gen-1").put("table","cash_fixture");}
 static JSONObject row()throws Exception{
  JSONArray meta=new JSONArray().put(new JSONObject().put("name","big").put("type","integer").put("decimal","9223372036854775807"))
   .put(new JSONObject().put("name","blob").put("type","blob").put("bytes",4))
   .put(new JSONObject().put("name","empty").put("type","blob").put("bytes",0))
   .put(JSONObject.NULL).put(new JSONObject().put("name","unicode").put("type","text").put("bytes",90000))
   .put(JSONObject.NULL).put(new JSONObject().put("name","real").put("type","real").put("decimal","1.0"));
  return new JSONObject().put("_primaryRowid",1).put("_primaryOversize",meta.toString())
   .put("big",JSONObject.NULL).put("blob",JSONObject.NULL).put("empty",JSONObject.NULL)
   .put("nullable",JSONObject.NULL).put("unicode",JSONObject.NULL).put("safe",9007199254740991L).put("real",JSONObject.NULL);
 }
 static NativeFrozenExportV3.CellReader reader() {
  return (table,rowid,column,offset,size)->{
   byte[] data=column.equals("blob")?new byte[]{0,(byte)255,(byte)128,1}:new byte[90000];
   if(column.equals("unicode"))Arrays.fill(data,(byte)'A');
   StringBuilder hex=new StringBuilder();for(int i=offset;i<offset+size;i++)hex.append(String.format("%02x",data[i]&255));
   return new JSONObject().put("schemaVersion",3).put("generation","gen-1").put("table",table)
    .put("rowid",rowid).put("column",column).put("offset",offset).put("bytes",data.length)
    .put("kind",column.equals("blob")?"blob":"text").put("hex",hex.toString())
    .put("complete",offset+size==data.length);
  };
 }
 public static void main(String[] args)throws Exception {
  JSONObject inventory=inventory(),table=table(),page=page(),row=row();
  LinkedHashMap<String,Object> decoded=NativeFrozenExportV3.decode(inventory,table,page,row,reader());
  ok(decoded.get("big") instanceof Long && ((Long)decoded.get("big"))==Long.MAX_VALUE,"exact 64-bit INTEGER");
  ok(Arrays.equals((byte[])decoded.get("blob"),new byte[]{0,(byte)255,(byte)128,1}),"exact BLOB bytes");
  ok(((byte[])decoded.get("empty")).length==0 && decoded.get("nullable")==null,"empty BLOB differs from SQL NULL");
  ok(((String)decoded.get("unicode")).length()==90000,"multi-chunk deferred text");
  ok(((Long)decoded.get("safe"))==9007199254740991L,"safe integer");
  ok(decoded.get("real") instanceof Double && ((Double)decoded.get("real")).doubleValue()==1.0,"REAL 1.0 stays REAL");
  JSONObject fractional=new JSONObject(row().toString());JSONArray fm=new JSONArray(fractional.getString("_primaryOversize"));
  fm.getJSONObject(6).put("decimal","0.10000000000000001");fractional.put("_primaryOversize",fm.toString());
  ok(Double.doubleToLongBits((Double)NativeFrozenExportV3.decode(inventory,table,page,fractional,reader()).get("real"))==Double.doubleToLongBits(0.1),"REAL fraction binary64");
  fm.getJSONObject(6).put("decimal","1.0e-300");fractional.put("_primaryOversize",fm.toString());
  ok((Double)NativeFrozenExportV3.decode(inventory,table,page,fractional,reader()).get("real")==1e-300,"REAL exponent");
  fm.getJSONObject(6).put("decimal","NaN");fractional.put("_primaryOversize",fm.toString());
  fail(()->NativeFrozenExportV3.decode(inventory,table,page,fractional,reader()),"reject NaN REAL");
  fm.getJSONObject(6).put("decimal","1.0e9999");fractional.put("_primaryOversize",fm.toString());
  fail(()->NativeFrozenExportV3.decode(inventory,table,page,fractional,reader()),"reject infinite REAL");
  JSONObject signedRow=new JSONObject(row().toString()).put("safe",-9007199254740991L);
  ok(((Long)NativeFrozenExportV3.decode(inventory,table,page,signedRow,reader()).get("safe"))==-9007199254740991L,"negative signed safe integer");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),new JSONObject(page().toString()).put("schemaVersion",2),row(),reader()),"reject stale v2");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),new JSONObject(page().toString()).put("generation","other"),row(),reader()),"reject generation mismatch");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("big",5),reader()),"reject inline/deferred conflict");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("safe",9007199254740992L),reader()),"reject unsafe inline integer");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("real",1.0),reader()),"reject REAL descriptor conflict");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("safe",JSONObject.NULL),reader()),"reject missing NOT NULL");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("_primaryRowid",0),reader()),"reject zero rowid");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),new JSONObject(row().toString()).put("rogue","unexpected"),reader()),"reject unknown field");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),row(),(t,id,c,o,s)->new JSONObject(reader().read(t,id,c,o,s).toString()).put("generation","other")),"reject cross-generation cell");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),row(),(t,id,c,o,s)->new JSONObject(reader().read(t,id,c,o,s).toString()).put("hex","00")),"reject truncated cell");
  fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),row(),(t,id,c,o,s)->new JSONObject(reader().read(t,id,c,o,s).toString()).put("complete",false)),"reject wrong completion");
  JSONObject bad=new JSONObject(row().toString());JSONArray m=new JSONArray(bad.getString("_primaryOversize"));m.getJSONObject(0).put("decimal","9223372036854775808");bad.put("_primaryOversize",m.toString());
  final JSONObject overflow=bad;fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),overflow,reader()),"reject 64-bit overflow");
  bad=new JSONObject(row().toString());m=new JSONArray(bad.getString("_primaryOversize"));m.getJSONObject(1).put("bytes",NativeFrozenExportV3.MAX_CELL_BYTES+1);bad.put("_primaryOversize",m.toString());
  final JSONObject tooBig=bad;fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),tooBig,reader()),"reject oversized cell before allocation");
  bad=new JSONObject(row().toString());m=new JSONArray(bad.getString("_primaryOversize"));m.getJSONObject(1).put("bytes",4294967296L);bad.put("_primaryOversize",m.toString());
  final JSONObject wrapped=bad;fail(()->NativeFrozenExportV3.decode(inventory(),table(),page(),wrapped,reader()),"reject length overflow before integer cast");
  System.out.println("PASS native frozen D1 export v3: exact 64-bit, BLOB/empty/NULL, bounded Unicode, generation, malformed/overflow/cell-size rejection.");
 }
}
`);
 const jar=path.join(root,'vendor/json-java/json-20240303.jar');
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,path.join(dir,'FrozenV3Test.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/NativeFrozenExportV3.java')],{stdio:'inherit'});
 execFileSync('java',['-Xmx64m','-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.FrozenV3Test'],{stdio:'inherit',timeout:20000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}

// The same mandatory native CI gate also exercises transactional SQLite staging.
execFileSync(process.execPath,['scripts/test-native-frozen-import-v3.mjs'],{stdio:'inherit',timeout:90000});
