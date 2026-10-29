import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-stores-'));
try{
 const pkg='server-android/src/gr/argyrismitsos/fleetserver/',jar='vendor/json-java/json-20240303.jar',compiler='.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar';
 fs.writeFileSync(path.join(dir,'StoresTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.util.*;
public class StoresTest {
 static int assertions=0;static void check(boolean b,String why){assertions++;if(!b)throw new AssertionError(why);}
 interface Work{void run()throws Exception;}static void denied(Work w,String why)throws Exception{boolean b=false;try{w.run();}catch(Exception e){b=true;}check(b,why);}
 static JSONObject term(long p,long m,boolean z)throws Exception{return new JSONObject().put("id","terms-1").put("effectiveDay","").put("unitPriceCents",p).put("dailyMinimumCents",m).put("chargeOnZero",z);}
 static JSONObject billing(long n,JSONObject t)throws Exception{return StoreBillingEngine.day("shop","2026-10-26",n,t,"2026-10-27T04:00:00Z",0,0);}
 public static void main(String[] args)throws Exception{
  for(String[] v:new String[][]{{"2026-10-27T04:59:59+02:00","2026-10-26"},{"2026-10-27T05:00:00+02:00","2026-10-27"},{"2026-10-26T02:30:00+02:00","2026-10-25"},{"2026-10-25T03:30:00+03:00","2026-10-24"},{"2026-10-25T03:30:00+02:00","2026-10-24"},{"2026-03-29T05:00:00+03:00","2026-03-29"},{"2027-01-01T01:00:00+02:00","2026-12-31"}})check(StoreBillingEngine.businessDay(OrdexaClient.instant(v[0])).equals(v[1]),"Athens05 cutoff/DST: "+v[0]);
  check(StoreBillingEngine.monday(OrdexaClient.instant("2026-10-26T04:30:00+02:00")).equals("2026-10-19"),"Sunday night remains previous week");
  check(StoreBillingEngine.monday(OrdexaClient.instant("2026-10-26T05:00:00+02:00")).equals("2026-10-26"),"new week exactly05");
  check(billing(9,term(200,4000,false)).getLong("totalChargeCents")==4000,"minimum is not additive");
  check(billing(25,term(200,4000,false)).getLong("totalChargeCents")==5000,"above minimum");
  check(billing(9,term(250,0,false)).getLong("totalChargeCents")==2250,"no minimum");
  check(billing(0,term(200,4000,false)).getLong("totalChargeCents")==0,"zero day off");
  check(billing(0,term(200,4000,true)).getLong("totalChargeCents")==4000,"zero day on");
  check(billing(9,term(0,0,false)).getLong("totalChargeCents")==0,"explicit free");
  check(billing(9,null).isNull("totalChargeCents"),"unknown is not free");
  JSONArray history=new JSONArray().put(term(200,4000,false)).put(term(250,4000,false).put("effectiveDay","2026-10-28"));
  check(StoreBillingEngine.termsFor(history,"2026-10-27").getLong("unitPriceCents")==200,"old terms retained");
  check(StoreBillingEngine.termsFor(history,"2026-10-28").getLong("unitPriceCents")==250,"effective day");
  check(StoreBillingEngine.termsFor(history,"2026-10-28").getLong("dailyMinimumCents")==4000,"changing price does not alter minimum");
  check(StoreBillingEngine.cents("2.50")==250,"exact money");
  denied(()->StoreBillingEngine.cents("2.005"),"no hidden rounding");denied(()->StoreBillingEngine.cents(-1),"no negative price");
  JSONObject setup=new JSONObject("{\"settings\":{\"chargeFixedOnZeroDays\":false},\"shops\":[{\"id\":7,\"name\":\"Synthetic\",\"blocked\":false,\"versions\":[{\"from\":null,\"terms\":{\"method\":\"dailyMin\",\"perOrder\":2,\"minOrders\":20,\"zeroDays\":null}}]}]}");
  JSONArray shops=StoreBillingProtocol.setup(setup);check(shops.length()==1&&shops.getJSONObject(0).getString("sourceShopId").equals("7"),"numeric ID normalized");
  JSONObject initial=shops.getJSONObject(0).getJSONArray("sourceTerms").getJSONObject(0);check(initial.getLong("dailyMinimumCents")==4000&&!initial.getBoolean("chargeOnZero"),"bootstrap exact minimum and city inheritance");
  setup.getJSONArray("shops").getJSONObject(0).getJSONArray("versions").getJSONObject(0).getJSONObject("terms").put("method","monthlyMin");check(!StoreBillingProtocol.setup(setup).getJSONObject(0).getJSONArray("sourceTerms").getJSONObject(0).getBoolean("supported"),"unsupported not silently converted");
  JSONObject page=new JSONObject("{\"page\":1,\"pages\":2,\"total\":51,\"rows\":[{\"id\":\"order1\",\"at\":\"2026-10-27T04:30:00+02:00\",\"shop\":\"ambiguous name\"}]}");
  Set<String> ids=new HashSet<String>(Arrays.asList("7"));check(StoreBillingProtocol.page(page,1,null,ids).getBoolean("needsShopFilter"),"no name-based mapping");
  JSONObject parsed=StoreBillingProtocol.page(page,1,"7",ids);check(parsed.getJSONArray("rows").getJSONObject(0).getString("businessDay").equals("2026-10-26"),"filtered shop request gives identity and05day");
  page.getJSONArray("rows").getJSONObject(0).put("shopId",8);denied(()->StoreBillingProtocol.page(page,1,"7",ids),"conflicting shop ID");page.getJSONArray("rows").getJSONObject(0).remove("shopId");
  page.getJSONArray("rows").getJSONObject(0).put("at","2026-10-27T04:30:00");denied(()->StoreBillingProtocol.page(page,1,"7",ids),"ambiguous timezone rejected");page.getJSONArray("rows").getJSONObject(0).put("at","2026-10-27T04:30:00+02:00");
  denied(()->StoreBillingProtocol.page(page,2,"7",ids),"wrong page");
  final List<String> calls=new ArrayList<String>();OrdexaClient c=new OrdexaClient((u,m,b,t)->{check(m.equals("GET")&&b==null,"only read requests");calls.add(u);return new JSONObject();});c.token("synthetic-only");c.storesSetup("7");c.storesOrders("7","2026-10-26","2026-10-27",2,"19");check(calls.get(1).endsWith("page=2&sort=at&dir=asc&shopId=19"),"bounded explicit pagination");
  int before=calls.size();denied(()->c.storesOrders("7","2026-10-26","2026-10-27",0,null),"invalid page before network");denied(()->c.storesOrders("7","2026-10-26","2026-10-27",1,"../settings"),"invalid shop before network");denied(()->c.storesSetup("7/../../settings"),"invalid city before network");check(calls.size()==before,"invalid input sent no request");
  OrdexaClient.HttpsTransport transport=new OrdexaClient.HttpsTransport();for(String method:new String[]{"PUT","DELETE","POST"})denied(()->transport.send("https://api.ordexa.gr/api/cities/7/setup",method,null,""),"provider writes blocked");
  denied(()->transport.send("https://api.ordexa.gr/api/cities/7/orders?from=2026-10-26&to=2026-10-27&page=1&sort=at&dir=asc&delete=1","GET",null,""),"unknown query blocked before network");
  System.out.println("PASS actual Java store engine/protocol: "+assertions+" assertions,05:00 day/DST/week, cents/minimum/history, strict setup/page/IDs, explicit shop filter fallback, read-only transport. No live provider calls.");
 }
}`);
 execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,...['OrdexaClient','StoreBillingEngine','StoreBillingProtocol'].map(n=>pkg+n+'.java'),path.join(dir,'StoresTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.StoresTest'],{stdio:'inherit'});
 const android='.android-toolchain/usr/share/java/com.android.android-23.jar';
 execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',android,'-d',path.join(dir,'sdk'),...['OrdexaClient','StoreBillingEngine','StoreBillingProtocol'].map(n=>pkg+n+'.java')],{stdio:'inherit'});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
