(function(root){
  'use strict';
  // Dialogs are a navigation layer, including in the embedded Fleet screen.
  const opened=[];let guard=false,pending=false,queued=false;
  const marker='fleetDialogNavigation';
  const own=()=>{for(let i=opened.length-1;i>=0;i--)if(!opened[i].isConnected||!opened[i].open)opened.splice(i,1);return opened.slice();};
  const guarded=()=>own().filter(d=>d.id!=='historyReportDialog');
  function ensure(){if(guard||pending||!guarded().length)return;try{history.pushState(Object.assign({},history.state,{[marker]:true}),'',location.href);guard=true;}catch(e){}}
  function cleanup(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!guarded().length&&guard&&!pending){guard=false;pending=true;history.back();}});}
  function closeTop(){const d=own().pop();if(!d)return false;const e=new Event('cancel',{cancelable:true});if(d.dispatchEvent(e)&&d.open)d.close();return true;}
  function back(){if(closeTop())return true;for(const f of document.querySelectorAll('iframe')){if(f.hidden||f.closest('.is-hidden')||f.getAttribute('aria-hidden')==='true')continue;try{if(f.contentWindow?.FleetNavigation?.back())return true;}catch(e){}}return false;}
  const proto=root.HTMLDialogElement?.prototype;
  if(proto){const show=proto.showModal;proto.showModal=function(){const result=show.apply(this,arguments);const index=opened.indexOf(this);if(index>=0)opened.splice(index,1);opened.push(this);if(!this.dataset.fleetBackTracked){this.dataset.fleetBackTracked='1';this.addEventListener('close',cleanup);}ensure();return result;};}
  root.addEventListener('popstate',e=>{if(pending){pending=false;e.stopImmediatePropagation();ensure();return;}if(!guard)return;guard=false;e.stopImmediatePropagation();closeTop();ensure();},true);
  root.FleetNavigation={back};
})(window);
