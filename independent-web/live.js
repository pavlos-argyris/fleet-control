(function(root){
 'use strict';let controller;
 root.FleetLive={start(config){controller?.stop();let stopped=false,connected=false,events=null,timer=null;
  function close(){events?.close();events=null;connected=false;}
  function connect(){if(stopped||document.hidden||config.isActive&&!config.isActive()){close();return;}if(events)return;
   events=new EventSource('/api/independent/events');
   events.addEventListener('ready',()=>{connected=true;const scopes=['fleet','invoices','workforce','stores','cash','status'];root.FleetSharedReads?.invalidate(scopes);config.onChange?.(scopes);});
   events.addEventListener('changed',event=>{let message;try{message=JSON.parse(event.data);}catch{return;}root.FleetSharedReads?.invalidate(message.scopes);config.onChange?.(message.scopes);});
   events.onerror=()=>{connected=false;};
  }
  const visibility=()=>connect();document.addEventListener('visibilitychange',visibility);timer=setInterval(connect,5000);connect();controller={connected:()=>connected&&!stopped&&!document.hidden,stop(){stopped=true;clearInterval(timer);close();document.removeEventListener('visibilitychange',visibility);}};return controller;
 },stop(){controller?.stop();controller=null;},connected:()=>!!controller?.connected()};
})(window);
