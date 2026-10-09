(function () {
  "use strict";
  const bridge = window.AndroidServer || null;
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const navItems = Array.from(document.querySelectorAll("[data-tab]"));
  let state = {};
  let toastTimer = null;
  let settingsDirty = false;

  const el = {};
  ["otaStatus", "otaBackup", "automaticOta", "otaCard", "otaVersion", "otaNotes", "otaProgress", "otaProgressBar", "otaProgressLabel", "checkServerUpdate", "installServerUpdate", "liveDot", "heroStatus", "heroDetail", "publicUrl", "metricBikes", "metricUsers", "metricShifts", "metricAlerts", "metricHistory", "metricPending", "systemBadge", "syncStatus", "syncCheck", "webCheck", "backupStatus", "backupCheck", "databaseStatus", "databaseCheck", "storageStatus", "storageCheck", "pwaStatus", "pwaCheck", "watchdogCheck", "invoiceProcessingCard", "invoiceProcessingBadge", "invoiceProcessingTitle", "invoiceProcessingName", "invoiceProcessingPercent", "invoiceProcessingBar", "invoiceProcessingDetail", "invoiceProcessingStage", "invoiceProcessingMessage", "deviceHealthBadge", "deviceHealthWarnings", "deviceBattery", "deviceCharging", "deviceTemperature", "deviceThermal", "deviceStorage", "deviceStorageTotal", "deviceAndroid", "deviceModel", "deviceRestrictions", "devicePowerSave", "deviceNetwork", "deviceUptime", "serverToggle", "statusError", "driveBadge", "backupSchedule", "autoBackupState", "lastBackup", "retentionLabel", "backupMessage", "uploadMessage", "releaseList", "workerUrl", "syncSeconds", "invoiceParallelism", "backupFrequency", "backupHour", "backupRetention", "automaticStart", "automaticBackup", "settingsMessage", "pinDialog", "pinForm", "newPin", "confirmPin", "pinError", "restorePinDialog", "restorePinForm", "restoreAdminPin", "restorePinError", "toast"].forEach(function (id) { el[id] = document.getElementById(id); });

  function parse(value, fallback) {
    try { return JSON.parse(value); } catch (error) { return fallback; }
  }

  function dashboard() {
    if (!bridge) return {
      bikes: 29, historyEntries: 148, lastAppliedCount: 0, serviceRunning: true, serverOnline: true,
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
    return parse(bridge.getDashboard(), {});
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
    el.invoiceProcessingMessage.textContent = notes.join(" • ");
  }

  function releaseNoteItems(notes) {
    const text = String(notes || "").trim();
    return text.split(/\r?\n|,\s+/).map(function (line) { return line.replace(/^\s*[•*-]\s*/, "").trim(); }).filter(Boolean);
  }

  function releaseNotesMarkup(notes) {
    const items = releaseNoteItems(notes);
    return items.length ? '<ul class="release-notes">' + items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>' : '';
  }

  function renderOta(ota) {
    const update = ota || {};
    const inProgress = ["checking", "downloading", "validating", "backup"].includes(update.stage);
    const nativeStatus = ["installing", "confirmation"].includes(update.installStatus) || (update.installStatus === "failed" && update.ready && !inProgress);
    const stage = nativeStatus ? update.installStatus : update.stage || "idle";
    const active = ["checking", "downloading", "validating", "backup", "installing"].includes(stage);
    el.automaticOta.checked = update.automatic !== false;
    el.otaStatus.textContent = nativeStatus ? update.installMessage : update.message || "Αυτόματος έλεγχος κάθε λεπτό.";
    el.otaBackup.textContent = update.backupName ? "Backup πριν την ενημέρωση: " + update.backupName : "";
    el.otaVersion.textContent = update.ready ? "Νέα έκδοση " + update.ready.version : "Server " + (state.serverVersion || "");
    el.otaNotes.innerHTML = releaseNotesMarkup(update.ready && update.ready.notes);
    el.otaProgress.hidden = !active;
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
    const order = { idle: -1, current: -1, checking: 0, downloading: 1, validating: 1, ready: 1, waiting: 1, permission: 1, backup_folder: 1, backup: 2, installing: 3, confirmation: 3, failed: -1 };
    const index = order[stage] === undefined ? -1 : order[stage];
    document.querySelectorAll("[data-ota-step]").forEach(function (step) {
      const value = Number(step.dataset.otaStep);
      step.classList.toggle("is-done", index > value);
      step.classList.toggle("is-active", index === value);
    });
    el.otaCard.classList.toggle("has-error", stage === "failed");
    el.checkServerUpdate.disabled = active || stage === "confirmation";
    el.installServerUpdate.disabled = active || (!update.ready && stage !== "confirmation");
    el.installServerUpdate.textContent = stage === "confirmation" ? "Επιβεβαίωση στο Android" : stage === "permission" ? "Άδεια εγκατάστασης" : "Εγκατάσταση ενημέρωσης";
  }

  function render(next) {
    state = next || dashboard();
    renderOta(state.ota || {});
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
    el.statusError.textContent = state.lastError || state.connectionError || "";
    renderInvoiceProcessing(state.invoiceReprocess);

    el.driveBadge.textContent = state.backupFolderSelected ? "Drive έτοιμο" : "Δεν έχει οριστεί";
    el.driveBadge.className = "state-badge" + (state.backupFolderSelected ? "" : " warn");
    const frequencyLabel = state.backupFrequency === "weekly" ? "Κάθε Δευτέρα" : state.backupFrequency === "weekdays" ? "Δευτέρα–Παρασκευή" : "Καθημερινά";
    el.backupSchedule.textContent = frequencyLabel + " στις " + String(state.backupHour == null ? 3 : state.backupHour).padStart(2, "0") + ":00";
    el.autoBackupState.textContent = state.automaticBackup ? "Ενεργό" : "Κλειστό";
    el.lastBackup.textContent = state.lastBackupTime ? formatDate(state.lastBackupTime) + " • " + (state.lastBackupResult || "Επιτυχία") : "Δεν έχει γίνει ακόμη";
    el.retentionLabel.textContent = "Τα τελευταία " + (state.backupRetention || 30) + " αντίγραφα";

    if (!settingsDirty) {
      el.workerUrl.value = state.workerUrl || "";
      el.syncSeconds.value = String(state.syncSeconds || 30);
      el.invoiceParallelism.value = String(state.invoiceParallelism || 4);
      el.backupFrequency.value = state.backupFrequency || "daily";
      el.backupHour.value = state.backupHour == null ? 3 : state.backupHour;
      el.backupRetention.value = state.backupRetention || 30;
      el.automaticStart.checked = state.automaticStart !== false;
      el.automaticBackup.checked = state.automaticBackup !== false;
    }
  }

  function showTab(name) {
    panels.forEach(function (panel) { panel.classList.toggle("is-hidden", panel.dataset.panel !== name); });
    navItems.forEach(function (item) { item.classList.toggle("active", item.dataset.tab === name); });
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

  navItems.forEach(function (item) { item.addEventListener("click", function () { showTab(item.dataset.tab); }); });
  document.getElementById("headerSettings").addEventListener("click", function () { showTab("settings"); });
  el.serverToggle.addEventListener("click", function () {
    if (!bridge) return;
    state.serviceRunning ? bridge.stopServer() : bridge.startServer();
    setTimeout(function () { render(dashboard()); }, 500);
  });
  document.getElementById("chooseFolder").addEventListener("click", function () { if (bridge) bridge.chooseBackupFolder(); });
  document.getElementById("backupNow").addEventListener("click", function () { el.backupMessage.textContent = "Δημιουργία backup…"; if (bridge) bridge.backupNow(); });
  document.getElementById("restoreBackup").addEventListener("click", function () { el.restorePinForm.reset(); el.restorePinError.textContent = ""; el.restorePinDialog.showModal(); });
  document.getElementById("uploadClient").addEventListener("click", function () { busy("Περιμένω να επιλέξεις το νέο APK…"); if (bridge) bridge.chooseClientApk(); });
  document.getElementById("uploadWeb").addEventListener("click", function () { busy("Περιμένω να επιλέξεις το ZIP της web έκδοσης…"); if (bridge) bridge.chooseWebPackage(); });
  document.getElementById("refreshReleases").addEventListener("click", function () { if (bridge) bridge.loadReleases(); });
  document.getElementById("checkServerUpdate").addEventListener("click", function () { if (bridge) bridge.checkServerUpdate(); el.otaStatus.textContent = "Γίνεται έλεγχος…"; });
  document.getElementById("installServerUpdate").addEventListener("click", function () { if (bridge) bridge.installServerUpdate(); });
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
    const payload = {
      workerUrl: el.workerUrl.value.trim(), syncSeconds: Number(el.syncSeconds.value), invoiceParallelism: Number(el.invoiceParallelism.value),
      backupFrequency: el.backupFrequency.value,
      backupHour: Number(el.backupHour.value), backupRetention: Number(el.backupRetention.value),
      automaticStart: el.automaticStart.checked, automaticBackup: el.automaticBackup.checked
    };
    const result = parse(bridge.saveSettings(JSON.stringify(payload)), { ok: false, message: "Η αποθήκευση απέτυχε." });
    el.settingsMessage.textContent = result.ok ? "Οι ρυθμίσεις αποθηκεύτηκαν." : result.message;
    if (result.ok) settingsDirty = false;
    render(result.ok ? result : dashboard());
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
