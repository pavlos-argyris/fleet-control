(function(root){
  'use strict';const PREFIX='fleet-primary-private-v1:',memory=new Map();let opened;
  function database(){
    if(!root.indexedDB)return Promise.resolve(null);
    if(!opened)opened=new Promise(resolve=>{let done=false;const timer=setTimeout(()=>{done=true;resolve(null);},4000);try{const request=root.indexedDB.open('fleet-primary-private-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'id'});request.onsuccess=()=>{clearTimeout(timer);if(done){request.result.close();return;}resolve(request.result);};request.onerror=request.onblocked=()=>{clearTimeout(timer);resolve(null);};}catch{clearTimeout(timer);resolve(null);}});return opened;
  }
  async function read(id){const db=await database();if(!db){try{const value=root.localStorage.getItem(PREFIX+id);return value?JSON.parse(value):memory.get(id)||null;}catch{return memory.get(id)||null;}}
    return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readonly'),request=transaction.objectStore('records').get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(Error('Δεν διαβάστηκε η ιδιωτική προσωρινή αποθήκευση.'));});
  }
  async function write(value,durable=false){
    const db=await database();if(!db){try{root.localStorage.setItem(PREFIX+value.id,JSON.stringify(value));return;}catch{if(durable)throw Error('Δεν αποθηκεύτηκε η ταυτότητα ενέργειας στη συσκευή. Το προσχέδιο διατηρήθηκε.');memory.set(value.id,value);return;}}
    return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readwrite');transaction.objectStore('records').put(value);transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(Error('Δεν αποθηκεύτηκε η ιδιωτική προσωρινή εγγραφή.'));});
  }
  async function remove(id){const db=await database();memory.delete(id);if(!db){try{root.localStorage.removeItem(PREFIX+id);}catch{}return;}return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readwrite');transaction.objectStore('records').delete(id);transaction.oncomplete=resolve;transaction.onerror=transaction.onabort=()=>reject(Error('Δεν αποδεσμεύτηκε η προσωρινή εγγραφή.'));});}
  async function claim(value){
    const db=await database();
    if(!db){if(!root.navigator?.locks?.request)throw Error('Δεν υποστηρίζεται ασφαλής αποθήκευση ταυτότητας ενέργειας. Το προσχέδιο διατηρήθηκε.');return root.navigator.locks.request(PREFIX+value.id,async()=>{const prior=await read(value.id);if(prior)return prior;await write(value,true);return value;});}
    return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readwrite'),records=transaction.objectStore('records'),request=records.get(value.id);let selected;request.onsuccess=()=>{selected=request.result||value;if(!request.result)records.put(value);};transaction.oncomplete=()=>resolve(selected);transaction.onerror=transaction.onabort=()=>reject(Error('Δεν δεσμεύτηκε η ταυτότητα ενέργειας. Το προσχέδιο διατηρήθηκε.'));});
  }
  async function all(){const db=await database();if(!db){const records=[...memory.values()];try{for(let i=0;i<root.localStorage.length;i++){const key=root.localStorage.key(i);if(key?.startsWith(PREFIX)){const value=JSON.parse(root.localStorage.getItem(key));if(value)records.push(value);}}}catch{}return records;}return new Promise((resolve,reject)=>{const request=db.transaction('records','readonly').objectStore('records').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Δεν φορτώθηκε η ιδιωτική προσωρινή αποθήκευση.'));});}
  async function clearReads(origin,actor){for(const value of await all())if(value.kind==='cache'&&(!origin||value.origin===origin)&&(!actor||value.actor===actor))await remove(value.id);}
  async function trim(){const records=(await all()).filter(v=>v.kind==='cache').sort((a,b)=>b.at-a.at);let bytes=0;for(let i=0;i<records.length;i++){bytes+=records[i].bytes||0;if(i>=40||bytes>30*1024*1024||Date.now()-records[i].at>7*86400000)await remove(records[i].id);}}
  root.FleetPrimaryStorage={read,write,remove,claim,all,clearReads,trim};
})(window);
