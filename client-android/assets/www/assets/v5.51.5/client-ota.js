(function(){
  "use strict";
  const bridge=window.AndroidFleet;
  if(!bridge || typeof bridge.getClientUpdateState!=="function") return;
  const dialog=document.createElement("dialog");dialog.className="client-ota-dialog";
  dialog.innerHTML='<article class="client-ota-card"><button class="client-ota-close" type="button" aria-label="Κλείσιμο">×</button><div class="client-ota-head"><i>↻</i><div><small>ΕΝΗΜΕΡΩΣΗ CLIENT</small><h2 id="clientOtaVersion">Fleet Control</h2></div><b>OTA</b></div><p id="clientOtaMessage"></p><ol class="client-ota-steps"><li><b>1</b>Έλεγχος</li><li><b>2</b>Λήψη</li><li><b>3</b>Επαλήθευση</li><li><b>4</b>Εγκατάσταση</li></ol><div class="client-ota-progress" role="progressbar" aria-label="Πρόοδος ενημέρωσης"><span></span></div><small id="clientOtaProgressText"></small><ul id="clientOtaNotes"></ul><div class="client-ota-actions"><button id="clientOtaCheck" type="button">Έλεγχος τώρα</button><button id="clientOtaInstall" type="button">Εγκατάσταση</button></div></article>';
  document.body.appendChild(dialog);
  const open=document.createElement("button");open.type="button";open.className="client-ota-open";open.textContent="↻ Ενημέρωση";
  const host=document.querySelector(".sidebar-foot") || document.querySelector(".topbar-actions") || document.body;
  host.appendChild(open);
  const login=document.querySelector(".download-note");
  if(login){const shortcut=open.cloneNode(true);shortcut.addEventListener("click",()=>open.click());login.after(shortcut);}
  let manualUntil=0,lastOffer="";
  function show(){if(!dialog.open)dialog.showModal();if(bridge.setClientOtaOpen)bridge.setClientOtaOpen(true);}
  function close(){dialog.close();if(bridge.dismissClientUpdate)bridge.dismissClientUpdate();if(bridge.setClientOtaOpen)bridge.setClientOtaOpen(false);}
  window.FleetClientOta={close};
  dialog.addEventListener("close",()=>{if(bridge.setClientOtaOpen)bridge.setClientOtaOpen(false);});
  const $=id=>dialog.querySelector("#"+id);
  function render(value){
    const state=value||{};let stage=state.stage||"idle";
    if(Date.now()<manualUntil && ["idle","current","waiting","failed"].includes(stage)) stage="checking";
    const active=["checking","downloading","validating","installing","confirmation","permission","waiting"].includes(stage);
    const ready=state.ready;
    $("clientOtaVersion").textContent=ready ? "Νέα έκδοση "+ready.version : "Client "+(state.currentVersion||"");
    $("clientOtaMessage").textContent=stage==="checking" ? "Έλεγχος νέας έκδοσης…" : state.message||"Έλεγξε για ενημερώσεις.";
    const progress=dialog.querySelector(".client-ota-progress");progress.classList.toggle("is-active",active);
    const download=stage==="downloading",percent=ready&&ready.sizeBytes ? Math.min(100,Math.round(Number(state.downloadedBytes||0)*100/ready.sizeBytes)) : 0;
    progress.querySelector("span").style.width=download ? percent+"%" : active ? "35%" : "100%";
    progress.classList.toggle("is-indeterminate",active&&!download);
    if(download) progress.setAttribute("aria-valuenow",String(percent));else progress.removeAttribute("aria-valuenow");
    $("clientOtaProgressText").textContent=download ? percent+"% · "+(Number(state.downloadedBytes||0)/1048576).toFixed(1)+" MB" : "";
    const order={checking:0,waiting:0,downloading:1,validating:2,installing:3,confirmation:3,permission:3,current:4};const index=order[stage]??-1;
    dialog.querySelectorAll(".client-ota-steps li").forEach((li,i)=>{li.classList.toggle("is-active",index===i);li.classList.toggle("is-done",index>i);});
    $("clientOtaNotes").replaceChildren();String(ready?.notes||"").split(/\r?\n/).map(line=>line.replace(/^\s*[•*-]\s*/,"").trim()).filter(Boolean).forEach(note=>{const li=document.createElement("li");li.textContent=note;$("clientOtaNotes").appendChild(li);});
    $("clientOtaCheck").disabled=["checking","downloading","validating","installing"].includes(stage);
    $("clientOtaInstall").disabled=!ready||["checking","downloading","validating","installing"].includes(stage);
    $("clientOtaInstall").textContent=stage==="confirmation" ? "Επιβεβαίωση Android" : stage==="permission" ? "Άδεια εγκατάστασης" : "Εγκατάσταση";
    dialog.classList.toggle("has-error",stage==="failed");
    if(state.offer&&ready&&lastOffer!==ready.version){lastOffer=ready.version;show();}
  }
  function refresh(){try{render(JSON.parse(bridge.getClientUpdateState()));}catch(error){}}
  open.onclick=()=>{refresh();show();};
  dialog.querySelector(".client-ota-close").onclick=close;
  dialog.addEventListener("cancel",()=>{if(bridge.dismissClientUpdate)bridge.dismissClientUpdate();});
  $("clientOtaCheck").onclick=()=>{manualUntil=Date.now()+1200;render({stage:"checking"});bridge.checkClientUpdate();};
  $("clientOtaInstall").onclick=()=>bridge.installClientUpdate();
  window.addEventListener("fleet-client-ota",event=>render(event.detail));
  setInterval(()=>{if(document.visibilityState==="visible")refresh();},500);refresh();
})();
