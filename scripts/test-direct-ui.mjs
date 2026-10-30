import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const html=fs.readFileSync('cloudflare-worker/public/direct.html','utf8'),source=fs.readFileSync('cloudflare-worker/public/direct-access.js','utf8');
const dom=new JSDOM(html,{url:'https://fixture.invalid/direct.html#pair='+'a'.repeat(43),runScripts:'outside-only'}),w=dom.window;
const requests=[];let failure=0;w.AbortController=globalThis.AbortController;w.localStorage.setItem('fleet-control-auth-token','normal-cloud-token');
w.fetch=async(url,options)=>{const request=JSON.parse(options.body);requests.push({url,options,request});if(failure)return new Response(JSON.stringify({error:'Synthetic Server offline'}),{status:failure});
 let body=request.path.endsWith('/login')?{token:'b'.repeat(43),user:{name:'Synthetic owner'}}:request.path.endsWith('/me')?{user:{name:'Synthetic owner'},views:['fleet','employees'],snapshotAt:'2026-10-30T10:00:00Z'}:request.path.endsWith('/logout')?{loggedOut:true}:{rows:[{id:'bike',name:'<img src=x onerror=alert(1)>',currentKm:12000}],total:1,offset:0,hasMore:false,snapshotAt:'2026-10-30T10:00:00Z'};
 return new Response(JSON.stringify({status:200,body:JSON.stringify(body)}));};
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI did not settle');};
try{
 w.eval(source);assert.equal(w.location.hash,'','shared pairing secret is removed from the visible URL');assert.equal(w.document.getElementById('directPair').value,'a'.repeat(43));
 const $=id=>w.document.getElementById(id),submit=()=>$('directLogin').dispatchEvent(new w.Event('submit',{cancelable:true}));
 $('directPair').value='invalid';submit();assert.equal(requests.length,0);assert.match($('directError').textContent,/σύζευξης/);
 $('directPair').value='a'.repeat(43);$('directUsername').value='owner';$('directPassword').value='Synthetic password';submit();assert.equal($('directPassword').value,'','password is not retained in the form');assert.equal($('directLoginButton').disabled,true);
 await until(()=>$('directRows').children.length===1);assert.equal($('directWorkspace').hidden,false);assert.equal($('directRows').querySelector('img'),null,'server text is never inserted as HTML');assert.match($('directRows').textContent,/12000/);assert.match($('directFreshness').textContent,/2026/);assert.match(w.document.body.textContent,/Μόνο προβολή/);
 assert.equal(w.localStorage.getItem('fleet-control-auth-token'),'normal-cloud-token','direct session never replaces normal login');
 assert.ok(requests.every(r=>r.url==='https://fixture.invalid/api/direct/request'));assert.equal(requests[0].options.headers['X-Fleet-Direct-Key'],'a'.repeat(43));assert.equal(requests[0].request.body.password,'Synthetic password');
 $('directLogout').click();await until(()=>$('directLogin').hidden===false);assert.equal(w.sessionStorage.getItem('fleet-direct-v1'),null);assert.equal($('directRows').children.length,0);
 failure=503;$('directPair').value='a'.repeat(43);$('directPassword').value='Synthetic password';const before=requests.length;submit();await until(()=>$('directError').textContent.includes('offline'));assert.equal(requests.length,before+1,'no automatic login replay after a network/server failure');
 assert.equal(w.localStorage.getItem('fleet-control-auth-token'),'normal-cloud-token');
 console.log('OK actual direct UI: pairing fragment removal, local session isolation, password clearing, no mutation retry, explicit read-only/freshness, safe text rendering and offline recovery.');
}finally{w.close();}
