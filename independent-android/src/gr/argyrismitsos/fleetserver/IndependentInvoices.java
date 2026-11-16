package gr.argyrismitsos.fleetserver;
import android.content.*;import org.json.*;import java.io.*;import java.net.*;import java.util.*;import java.util.concurrent.*;

/** Two bounded Direct PDF lanes; the shared heavy OCR lane remains one. */
public final class IndependentInvoices {
 private final Context context;private final IndependentRuntime runtime;private final FleetDataStore store;private final LocalWorkQueue queue;
 private final ExecutorService workers=Executors.newFixedThreadPool(2);private final Set<String> running=new HashSet<String>();private boolean closed,storeClosed;private long next;
 IndependentInvoices(Context c,IndependentRuntime r)throws Exception{context=c;runtime=r;store=new FleetDataStore(c);queue=new LocalWorkQueue(new LocalWorkQueue.Storage(){public JSONObject read(){return store.getLocalWorkState();}public void write(JSONObject v){store.setLocalWorkState(v);}});}
 private Map<String,String> headers(){return new HashMap<String,String>();}
 synchronized void tick(){long now=System.currentTimeMillis();if(closed||now<next)return;next=now+5000;
  try{
   JSONObject health=DeviceHealth.collect(context);long available=Runtime.getRuntime().maxMemory()-Runtime.getRuntime().totalMemory()+Runtime.getRuntime().freeMemory();int slots=DirectInvoiceRetry.parallelism(health.optString("thermalStatus"),health.optDouble("batteryTemperatureC",0),available);
   JSONArray known=queue.known();if(known.length()>200)throw new IOException("Invoice queue capacity");
   JSONObject pending=runtime.internal("/api/server/pending?limit=50&queue=invoices&local=1&combined=1&known="+q(known.toString()),"GET",null);JSONArray jobs=pending.optJSONArray("operations");if(jobs==null)return;
   queue.reconcile(jobs,pending.optJSONArray("known"),null);
   JSONArray retained=queue.ready(Long.MAX_VALUE);for(int i=0;i<retained.length();i++){JSONObject row=retained.getJSONObject(i);if("review".equals(row.optString("directState"))&&!row.optString("type").equals("service_document_reprocess_batch"))terminal(row,row.optInt("directAttempts"),row.optString("directLastError","invalid-input"));}
   JSONArray ready=queue.ready(now);
   for(int i=0;i<ready.length()&&running.size()<slots;i++){
    final JSONObject job=ready.getJSONObject(i);final String id=job.getString("id");if(running.contains(id))continue;
    int attempts=Math.max(job.optInt("directAttempts"),job.getJSONObject("payload").optInt("directAttemptCount"));
    if(attempts>=6){terminal(job,attempts,"retry-exhausted");continue;}
    if(!job.getJSONObject("payload").has("documentKey")&&!job.optString("type").equals("service_document_reprocess_batch")&&!health.optBoolean("networkConnected",false)){queue.patch(id,new JSONObject().put("directState","offline").put("retryAt",now+5000));continue;}
    final String lane="independent-invoice-"+id;if(!ServerWorkTracker.begin(context,lane,"Τιμολόγια","Τοπική επεξεργασία · "+(attempts+1)+"/6"))break;
    final int attempt=attempts+1;try{queue.patch(id,new JSONObject().put("directAttempts",attempt).put("directState","running").put("directStartedAt",now));}catch(Exception failure){ServerWorkTracker.finish(lane);throw failure;}running.add(id);
    try{workers.execute(()->process(job,attempt,lane));}catch(RejectedExecutionException stopped){running.remove(id);ServerWorkTracker.finish(lane);queue.patch(id,new JSONObject().put("directAttempts",attempts).put("directState","paused"));}
   }
  }catch(Exception error){next=now+15000;stage("Η τοπική ουρά θα ελεγχθεί ξανά. Τα αρχικά τιμολόγια διατηρούνται.");}
 }
 private boolean current(String id)throws Exception{JSONObject state=runtime.internal("/api/server/pending?limit=1&queue=invoices&local=1&combined=1&known="+q(new JSONArray().put(id).toString()),"GET",null);JSONArray values=state.optJSONArray("known");return values!=null&&values.length()==1&&"pending".equals(values.getJSONObject(0).optString("status"));}
 private void process(JSONObject job,int attempt,String lane){String id=job.optString("id");boolean batch=job.optString("type").equals("service_document_reprocess_batch");
  try{
   if(!current(id))return;
   if(batch){batch();queue.patch(id,new JSONObject().put("directAttempts",0).put("retryAt",0).put("directState","queued"));return;}
   runtime.internal("/api/server/operation-progress","POST",new JSONObject().put("jobId",id).put("progress",5).put("lightweight",true).put("directAttemptCount",attempt).put("stage","Τοπική ανάγνωση · προσπάθεια "+attempt+"/6"));
   JSONObject payload=job.getJSONObject("payload");
   if(payload.has("documentKey")){
    JSONObject local=job.optJSONObject("localResult");if(local==null){local=read(payload.getString("documentKey"),payload.optString("name","invoice.pdf"),payload.optBoolean("forceRead"));queue.update(id,"localResult",local);}
    if(!current(id))return;runtime.internal("/api/server/service-documents/analysis-result","POST",new JSONObject().put("jobId",id).put("localOcr",local));
   }else render(id,payload);
   runtime.internal("/api/server/ack","POST",new JSONObject().put("ids",new JSONArray().put(id)));queue.patch(id,new JSONObject().put("localComplete",true).put("directState","completed"));stage("Η τοπική επεξεργασία ολοκληρώθηκε.");
  }catch(InterruptedException|CancellationException stopped){Thread.currentThread().interrupt();try{queue.patch(id,new JSONObject().put("directState","paused").put("retryAt",System.currentTimeMillis()+10000));}catch(Exception ignored){}
  }catch(Exception error){try{
    boolean offline=!DeviceHealth.collect(context).optBoolean("networkConnected",false)&&!job.getJSONObject("payload").has("documentKey");
    if(offline){queue.patch(id,new JSONObject().put("directAttempts",Math.max(0,attempt-1)).put("directState","offline").put("retryAt",System.currentTimeMillis()+5000));stage("Χωρίς δίκτυο · οι προσπάθειες δεν καταναλώνονται.");}
    else if(!DirectInvoiceRetry.transientFailure(error)||attempt>=6){
     if(batch){queue.patch(id,new JSONObject().put("retryAt",Long.MAX_VALUE).put("directState","review"));JSONObject state=runtime.internal("/api/server/service-documents/reprocess-batch","GET",null);JSONObject b=state.optJSONObject("batch");if(b!=null)runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","pause").put("batchId",b.getString("id")).put("error","Η τοπική ανάγνωση χρειάζεται έλεγχο."));}
     else terminal(job,attempt,attempt>=6?"retry-exhausted":"invalid-input");
    }else{queue.patch(id,new JSONObject().put("directState","waiting").put("directLastError","temporary").put("retryAt",System.currentTimeMillis()+DirectInvoiceRetry.delay(attempt)));if(!batch)runtime.internal("/api/server/operation-error","POST",new JSONObject().put("jobId",id).put("error","Προσωρινή αποτυχία τοπικής ανάγνωσης· προγραμματίστηκε νέα προσπάθεια.").put("retryable",true).put("directAttemptCount",attempt));stage("Προγραμματίστηκε νέα τοπική προσπάθεια.");}
   }catch(Exception ignored){stage("Η ουρά διατηρήθηκε. Δεν επιβεβαιώθηκε η τελευταία προσπάθεια.");}
  }finally{ServerWorkTracker.finish(lane);synchronized(this){running.remove(id);closeStoreWhenIdle();}}
 }
 private void terminal(JSONObject job,int attempt,String code)throws Exception{String id=job.getString("id");queue.patch(id,new JSONObject().put("directAttempts",attempt).put("directState","review").put("directLastError",code).put("retryAt",Long.MAX_VALUE));if(job.optString("type").equals("service_document_reprocess_batch")){JSONObject state=runtime.internal("/api/server/service-documents/reprocess-batch","GET",null),batch=state.optJSONObject("batch");if(batch!=null)runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","pause").put("batchId",batch.getString("id")).put("error","Εξαντλήθηκαν οι τοπικές προσπάθειες. Η θέση και τα αρχεία διατηρούνται."));return;}runtime.internal("/api/server/operation-error","POST",new JSONObject().put("jobId",id).put("error",code.equals("retry-exhausted")?"Εξαντλήθηκαν οι 6 τοπικές προσπάθειες. Το αρχικό αρχείο και οι επιβεβαιώσεις διατηρούνται.":"Το αρχείο ή η πρόσβαση χρειάζεται ανθρώπινο έλεγχο. Το αρχικό τιμολόγιο διατηρείται.").put("retryable",false).put("terminal",true).put("directAttemptCount",attempt).put("code",code));}
 private void stage(String text){context.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("invoice",text).apply();}
 private JSONObject read(String key,String name,boolean force)throws Exception{
  if(!key.startsWith("service-documents/")||key.contains(".."))throw new DirectInvoiceRetry.InvalidInput("Invalid local invoice key");File file=ServiceDocumentStore.localFile(context,key,name);if(!file.isFile())FleetHttp.downloadToFile(runtime.realm()+"/api/service-documents/"+android.net.Uri.encode(key,"/"),file,headers());
  if(!file.isFile()||file.length()==0||file.length()>15L*1024*1024)throw new DirectInvoiceRetry.InvalidInput("Invalid local invoice file");
  return InvoicePipeline.read(context,file,"",force,text->stage(text));
 }
 private void render(String id,JSONObject payload)throws Exception{
  String url=payload.getString("qrUrl");URI uri=new URI(url);String host=uri.getHost();if(!"https".equalsIgnoreCase(uri.getScheme())||host==null||host.endsWith(".workers.dev")||host.endsWith(".cloudflare.com"))throw new DirectInvoiceRetry.InvalidInput("Invalid independent invoice origin");
  ServiceDocumentRenderer.RenderedDocument document=ServiceDocumentRenderer.renderToPdfWithText(context,url,"independent-"+id+".pdf",new java.util.concurrent.atomic.AtomicBoolean());File file=document.output;
  try{JSONObject local=InvoicePipeline.read(context,file,document.pageText,false,text->stage(text));if(!current(id))return;String endpoint=runtime.realm()+"/api/server/service-documents/rendered?jobId="+q(id)+"&bikeId="+q(payload.getString("bikeId"))+"&entryId="+q(payload.getString("entryId"))+"&qrValue="+q(payload.optString("qrValue"))+"&qrUrl="+q(url)+"&name="+q("invoice-"+id+".pdf");FleetHttp.putInvoice(endpoint,file,local,headers());}finally{file.delete();}
 }
 private void batch()throws Exception{
  JSONObject state=runtime.internal("/api/server/service-documents/reprocess-batch?window=2","GET",null),batch=state.optJSONObject("batch");if(batch==null||state.optBoolean("complete"))return;
  if(batch.optString("mode").equals("workers-ai")){runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","pause").put("batchId",batch.getString("id")).put("error","Η Direct εγκατάσταση υποστηρίζει μόνο τοπική ανάγνωση."));return;}
  JSONObject item=state.optJSONObject("item");if(item==null)return;JSONArray items=state.optJSONArray("items");JSONObject second=items!=null&&items.length()>1?items.getJSONObject(1):null;Future<JSONObject> prepared=null;
  synchronized(this){if(second!=null&&!second.optString("key").isEmpty()&&running.size()==1&&!closed){final JSONObject nextItem=second;prepared=workers.submit(()->read(nextItem.getString("key"),nextItem.optString("name","invoice.pdf"),nextItem.optBoolean("forceRead")));}}
  try{
   JSONObject result=new JSONObject().put("action","result").put("batchId",batch.getString("id")).put("index",batch.optInt("currentIndex")).put("id",item.optString("id"));
   if(!item.optString("key").isEmpty())result.put("key",item.getString("key")).put("localOcr",read(item.getString("key"),item.optString("name","invoice.pdf"),item.optBoolean("forceRead")));runtime.internal("/api/server/service-documents/reprocess-batch","POST",result);
   if(prepared!=null){JSONObject local=prepared.get(180,TimeUnit.SECONDS),fresh=runtime.internal("/api/server/service-documents/reprocess-batch?window=1","GET",null),current=fresh.optJSONObject("batch"),nextItem=fresh.optJSONObject("item");if(current!=null&&nextItem!=null&&current.optString("id").equals(batch.optString("id"))&&nextItem.optString("id").equals(second.optString("id"))&&nextItem.optString("key").equals(second.optString("key")))runtime.internal("/api/server/service-documents/reprocess-batch","POST",new JSONObject().put("action","result").put("batchId",current.getString("id")).put("index",current.optInt("currentIndex")).put("id",nextItem.optString("id")).put("key",nextItem.getString("key")).put("localOcr",local));}
  }finally{if(prepared!=null&&!prepared.isDone())prepared.cancel(true);}
 }
 private static String q(String value)throws Exception{return URLEncoder.encode(value,"UTF-8");}
 private synchronized void closeStoreWhenIdle(){if(closed&&running.isEmpty()&&!storeClosed){storeClosed=true;store.close();}}
 void close(){synchronized(this){closed=true;workers.shutdownNow();closeStoreWhenIdle();}}
}
