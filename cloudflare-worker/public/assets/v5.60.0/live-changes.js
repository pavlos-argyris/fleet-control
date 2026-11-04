(function(root){
 'use strict';
 let current=null,controller=null;
 function start(config){
  const identity=config.token+'|'+config.user?.id+'|'+JSON.stringify(config.user?.permissions||[]);
  if(current===identity)return controller;stop();current=identity;
  let disposed=false,leader=false,connected=false,ws=null,bus=null,timer=null,ping=null,retry=null,release=null,locking=false,failures=0,realm='',retryAt=0,scopeTimer=null,scopes=new Set(),lastState=0,lastMessage=Date.now();
  const id=root.crypto?.randomUUID?.()||Math.random().toString(36).slice(2),active=()=>!disposed&&!document.hidden&&(!config.isActive||config.isActive());
  function deliver(values){for(const s of values||[])if(['fleet','invoices','workforce','status','stores'].includes(s))scopes.add(s);if(!scopeTimer)scopeTimer=setTimeout(()=>{scopeTimer=null;const list=[...scopes];scopes.clear();root.FleetSharedReads?.invalidate(list);config.onChange?.(list);},450);}
  function state(value){connected=value;lastState=Date.now();if(leader)bus?.postMessage({type:'state',connected:value});}
  function closeSocket(){clearInterval(ping);ping=null;if(ws){ws.onclose=null;ws.onmessage=null;ws.onerror=null;ws.close();ws=null;}state(false);}
  async function connect(){
   if(!active()||!leader||ws||Date.now()<retryAt)return;
   try{
    const response=await root.fetch(config.apiBase+'/api/events/ticket',{method:'POST',headers:{Authorization:'Bearer '+config.token},cache:'no-store'});
    if(!response.ok){if(response.status===401||response.status===403)retryAt=Date.now()+300000;throw new Error('ticket');}
    const data=await response.json();if(!active()||!leader)return;
    const url=new URL(data.path,config.apiBase||root.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',data.ticket);
    lastMessage=Date.now();ws=new WebSocket(url.href);
    ws.onmessage=event=>{lastMessage=Date.now();if(event.data==='pong')return;let data;try{data=JSON.parse(event.data);}catch{return;}
     if(data.type==='ready'){failures=0;state(true);deliver(['fleet','invoices','workforce','status']);}
     if(data.type==='changed'){bus?.postMessage(data);deliver(data.scopes);}
    };
    ws.onclose=()=>{ws=null;clearInterval(ping);ping=null;state(false);failures++;retryAt=Math.max(retryAt,Date.now()+Math.min(60000,2000*2**Math.min(failures,5))+Math.random()*1500);};
    ws.onerror=()=>{};
    ping=setInterval(()=>{if(ws?.readyState===WebSocket.OPEN)ws.send('ping');},45000);
   }catch{failures++;state(false);retryAt=Math.max(retryAt,Date.now()+Math.min(60000,3000*2**Math.min(failures,5)));}
  }
  function yieldLeader(){if(!leader)return;closeSocket();leader=false;if(release){release();release=null;}try{const value=JSON.parse(localStorage.getItem('fleet-live:'+realm)||'null');if(value?.id===id)localStorage.removeItem('fleet-live:'+realm);}catch{}}
  function takeLease(){try{const key='fleet-live:'+realm,value=JSON.parse(localStorage.getItem(key)||'null');if(!value||value.until<Date.now()||value.id===id){localStorage.setItem(key,JSON.stringify({id,until:Date.now()+13000}));leader=true;connect();}else{leader=false;if(Date.now()-lastState>15000)connected=false;}}catch{leader=true;connect();}}
  async function tick(){
   if(!active()){yieldLeader();connected=false;return;}if(!realm)return;
   if(leader){if(ws&&Date.now()-lastMessage>100000)closeSocket();if(!root.navigator.locks?.request)takeLease();else connect();return;}
   if(root.navigator.locks?.request){if(locking)return;locking=true;root.navigator.locks.request('fleet-live:'+realm,{ifAvailable:true},async lock=>{locking=false;if(!lock||!active())return;leader=true;connect();await new Promise(resolve=>{release=resolve;});}).catch(()=>{locking=false;takeLease();});}
   else takeLease();
   if(!leader&&bus)bus.postMessage({type:'state-request'});
  }
  function visibility(){tick();}
  controller={connected:()=>active()&&connected,stop(){disposed=true;clearInterval(timer);clearInterval(ping);clearTimeout(retry);clearTimeout(scopeTimer);yieldLeader();closeSocket();bus?.close();document.removeEventListener('visibilitychange',visibility);root.removeEventListener('online',visibility);}};
  (async()=>{
   if(!root.FleetSharedReads||!root.WebSocket)return;realm=await root.FleetSharedReads.realm(config.user,config.token);if(disposed||!realm)return;
   try{bus=new BroadcastChannel('fleet-live:'+realm);bus.onmessage=e=>{const data=e.data;if(data?.type==='changed')deliver(data.scopes);if(data?.type==='state'){connected=!!data.connected;lastState=Date.now();}if(data?.type==='state-request'&&leader)bus.postMessage({type:'state',connected});};}catch{}
   document.addEventListener('visibilitychange',visibility);root.addEventListener('online',visibility);timer=setInterval(tick,5000);tick();
  })();return controller;
 }
 function stop(){controller?.stop();controller=null;current=null;}
 root.FleetLive={start,stop,connected:()=>!!controller?.connected()};
})(window);
