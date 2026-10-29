// Durable recovery uses the existing Server-owned batch and operation queue.
// Each request handles one result; originals and human decisions stay intact.
export function recoveryItems(items,clean,isKey){
 const seen=new Set();return items.map(item=>({id:clean(item?.id,160),key:clean(item?.key,500),name:clean(item?.name,240),jobId:clean(item?.jobId,120),bikeId:clean(item?.bikeId,100),entryId:clean(item?.entryId,120),qrUrl:clean(item?.qrUrl,3000)})).filter(item=>{
  if(!isKey(item.key)&&!(item.bikeId&&item.entryId&&(item.jobId||item.qrUrl)))return false;
  const identity=isKey(item.key)?item.key:JSON.stringify([item.bikeId,item.entryId,item.jobId||item.qrUrl]);
  if(seen.has(identity))return false;seen.add(identity);return true;
 });
}
export function recoveryResult(batch,item,index,{queued=false,failed=false,skipped=false,error='',document=null},now){
 const nextIndex=index+1,total=batch.items.length,status=failed?'error':queued?'queued':skipped?'skipped':document?.status==='confirmed'?'confirmed':'needs_review';
 const results=(batch.results||[]).concat({id:item.id,key:item.key,jobId:item.jobId||'',name:item.name,status,error:String(error||'').slice(0,500)});
 return {...batch,results,currentIndex:nextIndex,completed:nextIndex,total,
  failed:(Number(batch.failed)||0)+(failed?1:0),queued:(Number(batch.queued)||0)+(queued?1:0),
  skipped:(Number(batch.skipped)||0)+(skipped?1:0),
  status:nextIndex<total?'processing':failed||Number(batch.failed)>0?'completed_with_errors':'completed',
  progress:nextIndex>=total?100:Math.min(99,Math.round(nextIndex/total*100)),currentName:batch.items[nextIndex]?.name||'Η υποβολή ολοκληρώθηκε',currentStartedAt:now,updatedAt:now,completedAt:nextIndex>=total?now:'',error};
}
