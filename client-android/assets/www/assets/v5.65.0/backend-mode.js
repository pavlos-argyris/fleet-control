(function(root){
  'use strict';
  const CLOUD='https://fleet-control.pavlosargyris.workers.dev',DIRECT='https://fleet-control.duckdns.org';
  const DIRECT_ONLY=true;
  const KEY='fleet-backend-selection-v1',network=root.fetch.bind(root),controllers=new Set();
  const discoveryOrigin=['localhost','127.0.0.1','[::1]'].includes(location.hostname)?location.origin:DIRECT;
  const valid=s=>s?.schema===1&&Number.isSafeInteger(s.revision)&&s.revision>=0&&['cloudflare','direct'].includes(s.activeMode)&&s.cloudUrl===CLOUD&&s.directUrl===DIRECT;
  let loaded=false,selection={schema:1,revision:0,activeMode:'cloudflare',selectedMode:'cloudflare',cloudUrl:CLOUD,directUrl:DIRECT,updatedAt:0},changing=false,lastContact=0,flight=null;
  try{const saved=JSON.parse(root.AndroidFleet?.getBackendSelection?.()||localStorage.getItem(KEY)||'null');if(valid(saved)){selection=saved;loaded=true;}}catch{}
  // Direct documents carry only this origin's accounts. A fresh Direct URL opens
  // the setup/probe UI without assuming an active production connection.
  const pageMode=DIRECT_ONLY?(location.origin===CLOUD||location.protocol==='file:'?'cloudflare':'direct'):(location.origin===DIRECT?'direct':'cloudflare'),setup=pageMode==='direct'&&new URL(location.href).searchParams.has('fleetSetup');
  if(!loaded&&pageMode==='direct')selection={...selection,activeMode:'direct',selectedMode:'direct'};
  if(setup)selection={...selection,activeMode:'direct'};
  if(DIRECT_ONLY){selection={...selection,activeMode:'direct',selectedMode:'direct',directOnly:true,localRecovery:false};try{persist(selection);}catch{}}
  // A Fleet iframe shares the parent's verified selection, not an independent
  // revision-zero boot. No extra discovery poll or reload is needed per frame.
  try{if(root!==root.top&&valid(root.top.FleetBackend?.selection)&&root.top.FleetBackend.confirmedAt){selection=root.top.FleetBackend.selection;lastContact=root.top.FleetBackend.confirmedAt;}}catch{}
  const destination=mode=>root.AndroidFleet?(mode==='direct'?DIRECT+'/':'file:///android_asset/www/portal.html'):(mode==='direct'?DIRECT:CLOUD)+'/';
  function persist(value){localStorage.setItem(KEY,JSON.stringify(value));root.AndroidFleet?.setBackendSelection?.(JSON.stringify(value));}
  function announce(message){root.dispatchEvent(new CustomEvent('fleet-backend-state',{detail:{...selection,lastContact,message}}));const label=document.getElementById('fleetBackendLabel');if(label)label.textContent=message;}
  function halt(){changing=true;for(const controller of controllers)controller.abort();controllers.clear();root.FleetLive?.stop();root.FleetSharedReads?.clear();root.FleetViewCache?.clear();}
  function apply(value,{local=false,navigate=true}={}){
    if(!valid(value))throw Error('Μη έγκυρη επιλογή λειτουργίας.');
    if(DIRECT_ONLY&&value.activeMode!=='direct')throw Error('Η επιλογή Cloudflare είναι προσωρινά ανενεργή. Η σύνδεση παραμένει μέσω Server.');
    if(!local&&value.revision<selection.revision)return false;
    const changed=value.activeMode!==selection.activeMode||value.revision!==selection.revision;
    if(!changed&&!selection.localRecovery)return false;
    halt();selection={...value,directOnly:DIRECT_ONLY,localRecovery:DIRECT_ONLY?false:local};persist(selection);
    announce(DIRECT_ONLY?'Direct Android Server · η σύνδεση ενημερώθηκε.':local?'Τοπική ανάκτηση Cloudflare · απαιτείται ξεχωριστή σύνδεση.':'Η λειτουργία άλλαξε. Απαιτείται σύνδεση στη συγκεκριμένη βάση.');
    if(navigate&&root.AndroidFleet?.openBackend){root.AndroidFleet.openBackend(value.activeMode);return true;}
    if(navigate){if(value.activeMode!==pageMode)location.replace(destination(value.activeMode));else location.reload();}
    return true;
  }
  async function discover(){
    if(flight)return flight;
    // Recovering locally never gets silently overridden by an older server
    // command. A newer revision can be adopted after explicit resumption.
    flight=(async()=>{try{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
      let response;try{response=await network(discoveryOrigin+'/fleet-mode.json',{credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});}finally{clearTimeout(timeout);}
      if(!response.ok)throw Error('discovery');const value=await response.json();if(!valid(value))throw Error('descriptor');lastContact=Date.now();
      if(setup&&value.activeMode!=='direct')announce('Προετοιμασία Direct · διαθέσιμα σύνδεση και έλεγχος 4G/5G.');else if(!selection.localRecovery)apply(value);else announce('Τοπική ανάκτηση · ο ενιαίος διακόπτης παραμένει '+(value.activeMode==='direct'?'Direct.':'Cloudflare.'));
    }catch{announce(DIRECT_ONLY?'Direct Android Server · η σύνδεση δεν επιβεβαιώθηκε. Έλεγξε τον Server και το δίκτυο.':(selection.activeMode==='direct'?'Direct Android Server':'Cloudflare')+' · τελευταία γνωστή επιλογή · δεν επιβεβαιώθηκε η ενημέρωση του διακόπτη.');}})().finally(()=>{flight=null;});return flight;
  }
  // Install before transports/polling. Old mutations are cancelled, never
  // rewritten to another backend, replayed or sent with another mode's token.
  root.fetch=async function(input,init){
    const request=new Request(input,init),url=new URL(request.url);if(!url.pathname.startsWith('/api/'))return network(request);
    if(DIRECT_ONLY&&url.origin===CLOUD)throw new DOMException('Η σύνδεση Cloudflare είναι προσωρινά ανενεργή.','AbortError');
    if(pageMode==='direct'&&!lastContact&&!url.pathname.startsWith('/api/auth/')&&!url.pathname.startsWith('/api/independent/'))await discover();
    if(changing||pageMode!==selection.activeMode&&!url.pathname.startsWith('/api/auth/')&&!url.pathname.startsWith('/api/independent/'))throw new DOMException('Η λειτουργία άλλαξε. Ανανέωσε τη σελίδα.','AbortError');
    const captured=selection.revision,controller=new AbortController(),abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)controller.abort();controllers.add(controller);
    try{const headers=new Headers(request.headers);if(pageMode==='direct')headers.set('X-Fleet-Backend-Revision',String(captured));const response=await network(new Request(request,{headers,signal:controller.signal}));if(changing||captured!==selection.revision)throw new DOMException('Η προηγούμενη απάντηση απορρίφθηκε.','AbortError');return response;}finally{controllers.delete(controller);request.signal?.removeEventListener('abort',abort);}
  };
  root.FleetBackend={directOnly:DIRECT_ONLY,get selection(){return {...selection};},get confirmedAt(){return lastContact;},key:name=>pageMode==='direct'?'direct:'+name:name,apply,discover,recoverCloud(){if(DIRECT_ONLY)throw Error('Η επιλογή Cloudflare είναι προσωρινά ανενεργή.');apply({...selection,activeMode:'cloudflare',selectedMode:'cloudflare'},{local:true});},resume(){selection.localRecovery=false;persist(selection);return discover();}};
  function mount(){if(root!==root.top)return;for(const link of document.querySelectorAll('a[href$="direct.html"]')){link.hidden=DIRECT_ONLY;link.style.display=DIRECT_ONLY?'none':'';}const bar=document.createElement('aside');bar.id='fleetBackendStatus';bar.className='fleet-backend-status';bar.setAttribute('aria-live','polite');const label=document.createElement('span');label.id='fleetBackendLabel';label.textContent=(DIRECT_ONLY?'Direct Android Server':pageMode==='direct'?'Direct Android Server':'Cloudflare')+(DIRECT_ONLY?' · σύνδεση μέσω Server':' · χωριστά δεδομένα');const recovery=document.createElement('button');recovery.type='button';recovery.textContent='Ανάκτηση Cloudflare';recovery.onclick=()=>root.FleetBackend.recoverCloud();const resume=document.createElement('button');resume.type='button';resume.textContent=DIRECT_ONLY?'Επανάληψη σύνδεσης':'Λήψη επιλογής Server';resume.onclick=()=>root.FleetBackend.resume();bar.append(label);if(!DIRECT_ONLY)bar.append(recovery);bar.append(resume);
    // Keep recovery visible before login, then inside the Portal workspace.
    // A sibling above the fixed-height Portal both hides text under its sidebar
    // and pushes the Fleet iframe below the viewport/bottom navigation.
    const portal=document.getElementById('portal'),shell=portal?.querySelector('.main-shell');
    const place=()=>{const settings=portal?.querySelector('section[data-view="server"]'),target=DIRECT_ONLY&&!setup?settings||document.body:shell&&!portal.classList.contains('is-hidden')?shell:document.body;bar.style.display=DIRECT_ONLY&&!setup&&!settings?'none':'';if(bar.parentNode!==target)target.prepend(bar);};
    place();if(portal)new MutationObserver(place).observe(portal,{attributes:true,attributeFilter:['class']});discover();}
  root.addEventListener('storage',event=>{if(event.key===KEY&&event.newValue){try{const value=JSON.parse(event.newValue);apply(value,{local:!!value.localRecovery});}catch{}}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
  if(root===root.top)setInterval(()=>{if(!document.hidden)discover();},15000);
  if(!setup&&selection.activeMode!==pageMode&&!selection.localRecovery){halt();if(root.AndroidFleet?.openBackend)root.AndroidFleet.openBackend(selection.activeMode);else location.replace(destination(selection.activeMode));}
})(window);
