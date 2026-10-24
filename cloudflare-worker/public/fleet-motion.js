(function (root) {
  'use strict';
  const doc = root.document;
  const reduced = () => root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let restoreGeneration = 0;
  const slides = new WeakMap();
  const runningSlides = new Set();
  const watchedNavigation = new WeakSet();
  function cancelRestore() { restoreGeneration++; }
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(type => root.addEventListener(type, cancelRestore, { passive: true, capture: true }));
  function capture(container, anchor) {
    if (!anchor) anchor = Array.from(container.querySelectorAll('[data-bike-id], [data-service-order-bike]')).find(node => node.getBoundingClientRect().bottom > 0);
    return { x: root.scrollX || 0, y: root.scrollY || 0, anchorId: anchor?.dataset.bikeId || anchor?.dataset.serviceOrderBike || '', anchorTop: anchor?.getBoundingClientRect().top || 0 };
  }
  function restore(container, position, focus) {
    if (!position) return;
    const generation = ++restoreGeneration;
    const apply = () => {
      if (generation !== restoreGeneration || container.classList.contains('is-hidden')) return;
      const anchor = Array.from(container.querySelectorAll('[data-bike-id], [data-service-order-bike]')).find(node => (node.dataset.bikeId || node.dataset.serviceOrderBike) === position.anchorId);
      const y = anchor ? (root.scrollY || 0) + anchor.getBoundingClientRect().top - position.anchorTop : position.y;
      root.scrollTo({ left: position.x, top: Math.max(0, y), behavior: 'instant' });
      if (focus && anchor) anchor.focus({ preventScroll: true });
    };
    apply();
    // The Portal changes the iframe height when leaving the full-screen detail.
    root.requestAnimationFrame(() => { apply(); root.requestAnimationFrame(apply); });
  }
  function finish() {
    runningSlides.forEach(animation => animation.cancel());
    runningSlides.clear();
  }
  function card({ opening, detail, update }) {
    finish(); cancelRestore();
    update();
    let view = opening ? detail : detail.ownerDocument.getElementById('homeView');
    if (!view) return;
    // Animate the iframe's viewport in Portal/Client, keeping its parent chrome
    // fixed. Standalone Fleet animates the newly visible view directly.
    try {
      const frame = view.ownerDocument.defaultView.frameElement;
      if (frame?.ownerDocument === doc) view = frame;
    } catch (error) {}
    const animation = slide(view, opening ? 1 : -1);
    if (animation) view.dataset.fleetBikeSlide = opening ? 'open' : 'close';
  }
  function slide(node, direction) {
    if (!node) return;
    slides.get(node)?.cancel();
    if (reduced() || doc.hidden || !node.animate) return;
    const animation = node.animate([{ transform: `translateX(${direction < 0 ? -22 : 22}px)` }, { transform: 'translateX(0)' }], { duration: 190, easing: 'cubic-bezier(.2,.7,.2,1)' });
    slides.set(node, animation);
    runningSlides.add(animation);
    animation.finished.catch(() => {}).finally(() => { runningSlides.delete(animation); if (slides.get(node) === animation) { slides.delete(node); delete node.dataset.fleetBikeSlide; } });
    return animation;
  }
  function selectTab(nav, animate = true) {
    if (!nav) return;
    if (!watchedNavigation.has(nav)) {
      watchedNavigation.add(nav);
      if (root.ResizeObserver) new root.ResizeObserver(() => selectTab(nav, false)).observe(nav);
      else root.addEventListener('resize', () => selectTab(nav, false), { passive: true });
    }
    const selected = nav.querySelector('button.active');
    let indicator = nav.querySelector('.bottom-nav-indicator');
    if (!selected || !nav.getBoundingClientRect().width) {
      if (indicator) indicator.hidden = true;
      delete nav.dataset.slidingIndicator;
      return;
    }
    const wasVisible = indicator && !indicator.hidden && nav.dataset.slidingIndicator;
    if (!indicator) {
      indicator = doc.createElement('span'); indicator.className = 'bottom-nav-indicator';
      indicator.setAttribute('aria-hidden', 'true'); nav.prepend(indicator);
    }
    const bounds = nav.getBoundingClientRect(), target = selected.getBoundingClientRect();
    indicator.style.transition = animate && wasVisible && !reduced() ? 'transform 220ms cubic-bezier(.2,.7,.2,1), width 220ms cubic-bezier(.2,.7,.2,1)' : 'none';
    indicator.hidden = false;
    indicator.style.width = target.width + 'px'; indicator.style.height = target.height + 'px';
    indicator.style.transform = `translate3d(${target.left-bounds.left-nav.clientLeft}px,${target.top-bounds.top-nav.clientTop}px,0)`;
    nav.dataset.slidingIndicator = 'true';
    nav.querySelectorAll('button[data-go]').forEach(button => {
      if (button === selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  root.addEventListener('pagehide', finish);
  root.FleetMotion = { capture, restore, card, slide, selectTab, finish };
  selectTab(doc.getElementById('bottomNav'), false);
})(window);

/* Shared controls intentionally add no polling, API requests or image captures. */
(function(root){
  'use strict';
  const doc=root.document;
  const paths={home:'M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8',shifts:'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',schedules:'M4 6h16v15H4zM8 3v6m8-6v6M4 11h16',employees:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',fleet:'M3 17h3l3-8h7l3 8h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 9l2-4h3l2 4',invoices:'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h7',payroll:'M17 5a7 7 0 1 0 0 14M5 10h10M5 14h9',reports:'M4 21V3m0 18h17M8 17v-5m5 5V8m5 9V5',alerts:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',audit:'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',recycle:'M4 8h16M6 8l1 13h10l1-13M9 8V4h6v4',server:'M4 3h16v7H4zM4 14h16v7H4zM8 6.5h.01M8 17.5h.01',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',more:'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',check:'m5 12 4 4L19 6',arrow:'m9 5 7 7-7 7'};
  function icon(name){const p=paths[name]||paths.shifts;return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+p+'"/></svg>';}
  function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function animate(node,direction){root.FleetMotion?.slide(node,direction||1);}
  function help(title,text){let d=doc.getElementById('uiHelpDialog');if(!d){d=doc.createElement('dialog');d.id='uiHelpDialog';d.className='app-dialog ui-help-dialog';d.setAttribute('aria-labelledby','uiHelpTitle');d.innerHTML='<div class="dialog-head"><h2 id="uiHelpTitle"></h2><button type="button" aria-label="Πίσω">←</button></div><p></p>';d.querySelector('button').onclick=()=>d.close();doc.body.append(d);}d.querySelector('h2').textContent=title;d.querySelector('p').textContent=text;if(!d.open)d.showModal();}
  let bikeContext='',bikeTab='summary';
  function setBikeTab(name,move=true){if(!['summary','history','files'].includes(name))return;const previous=bikeTab;bikeTab=name;doc.querySelectorAll('[data-ui-bike-panel]').forEach(n=>{n.hidden=n.dataset.uiBikePanel!==name;if(!n.hidden&&move&&previous!==name)animate(n,1);});doc.querySelectorAll('[data-ui-bike-tab]').forEach(b=>{const active=b.dataset.uiBikeTab===name;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});}
  function setBikeContext(id){if(bikeContext!==String(id)){bikeContext=String(id);setBikeTab('summary',false);}}
  function refreshFleetList(){const list=doc.getElementById('bikeList');if(!list)return;let density='cards';try{density=localStorage.getItem('fleet-ui-density')||density;}catch(e){}list.classList.toggle('ui-compact',density==='compact');doc.querySelectorAll('[data-ui-density]').forEach(b=>{const selected=b.dataset.uiDensity===density;b.setAttribute('aria-pressed',String(selected));b.classList.toggle('active',selected);});const key=v=>String(v).normalize('NFD').replace(/[\u0300-\u036f\s-]/g,'').toLocaleUpperCase('el-GR');const query=key(doc.getElementById('uiFleetSearch')?.value||'');let visible=0;list.querySelectorAll('[data-bike-id]').forEach(b=>{const match=key(b.querySelector('h3')?.textContent||'').includes(query);b.dataset.uiFiltered=String(!match);if(match)visible++;});const empty=doc.getElementById('uiFleetSearchEmpty');if(empty)empty.hidden=!query||visible>0;}
  function renderBikeFiles(bike){const list=doc.getElementById('uiBikeFiles');if(!list)return;const files=(bike.history||[]).flatMap(entry=>(entry.attachments||[]).map(file=>({file,entry}))).sort((a,b)=>String(root.FleetServiceModel?.date(b.file.invoiceData?.invoiceDate||b.file.ocr?.invoiceDate)||b.entry.date||'').localeCompare(String(root.FleetServiceModel?.date(a.file.invoiceData?.invoiceDate||a.file.ocr?.invoiceDate)||a.entry.date||'')));const markup=files.length?files.map(({file,entry})=>'<article class="ui-bike-file"><span><strong>'+esc(file.name||'Τιμολόγιο.pdf')+'</strong><small>Service: '+esc(String(entry.date||'').slice(0,10))+'</small></span><button type="button" class="secondary-button" data-view-document="'+esc(file.key)+'">Άνοιγμα</button><button type="button" class="secondary-button" data-download-document="'+esc(file.key)+'" data-download-document-name="'+esc(file.name||'Τιμολόγιο.pdf')+'">Λήψη</button></article>').join(''):'<p class="ui-empty">Δεν υπάρχουν αποθηκευμένα PDF σε αυτή τη μηχανή. Πρόσθεσε QR ή αρχείο σε ένα service.</p>';if(list.innerHTML!==markup)list.innerHTML=markup;}
  let scheduleDay='';
  function scheduleDays(dates){const bar=doc.getElementById('uiScheduleDays'),list=doc.getElementById('scheduleList');if(!bar||!list)return;const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(!dates.some(d=>d.date===scheduleDay))scheduleDay=dates.find(d=>d.date===today)?.date||dates[0]?.date||'';bar.innerHTML=dates.map(d=>'<button type="button" data-ui-schedule-day="'+esc(d.date)+'" aria-pressed="'+(d.date===scheduleDay)+'" class="'+(d.date===scheduleDay?'active':'')+'"><strong>'+esc(d.name.slice(0,3))+'</strong><span>'+esc(d.date.slice(8,10)+'/'+d.date.slice(5,7))+'</span></button>').join('');list.classList.add('ui-daily');list.querySelectorAll('[data-ui-weekday]').forEach(n=>n.classList.toggle('ui-selected-day',n.dataset.uiWeekday===scheduleDay));}
  function install(){
    const list=doc.getElementById('bikeList');if(list){refreshFleetList();new MutationObserver(refreshFleetList).observe(list,{childList:true});}
    doc.addEventListener('input',e=>{if(e.target.id==='uiFleetSearch')refreshFleetList();});
    doc.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.uiHelp){help(b.getAttribute('aria-label')||'Πώς λειτουργεί',b.dataset.uiHelp);return;}if(b.dataset.uiDensity){try{localStorage.setItem('fleet-ui-density',b.dataset.uiDensity);}catch(err){}refreshFleetList();return;}if(b.dataset.uiBikeTab){setBikeTab(b.dataset.uiBikeTab);return;}if(b.dataset.uiScheduleDay){scheduleDay=b.dataset.uiScheduleDay;const bar=doc.getElementById('uiScheduleDays');bar.querySelectorAll('button').forEach(n=>{const active=n===b;n.classList.toggle('active',active);n.setAttribute('aria-pressed',String(active));});const list=doc.getElementById('scheduleList');list.querySelectorAll('[data-ui-weekday]').forEach(n=>n.classList.toggle('ui-selected-day',n.dataset.uiWeekday===scheduleDay));animate(list,1);}});
    // Keyboard equivalents for segmented controls. Native buttons remain tabbable.
    doc.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const b=e.target.closest('.ui-segments button, .ui-schedule-days button');if(!b)return;const items=Array.from(b.parentElement.querySelectorAll('button')).filter(n=>!n.disabled&&!n.hidden),i=items.indexOf(b);if(i<0)return;const next=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowRight'?1:-1)+items.length)%items.length;e.preventDefault();items[next].focus();items[next].click();});
    // Watch only dialog open and submit disabled state, never scroll or list layout.
    new MutationObserver(records=>{const dialogs=new Set();for(const r of records){if(r.attributeName==='open'&&r.target.tagName==='DIALOG'&&r.target.open){const d=r.target;d.setAttribute('aria-modal','true');const title=d.querySelector('h2');if(title&&!d.hasAttribute('aria-labelledby')){if(!title.id)title.id='ui-dialog-title-'+(++install.title);d.setAttribute('aria-labelledby',title.id);}animate(d,1);}if(r.attributeName==='disabled'){const dialog=r.target.closest('dialog');if(dialog)dialogs.add(dialog);}}for(const d of dialogs){const busy=Array.from(d.querySelectorAll('button[type=submit]')).some(b=>b.disabled);const form=d.querySelector('form');if(!form)continue;form.setAttribute('aria-busy',String(busy));let status=form.querySelector('.ui-save-state');if(busy&&!status){status=doc.createElement('div');status.className='ui-save-state';status.setAttribute('role','status');status.innerHTML='<i aria-hidden="true"></i><span>Αποθήκευση αλλαγών…</span>';form.prepend(status);}else if(!busy&&status)status.remove();}}).observe(doc.body,{subtree:true,attributes:true,attributeFilter:['open','disabled']});
    if(root.visualViewport){let frame;const resize=()=>{root.cancelAnimationFrame(frame);frame=root.requestAnimationFrame(()=>doc.documentElement.style.setProperty('--ui-visible-height',Math.round(root.visualViewport.height)+'px'));};root.visualViewport.addEventListener('resize',resize,{passive:true});resize();}
  }
  install.title=0;
  root.FleetUI={icon,help,setBikeTab,setBikeContext,refreshFleetList,renderBikeFiles,scheduleDays};
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
