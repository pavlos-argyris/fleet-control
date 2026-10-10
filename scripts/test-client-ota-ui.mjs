import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
class Node {
 constructor(){this.children=[];this.classes=new Set();this.classList={toggle:(c,on)=>on?this.classes.add(c):this.classes.delete(c)};this.attrs={};this.style={};this.open=false;this.hidden=false;this.disabled=false;this.textContent='';this.nodes=new Map();this.listeners={};this.steps=Array.from({length:4},()=>({classes:new Set(),classList:{toggle(){}}}));}
 appendChild(n){this.children.push(n);return n;}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}
 querySelector(k){if(!this.nodes.has(k))this.nodes.set(k,new Node());return this.nodes.get(k);}querySelectorAll(){return this.steps;}addEventListener(k,fn){this.listeners[k]=fn;}showModal(){this.open=true;}close(){this.open=false;if(this.listeners.close)this.listeners.close();}
}
const body=new Node(),events={};let tick,clock=1000,checks=0,installs=0;
let state={stage:'current',currentVersion:'5.41.0'};
const bridge={getClientUpdateState:()=>JSON.stringify(state),checkClientUpdate:()=>checks++,installClientUpdate:()=>installs++,dismissClientUpdate(){}};
const context=vm.createContext({window:{AndroidFleet:bridge,addEventListener:(k,fn)=>events[k]=fn},document:{body,createElement:()=>new Node(),querySelector:()=>null,visibilityState:'visible'},setInterval:fn=>tick=fn,Date:{now:()=>clock}});
vm.runInContext(fs.readFileSync('cloudflare-worker/public/client-ota.js','utf8'),context);
const dialog=body.children[0],button=body.children[1],node=id=>dialog.querySelector('#'+id),bar=dialog.querySelector('.client-ota-progress');
button.onclick();assert.equal(dialog.open,true);
node('clientOtaCheck').onclick();assert.equal(checks,1);assert.ok(bar.classes.has('is-active'));assert.equal(node('clientOtaCheck').disabled,true);
tick();assert.match(node('clientOtaMessage').textContent,/Έλεγχος/);clock+=2000;tick();assert.equal(node('clientOtaCheck').disabled,false);
state={stage:'waiting',ready:{version:'5.42.0',sizeBytes:100,notes:'• Πρώτο\n• <script>not executed</script>'},downloadedBytes:25};
for(const stage of ['waiting','downloading','validating','installing','confirmation','permission']){state.stage=stage;tick();assert.ok(bar.classes.has('is-active'),stage);}
state.stage='downloading';tick();assert.equal(bar.attrs['aria-valuenow'],'25');assert.equal(node('clientOtaInstall').disabled,true);
state.stage='validating';tick();assert.equal(bar.attrs['aria-valuenow'],undefined,'validation has no invented percentage');
state.stage='confirmation';tick();assert.equal(node('clientOtaInstall').disabled,false);assert.equal(node('clientOtaInstall').textContent,'Επιβεβαίωση Android');node('clientOtaInstall').onclick();assert.equal(installs,1);
assert.equal(node('clientOtaNotes').children[1].textContent,'<script>not executed</script>');
state.stage='failed';tick();assert.ok(dialog.classes.has('has-error'));assert.equal(node('clientOtaInstall').disabled,false,'retry remains available');
state.offer=true;state.stage='waiting';tick();dialog.close();tick();assert.equal(dialog.open,false,'same offer must not reopen on polling');
console.log('OK actual Client OTA UI: forced-check feedback, all-stage animation, real download percent, safe bullet notes, permission/confirmation/retry actions and offer persistence.');
