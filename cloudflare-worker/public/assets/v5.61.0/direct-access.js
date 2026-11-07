(function () {
  'use strict';
  const base = location.protocol === 'https:' ? location.origin : 'https://fleet-control.pavlosargyris.workers.dev';
  const $ = id => document.getElementById(id), labels = {fleet:'Μηχανάκια',employees:'Εργαζόμενοι',schedules:'Πρόγραμμα',shifts:'Παρουσίες Ordexa',stores:'Καταστήματα'};
  const fields = {name:'Όνομα',full_name:'Ονοματεπώνυμο',employee_name:'Εργαζόμενος',role:'Ρόλος',active:'Ενεργός',currentKm:'Χιλιόμετρα',nextServiceKm:'Επόμενο service',lastServiceKm:'Τελευταίο service',lastCheckedAt:'Τελευταίος έλεγχος',assigned_vehicle_id:'Ανάθεση μηχανής',vehicle_id:'Μηχανάκι',start_at:'Έναρξη',end_at:'Λήξη',status:'Κατάσταση',provider_day:'Ημέρα πηγής',in_at:'Πραγματικό Clock In',out_at:'Πραγματικό Clock Out',review:'Χρειάζεται έλεγχο',ignored:'Εξαιρείται',day:'Ημέρα 05:00–05:00',updated_at:'Τελευταία ενημέρωση',last_seen:'Τελευταία εμφάνιση στην πηγή',blocked:'Αποκλεισμένο',retainOrders:'Διατήρηση παραγγελιών',orderCount:'Παραγγελίες',orderChargeCents:'Χρέωση παραγγελιών',minimumTopUpCents:'Συμπλήρωμα ελαχίστου',totalChargeCents:'Συνολική χρέωση',reviewCount:'Προς έλεγχο',retainedOrders:'Διατηρημένες παραγγελίες',sourceAt:'Πλήρης λήψη πηγής'};
  let pair='', token='', view='', offset=0, available=[], sequence=0, busy=false;
  function forget(){token='';pair='';try{sessionStorage.removeItem('fleet-direct-v1');}catch{} }
  function save(){try{sessionStorage.setItem('fleet-direct-v1',JSON.stringify({pair,token}));}catch{} }
  function freshness(at){const date=new Date(at);$('directFreshness').textContent='Αντίγραφο: '+(Number.isFinite(date.getTime())?date.toLocaleString('el-GR',{timeZone:'Europe/Athens'}):at||'άγνωστο');}
  async function call(path,method='GET',body=null){
    const requestPair=pair,requestToken=token;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{
      const exchange=await window.FleetDirectCrypto.request(requestPair,{path,method,body,headers:requestToken?{Authorization:'Bearer '+requestToken}:{}});
      const r=await fetch(base+'/api/direct/request',{method:'POST',headers:{'Content-Type':'application/json','X-Fleet-Direct-Key':await window.FleetDirectCrypto.routingKey(requestPair)},body:JSON.stringify(exchange.packet),cache:'no-store',signal:controller.signal});
      const envelope=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(envelope.error||'Δεν ήταν δυνατή η επικοινωνία με τον Server.'),{status:r.status});
      const response=await exchange.open(envelope);let data;try{data=JSON.parse(response.body);}catch{throw new Error('Μη έγκυρη απόκριση Server.');}
      if(response.status<200||response.status>=300)throw Object.assign(new Error(data.error||'Η ενέργεια δεν ολοκληρώθηκε.'),{status:response.status});
      return data;
    }catch(error){if(error.name==='AbortError')throw new Error('Ο Server δεν απάντησε εγκαίρως. Έλεγξε το δίκτυό του.');throw error;}
    finally{clearTimeout(timer);}
  }
  function showLogin(message=''){$('directLogin').hidden=false;$('directWorkspace').hidden=true;$('directRows').replaceChildren();$('directError').textContent=message;}
  function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function format(key,value){if(value===null||value==='')return '—';if(['active','review','ignored','blocked','retainOrders'].includes(key))return value?'Ναι':'Όχι';if(key.endsWith('Cents'))return new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(Number(value)/100);if(key.endsWith('_at')||key==='lastCheckedAt'||key==='sourceAt'||key==='last_seen'){const date=new Date(value);if(Number.isFinite(date.getTime()))return date.toLocaleString('el-GR',{timeZone:'Europe/Athens'});}return String(value);}
  function renderRow(row){
    const card=element('article',undefined,'direct-record');card.append(element('h3',row.employee_name||row.full_name||row.name||row.day||row.id));const list=element('dl');
    for(const [key,value] of Object.entries(row)){if(!fields[key]||key==='employee_name'&&row.full_name)continue;list.append(element('dt',fields[key]),element('dd',format(key,value)));}card.append(list);
    return card;
  }
  async function load(){
    if(!view)return;const current=++sequence;$('directRefresh').disabled=true;$('directMessage').textContent='Ανάγνωση από τον Server…';
    try{const data=await call('/api/direct-local/view/'+view,'GET',{offset});if(current!==sequence)return;freshness(data.snapshotAt);$('directRows').replaceChildren(...data.rows.map(renderRow));$('directTitle').textContent=labels[view];$('directMessage').textContent=data.total?data.total+' αποθηκευμένες εγγραφές.':'Δεν υπάρχουν αποθηκευμένες εγγραφές σε αυτή την προβολή.';$('directPage').textContent=data.total?`${offset+1}–${offset+data.rows.length} από ${data.total}`:'0 εγγραφές';$('directPrevious').disabled=offset===0;$('directNext').disabled=!data.hasMore;
    }catch(error){if(current!==sequence)return;$('directRows').replaceChildren();$('directMessage').textContent=error.message;$('directPrevious').disabled=true;$('directNext').disabled=true;if(error.status===401){forget();showLogin(error.message);}}
    finally{if(current===sequence)$('directRefresh').disabled=false;}
  }
  async function enter(data){
    if(!data.views)data=await call('/api/direct-local/me');available=data.views||[];$('directName').textContent=data.user.name;freshness(data.snapshotAt);$('directLogin').hidden=true;$('directWorkspace').hidden=false;
    $('directViews').replaceChildren(...available.map(name=>{const button=element('button',labels[name]||name);button.type='button';button.dataset.view=name;button.addEventListener('click',()=>{view=name;offset=0;select();load();});return button;}));
    view=available[0]||'';offset=0;select();if(view)await load();else{$('directMessage').textContent='Ο λογαριασμός σου δεν έχει δικαίωμα στις διαθέσιμες εφεδρικές προβολές.';$('directPrevious').disabled=true;$('directNext').disabled=true;}
  }
  function select(){for(const button of $('directViews').children)button.setAttribute('aria-current',String(button.dataset.view===view));}
  $('directLogin').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;pair=$('directPair').value.trim();try{window.FleetDirectCrypto.parse(pair);}catch(error){showLogin(error.message);return;}
    busy=true;$('directLoginButton').disabled=true;$('directError').textContent='Έλεγχος σύνδεσης στον Server…';token='';
    const password=$('directPassword').value;$('directPassword').value='';
    try{const data=await call('/api/direct-local/login','POST',{username:$('directUsername').value,password});token=data.token;save();await enter(data);}
    catch(error){forget();showLogin(error.message);}
    finally{busy=false;$('directLoginButton').disabled=false;}
  });
  $('directLogout').addEventListener('click',async()=>{++sequence;const logout=call('/api/direct-local/logout','POST');forget();showLogin();$('directPair').value='';try{await logout;}catch{} });
  $('directRefresh').addEventListener('click',load);
  $('directPrevious').addEventListener('click',()=>{offset=Math.max(0,offset-50);load();});
  $('directNext').addEventListener('click',()=>{offset+=50;load();});
  try{const fragment=new URLSearchParams(location.hash.slice(1)),shared=fragment.get('pair');if(shared){window.FleetDirectCrypto.parse(shared);$('directPair').value=shared;history.replaceState(null,'',location.pathname+location.search);forget();}else{const saved=JSON.parse(sessionStorage.getItem('fleet-direct-v1')||'null');if(saved&&/^[A-Za-z0-9_-]{43}$/.test(saved.token)){window.FleetDirectCrypto.parse(saved.pair);pair=saved.pair;token=saved.token;$('directPair').value=pair;enter({}).catch(error=>{forget();showLogin(error.message);});}}}catch{}
}());
