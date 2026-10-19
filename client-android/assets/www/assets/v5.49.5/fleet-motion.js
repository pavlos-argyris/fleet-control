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
