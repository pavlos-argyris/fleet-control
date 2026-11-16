(function(root){
 'use strict';
 const AGE=300000,MAX_BYTES=8*1024*1024,views=new Map(),pdfs=new Map();
 const allowed=path=>/^\/api\/(workforce\/(dashboard|vehicles|employees|shifts|schedules)(\?|$)|employee\/home(\?|$)|admin\/(employees|schedules|schedule-week|payroll|pay-rules|ordexa-server\/(dashboard|shifts|payroll)|service-documents|alerts|audit|recycle|settings)(\?|$)|native\/(cash(?:\/rules|\/automatic)?|store-financials|payroll-review|health)(\?|$))/.test(path);
 function partition(user,token=''){if(!user?.id)return '';return JSON.stringify([user.id,user.role,[...(user.permissions||[])].sort(),token]);}
 const key=(user,path,token)=>partition(user,token)+':'+path;
 const clone=value=>JSON.parse(JSON.stringify(value));
 function cleanup(){try{for(let i=localStorage.length-1;i>=0;i--){const name=localStorage.key(i);if(name?.startsWith('fleet-view-cache-v1:')||name?.startsWith('fleet-shared-read-v1:')&&!name.endsWith(':generation'))localStorage.removeItem(name);}}catch{}try{root.indexedDB?.deleteDatabase?.('fleet-recent-pdfs');}catch{}}
 function read(user,path,token){if(!user||!allowed(path))return null;const item=views.get(key(user,path,token));if(!item||Date.now()-item.at>AGE)return null;return clone(item);}
 function save(user,path,data,token){try{if(!user||!allowed(path))return false;const item={at:Date.now(),data:clone(data)},text=JSON.stringify(item);if(text.length>1500000)return false;views.set(key(user,path,token),item);let bytes=0;for(const [name,row]of [...views].reverse()){bytes+=JSON.stringify(row).length*2;if(bytes>MAX_BYTES||Date.now()-row.at>AGE)views.delete(name);}return true;}catch{return false;}}
 function invalidate(){views.clear();pdfs.clear();cleanup();}
 function clear(){invalidate();root.FleetSharedReads?.clear();}
 root.FleetViewCache={read,save,clear,invalidate};
 root.FleetPdfCache={async get(user,path,token){const item=user&&pdfs.get(key(user,path,token));return item&&Date.now()-item.at<AGE?item.blob:null;},async put(user,path,blob,token){if(!user?.id||blob.size>15*1024*1024)return;pdfs.delete(key(user,path,token));pdfs.set(key(user,path,token),{at:Date.now(),blob});let bytes=0,count=0;for(const [name,row]of [...pdfs].reverse()){bytes+=row.blob.size;if(++count>4||bytes>16*1024*1024||Date.now()-row.at>AGE)pdfs.delete(name);}},async clear(){pdfs.clear();cleanup();}};
 cleanup();
})(window);
