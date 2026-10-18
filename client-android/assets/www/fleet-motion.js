(function (root) {
  'use strict';
  const doc = root.document, html = doc.documentElement;
  const reduced = () => root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let pending = null, restoreGeneration = 0, motionId = 0, htmlOwner = 0;
  const labelOwners = new WeakMap();
  const slides = new WeakMap();
  const runningSlides = new Set();
  const watchedNavigation = new WeakSet();
  function viewportRect(node) {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (node.ownerDocument === doc) return rect;
    try {
      const frame = node.ownerDocument.defaultView.frameElement, outer = frame?.getBoundingClientRect();
      if (frame?.ownerDocument !== doc || !outer) return null;
      return { top: rect.top + outer.top, bottom: rect.bottom + outer.top, left: rect.left + outer.left, right: rect.right + outer.left, width: rect.width, height: rect.height };
    } catch (error) { return null; }
  }
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
    if (!pending) return;
    const current = pending; pending = null;
    current.commit(); current.transition?.skipTransition(); current.clean();
  }
  function card({ opening, resolveCard, detail, update }) {
    finish(); cancelRestore();
    runningSlides.forEach(animation => animation.cancel()); runningSlides.clear();
    const source = opening ? resolveCard() : detail;
    const sourceRect = viewportRect(source);
    const canAnimate = !reduced() && !doc.hidden && typeof doc.startViewTransition === 'function' && sourceRect?.width > 0 && sourceRect.bottom > 0 && sourceRect.top < root.innerHeight;
    if (!canAnimate) { update(); return; }
    const labels = [], hiddenLabels = [], direction = opening ? 'open' : 'close', id = ++motionId;
    const external = source.ownerDocument !== doc;
    let proxy = null;
    const label = element => element?.querySelector(opening && element === source ? 'h3, strong' : '#detailName, h3, strong');
    const nameLabel = element => {
      const node = label(element); if (!node) return;
      labelOwners.set(node,id);
      if (external) {
        // Shared elements inside an iframe cannot join its parent's transition.
        // Move an inert copy of the plate instead; the real text stays in layout.
        const rect = viewportRect(node), style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (!rect) return;
        hiddenLabels.push([node,node.style.visibility]); node.style.visibility = 'hidden';
        if (!proxy) { proxy = doc.createElement('span'); proxy.setAttribute('aria-hidden','true'); proxy.dataset.fleetPlateProxy = ''; doc.body.append(proxy); }
        proxy.textContent = node.textContent;
        Object.assign(proxy.style,{ position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',font:style.font,letterSpacing:style.letterSpacing,color:style.color,whiteSpace:'nowrap',margin:'0',padding:'0',pointerEvents:'none',zIndex:'2147483647',viewTransitionName:'fleet-bike-plate' });
      } else { labels.push([node, node.style.viewTransitionName]); node.style.viewTransitionName = 'fleet-bike-plate'; }
    };
    nameLabel(source);
    html.dataset.fleetCardMotion = direction;
    htmlOwner = id;
    let committed = false;
    const state = {
      commit() { if (committed) return; committed = true; update(); labels.forEach(([node, value]) => { node.style.viewTransitionName = value; }); nameLabel(opening ? detail : resolveCard()); },
      clean() {
        labels.forEach(([node, value]) => { if (labelOwners.get(node) === id) { node.style.viewTransitionName = value; labelOwners.delete(node); } });
        hiddenLabels.forEach(([node,value]) => { if (labelOwners.get(node) === id) { node.style.visibility = value; labelOwners.delete(node); } });
        proxy?.remove();
        if (htmlOwner === id) delete html.dataset.fleetCardMotion;
      }
    };
    pending = state;
    try { state.transition = doc.startViewTransition(state.commit); }
    catch (error) { state.commit(); state.clean(); if (pending === state) pending = null; return; }
    state.transition.ready.then(() => {
      if (pending !== state) return;
      const rect = opening ? sourceRect : viewportRect(resolveCard());
      if (!rect || rect.width <= 0) { state.transition.skipTransition(); return; }
      const clamp = (n, max) => Math.max(0, Math.min(max, n));
      const width = root.innerWidth, height = root.innerHeight;
      const shape = `inset(${clamp(rect.top,height)}px ${clamp(width-rect.right,width)}px ${clamp(height-rect.bottom,height)}px ${clamp(rect.left,width)}px round 20px)`;
      const full = 'inset(0px 0px 0px 0px round 0px)';
      html.animate({ clipPath: opening ? [shape, full] : [full, shape] }, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both', pseudoElement: opening ? '::view-transition-new(root)' : '::view-transition-old(root)' });
    }).catch(() => {});
    state.transition.finished.catch(() => {}).finally(() => { state.clean(); if (pending === state) pending = null; });
  }
  function slide(node, direction) {
    slides.get(node)?.cancel();
    if (reduced() || doc.hidden || !node?.animate) return;
    const animation = node.animate([{ transform: `translateX(${direction < 0 ? -22 : 22}px)` }, { transform: 'translateX(0)' }], { duration: 190, easing: 'cubic-bezier(.2,.7,.2,1)' });
    slides.set(node, animation);
    runningSlides.add(animation);
    animation.finished.catch(() => {}).finally(() => { runningSlides.delete(animation); if (slides.get(node) === animation) slides.delete(node); });
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
