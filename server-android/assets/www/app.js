(function () {
  "use strict";
  const bridge = window.AndroidServer || null;
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const navItems = Array.from(document.querySelectorAll("[data-tab]"));
  let state = {};
  let toastTimer = null;
  let settingsDirty = false;
  let settingsReady = false;
  let settingsReadFailed = false;
  let otaManualUntil = 0;

  const el = {};
  ["backupProgressCard","backupProgressStage","backupProgressPercent","backupLiveBar","backupLiveFill","backupProgressDetail","backupProgressTiming","backupProgressSafety","backupProgressError","retryBackupExport","otaWaitDetails","otaBlockers","otaCheckpointDetail","pauseAndInstallUpdate","postponeUpdate","otaRetryBackup","forceUpdateDialog","forceUpdateContents","confirmForceUpdate","ocrParallelism","syncDiagnosticStage","syncDiagnosticEndpoint","syncDiagnosticAdvice","mirrorDiagnosticStage","mirrorDiagnosticError","retrySync","retrySystemMirror","invoiceProcessingAdvice","retryServerInvoice","otaStatus", "otaBackup", "automaticOta", "otaCard", "otaVersion", "otaNotes", "otaProgress", "otaProgressBar", "otaProgressLabel", "checkServerUpdate", "installServerUpdate", "liveDot", "heroStatus", "heroDetail", "publicUrl", "metricBikes", "metricUsers", "metricShifts", "metricAlerts", "metricHistory", "metricPending", "systemBadge", "syncStatus", "syncCheck", "webCheck", "backupStatus", "backupCheck", "databaseStatus", "databaseCheck", "storageStatus", "storageCheck", "pwaStatus", "pwaCheck", "watchdogCheck", "invoiceProcessingCard", "invoiceProcessingBadge", "invoiceProcessingTitle", "invoiceProcessingName", "invoiceProcessingPercent", "invoiceProcessingBar", "invoiceProcessingDetail", "invoiceProcessingStage", "invoiceProcessingMessage", "deviceHealthBadge", "deviceHealthWarnings", "deviceBattery", "deviceCharging", "deviceTemperature", "deviceThermal", "deviceStorage", "deviceStorageTotal", "deviceAndroid", "deviceModel", "deviceRestrictions", "devicePowerSave", "deviceNetwork", "deviceUptime", "serverToggle", "statusError", "driveBadge", "backupSchedule", "autoBackupState", "lastBackup", "retentionLabel", "backupMessage", "uploadMessage", "releaseList", "workerUrl", "syncSeconds", "invoiceParallelism", "backupFrequency", "backupHour", "backupRetention", "automaticStart", "automaticBackup", "settingsMessage", "pinDialog", "pinForm", "newPin", "confirmPin", "pinError", "restorePinDialog", "restorePinForm", "restoreAdminPin", "restorePinError", "toast"].forEach(function (id) { el[id] = document.getElementById(id); });

  function parse(value, fallback) {
    try { return JSON.parse(value); } catch (error) { return fallback; }
  }

  function dashboard() {
    if (!bridge) return {
      settingsLoaded: true, bikes: 29, historyEntries: 148, lastAppliedCount: 0, serviceRunning: true, serverOnline: true,
      lastSyncTime: new Date().toISOString(), workerUrl: "https://fleet-control.pavlosargyris.workers.dev",
      backupFolderSelected: true, automaticBackup: true, backupHour: 3, backupRetention: 30, backupFrequency: "daily",
      lastBackupTime: new Date().toISOString(), lastBackupResult: "Επιτυχία", syncSeconds: 30, invoiceParallelism: 4, automaticStart: true,
      users: 8, activeShifts: 3, openAlerts: 1, databaseOk: true, storageOk: true, fleetControlOk: true,
      watchdogActive: true, pwaConnected: true, pwaLastSeen: new Date().toISOString(),
      health: { batteryPercent: 84, batteryCharging: true, batteryTemperatureC: 34.2,
        storageFreeBytes: 18874368000, storageTotalBytes: 128849018880, powerSaveMode: false,
        ignoringBatteryOptimizations: true, thermalStatus: "none", networkConnected: true,
        networkType: "MOBILE • LTE", androidVersion: "16", deviceModel: "Samsung Galaxy S24 Ultra", uptimeSeconds: 172800 }
    };
    try { return parse(bridge.getDashboard(), {settingsLoaded:false,dashboardError:"Δεν φορτώθηκαν τα στοιχεία του Server."}); }
    catch(error) { return {settingsLoaded:false,dashboardError:error.message||"Δεν φορτώθηκαν τα στοιχεία του Server."}; }
  }

  function formatDate(value) {
    if (!value) return "Δεν έχει γίνει ακόμη";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  function formatUptime(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days ? days + "η " + hours + "ω λειτουργίας" : hours + "ω λειτουργίας";
  }

  function renderInvoiceProcessing(batch) {
    const job=state.invoiceJob;
    if (job && (!batch || batch.status !== "processing")) batch={status:job.error ? "error" : Number(job.progress)>=100 ? "completed" : "processing",total:1,completed:Number(job.progress)>=100 ? 1:0,progress:job.progress,currentName:"QR · " + String(job.jobId||"").slice(0,8),serverStage:job.stage,serverError:job.error};
    el.retryServerInvoice.hidden=(!job || !job.jobId) && !batch && !state.invoiceQueueError;
    el.retryServerInvoice.textContent=batch && batch.status === "error" ? "Συνέχιση από το σημείο διακοπής" : job && job.jobId ? "Διακοπή & νέα προσπάθεια" : "Έλεγχος ουράς τώρα";
    el.invoiceProcessingAdvice.textContent=job && job.error ? problemAdvice(job.error) : "Φόρτωση σελίδας QR → PDF → τοπική ανάγνωση → αποστολή → έλεγχος Cloudflare / AI.";
    if (!batch && state.invoiceQueueError) batch={status:"error",total:0,completed:0,serverError:state.invoiceQueueError,currentName:"Έλεγχος σύνδεσης ουράς"};
    if (!batch || typeof batch !== "object") {
      el.invoiceProcessingCard.classList.add("is-hidden");
      el.invoiceProcessingBadge.textContent = "Αδρανές";
      el.invoiceProcessingBadge.className = "state-badge warn";
      return;
    }
    const status = String(batch.status || "processing");
    const total = Math.max(0, Number(batch.total) || 0);
    const completed = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(batch.completed) || 0));
    let progress = Number(batch.progress);
    if (!Number.isFinite(progress)) progress = total ? completed * 100 / total : 0;
    if (status === "completed") progress = 100;
    progress = Math.max(0, Math.min(100, Math.round(progress)));
    const processing = status === "processing";
    const failed = status === "error" || status === "completed_with_errors" || Boolean(batch.serverError);
    const complete = status === "completed" || status === "completed_with_errors";
    el.invoiceProcessingCard.classList.remove("is-hidden", "is-processing", "has-error", "is-complete");
    el.invoiceProcessingCard.classList.toggle("is-processing", processing);
    el.invoiceProcessingCard.classList.toggle("has-error", failed);
    el.invoiceProcessingCard.classList.toggle("is-complete", complete && !failed);
    el.invoiceProcessingBadge.className = "state-badge" + (failed || !processing && !complete ? " warn" : "");
    el.invoiceProcessingBadge.textContent = processing ? "Σε εξέλιξη" : failed ? "Έλεγχος" : complete ? "Ολοκληρώθηκε" : "Αναμονή";
    el.invoiceProcessingTitle.textContent = processing ? "Νέα ανάγνωση τιμολογίων" : failed ? "Η ανάγνωση χρειάζεται έλεγχο" : "Η ανάγνωση ολοκληρώθηκε";
    const activeItems = Array.isArray(batch.activeItems) ? batch.activeItems.filter(Boolean).map(String) : [];
    const activeLabel = activeItems.length > 1
      ? activeItems.slice(0, 2).join(" • ") + (activeItems.length > 2 ? " • +" + (activeItems.length - 2) : "")
      : String(batch.currentName || "Προετοιμασία…");
    el.invoiceProcessingName.textContent = activeLabel;
    el.invoiceProcessingPercent.textContent = progress + "%";
    el.invoiceProcessingBar.style.width = progress + "%";
    el.invoiceProcessingBar.parentElement.setAttribute("aria-valuenow", String(progress));
    el.invoiceProcessingDetail.textContent = (completed || 0) + "/" + (total || 0) + " τιμολόγια";
    el.invoiceProcessingStage.textContent = String(batch.serverStage || (processing ? "Ο Server επεξεργάζεται…" : complete ? "Τέλος διαδικασίας" : "Αναμονή Server…"));
    const notes = [];
    if (Number(batch.fallbackCount) > 0) notes.push("Workers AI fallback: " + Number(batch.fallbackCount));
    if (Number(batch.skipped) > 0) notes.push("Παραλείφθηκαν: " + Number(batch.skipped));
    if (batch.serverError) notes.push("Σφάλμα σύνδεσης: " + String(batch.serverError));
    if (batch.error) notes.push(String(batch.error));
    if(state.invoiceReaderStage)notes.push("Αναγνώστης: "+state.invoiceReaderStage);
    const metrics=state.invoiceAnalysisMetrics||{};Object.keys(metrics).forEach(key=>notes.push(({textMs:"Κείμενο",pdfboxMs:"PDFBox",ocrWaitMs:"Αναμονή OCR",ocrMs:"OCR",qrPdfMs:"Σελίδα QR/PDF",uploadMs:"Αποστολή και απάντηση Worker"}[key]||key.replace("Ms",""))+": "+(Number(metrics[key])/1000).toFixed(1)+"s"));
    el.invoiceProcessingMessage.textContent = notes.join(" • ");
  }

  function problemAdvice(error) {
    const text=String(error||"");
    if (/401|403/.test(text)) return "Η πρόσβαση απορρίφθηκε. Έλεγξε ότι το Worker URL και η εγκατάσταση Server ανήκουν στο ίδιο σύστημα. Έπειτα δοκίμασε σύνδεση ξανά.";
    if (/503|502|504|429/.test(text)) return "Προσωρινό σφάλμα Cloudflare. Η εργασία παραμένει αποθηκευμένη· δοκίμασε ξανά. Αν επιμένει, χρειάζεται το συγκεκριμένο νέο log Worker.";
    if (/χώρο|storage|space/i.test(text)) return "Ελευθέρωσε χώρο στις ρυθμίσεις Android και πάτησε νέα προσπάθεια.";
    if (/QR|σελίδα|φόρτωση|PDF|χρονικό όριο/.test(text)) return "Έλεγξε ότι το QR ανοίγει το σωστό τιμολόγιο. Μπορείς να διακόψεις αυτή την προσπάθεια και να ξεκινήσεις νέα.";
    return "Έλεγξε Wi-Fi/δεδομένα και πάτησε επανάληψη. Τα αποθηκευμένα δεδομένα διατηρούνται.";
  }

  function releaseNoteItems(notes) {
    const text = String(notes || "").trim();
    return text.split(/\r?\n|,\s+/).map(function (line) { return line.replace(/^\s*[•*-]\s*/, "").trim(); }).filter(Boolean);
  }

  function releaseNotesMarkup(notes) {
    const items = releaseNoteItems(notes);
    return items.length ? '<ul class="release-notes">' + items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>' : '';
  }

  function duration(seconds) { const n=Math.max(0,Math.floor(Number(seconds)||0));return n<60?n+" δευτ.":Math.floor(n/60)+" λεπ. "+(n%60)+" δευτ."; }
  function backupSafety(progress) {
    if (!progress.localReady) return "Το νέο τοπικό αντίγραφο προετοιμάζεται. Το προηγούμενο ολοκληρωμένο backup διατηρείται.";
    const missing=Number(progress.missingDocuments||0);
    return "Τοπικό αντίγραφο έτοιμο · τιμολόγια "+Number(progress.includedDocuments||0)+" / "+Number(progress.expectedDocuments||0)+"."+(missing?" Λείπουν "+missing+" τοπικά αρχεία· χρειάζεται συγχρονισμός και νέο backup.":"")+(progress.workforceIncluded===false?" Δεν υπάρχει τοπικό αντίγραφο προσωπικού/συστήματος· χρειάζεται συγχρονισμός και νέο backup.":"")+(progress.state==="completed"?" Ολοκληρώθηκε και η εγγραφή στον επιλεγμένο φάκελο.":" Δεν έχει ολοκληρωθεί ακόμη η αποστολή στον φάκελο. Μην απεγκαταστήσεις την εφαρμογή.");
  }
  function renderBackup(progress) {
    progress=progress||{};const active=["preparing","exporting"].includes(progress.state),failed=["failed","paused"].includes(progress.state),percent=Math.max(0,Math.min(progress.state==="completed"?100:99,Number(progress.percent)||0));
    el.backupProgressCard.hidden=!progress.id;
    el.backupProgressStage.textContent=progress.stage||"Προετοιμασία αντιγράφου";
    el.backupProgressPercent.textContent=percent+"%";
    el.backupLiveFill.style.width=percent+"%";el.backupLiveBar.setAttribute("aria-valuenow",String(percent));el.backupLiveBar.classList.toggle("is-active",active);
    const parts=[];if(Number(progress.filesTotal)>0)parts.push(Number(progress.filesDone||0)+" / "+Number(progress.filesTotal)+" αρχεία");if(Number(progress.bytesTotal)>0)parts.push(formatBytes(progress.bytesDone||0)+" / "+formatBytes(progress.bytesTotal));if(progress.fileName)parts.push(progress.fileName);
    el.backupProgressDetail.textContent=parts.join(" · ");
    el.backupProgressTiming.textContent=progress.id?"Συνολικός χρόνος: "+duration(progress.elapsedSeconds)+" · Στο τρέχον στάδιο: "+duration(progress.stageSeconds)+(active&&Number(progress.idleSeconds)>=30?" · Χωρίς νέα ένδειξη προόδου για "+duration(progress.idleSeconds)+". Αν περιμένει ο φάκελος, η αποστολή θα τερματιστεί μετά από 90 δευτ. αδράνειας.":""):"";
    el.backupProgressSafety.textContent=progress.id?backupSafety(progress):"";el.backupProgressError.textContent=progress.error||"";
    el.retryBackupExport.hidden=!(failed&&progress.localReady);el.retryBackupExport.disabled=Boolean(state.ota?.forceRequested);document.getElementById("backupNow").disabled=active||Boolean(state.ota?.pauseRequested);
    el.backupProgressCard.classList.toggle("has-error",failed);
  }

  function renderOta(ota) {
    const update = Object.assign({},ota || {});
    if (Date.now()<otaManualUntil && !["downloading","validating","backup","installing"].includes(update.stage)) update.stage="checking";
    const inProgress = ["checking", "downloading", "validating", "backup"].includes(update.stage);
    const nativeStatus = ["installing", "confirmation"].includes(update.installStatus) || (update.installStatus === "failed" && update.ready && !inProgress);
    const stage = nativeStatus ? update.installStatus : update.stage || "idle";
    const active = ["checking", "downloading", "validating", "backup", "installing"].includes(stage);
    const animated = active || ["confirmation","waiting","permission","backup_folder"].includes(stage);
    el.automaticOta.checked = update.automatic !== false;
    el.otaStatus.textContent = nativeStatus ? update.installMessage : update.message || "Αυτόματος έλεγχος κάθε ώρα.";
    el.otaBackup.textContent = update.backupName ? "Backup πριν την ενημέρωση: " + update.backupName : "";
    el.otaVersion.textContent = update.ready ? "Νέα έκδοση " + update.ready.version : "Server " + (state.serverVersion || "");
    el.otaNotes.innerHTML = releaseNotesMarkup(update.ready && update.ready.notes);
    el.otaProgress.hidden = !animated;
    const download = stage === "downloading";
    if (download) {
      const percent = Math.max(0, Math.min(100, Number(update.downloadPercent) || 0));
      el.otaProgressBar.style.width = percent + "%";
      el.otaProgress.setAttribute("aria-valuenow", String(percent));
      el.otaProgressLabel.textContent = percent + "% · " + formatBytes(update.downloadedBytes) + " / " + formatBytes(update.totalBytes);
    } else {
      el.otaProgress.removeAttribute("aria-valuenow");
      el.otaProgressBar.style.width = "35%";
      el.otaProgressLabel.textContent = stage === "backup" ? "Αποθήκευση δεδομένων και τιμολογίων…" : stage === "installing" ? "Εγκατάσταση από το Android…" : "Προετοιμασία…";
    }
    if (!active) el.otaProgressLabel.textContent = "";
    el.otaProgress.classList.toggle("is-indeterminate", !download);
    el.otaProgress.classList.toggle("is-active",animated);
    const order = { idle: -1, current: -1, checking: 0, downloading: 1, validating: 1, ready: 1, waiting: 1, permission: 1, backup_folder: 1, backup: 2, installing: 3, confirmation: 3, failed: -1 };
    const index = order[stage] === undefined ? -1 : order[stage];
    document.querySelectorAll("[data-ota-step]").forEach(function (step) {
      const value = Number(step.dataset.otaStep);
      step.classList.toggle("is-done", index > value);
      step.classList.toggle("is-active", index === value);
    });
    el.otaCard.classList.toggle("has-error", stage === "failed" || stage === "backup_failed");
    const blockers=Array.isArray(update.blockers)?update.blockers:[],progress=update.backupProgress||{},pendingAndroid=["confirmation","installing"].includes(stage),canPause=Boolean(update.ready)&&!["downloading","validating","checking"].includes(stage)&&!pendingAndroid;
    el.otaWaitDetails.hidden=!update.ready||pendingAndroid;
    el.otaBlockers.innerHTML=blockers.map(task=>'<div class="ota-blocker"><strong>'+escapeHtml(task.title)+'</strong><span>'+escapeHtml(task.detail)+'</span><small>Διάρκεια '+escapeHtml(duration(task.elapsedSeconds))+' · ίδιο στάδιο '+escapeHtml(duration(task.stageSeconds))+'</small></div>').join('');
    el.otaCheckpointDetail.textContent=progress.id?((progress.stage||"")+" · "+Number(progress.percent||0)+"% · "+backupSafety(progress)+(progress.error?" "+progress.error:"")):blockers.length?"Η ενημέρωση περιμένει να ολοκληρωθεί ή να παύσει με ασφάλεια η παραπάνω εργασία.":update.held?"Η ενημέρωση έχει αναβληθεί· οι εργασίες συνεχίζονται.":"Δεν εκτελείται εργασία δεδομένων. Αναμένεται προετοιμασία backup ή η ενέργεια που αναφέρεται παραπάνω.";
    el.pauseAndInstallUpdate.hidden=!canPause;el.pauseAndInstallUpdate.disabled=Boolean(update.forceRequested);el.postponeUpdate.hidden=!update.ready||pendingAndroid;
    el.otaRetryBackup.disabled=Boolean(update.forceRequested);
    el.otaRetryBackup.hidden=!(update.ready&&progress.localReady&&["failed","paused"].includes(progress.state)&&!pendingAndroid);
    if(stage==="backup"&&progress.id){el.otaProgressBar.style.width=Number(progress.percent||0)+"%";el.otaProgress.setAttribute("aria-valuenow",String(Number(progress.percent||0)));el.otaProgress.classList.remove("is-indeterminate");el.otaProgressLabel.textContent=(progress.stage||"")+" · "+Number(progress.percent||0)+"%";}
    el.checkServerUpdate.disabled = active || stage === "confirmation";
    el.installServerUpdate.disabled = active || (!update.ready && stage !== "confirmation");
    el.installServerUpdate.textContent = stage === "confirmation" ? "Επιβεβαίωση στο Android" : stage === "permission" ? "Άδεια εγκατάστασης" : "Εγκατάσταση ενημέρωσης";
  }

  function setSettingsReady(ready) {
    settingsReady = ready;
    document.getElementById("settingsForm").querySelectorAll("input,select,button").forEach(function(input){input.disabled=!ready;});
    el.serverToggle.disabled=!ready;
    el.automaticOta.disabled=!ready;
    document.getElementById("chooseFolder").disabled=!ready;
    document.getElementById("restoreBackup").disabled=!ready;
  }

  function render(next) {
    const incoming = next || dashboard();
    if (!incoming || incoming.settingsLoaded !== true) {
      setSettingsReady(false);
      settingsReadFailed = true;
      el.systemBadge.className="state-badge warn";
      const error = incoming?.dashboardError || "Δεν φορτώθηκαν οι αποθηκευμένες ρυθμίσεις. Περίμενε την επανάληψη φόρτωσης.";
      el.statusError.textContent = error;
      el.settingsMessage.textContent = error + " Η αποθήκευση παραμένει κλειδωμένη.";
      if (!state.settingsLoaded) {
        el.heroStatus.textContent="Δεν φορτώθηκαν τα στοιχεία του Server";
        el.heroDetail.textContent="Η κατάσταση λειτουργίας και αντιγράφων δεν είναι διαθέσιμη ακόμη.";
        el.publicUrl.textContent="Δεν φορτώθηκε";
        el.driveBadge.textContent="Δεν φορτώθηκε";
        el.autoBackupState.textContent="Δεν φορτώθηκε";
        el.backupSchedule.textContent="Δεν φορτώθηκε";
        el.systemBadge.textContent="Σφάλμα φόρτωσης";
        [el.metricBikes,el.metricUsers,el.metricShifts,el.metricAlerts,el.metricHistory,el.metricPending].forEach(function(node){node.textContent="—";});
      }
      document.getElementById("backupNow").disabled=true;
      return;
    }
    state = incoming;
    setSettingsReady(true);
    if(settingsReadFailed&&!settingsDirty)el.settingsMessage.textContent="Οι αποθηκευμένες ρυθμίσεις φορτώθηκαν.";
    settingsReadFailed=false;
    renderOta(state.ota || {});
    renderBackup(state.backupProgress || state.ota?.backupProgress);
    const sync=state.syncDiagnostics || {};
    el.syncDiagnosticStage.textContent=sync.stage || "Αναμονή";
    el.syncDiagnosticEndpoint.textContent=(sync.endpoint||"") + (sync.durationMs ? " · τελευταίος κύκλος " + (Number(sync.durationMs)/1000).toFixed(1) + " δευτ." : "");
    el.syncDiagnosticAdvice.textContent=state.lastError ? problemAdvice(state.lastError) : "Ο στόλος συγχρονίζεται ανεξάρτητα από τα PDF και το αντίγραφο προσωπικού.";
    el.mirrorDiagnosticStage.textContent=sync.mirrorStage || "";
    el.mirrorDiagnosticError.textContent=sync.mirrorError ? sync.mirrorError + " · " + problemAdvice(sync.mirrorError) : "";
    const running = Boolean(state.serviceRunning);
    const online = running && Boolean(state.serverOnline);
    el.liveDot.className = "live-dot " + (online ? "online" : running ? "warning" : "");
    el.heroStatus.textContent = online ? "Ο server λειτουργεί" : running ? "Αναμονή σύνδεσης" : "Ο server είναι σταματημένος";
    el.heroDetail.textContent = online ? "Δεδομένα κινητής ή Wi‑Fi • συγχρονίστηκε " + formatDate(state.lastSyncTime) : running ? "Θα επανασυνδεθεί αυτόματα μόλις υπάρχει ίντερνετ" : "Πάτησε εκκίνηση για να αρχίσει ο συγχρονισμός";
    el.publicUrl.textContent = String(state.workerUrl || "").replace(/^https?:\/\//, "");
    el.metricBikes.textContent = state.bikes || 0;
    el.metricUsers.textContent = state.users || state.remoteUsers || 0;
    el.metricShifts.textContent = state.activeShifts || state.remoteActiveShifts || 0;
    el.metricAlerts.textContent = state.openAlerts || state.remotePendingAlerts || 0;
    el.metricHistory.textContent = state.historyEntries || 0;
    el.metricPending.textContent = state.lastAppliedCount || 0;
    el.systemBadge.textContent = online && state.lastError ? "Καθυστέρηση συγχρονισμού" : online ? "Όλα καλά" : running ? "Εκκρεμεί" : "Ανενεργό";
    el.systemBadge.className = "state-badge" + (online && !state.lastError ? "" : " warn");
    el.syncStatus.textContent = state.lastSyncTime ? "Τελευταία σύνδεση " + formatDate(state.lastSyncTime) : "Δεν έχει γίνει ακόμη";
    el.syncCheck.textContent = online ? "✓" : "—";
    el.webCheck.textContent = state.workerUrl ? "✓" : "—";
    el.backupStatus.textContent = state.backupFolderSelected ? (state.lastBackupResult || "Ο φάκελος είναι έτοιμος") : "Δεν έχει οριστεί φάκελος";
    el.backupCheck.textContent = state.backupFolderSelected ? "✓" : "—";
    el.databaseStatus.textContent = state.databaseOk ? "D1 online • πλήρες mirror " + formatDate(state.systemMirrorTime) : "Η κοινή βάση δεν έχει επιβεβαιωθεί";
    el.databaseCheck.textContent = state.databaseOk ? "✓" : "—";
    el.storageStatus.textContent = state.storageOk ? "R2 online • ενημερώσεις διαθέσιμες" : "Το R2 δεν έχει επιβεβαιωθεί";
    el.storageCheck.textContent = state.storageOk ? "✓" : "—";
    el.pwaStatus.textContent = state.pwaConnected ? "Τελευταία σύνδεση " + formatDate(state.pwaLastSeen) : "Δεν έχει συνδεθεί ακόμη";
    el.pwaCheck.textContent = state.pwaConnected ? "✓" : "—";
    el.watchdogCheck.textContent = state.watchdogActive ? "✓" : "—";
    const health = state.health || {};
    const battery = Number(health.batteryPercent);
    const temperature = Number(health.batteryTemperatureC);
    const freeBytes = Number(health.storageFreeBytes);
    const totalBytes = Number(health.storageTotalBytes);
    const storagePercent = totalBytes > 0 ? freeBytes * 100 / totalBytes : null;
    const warnings = [];
    if (Number.isFinite(temperature) && temperature >= 42) warnings.push("Υψηλή θερμοκρασία: " + temperature.toFixed(1) + "°C");
    if (Number.isFinite(storagePercent) && storagePercent <= 10) warnings.push("Ο ελεύθερος χώρος είναι κάτω από 10%");
    if (Number.isFinite(battery) && battery <= 15 && !health.batteryCharging) warnings.push("Χαμηλή μπαταρία χωρίς φόρτιση");
    if (health.ignoringBatteryOptimizations === false) warnings.push("Η βελτιστοποίηση μπαταρίας μπορεί να σταματήσει τον server");
    if (health.powerSaveMode) warnings.push("Είναι ενεργή η εξοικονόμηση ενέργειας");
    if (health.networkConnected === false) warnings.push("Δεν υπάρχει ενεργό δίκτυο");
    el.deviceHealthBadge.textContent = warnings.length ? warnings.length + (warnings.length === 1 ? " προειδοποίηση" : " προειδοποιήσεις") : "Καλή κατάσταση";
    el.deviceHealthBadge.className = "state-badge" + (warnings.length ? " warn" : "");
    el.deviceHealthWarnings.classList.toggle("is-hidden", !warnings.length);
    el.deviceHealthWarnings.innerHTML = warnings.map(function (warning) { return "<span>• " + escapeHtml(warning) + "</span>"; }).join("");
    el.deviceBattery.textContent = Number.isFinite(battery) ? battery.toFixed(battery % 1 ? 1 : 0) + "%" : "—";
    el.deviceCharging.textContent = health.batteryCharging ? "Σε φόρτιση" : "Δεν φορτίζει";
    el.deviceTemperature.textContent = Number.isFinite(temperature) ? temperature.toFixed(1) + "°C" : "—";
    el.deviceThermal.textContent = "Thermal: " + (health.thermalStatus || "μη διαθέσιμο");
    el.deviceStorage.textContent = formatBytes(freeBytes);
    el.deviceStorageTotal.textContent = "από " + formatBytes(totalBytes);
    el.deviceAndroid.textContent = "Android " + (health.androidVersion || "—");
    el.deviceModel.textContent = health.deviceModel || "—";
    el.deviceRestrictions.textContent = health.ignoringBatteryOptimizations === false ? "Χρειάζεται ρύθμιση" : "Χωρίς περιορισμό";
    el.devicePowerSave.textContent = health.powerSaveMode ? "Εξοικονόμηση ενεργή" : "Κανονική λειτουργία";
    el.deviceNetwork.textContent = health.networkConnected === false ? "Εκτός σύνδεσης" : (health.networkType || "Συνδεδεμένο");
    el.deviceUptime.textContent = formatUptime(health.uptimeSeconds);
    el.serverToggle.textContent = running ? "Διακοπή server" : "Εκκίνηση server";
    el.serverToggle.className = "primary-action" + (running ? " stop" : "");
    el.statusError.textContent = state.dataReadError || state.lastError || state.connectionError || "";
    renderInvoiceProcessing(state.invoiceReprocess);

    el.driveBadge.textContent = state.backupFolderSelected ? "Drive έτοιμο" : "Δεν έχει οριστεί";
    el.driveBadge.className = "state-badge" + (state.backupFolderSelected ? "" : " warn");
    const frequencyLabel = state.backupFrequency === "weekly" ? "Κάθε Δευτέρα" : state.backupFrequency === "weekdays" ? "Δευτέρα–Παρασκευή" : "Καθημερινά";
    el.backupSchedule.textContent = frequencyLabel + " στις " + String(state.backupHour == null ? 3 : state.backupHour).padStart(2, "0") + ":00";
    el.autoBackupState.textContent = state.automaticBackup ? "Ενεργό" : "Κλειστό";
    const backupInfo=state.backupMetadata||{},verification=state.backupVerification||{};
    el.lastBackup.textContent = backupInfo.time ? formatDate(backupInfo.time)+" • "+backupInfo.fileName : state.lastBackupTime ? formatDate(state.lastBackupTime)+" • Παλαιότερο αντίγραφο" : "Δεν έχει γίνει ακόμη";
    document.getElementById("verifyLastBackup").disabled=!state.canVerifyLastBackup;
    document.getElementById("backupContents").textContent=backupInfo.fileName ? "Τιμολόγια στο αντίγραφο: "+Number(backupInfo.includedDocuments||0)+" / "+Number(backupInfo.expectedDocuments||0)+(backupInfo.missingDocuments?" · Λείπουν "+backupInfo.missingDocuments+". Άνοιξε τον συγχρονισμό και δημιούργησε ξανά backup.":" · Τα αναμενόμενα τιμολόγια περιλαμβάνονται.") + (backupInfo.workforceIncluded===false?" Δεν υπάρχει συγχρονισμένο αντίγραφο προσωπικού/συστήματος· συγχρόνισε και πάρε νέο backup.":"") : "Τα στοιχεία περιεχομένου θα εμφανιστούν μετά το επόμενο backup.";
    document.getElementById("backupContents").classList.toggle("backup-health-warning",!!backupInfo.fileName&&(!!backupInfo.missingDocuments||backupInfo.workforceIncluded===false));
    document.getElementById("backupVerificationStatus").textContent=verification.checkedAt ? formatDate(verification.checkedAt)+" • "+verification.fileName+" • "+verification.message : "Δεν έχει γίνει έλεγχος αναγνωσιμότητας.";
    document.getElementById("backupVerificationStatus").classList.toggle("backup-health-warning",!!verification.checkedAt&&!verification.complete);
    el.retentionLabel.textContent = "Τα τελευταία " + (state.backupRetention || 30) + " καταγεγραμμένα πλήρη αντίγραφα. Αρχεία παλιών εκδόσεων και ημιτελείς προσπάθειες διατηρούνται.";

    if(state.statsUnavailable){
      [el.metricBikes,el.metricUsers,el.metricShifts,el.metricAlerts,el.metricHistory].forEach(function(node){node.textContent="—";});
      el.systemBadge.textContent="Τα τοπικά δεδομένα δεν φορτώθηκαν";
      el.systemBadge.className="state-badge warn";
      document.getElementById("backupNow").disabled=true;
    }

    if (!settingsDirty) {
      el.workerUrl.value = state.workerUrl || "";
      el.syncSeconds.value = String(state.syncSeconds || 30);
      el.ocrParallelism.value=String(state.ocrParallelism||1);
      el.invoiceParallelism.value = String(state.invoiceParallelism || 4);
      el.backupFrequency.value = state.backupFrequency || "daily";
      el.backupHour.value = state.backupHour == null ? 3 : state.backupHour;
      el.backupRetention.value = state.backupRetention || 30;
      el.automaticStart.checked = state.automaticStart !== false;
      el.automaticBackup.checked = state.automaticBackup !== false;
    }
  }

  let activeTab="status";
  function showTab(name) {
    const previous=activeTab;activeTab=name;
    panels.forEach(function (panel) { panel.classList.toggle("is-hidden", panel.dataset.panel !== name); });
    navItems.forEach(function (item) { item.classList.toggle("active", item.dataset.tab === name); });
    navItems.forEach(item=>{if(item.dataset.tab===name)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
    if(previous!==name)window.FleetMotion?.slide(panels.find(panel=>panel.dataset.panel===name),['status','backup','updates','settings'].indexOf(name)<['status','backup','updates','settings'].indexOf(previous)?-1:1);
    if (name === "updates" && bridge) { bridge.loadReleases(); bridge.checkServerUpdate(); }
    window.scrollTo(0, 0);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add("show");
    toastTimer = setTimeout(function () { el.toast.classList.remove("show"); }, 3500);
  }

  function busy(message) {
    el.uploadMessage.textContent = message;
    [document.getElementById("uploadClient"), document.getElementById("uploadWeb")].forEach(function (button) { button.disabled = true; });
  }

  function releaseList(payload) {
    const releases = Array.isArray(payload.releases) ? payload.releases : [];
    if (!releases.length) {
      el.releaseList.innerHTML = '<p class="empty-copy">Δεν έχουν ανέβει ακόμη εκδόσεις.</p>';
      return;
    }
    el.releaseList.innerHTML = releases.map(function (release) {
      const label = release.kind === "client" ? "Client APK" : release.kind === "server" ? "Server APK" : "Web";
      return '<div class="release-row"><span><strong>' + label + ' • ' + escapeHtml(release.version) + '</strong><small>' + formatDate(release.created_at) + '</small>' + releaseNotesMarkup(release.notes) + '</span>' +
        (release.kind === "server" ? '<small>Εγκατάσταση μέσω OTA</small>' : Number(release.active) === 1 ? '<b class="active-release">Ενεργή</b>' : '<button type="button" data-activate="' + escapeHtml(release.id) + '">Επαναφορά</button>') + '</div>';
    }).join("");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  window.FleetServer = {
    onNativeEvent: function (event, payload) {
      payload = payload || {};
      if (event === "connection") {
        el.settingsMessage.textContent = payload.ok ? (payload.serverOnline ? "Η σύνδεση λειτουργεί και ο server φαίνεται online." : "Η Cloudflare πύλη λειτουργεί. Η υπηρεσία θα συνδεθεί σε λίγο.") : payload.message;
      } else if (event === "backup") {
        el.backupMessage.textContent = payload.ok ? "Το backup αποθηκεύτηκε: " + payload.fileName : payload.message;
      } else if(event==="ota"){showToast(payload.message||"Έλεγξε τις λεπτομέρειες ενημέρωσης.");
      } else if (event === "backupVerification") {
        el.backupMessage.textContent=payload.ok ? payload.message+" Μηχανάκια: "+Number(payload.bikes||0)+" · Εγγραφές ιστορικού: "+Number(payload.historyEntries||0)+" · Εγγραφές συστήματος: "+Number(payload.records||0)+". "+payload.documentsMessage : payload.message;
      } else if (event === "backupPreview") {
        if(!payload.ok){el.backupMessage.textContent=payload.message;return;}
        const d=document.createElement('dialog');d.className='backup-restore-preview';
        d.innerHTML='<div class="dialog-head"><h2>Πριν από την επαναφορά</h2></div><p>Προσθήκες: <strong>'+Number(payload.added||0)+'</strong><br>Εγγραφές που αντικαθίστανται: <strong>'+Number(payload.replaced||0)+'</strong><br>Πρόσθετες εγγραφές που διατηρούνται: <strong>'+Number(payload.preserved||0)+'</strong></p><p>Οι εγγραφές με ίδιο κλειδί αντικαθίστανται από το backup. Οι επιπλέον εγγραφές παραμένουν. Θα δημιουργηθεί τοπικό αντίγραφο πριν την αλλαγή. Η επαναφορά συσκευής και cloud γίνεται σε στάδια· αν διακοπεί, έλεγξε το αποτέλεσμα πριν επαναλάβεις.</p><details><summary>Ανά κατηγορία</summary><div data-tables></div></details><div class="dialog-buttons"><button type="button" class="secondary-action" data-cancel>Ακύρωση</button><button type="button" class="primary-action inline" data-confirm>Επιβεβαίωση επαναφοράς</button></div>';
        payload.tables.forEach(function(t){const row=document.createElement('p');row.textContent=t.table+': +'+t.added+' / αντικατάσταση '+t.replaced+' / διατήρηση '+t.preserved;d.querySelector('[data-tables]').append(row);});
        document.body.append(d);let confirmed=false;
        d.querySelector('[data-cancel]').onclick=function(){d.close();};
        d.querySelector('[data-confirm]').onclick=function(){confirmed=true;d.querySelector('[data-confirm]').disabled=true;bridge.confirmBackupRestore();d.close();el.backupMessage.textContent='Επαναφορά σε εξέλιξη…';};
        d.addEventListener('close',function(){if(!confirmed)bridge.cancelBackupRestore();d.remove();},{once:true});d.showModal();
      } else if (event === "backupRestore") {
        if (!payload.ok) {
          el.backupMessage.textContent = payload.message;
        } else {
          const expected = Number(payload.documentsExpected || 0);
          const uploaded = Number(payload.documentsUploaded || 0);
          const missing = Number(payload.documentsMissing || 0);
          el.backupMessage.textContent = "Έγινε επαναφορά " + payload.bikes + " οχημάτων και " + payload.records + " εγγραφών συστήματος." + (expected ? " Τιμολόγια: " + uploaded + "/" + expected + " αποκαταστάθηκαν στο cloud" + (missing ? " · λείπουν " + missing : "") + "." : " Δεν βρέθηκε συνοδευτικό αρχείο τιμολογίων.");
        }
      } else if (event === "folder") {
        showToast(payload.ok ? "Ο φάκελος backup αποθηκεύτηκε." : payload.message);
      } else if (event === "clientUpload" || event === "webUpload") {
        document.getElementById("uploadClient").disabled = false;
        document.getElementById("uploadWeb").disabled = false;
        el.uploadMessage.textContent = payload.ok ? (event === "clientUpload" ? "Το νέο Client APK είναι πλέον διαθέσιμο στο web." : "Η νέα web έκδοση ενεργοποιήθηκε.") : payload.message;
        if (payload.ok && bridge) bridge.loadReleases();
      } else if (event === "releases") {
        if (payload.ok) releaseList(payload); else el.uploadMessage.textContent = payload.message;
      } else if (event === "releaseActivated") {
        el.uploadMessage.textContent = payload.ok ? "Η επιλεγμένη έκδοση ενεργοποιήθηκε." : payload.message;
        if (bridge) bridge.loadReleases();
      } else if (event === "pin") {
        if (payload.ok) {
          el.pinDialog.close();
          showToast("Το PIN άλλαξε με επιτυχία.");
        } else {
          el.pinError.textContent = payload.message;
        }
      }
      render(dashboard());
    }
  };

  document.querySelectorAll('[data-server-jump]').forEach(jump=>jump.addEventListener('click',()=>showTab(jump.dataset.serverJump)));
  navItems.forEach(function (item) { item.addEventListener("click", function () { showTab(item.dataset.tab); }); });
  document.getElementById("headerSettings").addEventListener("click", function () { showTab("settings"); });
  el.serverToggle.addEventListener("click", function () {
    if (!bridge) return;
    state.serviceRunning ? bridge.stopServer() : bridge.startServer();
    setTimeout(function () { render(dashboard()); }, 500);
  });
  document.getElementById("chooseFolder").addEventListener("click", function () { if (bridge) bridge.chooseBackupFolder(); });
  document.getElementById("verifyLastBackup").addEventListener("click",function(){el.backupMessage.textContent="Έλεγχος αναγνωσιμότητας σε εξέλιξη… Δεν γίνεται επαναφορά.";if(bridge)bridge.verifyLastBackup();});
  document.getElementById("verifyBackupFile").addEventListener("click",function(){el.backupMessage.textContent="Διάλεξε backup για έλεγχο, χωρίς επαναφορά.";if(bridge)bridge.chooseBackupVerification();});
  document.getElementById("backupNow").addEventListener("click", function () { el.backupMessage.textContent = "Δημιουργία backup…"; if (bridge) bridge.backupNow(); });
  document.getElementById("restoreBackup").addEventListener("click", function () { el.restorePinForm.reset(); el.restorePinError.textContent = ""; el.restorePinDialog.showModal(); });
  document.getElementById("uploadClient").addEventListener("click", function () { busy("Περιμένω να επιλέξεις το νέο APK…"); if (bridge) bridge.chooseClientApk(); });
  document.getElementById("uploadWeb").addEventListener("click", function () { busy("Περιμένω να επιλέξεις το ZIP της web έκδοσης…"); if (bridge) bridge.chooseWebPackage(); });
  document.getElementById("refreshReleases").addEventListener("click", function () { if (bridge) bridge.loadReleases(); });
  el.retrySync.addEventListener("click",function(){if(bridge) bridge.retrySync();showToast("Ζητήθηκε νέος συγχρονισμός.");});
  el.retrySystemMirror.addEventListener("click",function(){if(bridge) bridge.retrySystemMirror();showToast("Ζητήθηκε ενημέρωση αντιγράφου.");});
  el.retryServerInvoice.addEventListener("click",function(){
    if(state.invoiceReprocess?.status === "error"){if(bridge) bridge.resumeInvoiceBatch();showToast("Ζητήθηκε συνέχιση της ουράς.");return;}
    const job=state.invoiceJob;
    if(!job || !job.jobId){if(bridge)bridge.retryInvoice("");return;}
    if(window.confirm("Διακοπή της παλιάς προσπάθειας και έναρξη νέας;")){if(bridge) bridge.retryInvoice(job.jobId);showToast("Ζητήθηκε νέα προσπάθεια.");}
  });
  document.getElementById("checkServerUpdate").addEventListener("click", function () { otaManualUntil=Date.now()+1200; renderOta({stage:"checking",message:"Γίνεται έλεγχος…"}); if (bridge) bridge.checkServerUpdate(); });
  document.getElementById("installServerUpdate").addEventListener("click", function () { if (bridge) bridge.installServerUpdate(); });
  el.pauseAndInstallUpdate.addEventListener("click",function(){const progress=state.backupProgress||state.ota?.backupProgress||{};el.forceUpdateContents.textContent=progress.id?backupSafety(progress):"Θα δημιουργηθεί νέο τοπικό αντίγραφο πριν από την εγκατάσταση.";el.forceUpdateDialog.showModal();});
  el.confirmForceUpdate.addEventListener("click",function(){el.forceUpdateDialog.close();if(bridge)bridge.pauseAndInstallServerUpdate();showToast("Ζητήθηκε ασφαλής παύση. Δες την εργασία που αναμένεται και την πρόοδο backup.");});
  el.postponeUpdate.addEventListener("click",function(){if(bridge)bridge.postponeServerUpdate();showToast("Η ενημέρωση αναβλήθηκε. Οι εργασίες μπορούν να συνεχιστούν.");});
  [el.retryBackupExport,el.otaRetryBackup].forEach(button=>button.addEventListener("click",function(){if(bridge)bridge.retryBackupExport();showToast("Ζητήθηκε νέα αποστολή του τοπικού αντιγράφου.");}));
  el.automaticOta.addEventListener("change", function () { if (bridge) bridge.setAutomaticOta(el.automaticOta.checked); });
  el.releaseList.addEventListener("click", function (event) { const button = event.target.closest("[data-activate]"); if (button && bridge) bridge.activateRelease(button.dataset.activate); });
  document.getElementById("testConnection").addEventListener("click", function () { el.settingsMessage.textContent = "Έλεγχος…"; if (bridge) bridge.testConnection(); });
  document.getElementById("batterySettings").addEventListener("click", function () { if (bridge) bridge.openBatterySettings(); });
  document.getElementById("changePin").addEventListener("click", function () { el.pinForm.reset(); el.pinError.textContent = ""; el.pinDialog.showModal(); });
  document.querySelectorAll("[data-close]").forEach(function (button) { button.addEventListener("click", function () { document.getElementById(button.dataset.close).close(); }); });

  ["input", "change", "focusin"].forEach(function (eventName) {
    document.getElementById("settingsForm").addEventListener(eventName, function () {
      settingsDirty = true;
      el.settingsMessage.textContent = "Οι αλλαγές σου διατηρούνται. Πάτησε Αποθήκευση.";
    });
  });

  document.getElementById("settingsForm").addEventListener("submit", function (event) {
    event.preventDefault();
    if (!bridge) return;
    if (!settingsReady) { el.settingsMessage.textContent="Οι αποθηκευμένες ρυθμίσεις δεν έχουν φορτωθεί. Δεν έγινε καμία αλλαγή."; return; }
    const payload = {
      settingsLoaded: true,
      workerUrl: el.workerUrl.value.trim(), syncSeconds: Number(el.syncSeconds.value), invoiceParallelism: Number(el.invoiceParallelism.value), ocrParallelism:Number(el.ocrParallelism.value),
      backupFrequency: el.backupFrequency.value,
      backupHour: Number(el.backupHour.value), backupRetention: Number(el.backupRetention.value),
      automaticStart: el.automaticStart.checked, automaticBackup: el.automaticBackup.checked
    };
    const result = parse(bridge.saveSettings(JSON.stringify(payload)), { ok: false, message: "Η αποθήκευση απέτυχε." });
    el.settingsMessage.textContent = result.ok ? "Οι ρυθμίσεις αποθηκεύτηκαν." : result.message;
    if (result.ok) {
      Object.assign(state,payload);
      const fresh=dashboard();
      if(fresh?.settingsLoaded===true){settingsDirty=false;render(fresh);el.settingsMessage.textContent="Οι ρυθμίσεις αποθηκεύτηκαν.";}
      else{settingsDirty=true;render(fresh);el.settingsMessage.textContent="Οι ρυθμίσεις αποθηκεύτηκαν, αλλά η ανανέωση της οθόνης απέτυχε. Οι τιμές σου διατηρούνται.";}
    }
  });

  el.pinForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const pin = el.newPin.value.trim();
    if (!/^\d{4,6}$/.test(pin)) return void (el.pinError.textContent = "Το PIN πρέπει να έχει 4 έως 6 αριθμούς.");
    if (pin !== el.confirmPin.value.trim()) return void (el.pinError.textContent = "Τα δύο PIN δεν είναι ίδια.");
    el.pinError.textContent = "Αποθήκευση…";
    if (bridge) bridge.changePin(pin);
  });

  el.restorePinForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const pin = el.restoreAdminPin.value.trim();
    if (!/^\d{4,6}$/.test(pin)) return void (el.restorePinError.textContent = "Το PIN πρέπει να έχει 4 έως 6 αριθμούς.");
    el.restorePinDialog.close();
    el.backupMessage.textContent = "Διάλεξε το κρυπτογραφημένο Fleet Control backup…";
    if (bridge) bridge.chooseBackupFile(pin);
  });

  render(dashboard());
  setInterval(function () { render(dashboard()); }, 1000);
}());
