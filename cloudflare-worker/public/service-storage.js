(function(root){'use strict';let pending;
  function db(){if(!pending)pending=new Promise((resolve,reject)=>{if(!root.indexedDB)return reject(new Error('Δεν είναι διαθέσιμη η αποθήκευση προσχεδίων.'));const r=root.indexedDB.open('fleet-service-drafts-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('records',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>{pending=null;reject(r.error);};});return pending;}
  async function run(mode,fn){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('records',mode),r=fn(tx.objectStore('records'));let result;r.onsuccess=()=>{result=r.result};tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Αποτυχία αποθήκευσης προσχεδίου.'));});}
  const id=(scope,kind,key)=>[scope,kind,key].join('|');
  async function claim(scope,kind,key,data,queuedAt=new Date().toISOString()){
    const d=await db();
    return new Promise((resolve,reject)=>{
      const tx=d.transaction('records','readwrite'),store=tx.objectStore('records'),request=store.get(id(scope,kind,key));
      let record;
      request.onsuccess=()=>{
        record=request.result;
        if(record&&!record.data.syncError)return;
        record={id:id(scope,kind,key),scope,kind,key,data:{...data,id:record?.data.id||data.id},at:record?.at||queuedAt};
        store.put(record);
      };
      tx.oncomplete=()=>resolve(record);
      tx.onabort=tx.onerror=()=>reject(tx.error||new Error('Αποτυχία αποθήκευσης καταχώρισης.'));
    });
  }
  async function list(scope,kind){
    const prefix=id(scope,kind,'');
    const range=root.IDBKeyRange?.bound(prefix,prefix+'\uffff');
    return (await run('readonly',store=>range?store.getAll(range):store.getAll())).filter(row=>row.scope===scope&&row.kind===kind);
  }
  root.FleetServiceStorage={claim,get:(s,k,v)=>run('readonly',o=>o.get(id(s,k,v))),put:(s,k,v,data)=>run('readwrite',o=>o.put({id:id(s,k,v),scope:s,kind:k,key:v,data,at:new Date().toISOString()})),remove:(s,k,v)=>run('readwrite',o=>o.delete(id(s,k,v))),list};
})(globalThis);
