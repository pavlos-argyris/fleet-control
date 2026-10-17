import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-offload-'));
try{
for(const f of ['JSONObject.java','JSONArray.java'])fs.copyFileSync(path.join(root,'scripts/fixtures/java-json',f),path.join(temp,f));
fs.writeFileSync(path.join(temp,'OffloadTest.java'),`import gr.argyrismitsos.fleetserver.*;import org.json.*;public class OffloadTest{
 static void check(boolean b){if(!b)throw new AssertionError();}
 static class Disk implements LocalWorkQueue.Storage{String raw="{}";public JSONObject read(){return new JSONObject(raw);}public void write(JSONObject o){raw=o.toString();}}
 public static void main(String[] args)throws Exception{
 Disk disk=new Disk();LocalWorkQueue queue=new LocalWorkQueue(disk);JSONObject job=new JSONObject().put("id","a").put("type","service_document_render");
 queue.reconcile(new JSONArray().put(job),null,null);queue.update("a","localResult",new JSONObject().put("totalAmount","59"));queue.update("a","retryAt",100L);
 queue=new LocalWorkQueue(disk);check(queue.ready(99).length()==0);check(queue.ready(101).getJSONObject(0).getJSONObject("localResult").getString("totalAmount").equals("59"));
 queue.reconcile(new JSONArray().put(new JSONObject(job.toString())),null,null);check(queue.ready(101).getJSONObject(0).has("localResult"));
 queue.update("a","localComplete",true);check(!queue.hasWork());check(queue.acknowledgements().length()==1);queue=new LocalWorkQueue(disk);check(queue.ready(1000).length()==0);
 queue.reconcile(null,null,new JSONArray().put("a"));check(queue.known().length()==0);
 queue.reconcile(new JSONArray().put(job),null,null);queue.reconcile(null,new JSONArray().put(new JSONObject().put("id","a").put("status","cancelled")),null);check(!queue.hasWork());
 check(SyncPollPolicy.seconds(30,false,2,0)==60);check(86400/SyncPollPolicy.seconds(10,false,10,0)==1440);check(SyncPollPolicy.seconds(60,true,100,0)==10);check(SyncPollPolicy.seconds(30,false,0,1)==15);check(SyncPollPolicy.seconds(30,true,0,8)==120);
 check(FleetAuditReport.cents("1.234,50")==123450L);check(FleetAuditReport.cents("1,234.50")==123450L);check(FleetAuditReport.cents("-9,00")==-900L);check(FleetAuditReport.cents("1.234")==123400L);check(FleetAuditReport.cents("1,23,50")==null);check(FleetAuditReport.cents("")==null);
 JSONArray files=new JSONArray().put(new JSONObject().put("key","a").put("ocr",new JSONObject().put("totalAmount","9"))).put(new JSONObject().put("key","b").put("ocr",new JSONObject().put("totalAmount","50").put("odometerKm","11000")));
 JSONObject first=new JSONObject().put("id","first").put("date","2026-10-01").put("km",10000).put("attachments",files);
 JSONObject lower=new JSONObject().put("id","lower").put("date","2026-10-02").put("km",9000);
 JSONObject bike=new JSONObject().put("id","b").put("name","BTO 756").put("history",new JSONArray().put(first).put(lower));JSONObject snapshot=new JSONObject().put("version",31).put("bikes",new JSONArray().put(bike));String original=snapshot.toString();JSONObject report=FleetAuditReport.build(snapshot);
 check(report.getLong("costCents")==5900);check(report.getLong("unknownCosts")==1);check(report.getLong("missingInvoices")==1);check(report.getLong("mileageWarnings")==1);check(report.getLong("invoiceKmDifferences")==1);check(report.getLong("snapshotVersion")==31);check(snapshot.toString().equals(original));
 lower.put("kmAcknowledgments",new JSONArray().put(new JSONObject().put("signature",new JSONArray().put("first").put("2026-10-01").put(10000).put("lower").put("2026-10-02").put(9000).toString()).put("reason","Αλλαγή κοντέρ").put("at","now")));
 check(FleetAuditReport.build(snapshot).getLong("mileageWarnings")==0);
 lower.put("attachments",new JSONArray().put(new JSONObject().put("key","a").put("ocr",new JSONObject().put("totalAmount","9"))).put(new JSONObject().put("key","credit").put("ocr",new JSONObject().put("totalAmount","-10"))));
 report=FleetAuditReport.build(snapshot);check(report.getLong("costCents")==4900);check(report.getLong("possibleDuplicates")==1);check(report.getLong("unknownCosts")==0);
 System.out.println("OK actual native durable queue: process restart, saved OCR, retries, cancellation, acknowledgements; adaptive polling; read-only versioned report, cents/credits, costs 9+50, unknown amounts, duplicate keys and bound chronology acknowledgements.");
 }} `);
const native=['LocalWorkQueue','SyncPollPolicy','FleetAuditReport'].map(n=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',n+'.java'));
execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.join(temp,'JSONObject.java'),path.join(temp,'JSONArray.java'),...native,path.join(temp,'OffloadTest.java')],{stdio:'inherit'});
execFileSync('java',['-cp',temp,'OffloadTest'],{stdio:'inherit'});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
