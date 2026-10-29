(function () {
  "use strict";
  const root = document.documentElement;
  let frameDialogOpen = false;
  let modalOpen = false;
  let height = 0;
  let width = window.innerWidth;
  let scheduled = false;

  function viewportHeight() {
    const visual = window.visualViewport;
    return Math.max(1, Math.round(Math.min(window.innerHeight, visual ? visual.height : window.innerHeight)));
  }

  function updateModal() {
    const wasOpen = modalOpen;
    modalOpen = Boolean(document.querySelector("dialog[open]"));
    root.classList.toggle("fleet-modal-open", modalOpen || frameDialogOpen);
    if (modalOpen && !wasOpen) {
      height = viewportHeight();
      root.style.setProperty("--fleet-dialog-viewport", height + "px");
    }
    if (wasOpen !== modalOpen && window.parent !== window) {
      window.parent.postMessage({ type: "fleet-control:modal-state", open: modalOpen }, "*");
    }
  }

  function resize() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function () {
      scheduled = false;
      const next = viewportHeight();
      const rotated = Math.abs(window.innerWidth - width) > 10;
      width = window.innerWidth;
      // Browser chrome motion must not resize a modal on every swipe.
      // Keyboard/rotation changes remain available to focused form fields.
      if (modalOpen && (rotated || Math.abs(next - height) > 160)) {
        height = next;
        root.style.setProperty("--fleet-dialog-viewport", height + "px");
      }
    });
  }

  new MutationObserver(updateModal).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"], childList: true });
  window.addEventListener("resize", resize, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resize, { passive: true });
  window.addEventListener("message", function (event) {
    const frame = document.getElementById("fleetModuleFrame");
    if (!frame || event.source !== frame.contentWindow || !event.data || event.data.type !== "fleet-control:modal-state") return;
    frameDialogOpen = event.data.open === true;
    updateModal();
  });
  const frame = document.getElementById("fleetModuleFrame");
  if (frame) frame.addEventListener("load", function () { frameDialogOpen = false; updateModal(); });
  updateModal();
}());
