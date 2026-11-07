import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {storeSqliteFixture} from './fixtures/native-store-sqlite.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-cash-source-')),jar=path.resolve('vendor/json-java/json-20240303.jar');
try{
 const stubs=storeSqliteFixture(dir);
 fs.writeFileSync(path.join(dir,'CashSourceTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.util.*;
public class CashSourceTest {
 static String scope="synthetic-observed-schema",day="2026-11-07";static int rider=17;static String name="Synthetic nickname";
 static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 static JSONObject source(int id)throws Exception{
  long at=OrdexaClient.instant(day+"T09:00:00Z")+id*1000L;java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));
  return new JSONObject().put("id",id).put("riderId",rider).put("rider",name).put("shopId",7).put("shop","Synthetic shop")
    .put("at",f.format(new Date(at))).put("area","Synthetic area").put("charge",999999).put("common",2).put("dayShare",0)
    .put("hoursShare",0).put("income",123456).put("km",JSONObject.NULL).put("orderPay",0).put("profit",12345).put("riderCost",99999)
    .put("straight",true).put("tooFar",false).put("topUp",0).put("zeroCharge",true);
 }
 static JSONObject page(int start,int count,int requested,int total)throws Exception{
  JSONArray rows=new JSONArray();for(int i=start;i<start+count;i++)rows.put(source(i));
  return new JSONObject().put("page",requested).put("pages",total==0?0:(total+49)/50).put("total",total).put("rows",rows).put("options",new JSONObject()).put("sums",new JSONObject());
 }
 static void stage(OrdexaCashSourceStore cash,String run,int n)throws Exception{
  for(int p=1;p<=Math.max(1,(n+49)/50);p++){JSONObject raw=page((p-1)*50,Math.min(50,n-(p-1)*50),p,n),validated=StoreBillingProtocol.page(raw,p,null,new HashSet<String>(Arrays.asList("7")));cash.stage(scope,run,day,"city:"+p,raw,validated,Long.MAX_VALUE);}
 }
 static JSONObject coverage(StoreBillingStore store)throws Exception{return store.get(StoreBillingStore.key("cash-coverage",scope,day));}
 public static void main(String[] args)throws Exception{
  check(StoreBillingStore.key("cash-refresh","report-fixture","2026-11-04").equals("cash-refresh:b262616453381dde425c8d05f34f2db6959b917228efd769918183e703e0c86a"),"shared JS/Java queue key contract");
  FleetDataStore fleet=new FleetDataStore();try{StoreBillingStore store=new StoreBillingStore(fleet);OrdexaCashSourceStore cash=new OrdexaCashSourceStore(store);String shop=StoreBillingStore.key("store",scope,"7");store.put(shop,"store",scope,shop,"",new JSONObject().put("id",shop).put("sourceShopId","7").put("retainOrders",false).put("name","Synthetic shop"),false);
   for(int n:new int[]{0,1,50,51,138,1055}){
    String run="orders-"+n;stage(cash,run+":p1",n);stage(cash,run+":p2",n);check(cash.digest(scope,run+":p1").equals(cash.digest(scope,run+":p2")),"stable same-time/full pagination identity digest");
    cash.promote(scope,run+":p2",day,day+"T12:00:00Z",true);JSONObject proof=coverage(store);
    check(proof.getBoolean("identityVerified")&&proof.getBoolean("ordersCoverageComplete")&&!proof.getBoolean("automaticWritesEnabled")&&proof.getBoolean("timeSemanticsVerified")&&proof.getBoolean("cancellationSemanticsVerified"),"owner-confirmed delivery/absence semantics are separate from financial completion");
    check(proof.getString("sourceDigest").matches("[a-f0-9]{64}")&&store.rows(scope,"cash_snapshot_order").length()==n,"complete bounded snapshot replaces old view");
    int events=store.rows(scope,"cash_source_event").length();cash.promote(scope,run+":p2",day,day+"T12:00:00Z",true);check(store.rows(scope,"cash_source_event").length()==events,"lost completion ACK is idempotent");
    check(store.dirty(scope).length()==0,"no raw identity/order/name is put into cloud outbox");store.cleanupTemporary(scope);
   }
   int before=store.rows(scope,"cash_source_event").length();String old=coverage(store).getString("runId");
   JSONObject raw=page(0,50,1,51);cash.stage(scope,"missing-last",day,"city:1",raw,StoreBillingProtocol.page(raw,1,null,new HashSet<String>(Arrays.asList("7"))),Long.MAX_VALUE);
   cash.promote(scope,"missing-last",day,day+"T12:00:00Z",true);check(!coverage(store).getBoolean("ordersCoverageComplete")&&coverage(store).getString("runId").equals(old)&&store.rows(scope,"cash_source_event").length()==before,"missing page cannot remove source orders or replace pointer even with caller success flag");store.cleanupTemporary(scope);
   stage(cash,"changed:p1",1);rider=18;stage(cash,"changed:p2",1);check(!cash.digest(scope,"changed:p1").equals(cash.digest(scope,"changed:p2")),"rider reassignment is detected independently of store/order/time digest");
   cash.promote(scope,"changed:p2",day,day+"T12:00:00Z",false);check(coverage(store).getString("runId").equals(old),"inconsistent reassignment retains old source view");store.cleanupTemporary(scope);
   stage(cash,"reassigned:p1",1);stage(cash,"reassigned:p2",1);cash.promote(scope,"reassigned:p2",day,day+"T12:00:00Z",true);store.cleanupTemporary(scope);
   before=store.rows(scope,"cash_source_event").length();name="Different alias";stage(cash,"rename:p1",1);stage(cash,"rename:p2",1);cash.promote(scope,"rename:p2",day,day+"T12:00:00Z",true);
   check(store.rows(scope,"cash_source_event").length()==before,"nickname change cannot create another financial identity event");check(store.rows(scope,"cash_rider_alias").length()>=2,"nicknames are preserved separately from ID mapping");store.cleanupTemporary(scope);
   JSONObject normalized=OrdexaCashOrderProtocol.page(page(0,1,1,1),StoreBillingProtocol.page(page(0,1,1,1),1,null,new HashSet<String>(Arrays.asList("7")))).getJSONArray("rows").getJSONObject(0);
   check(!normalized.has("income")&&!normalized.has("charge")&&!normalized.has("riderCost")&&!normalized.has("zeroCharge"),"Ordexa money/zeroCharge cannot become cash or cancellation policy");
   JSONObject bad=page(0,1,1,1);bad.getJSONArray("rows").getJSONObject(0).put("riderId","guessed-string-id");JSONObject base=StoreBillingProtocol.page(bad,1,null,new HashSet<String>(Arrays.asList("7")));check(!OrdexaCashOrderProtocol.page(bad,base).getBoolean("identityVerified"),"unobserved rider schema fails closed without breaking the existing store adapter");
   // Failed promotion rolls back new events, aliases, pointer and old-source pruning together.
   String pointer=coverage(store).toString();before=store.rows(scope,"cash_source_event").length();rider=19;stage(cash,"rollback:p2",1);
   fleet.getWritableDatabase().execSQL("CREATE TRIGGER cash_fixture_fail BEFORE INSERT ON store_billing_local WHEN NEW.kind='cash_source_coverage' BEGIN SELECT RAISE(ABORT,'fixture cash commit failed'); END;");
   boolean rejected=false;try{cash.promote(scope,"rollback:p2",day,day+"T12:00:00Z",true);}catch(Exception expected){rejected=true;}fleet.getWritableDatabase().execSQL("DROP TRIGGER cash_fixture_fail");
   check(rejected&&coverage(store).toString().equals(pointer)&&store.rows(scope,"cash_source_event").length()==before,"atomic rollback preserves prior snapshot and observations");
   // A selective legacy store restore cannot erase the new cash source history.
   int snapshots=store.rows(scope,"cash_snapshot_order").length(),aliases=store.rows(scope,"cash_rider_alias").length();store.restore(store.exportRows());
   check(store.rows(scope,"cash_snapshot_order").length()==snapshots&&store.rows(scope,"cash_rider_alias").length()==aliases&&store.rows(scope,"cash_source_event").length()==before&&coverage(store).getBoolean("needsSourceRefresh")&&!coverage(store).getBoolean("ordersCoverageComplete"),"selective restore preserves cash source/history but invalidates freshness");
   // Compare-and-delete leaves a newer coalesced request in the shared reader queue.
   String key=StoreBillingStore.key("cash-refresh",scope,day);JSONObject request=new JSONObject().put("from",day).put("to",day).put("generation","g1").put("requestId","first");store.put(key,"cash_refresh_request",scope,"",day,request,false);
   JSONObject claimed=cash.nextRequest(scope,"g1");request.put("requestId","newer");store.put(key,"cash_refresh_request",scope,"",day,request,false);cash.acknowledge(claimed);check(cash.nextRequest(scope,"g1")!=null,"late ACK cannot discard newer refresh request");cash.acknowledge(cash.nextRequest(scope,"g1"));check(cash.nextRequest(scope,"g1")==null,"current request acknowledged exactly once");
   store.put(key,"cash_refresh_request",scope,"",day,request,false);check(cash.nextRequest(scope,"new-generation")==null,"credential/source generation change cannot execute old queued request");
   System.out.println("PASS real Java/SQLite Ordexa cash identity source: observed numeric schema,0/1/50/51/138/1055 pagination, repeat/rider change, no money inference/D1 raw writes, atomic snapshot/rollback/lost ACK, nickname history, incomplete retention, selective restore fencing and coalesced source-generation queue. Owner-confirmed delivery/absence semantics; source collection alone does not complete financial writes.");
  }finally{fleet.close();}
 }
}`);
 const provider='server-android/src/gr/argyrismitsos/fleetserver/';
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,...['OrdexaClient','StoreBillingEngine','StoreBillingProtocol','StoreBillingStore','OrdexaCashOrderProtocol','OrdexaCashSourceStore'].map(n=>provider+n+'.java'),...stubs,path.join(dir,'CashSourceTest.java')],{stdio:'inherit'});
 execFileSync('java',['-Dfixture.rpc='+path.join(dir,'sqlite_rpc.py'),'-Dfixture.db='+path.join(dir,'cash.sqlite'),'-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.CashSourceTest'],{stdio:'inherit',timeout:180000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
