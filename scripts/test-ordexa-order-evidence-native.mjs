import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-order-evidence-'));
const compiler=path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
const jar=path.resolve('vendor/json-java/json-20240303.jar');
try{
 fs.writeFileSync(path.join(dir,'OrderEvidenceTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import java.net.*;import java.io.*;import java.util.*;import javax.net.ssl.*;import org.json.*;
public class OrderEvidenceTest {
 static int network=0,closed=0,status=200;static String media="application/json; charset=utf-8";
 static JSONObject payload;static void check(boolean x,String message){if(!x)throw new AssertionError(message);}
 static class Wire extends HttpsURLConnection {
  Wire(URL u){super(u);}public void connect(){}public void disconnect(){closed++;}public boolean usingProxy(){return false;}
  public String getCipherSuite(){return "synthetic-test-only";}public java.security.cert.Certificate[] getLocalCertificates(){return null;}public java.security.cert.Certificate[] getServerCertificates(){return null;}
  public int getResponseCode(){return status;}public String getContentType(){return media;}
  public InputStream getInputStream()throws IOException{return new ByteArrayInputStream(payload.toString().getBytes("UTF-8"));}
 }
 static JSONObject row(int id)throws Exception{return new JSONObject().put("id",id).put("providerRiderReference",17).put("shopId",7).put("at","2026-11-07T04:59:00+02:00").put("status","test-status-not-verified").put("riderName","PRIVATE-NICKNAME-SENTINEL").put("customerEmail","PRIVATE-CONTACT-SENTINEL").put("authorization","PRIVATE-TOKEN-SENTINEL").put("nested",new JSONObject().put("address","PRIVATE-ADDRESS-SENTINEL"));}
 public static void main(String[] args)throws Exception{
  payload=new JSONObject().put("page",1).put("pages",22).put("total",1055).put("rows",new JSONArray().put(row(1)).put(row(2)));
  URL.setURLStreamHandlerFactory(protocol->"https".equals(protocol)?new URLStreamHandler(){protected URLConnection openConnection(URL url){network++;return new Wire(url);}}:null);
  OrdexaClient client=new OrdexaClient();client.token("PRIVATE-AUTHORIZATION-SENTINEL");client.storesOrders("7","2026-11-06","2026-11-07",1,null);
  JSONObject metadata=client.ordersHttpObservation();check(network==1&&closed==1,"one existing request and connection release");check(metadata.getBoolean("transportObserved")&&metadata.getInt("status")==200,"observed HTTPS transport metadata");
  check(metadata.getInt("responseBytes")==payload.toString().getBytes("UTF-8").length,"actual UTF8 body bytes");check(metadata.getLong("durationMs")>=0,"monotonic duration");check(!metadata.toString().contains("PRIVATE-")&&!metadata.toString().contains("cityId=7"),"no authorization, URL values or payload in HTTP metadata");
  JSONObject first=StoreBillingProtocol.observeOrders("scope-one",payload,metadata,1),second=StoreBillingProtocol.observeOrders("scope-one",payload,metadata,1);
  String tag=first.getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("providerRiderReference").getString("valueProof");
  check(tag.equals(second.getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("providerRiderReference").getString("valueProof")),"stable keyed same-scope proof without a guessed rider adapter");
  JSONObject other=StoreBillingProtocol.observeOrders("scope-two",payload,metadata,1);check(!tag.equals(other.getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("providerRiderReference").getString("valueProof")),"different source scopes cannot share proof tags");
  check(!first.toString().contains("PRIVATE-")&&!first.toString().contains("test-status-not-verified")&&!first.toString().contains("2026-11-07T04:59"),"all row values pseudonymized; no names, contacts, status assumptions or exact row timestamps exported");
  check(!first.getBoolean("automaticWritesEnabled")&&!first.getBoolean("semanticsVerified"),"an observation never authorizes automatic money");check(first.getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("at").getBoolean("fullTimestampWithZone"),"timezone evidence without assigning timestamp meaning");
  JSONObject report=new JSONObject().put("schemaVersion",1).put("observedAt",first.getString("observedAt")).put("frames",new JSONArray().put(first).put(second));
  report.put("authorization","PRIVATE-RESTORE-SENTINEL").put("automaticWritesEnabled",true);first.put("rawBody","PRIVATE-RESTORE-SENTINEL");first.getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("id").put("valueProof","PRIVATE-RESTORE-SENTINEL");
  JSONObject safe=StoreBillingProtocol.evidenceView(new JSONObject(report.toString()));check(!safe.toString().contains("PRIVATE-")&&!safe.getBoolean("automaticWritesEnabled"),"restored evidence is reprojected through the allowlist, never trusted as approval");
  for(int count:new int[]{0,1,50,51,1055}){JSONArray rows=new JSONArray();for(int i=0;i<count;i++)rows.put(row(i));payload.put("rows",rows);JSONObject frame=StoreBillingProtocol.observeOrders("scope-one",payload,metadata,1);check(frame.getInt("rowsOnPage")==count&&frame.getJSONArray("samples").length()==Math.min(2,count),"bounded observation, not a claim of complete pagination");check(frame.toString().getBytes("UTF-8").length<16000,"bounded evidence memory/cell");}
  OrdexaClient fake=new OrdexaClient((u,m,b,t)->payload);fake.token("synthetic-only");fake.storesOrders("7","2026-11-06","2026-11-07",1,null);check(!fake.ordersHttpObservation().getBoolean("transportObserved"),"mock transport cannot masquerade as observed HTTPS");
  for(int code:new int[]{401,403,429,503}){status=code;try{client.storesOrders("7","2026-11-06","2026-11-07",1,null);throw new AssertionError("status not rejected");}catch(OrdexaClient.HttpFailure expected){check(expected.statusCode==code,"original status preserved");}check(client.ordersHttpObservation().getInt("status")==code,"failed HTTPS observation status");}
  check(network==closed,"every response released");
  System.out.println("PASS actual Java Ordexa HTTPS observation and bounded deidentified evidence: synthetic URL transport only, privacy/restore projection/scope/0-1055-row sampling/error status/no automatic-write approval. No live provider call or verified rider contract.");
 }
}`);
 const pkg='server-android/src/gr/argyrismitsos/fleetserver/';
 execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,...['OrdexaClient','StoreBillingEngine','StoreBillingProtocol'].map(n=>pkg+n+'.java'),path.join(dir,'OrderEvidenceTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.OrderEvidenceTest'],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
