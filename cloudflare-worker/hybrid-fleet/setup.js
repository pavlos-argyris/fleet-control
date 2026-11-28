const setupPath='/fleet-cloud/setup';
const api='/api/fleet-web/v1';
const scriptType='application/javascript; charset=utf-8';

const page='<!doctype html><html lang="el"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleet Cloudflare</title>' +
  '<script defer src="/fleet-cloud/setup.js"></script></head><body><main><h1>Fleet Cloudflare</h1>' +
  '<p id="status" role="status" aria-live="polite"></p>' +
  '<form id="initial" hidden><h2>Δημιουργία PIN</h2>' +
  '<label>PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> ' +
  '<label>Επιβεβαίωση <input name="confirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> ' +
  '<button>Αποθήκευση PIN</button></form>' +
  '<form id="login" hidden><label>PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> <button>Σύνδεση</button></form>' +
  '<section id="owner" hidden><form id="pair" hidden><p>Επιβεβαίωσε ότι ο κωδικός που εμφανίζεται στις ρυθμίσεις του Server είναι <strong id="code"></strong>.</p>' +
  '<label><input name="verified" type="checkbox" required> Ο κωδικός συμφωνεί</label> <button>Έγκριση Server</button></form>' +
  '<div id="devices"></div><button type="button" id="revoke-trust">Αφαίρεση εμπιστοσύνης από αυτόν τον browser</button>' +
  ' <button type="button" id="logout">Αποσύνδεση</button><form id="change"><h2>Αλλαγή PIN</h2>' +
  '<label>Τρέχον PIN <input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> ' +
  '<label>Νέο PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> ' +
  '<label>Επιβεβαίωση <input name="confirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label> ' +
  '<button>Αλλαγή</button></form></section></main></body></html>';

function setupScript() {
  const api='/api/fleet-web/v1';
  const fields=new URLSearchParams(location.hash.slice(1));
  history.replaceState(null,'',location.pathname);
  let recoveryCredential=fields.get('recovery')||'';
  const id=fields.get('device')||'',secretSha256=fields.get('proof')||'',replaceId=fields.get('replace')||undefined;
  const claim=/^[A-Za-z0-9_-]{22,64}$/.test(id)&&/^[a-f0-9]{64}$/.test(secretSha256)?{action:'approve',id,secretSha256,replaceId}:null;
  let csrf='';
  const byId=id=>document.getElementById(id);
  const display=message=>{byId('status').textContent=message;};
  const apiCall=async(path,body)=>{
    const result=await fetch(api+path,{
      method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Fleet-CSRF':csrf}:{},
      body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error'
    });
    const value=await result.json();
    if (!result.ok) {
      const messages={invalid_pin:'Το PIN δεν είναι σωστό.',pin_temporarily_blocked:'Η σύνδεση είναι προσωρινά αποκλεισμένη.',
        sync_device_approval_conflict:'Η έγκριση δεν συμφωνεί με την τρέχουσα συσκευή.',trusted_device_required:'Απαιτείται έμπιστη συσκευή.'};
      throw new Error(messages[value.error]||'Η ενέργεια δεν επιβεβαιώθηκε.');
    }
    return value;
  };
  const submit=(id,action)=>{
    byId(id).addEventListener('submit',async event=>{
      event.preventDefault();
      const form=event.currentTarget,values=Object.fromEntries(new FormData(form));
      form.reset();
      const button=form.querySelector('button');
      button.disabled=true;
      try { await action(values); }
      catch (error) { display(error.message); }
      finally { button.disabled=false; }
    });
  };
  async function devices() {
    const {devices}=await apiCall('/sync-device');
    const list=byId('devices');
    list.replaceChildren();
    for (const device of devices) {
      const row=document.createElement('p'),button=document.createElement('button');
      row.textContent='Εγκεκριμένος Server '+device.id.slice(-8)+' ';
      button.textContent='Ανάκληση';
      button.type='button';
      button.onclick=async()=>{
        if (!window.confirm('Ανάκληση πρόσβασης για αυτόν τον Server;')) return;
        try { await apiCall('/sync-device',{action:'revoke',id:device.id}); await devices(); display('Η πρόσβαση ανακλήθηκε.'); }
        catch (error) { display(error.message); }
      };
      row.append(button);
      list.append(row);
    }
  }
  async function authorized(session) {
    csrf=session.csrf;
    byId('initial').hidden=byId('login').hidden=true;
    byId('owner').hidden=false;
    byId('pair').hidden=!claim;
    if (claim) byId('code').textContent=secretSha256.slice(0,8).toUpperCase();
    display('');
    try { await devices(); }
    catch (error) { display(error.message); }
  }
  submit('initial',async ({pin,confirmation})=>{
    if (pin!==confirmation) throw new Error('Η επιβεβαίωση PIN δεν συμφωνεί.');
    await apiCall('/enroll',{pin,recoveryCredential});
    recoveryCredential='';
    byId('initial').hidden=true;
    byId('login').hidden=false;
    display('Το PIN αποθηκεύτηκε. Συνδέσου για την έγκριση της συσκευής.');
  });
  submit('login',async ({pin})=>authorized(await apiCall('/login',{pin})));
  submit('pair',async ()=>{
    if (!claim) return;
    await apiCall('/sync-device',claim);
    byId('pair').hidden=true;
    await devices();
    display('Ο Server εγκρίθηκε. Μπορείς να επιστρέψεις στην εφαρμογή.');
  });
  submit('change',async values=>{
    await apiCall('/change-pin',values);
    byId('owner').hidden=true;
    byId('login').hidden=false;
    csrf='';
    display('Το PIN άλλαξε. Συνδέσου με το νέο PIN.');
  });
  for (const id of ['logout','revoke-trust']) byId(id).onclick=async()=>{
    const revoke=id==='revoke-trust';
    if (revoke&&!window.confirm('Αφαίρεση εμπιστοσύνης από αυτόν τον browser;')) return;
    try {
      await apiCall(revoke?'/revoke-device':'/logout',{});
      byId('owner').hidden=true;
      byId('login').hidden=revoke;
      csrf='';
      display(revoke?'Η εμπιστοσύνη αφαιρέθηκε.':'Η συνεδρία τερματίστηκε.');
    } catch (error) { display(error.message); }
  };
  apiCall('/session').then(authorized).catch(()=>{
    const initial=/^[A-Za-z0-9_-]{43}$/.test(recoveryCredential);
    byId('initial').hidden=!initial;
    byId('login').hidden=initial;
  });
}

export function routeFleetSetup(request,mode='rehearsal',enrollmentAvailable=false) {
  const path=new URL(request.url).pathname;
  if (![setupPath,setupPath+'.js',api+'/setup-info'].includes(path)) return null;
  if (request.method!=='GET') return new Response(null,{status:405});
  const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"};
  if (path===api+'/setup-info') return Response.json({protocol:1,mode,setupPath,
    ...(mode==='initial-transfer'?{enrollmentAvailable}:{})},{headers});
  if (path.endsWith('.js')) return new Response('('+setupScript.toString()+')();',{headers:{...headers,'Content-Type':scriptType}});
  return new Response(page,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
}
