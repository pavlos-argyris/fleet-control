(function (root) {
  'use strict';
  const doc = root.document, html = doc.documentElement;
  const reduced = () => root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let pending = null, restoreGeneration = 0, motionId = 0, htmlOwner = 0;
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
    current.commit(); current.transition?.skipTransition(); current.cancel?.();
    // Keep transition CSS until the browser removes its snapshots. Removing it
    // synchronously can briefly restore the browser's default cross-fade.
  }
  function returnSurface({ resolveCard, detail, update }) {
    const id = ++motionId, surface = doc.createElement('div');
    surface.className = 'fleet-bike-return-surface';
    surface.setAttribute('aria-hidden', 'true');
    // Static app icon and text only: never copy the detail DOM or its screenshot.
    surface.innerHTML = '<span class="fleet-bike-return-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h2l2-7h8l2 7h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 10l2-4h3l2 4"/></svg></span>';
    const plate = doc.createElement('strong');
    plate.textContent = detail.querySelector('#detailName')?.textContent || 'Μηχανή';
    surface.append(plate);
    const from = { left: '0px', top: '0px', width: root.innerWidth+'px', height: root.innerHeight+'px', borderRadius: '0px' };
    Object.assign(surface.style, from);
    let committed = false, cleaned = false;
    const state = {
      commit() { if (!committed) { committed = true; update(); } },
      cancel() { state.clean(); },
      clean() {
        if (cleaned) return;
        cleaned = true;
        state.animation?.cancel(); surface.remove();
        root.removeEventListener('resize', state.cancel);
        if (htmlOwner === id) { delete html.dataset.fleetCardMotion; html.style.removeProperty('--fleet-card-shape'); }
        if (pending === state) pending = null;
      }
    };
    pending = state; htmlOwner = id; html.dataset.fleetCardMotion = 'close';
    doc.body.append(surface);
    root.addEventListener('resize', state.cancel, { once: true });
    try { state.commit(); } catch (error) { state.clean(); throw error; }
    // No View Transition during Back: the real list is revealed underneath one
    // live, isolated surface. Its plate/icon remain centred as a single unit.
    root.requestAnimationFrame(() => root.requestAnimationFrame(() => {
      if (pending !== state || cleaned) return;
      const rect = viewportRect(resolveCard());
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= root.innerHeight) { state.clean(); return; }
      const to = { left: rect.left+'px', top: rect.top+'px', width: rect.width+'px', height: rect.height+'px', borderRadius: '20px' };
      try {
        state.animation = surface.animate([from, to], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both' });
        state.animation.finished.catch(() => {}).finally(state.clean);
      } catch (error) { state.clean(); }
    }));
  }
  function card({ opening, resolveCard, detail, update }) {
    finish(); cancelRestore();
    runningSlides.forEach(animation => animation.cancel()); runningSlides.clear();
    const sourceRect = viewportRect(opening ? resolveCard() : detail);
    const canAnimate = !reduced() && !doc.hidden && (opening ? typeof doc.startViewTransition === 'function' : typeof html.animate === 'function') && sourceRect?.width > 0 && sourceRect.bottom > 0 && sourceRect.top < root.innerHeight;
    if (!canAnimate) { update(); return; }
    if (!opening) { returnSurface({ resolveCard, detail, update }); return; }
    const id = ++motionId;
    const setShape = rect => {
      if (!rect || rect.width <= 0) return false;
      const clamp = (n, max) => Math.max(0, Math.min(max, n));
      const width = root.innerWidth, height = root.innerHeight;
      html.style.setProperty('--fleet-card-shape', `inset(${clamp(rect.top,height)}px ${clamp(width-rect.right,width)}px ${clamp(height-rect.bottom,height)}px ${clamp(rect.left,width)}px round 20px)`);
      return true;
    };
    setShape(sourceRect);
    html.dataset.fleetCardMotion = 'open';
    htmlOwner = id;
    let committed = false, settled;
    const state = {
      commit() {
        if (committed) return settled;
        committed = true;
        update();
        // Restore the list anchor and let the Portal/iframe finish resizing
        // before the new snapshot is captured, rather than during the reveal.
        // Rendering is paused inside a View Transition update callback, so
        // waiting for requestAnimationFrame here can deadlock the transition.
        settled = new Promise(resolve => root.setTimeout(() => root.setTimeout(resolve, 0), 0));
        return settled;
      },
      clean() {
        if (htmlOwner !== id) return;
        delete html.dataset.fleetCardMotion;
        html.style.removeProperty('--fleet-card-shape');
      }
    };
    pending = state;
    try { state.transition = doc.startViewTransition(state.commit); }
    catch (error) { state.commit(); state.clean(); if (pending === state) pending = null; return; }
    state.transition.ready.catch(() => {});
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
