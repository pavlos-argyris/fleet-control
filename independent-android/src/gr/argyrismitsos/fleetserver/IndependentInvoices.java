package gr.argyrismitsos.fleetserver;
import android.content.*;import org.json.*;import java.io.*;import java.net.*;import java.util.*;

/** Existing local PDF/OCR pipeline, bounded one-job lane; no Workers AI or cloud file transport. */
public final class IndependentInvoices {
 private final Context context;private final IndependentRuntime runtime;private final FleetDataStore store;private final LocalWorkQueue queue;private long next;
 IndependentInvoices(Context context,IndependentRuntime runtime)throws Exception{this.context=context;this.runtime=runtime;store=new FleetDataStore(context);queue=new LocalWorkQueue(new LocalWorkQueue.Storage(){public JSONObject read(){return store.getLocalWorkState();}public void write(JSONObject value){store.setLocalWorkState(value);}});}
 private Map<String,String> headers(){return new HashMap<String,String>();}
 void tick(){long now=System.currentTimeMillis();if(now<next)return;next=now+5000;
  try{
   JSONObject pending=runtime.internal("/api/server/pending?limit=10&queue=invoices&local=1&combined=1","GET",null);JSONArray jobs=pending.optJSONArray("operations");if(jobs==null)return;
   // Pending source is canonical local SQLite; a removed/completed job may not be replayed from a stale queue.
   JSONArray known=new JSONArray(),old=queue.known();Set<String> active=new HashSet<String>();for(int i=0;i<jobs.length();i++)active.add(jobs.getJSONObject(i).getString("id"));for(int i=0;i<old.length();i++)known.put(new JSONObject().put("id",old.getString(i)).put("status",active.contains(old.getString(i))?"pending":"completed"));queue.reconcile(jobs,known,null);
   JSONArray ready=queue.ready(now);if(ready.length()==0)return;JSONObject job=ready.getJSONObject(0);String id=job.getString("id");
   if(!ServerWorkTracker.begin(context,"independent-invoice","Τιμολόγια","Τοπική επεξεργασία μίας εργασίας"))return;
   try{
    String kind=job.optString("type");JSONObject result;
    if(kind.equals("service_document_reprocess_batch")){batch();return;}
    JSONObject payload=job.getJSONObject("payload");if(payload.has("documentKey")){
     JSONObject local=job.optJSONObject("localResult");if(local==null){local=read(payload.getString("documentKey"),payload.optString("name","invoice.pdf"),payload.optBoolean("forceRead"));queue.update(id,"localResult",local);}
     result=runtime.internal("/api/server/service-documents/analysis-result","POST",new JSONObject().put("jobId",id).put("localOcr",local));
    }else result=render(id,payload);
    runtime.internal("/api/server/ack","POST",new JSONObject().put("ids",new JSONArray().put(id)));queue.update(id,"localComplete",true);stage("Η τοπική επεξεργασία ολοκληρώθηκε.");
   }catch(Exception error){queue.update(id,"retryAt",now+60000);runtime.internal("/api/server/operation-error","POST",new JSONObject().put("jobId",id).put("error","Η τοπική ανάγνωση χρειάζεται έλεγχο. Το αρχικό τιμολόγιο και οι προηγούμενες επιβεβαιώσεις διατηρούνται.").put("retryable",true));next=now+60000;stage("Η ανάγνωση θα επαναληφθεί τοπικά. Δεν χρησιμοποιείται εξωτερικό AI.");}finally{ServerWorkTracker.finish("independent-invoice");}
  }catch(Exception error){next=now+60000;stage("Η τοπική ουρά τιμολογίων θα ελεγχθεί ξανά.");}
 }
 private void stage(String text){context.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("invoice",text).apply();}
 private JSONObject read(String key,String name,boolean force)throws Exception{
  if(!key.startsWith("service-documents/")||key.contains(".."))throw new IOException("Invalid local invoice key");File file=ServiceDocumentStore.localFile(context,key,name);if(!file.isFile())FleetHttp.downloadToFile(runtime.realm()+"/api/service-documents/"+UriPath(key),file,headers());
  return InvoicePipeline.read(context,file,"",force,new InvoicePipeline.Progress(){public void stage(String text){IndependentInvoices.this.stage(text);}});
 }
 private JSONObject render(String id,JSONObject payload)throws Exception{
  String url=payload.getString("qrUrl"),host=new URI(url).getHost();if(host==null||host.endsWith(".workers.dev")||host.endsWith(".cloudflare.com"))throw new IOException("Invalid independent invoice origin");
  ServiceDocumentRenderer.RenderedDocument document=ServiceDocumentRenderer.renderToPdfWithText(context,url,"independent-"+id+".pdf",new java.util.concurrent.atomic.AtomicBoolean());File file=document.output;
  try{JSONObject local=InvoicePipeline.read(context,file,document.pageText,false,text->stage(text));String endpoint=runtime.realm()+"/api/server/service-documents/rendered?jobId="+q(id)+"&bikeId="+q(payload.getString("bikeId"))+"&entryId="+q(payload.getString("entryId"))+"&qrValue="+q(payload.optString("qrValue"))+"&qrUrl="+q(url)+"&name="+q("invoice-"+id+".pdf");return FleetHttp.putInvoice(endpoint,file,local,headers());}finally{file.delete();}
 }
 private void batch()throws Exception{
  JSONObject state=runtime.internal("/api/server/service-documents/reprocess-batch?window=1","GET",null),batch=state.optJSONObject("batch");if(batch==null||state.optBoolean("complete"))return;
  if(batch.optString("mode").equals("workers-ai")){runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","pause").put("batchId",batch.getString("id")).put("error","Η ανεξάρτητη εγκατάσταση υποστηρίζει τοπική ανάγνωση. Επίλεξε Server-first."));return;}
  JSONObject item=state.optJSONArray("items")!=null&&state.getJSONArray("items").length()>0?state.getJSONArray("items").getJSONObject(0):state.optJSONObject("item");if(item==null)return;
  JSONObject local=read(item.getString("key"),item.optString("name","invoice.pdf"),item.optBoolean("forceRead"));runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","result").put("batchId",batch.getString("id")).put("index",batch.optInt("currentIndex")).put("id",item.optString("id")).put("key",item.getString("key")).put("localOcr",local));
 }
 private static String q(String value)throws Exception{return URLEncoder.encode(value,"UTF-8");}
 private static String UriPath(String key){return android.net.Uri.encode(key,"/");}
 void close(){store.close();}
}
