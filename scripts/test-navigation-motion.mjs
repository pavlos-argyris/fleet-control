import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../cloudflare-worker/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const dom = new JSDOM(fs.readFileSync('cloudflare-worker/public/index.html', 'utf8'), { url: 'https://fixture.invalid/index.html', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window;
const user = { id: 'owner', username: 'owner', role: 'owner', permissions: ['*'] };
const bikes = Array.from({ length: 35 }, (_, i) => ({ id: 'bike-' + i, name: 'ΜΗΧ ' + String(i).padStart(3,'0'), currentKm: 1200, lastServiceKm: 1000, intervalKm: 3000, history: [], createdAt:'2026-10-01', updatedAt:'2026-10-01' }));
w.localStorage.setItem('fleet-control-auth-token', 'fixture'); w.localStorage.setItem('fleet-control-user-cache', JSON.stringify(user)); w.localStorage.setItem('moto-service-tracker-v1', JSON.stringify(bikes));
w.TextEncoder = TextEncoder; w.FLEET_CONFIG = { apiBase: 'https://fixture.invalid' };
let reduced = false, y = 0;
w.matchMedia = query => ({ matches: query.includes('reduced-motion') && reduced, addEventListener(){} });
w.setInterval = () => 1; w.requestAnimationFrame = fn => w.setTimeout(fn, 0);
Object.defineProperty(w, 'scrollY', { get: () => y });
Object.defineProperty(w, 'innerWidth', { value: 390 }); Object.defineProperty(w, 'innerHeight', { value: 800 });
w.scrollTo = (x, top) => { y = typeof x === 'object' ? x.top : top; };
w.HTMLDialogElement.prototype.showModal = function(){ this.open = true; }; w.HTMLDialogElement.prototype.close = function(){ this.open = false; this.dispatchEvent(new w.Event('close')); }; w.HTMLCanvasElement.prototype.getContext = () => null;
w.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ user, bikes, version: 1 }), text: async () => '' });
w.HTMLElement.prototype.getBoundingClientRect = function(){
  if (this.dataset.bikeId) { const i = Array.from(w.document.querySelectorAll('#bikeList [data-bike-id]')).indexOf(this); const top = 1000 + i*160 - y; return { top, bottom:top+140,left:16,right:374,width:358,height:140 }; }
  return { top:0,bottom:800,left:0,right:390,width:390,height:800 };
};
const transitions = [], animations = [];
w.HTMLElement.prototype.animate = function(frames,options){ let resolve; const finished = new Promise(r => resolve=r); const animation={ finished, cancel:resolve }; animations.push({node:this,frames,options,animation}); w.setTimeout(resolve,10); return animation; };
const start = update => { let resolve; const finished = new Promise(r => resolve=r), transition = { ready:Promise.resolve().then(update), finished, skipTransition:resolve }; transitions.push(transition); transition.ready.then(() => w.setTimeout(resolve,30)); return transition; };
w.document.startViewTransition = start;
for (const name of ['service-model.js','fleet-operations-model.js','fleet-motion.js']) w.eval(fs.readFileSync('cloudflare-worker/public/'+name,'utf8'));
let source = fs.readFileSync('cloudflare-worker/public/app.js','utf8'), marker = '}());'; source=source.slice(0,source.lastIndexOf(marker))+'window.__motionTest={openDetail,showHome,getBike,handleFleetNavigation,reorder(){bikes.reverse();},configure(){syncNow=async()=>{};}};'+marker; w.eval(source);
await new Promise(r=>setTimeout(r,30)); w.__motionTest.configure();
const wait = async () => {
  for (let i=0;i<80;i++) {
    await new Promise(r=>setTimeout(r,10));
    if (!w.document.querySelector('[data-fleet-bike-slide]')) { await new Promise(r=>setTimeout(r,10)); return; }
  }
  assert.fail('Navigation transition did not settle');
}, card = () => w.document.querySelector('#bikeList [data-bike-id="bike-15"]');
y = 3200; const original = card().getBoundingClientRect().top, originalNode = card();
card().click(); await wait(); assert.equal(w.history.state.view,'detail'); assert.equal(y,0); assert.equal(w.document.querySelector('#detailView').classList.contains('is-hidden'),false);
assert.equal(transitions.length,0,'No screenshot API is used');
assert.equal(animations.length,1);assert.equal(animations[0].node,w.document.querySelector('#detailView'));
assert.equal(animations[0].options.duration,190);assert.match(animations[0].frames[0].transform,/22px/);
w.document.querySelector('#detailBackButton').click(); await wait(); assert.equal(w.document.querySelector('#homeView').classList.contains('is-hidden'),false); assert.equal(card().getBoundingClientRect().top,original); assert.equal(w.document.activeElement,card());
assert.equal(animations.length,2);assert.equal(animations[1].node,w.document.querySelector('#homeView'));assert.match(animations[1].frames[0].transform,/-22px/);
for(const animation of animations){assert.equal(animation.options.duration,190);assert.ok(animation.frames.every(frame=>Object.keys(frame).every(key=>key==='transform')));}
assert.equal(w.document.querySelector('.fleet-bike-return-surface'),null);
assert.equal(card(),originalNode,'Unchanged Back keeps the actual card DOM');
// Actual changed content must invalidate the markup cache, not show stale data.
w.__motionTest.getBike('bike-15').currentKm=1999;
w.__motionTest.openDetail('bike-15',false);await wait();w.__motionTest.showHome();await wait();
assert.notEqual(card(),originalNode);assert.match(card().textContent,/1[.,]999/);
w.__motionTest.getBike('bike-15').currentKm=1200;w.__motionTest.showHome();await wait();
// Forward, rapid Back before capture, repeated actions and old cleanup cannot undo the latest navigation.
w.history.forward(); await wait(); assert.equal(w.history.state.view,'detail'); w.history.back(); await wait();
card().click(); w.__motionTest.showHome(); await wait(); assert.equal(w.document.querySelector('#homeView').classList.contains('is-hidden'),false); assert.equal(card().getBoundingClientRect().top,original);
assert.equal(w.document.querySelector('[data-fleet-bike-slide]'),null); assert.equal(w.document.querySelectorAll('[style*="fleet-bike-plate"]').length,0);
// Reduced motion and browsers without the API still restore position.
reduced=true; const count=animations.length; w.__motionTest.openDetail('bike-15',false); w.__motionTest.showHome(); await wait(); assert.equal(animations.length,count); assert.equal(card().getBoundingClientRect().top,original);
reduced=false; const animate=w.HTMLElement.prototype.animate;delete w.HTMLElement.prototype.animate; w.__motionTest.openDetail('bike-15',false); w.__motionTest.showHome(); await wait(); assert.equal(card().getBoundingClientRect().top,original);w.HTMLElement.prototype.animate=animate;
// A changed layout is anchored by identity rather than a stale absolute offset.
y=3200; const position=w.FleetMotion.capture(w.document.querySelector('#homeView'),card()); card().parentElement.prepend(card()); w.FleetMotion.restore(w.document.querySelector('#homeView'),position); await wait(); assert.equal(card().getBoundingClientRect().top,original);
const section=w.document.querySelector('#homeView'); const n=animations.length; w.FleetMotion.slide(section,-1); assert.equal(animations.length,n+1); assert.match(animations.at(-1).frames[0].transform,/-22/); assert.ok(!('opacity' in animations.at(-1).frames[0])); reduced=true; w.FleetMotion.slide(section,1); assert.equal(animations.length,n+1);
// Embedded Fleet animates the iframe viewport, not a huge document snapshot.
reduced=false;
const frame=w.document.createElement('iframe');w.document.body.append(frame);frame.contentDocument.body.innerHTML='<section id="homeView"><button id="card"><h3>ΜΗΧ 015</h3></button></section><section id="detail"><h2 id="detailName">ΜΗΧ 015</h2></section>';
const childCard=frame.contentDocument.querySelector('#card'),childDetail=frame.contentDocument.querySelector('#detail');
let closeUpdates=0;
w.FleetMotion.card({opening:true,resolveCard:()=>childCard,detail:childDetail,update(){}});
assert.equal(animations.at(-1).node,frame);assert.equal(frame.dataset.fleetBikeSlide,'open');
w.FleetMotion.card({opening:false,resolveCard:()=>childCard,detail:childDetail,update(){closeUpdates++;}});
assert.equal(frame.dataset.fleetBikeSlide,'close');
w.FleetMotion.finish();await wait();assert.equal(closeUpdates,1);assert.equal(frame.dataset.fleetBikeSlide,undefined);
assert.equal(w.document.querySelector('.fleet-bike-return-surface'),null);assert.equal(transitions.length,0);
dom.window.close(); console.log('OK actual Fleet navigation: shared 22px/190ms slide, anchored Back/Forward, rapid interruption, cleanup, focus, reduced motion, unsupported API and slide without opacity.');
