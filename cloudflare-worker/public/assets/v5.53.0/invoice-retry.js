(function(root){
  'use strict';
  function identity(record){return String(record.key||record.jobId||[record.bikeId,record.entryId,record.qrUrl].join('|'));}
  function eligible(record){
    return Boolean(record && record.status==='error' &&
      ((record.key&&(record.error||record.canRetry))||record.jobId||record.invoiceData?.qrJobId||(record.canRestart&&record.qrUrl)));
  }
  function candidates(records){
    const seen=new Set();return (records||[]).filter(record=>{if(!eligible(record))return false;const key=identity(record);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function create(options){
    const pending=new Map();let active=null;
    const context=()=>options.context?.()||'';
    function retry(record){
      const key=identity(record),scope=context(),scoped=scope+'|'+key;
      if(pending.has(scoped))return pending.get(scoped);
      const request=Promise.resolve().then(()=>{if(context()!==scope)throw new Error('Η σύνδεση άλλαξε. Η επανάληψη δεν υποβλήθηκε.');return options.submit(record);}).finally(()=>pending.delete(scoped));
      pending.set(scoped,request);return request;
    }
    function batch(records){
      if(active)return active;
      const items=candidates(records),scope=context();
      const progress={total:items.length,processed:0,queued:0,completed:0,skipped:0,failed:0,failures:[],done:false};
      const notify=()=>{if(context()===scope)options.onProgress?.({...progress,failures:progress.failures.slice()});};
      active=Promise.resolve().then(async()=>{
        notify();
        for(const record of items){
          if(context()!==scope){progress.cancelled=true;break;}
          progress.currentName=record.name||record.bikeName||'Τιμολόγιο';notify();
          try{
            const result=await retry(record);
            if(result.ocrWarning||result.document?.error||result.status==='error'||result.ok===false)throw new Error(result.ocrWarning||result.document?.error||result.error||'Η ανάγνωση απέτυχε.');
            if(result.busy||result.skipped)progress.skipped++;
            else if(result.queued||['processing','requesting'].includes(result.status))progress.queued++;
            else progress.completed++;
          }catch(error){progress.failed++;progress.failures.push({id:record.id,name:progress.currentName,error:error.message||'Η υποβολή δεν επιβεβαιώθηκε.'});}
          progress.processed++;notify();
        }
        progress.done=true;notify();return progress;
      }).finally(()=>{active=null;});
      return active;
    }
    return {retry,batch,busy:()=>Boolean(active),pending:record=>pending.has(context()+'|'+identity(record))};
  }
  root.FleetInvoiceRetry={identity,eligible,candidates,create};
})(typeof window==='undefined'?globalThis:window);
