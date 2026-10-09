(function () {
  "use strict";

  const STORAGE_KEY = "moto-service-tracker-v1";
  const AUTH_TOKEN_PERSIST = "fleet-control-auth-token";
  const AUTH_TOKEN_SESSION = "fleet-control-session-token";
  const USER_CACHE = "fleet-control-user-cache";
  const SERVER_URL_KEY = "fleet-control-server-url";
  const DIRTY_KEY = "fleet-control-pending-fleet-change";
  const MAX_BIKES = 40;
  const MAX_SERVICE_ATTACHMENTS = 10;
  const WARNING_KM = 500;
  const URGENT_KM = 200;
  const MAJOR_SERVICE_INTERVAL_KM = 10000;
  const MILEAGE_CHECK_STALE_DAYS = 7;
  const MILEAGE_CHECK_ALERT_SIGNATURE_KEY = "fleet-control-mileage-check-alert-signature";
  const numberFormat = new Intl.NumberFormat("el-GR");
  const dateFormat = new Intl.DateTimeFormat("el-GR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
  const config = window.FLEET_CONFIG || {};
  let apiBase = String(loadSetting(SERVER_URL_KEY) || config.apiBase || "").replace(/\/$/, "");
  const isAndroidApp = Boolean(window.AndroidFleet);
  const isEmbedded = new URLSearchParams(window.location.search).get("embedded") === "1" || /\/fleet\/?$/.test(window.location.pathname);

  if (isEmbedded) {
    document.documentElement.classList.add("embedded-mode");
    const staticSync = document.querySelector(".fleet-live-chip");
    if (staticSync) staticSync.classList.add("is-hidden");
  }

  let bikes = loadBikes();
  let activeBikeId = null;
  let serviceOrderHomeScroll = 0;
  let activeHistoryFilter = "service";
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let syncTimer = null;
  let syncRunning = false;
  let syncQueued = false;
  let pendingEditAction = null;
  let webToken = "";
  let pendingFleetChange = loadSetting(DIRTY_KEY) === "1";
  let currentUser = loadCachedUser();
  let archivedBikes = [];
  let qrScannerStream = null;
  let qrScannerFrame = 0;
  let qrScannerContext = "";
  let historyReportOpen = false;
  let historyEntrySaveQueue = Promise.resolve();
  const backgroundHistorySaves = new Map();

  try {
    webToken = localStorage.getItem(AUTH_TOKEN_PERSIST) || sessionStorage.getItem(AUTH_TOKEN_SESSION) || "";
    if (!webToken && window.AndroidFleet && typeof window.AndroidFleet.getAuthToken === "function") {
      webToken = String(window.AndroidFleet.getAuthToken() || "");
      if (webToken) sessionStorage.setItem(AUTH_TOKEN_SESSION, webToken);
    }
  } catch (error) {}

  if (!webToken) {
    try { sessionStorage.setItem("fleet-control-return-to-fleet", "1"); } catch (error) {}
    returnToPortal(true);
    return;
  }

  const elements = {
    homeView: document.getElementById("homeView"),
    serviceOrderView: document.getElementById("serviceOrderView"),
    serviceOrderButton: document.getElementById("serviceOrderButton"),
    serviceOrderBackButton: document.getElementById("serviceOrderBackButton"),
    serviceOrderList: document.getElementById("serviceOrderList"),
    serviceOrderSummary: document.getElementById("serviceOrderSummary"),
    quickCheckView: document.getElementById("quickCheckView"),
    detailView: document.getElementById("detailView"),
    bikeCount: document.getElementById("bikeCount"),
    healthyCount: document.getElementById("healthyCount"),
    attentionCount: document.getElementById("attentionCount"),
    overdueCount: document.getElementById("overdueCount"),
    attentionMeter: document.getElementById("attentionMeter"),
    overviewStats: document.querySelectorAll("[data-overview-filter]"),
    overviewMessage: document.getElementById("overviewMessage"),
    fleetAlert: document.getElementById("fleetAlert"),
    fleetAlertTitle: document.getElementById("fleetAlertTitle"),
    fleetAlertText: document.getElementById("fleetAlertText"),
    mileageCheckAlert: document.getElementById("mileageCheckAlert"),
    mileageCheckAlertTitle: document.getElementById("mileageCheckAlertTitle"),
    mileageCheckAlertText: document.getElementById("mileageCheckAlertText"),
    listStatus: document.getElementById("listStatus"),
    exportFleetButton: document.getElementById("exportFleetButton"),
    fleetExportDialog: document.getElementById("fleetExportDialog"),
    fleetExportList: document.getElementById("fleetExportList"),
    createFleetExportButton: document.getElementById("createFleetExportButton"),
    historyReportDialog: document.getElementById("historyReportDialog"),
    historyReportTitle: document.getElementById("historyReportTitle"),
    historyReportBody: document.getElementById("historyReportBody"),
    historyReportPrintButton: document.getElementById("historyReportPrintButton"),
    historyReportCloseButton: document.getElementById("historyReportCloseButton"),
    emptyState: document.getElementById("emptyState"),
    bikeList: document.getElementById("bikeList"),
    archivedBikesSection: document.getElementById("archivedBikesSection"),
    archivedBikeList: document.getElementById("archivedBikeList"),
    refreshArchivedButton: document.getElementById("refreshArchivedButton"),
    addBikeButton: document.getElementById("addBikeButton"),
    pinSettingsButton: document.getElementById("pinSettingsButton"),
    installButton: document.getElementById("installButton"),
    syncIndicator: document.getElementById("syncIndicator"),
    syncStatus: document.getElementById("syncStatus"),
    webAccessButton: document.getElementById("webAccessButton"),
    webAccessLabel: document.getElementById("webAccessLabel"),
    downloadApkButton: document.getElementById("downloadApkButton"),
    openQuickCheckButton: document.getElementById("openQuickCheckButton"),
    quickCheckForm: document.getElementById("quickCheckForm"),
    quickBikeSelect: document.getElementById("quickBikeSelect"),
    quickBikePicker: document.getElementById("quickBikePicker"),
    quickBikePickerLabel: document.getElementById("quickBikePickerLabel"),
    quickBikePickerMeta: document.getElementById("quickBikePickerMeta"),
    quickBikePickerStatus: document.getElementById("quickBikePickerStatus"),
    quickCurrentKm: document.getElementById("quickCurrentKm"),
    quickMajorHint: document.getElementById("quickMajorHint"),
    quickCheckError: document.getElementById("quickCheckError"),
    quickCheckResult: document.getElementById("quickCheckResult"),
    quickCheckBackButton: document.getElementById("quickCheckBackButton"),
    detailBackButton: document.getElementById("detailBackButton"),
    detailEditButton: document.getElementById("detailEditButton"),
    detailCheckButton: document.getElementById("detailCheckButton"),
    detailServiceButton: document.getElementById("detailServiceButton"),
    detailExportButton: document.getElementById("detailExportButton"),
    detailArchiveButton: document.getElementById("detailArchiveButton"),
    detailName: document.getElementById("detailName"),
    detailStatusCard: document.getElementById("detailStatusCard"),
    detailStatusBadge: document.getElementById("detailStatusBadge"),
    detailLastCheck: document.getElementById("detailLastCheck"),
    detailCurrentKm: document.getElementById("detailCurrentKm"),
    detailNextService: document.getElementById("detailNextService"),
    detailRemaining: document.getElementById("detailRemaining"),
    detailLastService: document.getElementById("detailLastService"),
    detailInterval: document.getElementById("detailInterval"),
    detailMajorService: document.getElementById("detailMajorService"),
    detailMajorServiceHint: document.getElementById("detailMajorServiceHint"),
    historyCount: document.getElementById("historyCount"),
    detailHistory: document.getElementById("detailHistory"),
    historyFilterButtons: document.querySelectorAll("[data-history-filter]"),
    historyEntryDialog: document.getElementById("historyEntryDialog"),
    historyEntryForm: document.getElementById("historyEntryForm"),
    historyEntryDialogTitle: document.getElementById("historyEntryDialogTitle"),
    historyEntryContext: document.getElementById("historyEntryContext"),
    historyEntryBikeId: document.getElementById("historyEntryBikeId"),
    historyEntryId: document.getElementById("historyEntryId"),
    historyEntryType: document.getElementById("historyEntryType"),
    historyEntryKm: document.getElementById("historyEntryKm"),
    historyEntryDate: document.getElementById("historyEntryDate"),
    historyEntryServiceFields: document.getElementById("historyEntryServiceFields"),
    historyEntryWorkshop: document.getElementById("historyEntryWorkshop"),
    historyEntryCost: document.getElementById("historyEntryCost"),
    historyEntryNotes: document.getElementById("historyEntryNotes"),
    historyEntryOilChanged: document.getElementById("historyEntryOilChanged"),
    historyEntryMajorService: document.getElementById("historyEntryMajorService"),
    historyEntryTaskInputs: document.querySelectorAll('[name="historyEntryTask"]'),
    historyEntryReason: document.getElementById("historyEntryReason"),
    historyEntryError: document.getElementById("historyEntryError"),
    historyEntryDeleteButton: document.getElementById("historyEntryDeleteButton"),
    historyEntrySaveButton: document.getElementById("historyEntrySaveButton"),
    historyEntryInvoiceFile: document.getElementById("historyEntryInvoiceFile"),
    historyEntryInvoiceFileName: document.getElementById("historyEntryInvoiceFileName"),
    historyEntryInvoiceQrValue: document.getElementById("historyEntryInvoiceQrValue"),
    historyEntryInvoiceQrStatus: document.getElementById("historyEntryInvoiceQrStatus"),
    historyEntryQrScanButton: document.getElementById("historyEntryQrScanButton"),
    invoiceReviewDialog: document.getElementById("invoiceReviewDialog"),
    invoiceReviewForm: document.getElementById("invoiceReviewForm"),
    invoiceReviewContext: document.getElementById("invoiceReviewContext"),
    invoiceReviewSource: document.getElementById("invoiceReviewSource"),
    invoiceReviewMismatch: document.getElementById("invoiceReviewMismatch"),
    invoiceReviewPlate: document.getElementById("invoiceReviewPlate"),
    invoiceReviewOdometerKm: document.getElementById("invoiceReviewOdometerKm"),
    invoiceReviewSupplier: document.getElementById("invoiceReviewSupplier"),
    invoiceReviewNumber: document.getElementById("invoiceReviewNumber"),
    invoiceReviewDate: document.getElementById("invoiceReviewDate"),
    invoiceReviewTotal: document.getElementById("invoiceReviewTotal"),
    invoiceReviewWorkPerformed: document.getElementById("invoiceReviewWorkPerformed"),
    invoiceReviewComments: document.getElementById("invoiceReviewComments"),
    invoiceReviewRawDetails: document.getElementById("invoiceReviewRawDetails"),
    invoiceReviewRawText: document.getElementById("invoiceReviewRawText"),
    invoiceReviewError: document.getElementById("invoiceReviewError"),
    invoiceReviewKeepFileButton: document.getElementById("invoiceReviewKeepFileButton"),
    invoiceReviewSaveButton: document.getElementById("invoiceReviewSaveButton"),
    bikeDialog: document.getElementById("bikeDialog"),
    bikeForm: document.getElementById("bikeForm"),
    bikeDialogTitle: document.getElementById("bikeDialogTitle"),
    bikeId: document.getElementById("bikeId"),
    bikeName: document.getElementById("bikeName"),
    serviceInterval: document.getElementById("serviceInterval"),
    lastServiceKm: document.getElementById("lastServiceKm"),
    nextPreview: document.querySelector("#nextPreview strong"),
    bikeFormError: document.getElementById("bikeFormError"),
    serviceDialog: document.getElementById("serviceDialog"),
    serviceForm: document.getElementById("serviceForm"),
    serviceBikeId: document.getElementById("serviceBikeId"),
    serviceBikeName: document.getElementById("serviceBikeName"),
    serviceKm: document.getElementById("serviceKm"),
    serviceDate: document.getElementById("serviceDate"),
    serviceWorkshop: document.getElementById("serviceWorkshop"),
    serviceCost: document.getElementById("serviceCost"),
    serviceNotes: document.getElementById("serviceNotes"),
    serviceOilChanged: document.getElementById("serviceOilChanged"),
    serviceMajorService: document.getElementById("serviceMajorService"),
    serviceMajorHint: document.getElementById("serviceMajorHint"),
    serviceTaskInputs: document.querySelectorAll('[name="serviceTask"]'),
    serviceNextPreview: document.querySelector("#serviceNextPreview strong"),
    serviceFormError: document.getElementById("serviceFormError"),
    serviceMileageWarning: document.getElementById("serviceMileageWarning"),
    serviceInvoiceFile: document.getElementById("serviceInvoiceFile"),
    serviceInvoiceFileName: document.getElementById("serviceInvoiceFileName"),
    serviceInvoiceQrValue: document.getElementById("serviceInvoiceQrValue"),
    serviceInvoiceQrStatus: document.getElementById("serviceInvoiceQrStatus"),
    serviceQrScanButton: document.getElementById("serviceQrScanButton"),
    qrScannerDialog: document.getElementById("qrScannerDialog"),
    qrScannerForm: document.getElementById("qrScannerForm"),
    qrScannerVideo: document.getElementById("qrScannerVideo"),
    qrScannerStatus: document.getElementById("qrScannerStatus"),
    qrScannerError: document.getElementById("qrScannerError"),
    qrScannerManualButton: document.getElementById("qrScannerManualButton"),
    qrScannerCancelButton: document.getElementById("qrScannerCancelButton"),
    qrScannerCloseButton: document.getElementById("qrScannerCloseButton"),
    checkDialog: document.getElementById("checkDialog"),
    checkDialogForm: document.getElementById("checkDialogForm"),
    checkDialogBikeId: document.getElementById("checkDialogBikeId"),
    checkDialogBikeName: document.getElementById("checkDialogBikeName"),
    checkDialogKm: document.getElementById("checkDialogKm"),
    checkDialogError: document.getElementById("checkDialogError"),
    bikePickerDialog: document.getElementById("bikePickerDialog"),
    bikePickerSearch: document.getElementById("bikePickerSearch"),
    bikePickerList: document.getElementById("bikePickerList"),
    overviewDialog: document.getElementById("overviewDialog"),
    overviewDialogTitle: document.getElementById("overviewDialogTitle"),
    overviewDialogContext: document.getElementById("overviewDialogContext"),
    overviewDialogList: document.getElementById("overviewDialogList"),
    unlockDialog: document.getElementById("unlockDialog"),
    unlockForm: document.getElementById("unlockForm"),
    unlockPin: document.getElementById("unlockPin"),
    unlockError: document.getElementById("unlockError"),
    unlockSubmitButton: document.getElementById("unlockSubmitButton"),
    pinSettingsDialog: document.getElementById("pinSettingsDialog"),
    pinSettingsForm: document.getElementById("pinSettingsForm"),
    newPin: document.getElementById("newPin"),
    confirmPin: document.getElementById("confirmPin"),
    pinSettingsError: document.getElementById("pinSettingsError"),
    pinSettingsSubmitButton: document.getElementById("pinSettingsSubmitButton"),
    connectionSettingsButton: document.getElementById("connectionSettingsButton"),
    connectionSettingsDialog: document.getElementById("connectionSettingsDialog"),
    connectionSettingsForm: document.getElementById("connectionSettingsForm"),
    serverUrlInput: document.getElementById("serverUrlInput"),
    serverTestResult: document.getElementById("serverTestResult"),
    testServerButton: document.getElementById("testServerButton"),
    requestBackupButton: document.getElementById("requestBackupButton"),
    legacyImportButton: document.getElementById("legacyImportButton"),
    connectionSettingsError: document.getElementById("connectionSettingsError"),
    toast: document.getElementById("toast")
  };

  function returnToPortal(replace) {
    const target = isEmbedded && window.parent !== window ? window.parent : window;
    if (replace) target.location.replace("./portal.html");
    else target.location.href = "./portal.html";
  }

  function loadSetting(key) {
    try { return localStorage.getItem(key) || ""; } catch (error) { return ""; }
  }

  function loadCachedUser() {
    try {
      const parsed = JSON.parse(localStorage.getItem(USER_CACHE) || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) { return null; }
  }

  function normalizedIso(value) {
    const parsed = new Date(value || "");
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
  }

  function deletedHistoryIds(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map(function (id) { return String(id || "").trim().slice(0, 100); }).filter(Boolean))).slice(0, 500);
  }

  function historyStamp(entry) {
    return String(entry.updatedAt || entry.createdAt || (entry.date ? entry.date + "T00:00:00.000Z" : ""));
  }

  function correctedBikeMetrics(history, odometerFloorKm) {
    const entries = Array.isArray(history) ? history : [];
    const lastServiceKm = entries.reduce(function (highest, entry) {
      return entry.type === "service" && entry.oilChanged ? Math.max(highest, Number(entry.km) || 0) : highest;
    }, 0);
    const currentKm = entries.reduce(function (highest, entry) {
      return Math.max(highest, Number(entry.km) || 0);
    }, Math.max(lastServiceKm, Number(odometerFloorKm) || 0));
    const checks = entries.filter(function (entry) { return entry.type === "check"; })
      .map(function (entry) { return String(entry.date || ""); }).sort();
    return { lastServiceKm: lastServiceKm, currentKm: currentKm, lastCheckedAt: checks.pop() || "" };
  }

  function majorEntryMilestone(entry) {
    if (!entry || entry.type !== "service" || !entry.majorService) return 0;
    // The odometer reading at which the user marked the major service is the
    // baseline. It must not be rounded to the nearest 10,000 km.
    return Math.max(0, Math.round(Number(entry.km) || Number(entry.majorServiceMilestoneKm) || 0));
  }

  function deriveMajorTracking(history) {
    const completed = (Array.isArray(history) ? history : []).reduce(function (result, entry) {
      if (!entry || entry.type !== "service" || !entry.majorService) return result;
      const actualKm = majorEntryMilestone(entry);
      const stamp = historyStamp(entry);
      if (!result.recorded || actualKm > result.actualKm || (actualKm === result.actualKm && stamp >= result.stamp)) {
        return { recorded: true, actualKm: actualKm, stamp: stamp };
      }
      return result;
    }, { recorded: false, actualKm: 0, stamp: "" });
    const nextMajorServiceKm = completed.recorded ? completed.actualKm + MAJOR_SERVICE_INTERVAL_KM : 0;
    return {
      hasMajorService: completed.recorded,
      lastMajorServiceKm: completed.actualKm,
      lastMajorServiceMilestoneKm: completed.actualKm,
      // Kept as a compatibility field for older snapshots. It is no longer
      // used to create an alert; only a real major-service history entry does.
      pendingMajorServiceKm: 0,
      nextMajorServiceKm: nextMajorServiceKm,
      majorServiceTargetKm: nextMajorServiceKm
    };
  }

  function refreshMajorTracking(bike) {
    const tracking = deriveMajorTracking(bike.history);
    Object.keys(tracking).forEach(function (key) { bike[key] = tracking[key]; });
    return tracking;
  }

  function getMajorServicePlan(bike, serviceKm) {
    const tracking = deriveMajorTracking(bike.history);
    const referenceKm = Number.isFinite(Number(serviceKm)) ? Math.max(0, Math.round(Number(serviceKm))) : Number(bike.currentKm || 0);
    if (!tracking.hasMajorService) {
      return Object.assign({
        key: "untracked",
        label: "Δεν έχει καταχωρηθεί μεγάλο service",
        message: "Η μέτρηση των 10.000 χλμ. θα ξεκινήσει όταν δηλώσεις ότι έγινε μεγάλο service.",
        dueNow: false,
        atNextService: false,
        remainingKm: null
      }, tracking);
    }
    const remainingKm = tracking.nextMajorServiceKm - referenceKm;
    const dueNow = remainingKm <= 0;
    const atNextService = tracking.nextMajorServiceKm === Number(bike.nextServiceKm);
    const key = dueNow ? "due" : remainingKm <= WARNING_KM ? "soon" : "future";
    const label = dueNow ? "Μεγάλο service τώρα" : "Μεγάλο service στα " + formatKm(tracking.nextMajorServiceKm);
    const message = dueNow
      ? "Έφτασε η μέτρηση των 10.000 χλμ. από το τελευταίο μεγάλο service στα " + formatKm(tracking.lastMajorServiceKm) + "."
      : "Απομένουν " + formatKm(remainingKm) + " χλμ. από το τελευταίο μεγάλο service στα " + formatKm(tracking.lastMajorServiceKm) + ".";
    return Object.assign({ key: key, label: label, message: message, dueNow: dueNow, atNextService: atNextService, remainingKm: remainingKm }, tracking);
  }

  function loadBikes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeBike).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  function normalizeBike(bike) {
    if (!bike || !bike.id || !bike.name) return null;
    const intervalKm = Math.max(1, Math.round(Number(bike.intervalKm) || 1));
    const historyDeletedIds = deletedHistoryIds(bike.historyDeletedIds);
    const deleted = new Set(historyDeletedIds);
    const history = Array.isArray(bike.history)
      ? bike.history.slice(0, 500).map(function (entry) {
          const notes = String(entry.notes || "");
          const tasks = Array.isArray(entry.tasks)
            ? entry.tasks.map(function (task) { return String(task).trim(); }).filter(Boolean).slice(0, 30)
            : (entry.type === "check" || !notes ? [] : notes.split(/\r?\n|,|•/).map(function (task) { return task.trim(); }).filter(Boolean).slice(0, 30));
          const type = entry.type === "check" ? "check" : "service";
          const majorService = type === "service" && (typeof entry.majorService === "boolean"
            ? entry.majorService
            : tasks.some(function (task) { return /μεγάλ(?:ο|ου)\s+(?:σέρβις|service)/i.test(task); }));
          if (majorService && !tasks.some(function (task) { return task === "Μεγάλο service"; })) {
            tasks.unshift("Μεγάλο service");
            if (tasks.length > 30) tasks.pop();
          }
          return {
            id: entry.id || uid(),
            type: type,
            km: Math.max(0, Math.round(Number(entry.km) || 0)),
            date: entry.date || today(),
            notes: notes,
            tasks: tasks,
            workshop: String(entry.workshop || "").trim().slice(0, 120),
            cost: String(entry.cost == null ? (entry.serviceCost || "") : entry.cost).trim().slice(0, 60),
            oilChanged: typeof entry.oilChanged === "boolean"
              ? entry.oilChanged
              : (entry.type !== "check" && (notes === "Αρχική καταχώρηση" || /λάδι/i.test(notes))),
            majorService: majorService,
            majorServiceMilestoneKm: majorService
              ? Math.max(0, Math.round(Number(entry.km) || Number(entry.majorServiceMilestoneKm) || 0))
              : 0,
            attachments: Array.isArray(entry.attachments) ? entry.attachments.map(function (file) {
              return {
                id: String(file.id || ""),
                key: String(file.key || ""),
                name: String(file.name || "τιμολόγιο"),
                contentType: String(file.contentType || "application/octet-stream"),
                size: Math.max(0, Number(file.size) || 0),
                uploadedAt: normalizedIso(file.uploadedAt),
                qrValue: String(file.qrValue || file.qrUrl || "").trim().slice(0, 4000),
                qrUrl: String(file.qrUrl || (String(file.qrValue || "").trim().match(/^https?:\/\//i) ? file.qrValue : "")).trim().slice(0, 2000),
                renderJobId: String(file.renderJobId || "").trim().slice(0, 120),
                ocrError: String(file.ocrError || "").trim().slice(0, 500),
                reviewSeenAt: normalizedIso(file.reviewSeenAt),
                ocr: file.ocr && typeof file.ocr === "object" ? file.ocr : null
              };
            }).filter(function (file) { return file.id && file.key; }).slice(0, 10) : [],
            invoiceData: entry.invoiceData && typeof entry.invoiceData === "object" ? normalizeInvoiceData(entry.invoiceData) : null,
            createdAt: normalizedIso(entry.createdAt),
            updatedAt: normalizedIso(entry.updatedAt) || normalizedIso(entry.createdAt)
          };
        }).filter(function (entry) { return !deleted.has(entry.id); })
      : [];
    const historyCorrectedAt = normalizedIso(bike.historyCorrectedAt);
    const odometerFloorKm = Math.max(0, Math.round(Number(bike.odometerFloorKm) || 0));
    const oilHistoryKm = history.reduce(function (highest, entry) {
      return entry.type === "service" && entry.oilChanged ? Math.max(highest, entry.km) : highest;
    }, 0);
    const corrected = correctedBikeMetrics(history, odometerFloorKm);
    const lastServiceKm = historyCorrectedAt
      ? corrected.lastServiceKm
      : Math.max(0, Math.round(Number(bike.lastServiceKm) || 0), oilHistoryKm);
    const currentKm = historyCorrectedAt
      ? Math.max(lastServiceKm, corrected.currentKm)
      : Math.max(lastServiceKm, Math.round(Number(bike.currentKm === undefined ? lastServiceKm : bike.currentKm) || 0));
    const nextServiceKm = lastServiceKm + intervalKm;

    const majorTracking = deriveMajorTracking(history);
    return {
      id: bike.id,
      name: String(bike.name),
      intervalKm: intervalKm,
      lastServiceKm: lastServiceKm,
      currentKm: currentKm,
      nextServiceKm: nextServiceKm,
      lastCheckedAt: historyCorrectedAt ? corrected.lastCheckedAt : bike.lastCheckedAt || "",
      createdAt: bike.createdAt || new Date().toISOString(),
      updatedAt: bike.updatedAt || new Date().toISOString(),
      history: history,
      historyDeletedIds: historyDeletedIds,
      historyCorrectedAt: historyCorrectedAt,
      odometerFloorKm: odometerFloorKm,
      hasMajorService: majorTracking.hasMajorService,
      lastMajorServiceKm: majorTracking.lastMajorServiceKm,
      lastMajorServiceMilestoneKm: majorTracking.lastMajorServiceMilestoneKm,
      pendingMajorServiceKm: majorTracking.pendingMajorServiceKm,
      nextMajorServiceKm: majorTracking.nextMajorServiceKm,
      majorServiceTargetKm: majorTracking.majorServiceTargetKm
    };
  }

  function persistBikes() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bikes));
  }

  function saveBikes(shouldSync) {
    persistBikes();
    if (shouldSync !== false) {
      pendingFleetChange = true;
      try { localStorage.setItem(DIRTY_KEY, "1"); } catch (error) {}
      scheduleSync();
    }
  }

  function mergeBikeRecords(first, second) {
    const firstTime = new Date(first.updatedAt || 0).getTime() || 0;
    const secondTime = new Date(second.updatedAt || 0).getTime() || 0;
    const latest = secondTime >= firstTime ? second : first;
    const historyDeletedIds = deletedHistoryIds((first.historyDeletedIds || []).concat(second.historyDeletedIds || []));
    const deleted = new Set(historyDeletedIds);
    const historyMap = new Map();
    (first.history || []).concat(second.history || []).forEach(function (entry) {
      const existing = historyMap.get(entry.id);
      if (!existing || historyStamp(entry) >= historyStamp(existing)) historyMap.set(entry.id, entry);
    });
    const history = Array.from(historyMap.values()).filter(function (entry) { return !deleted.has(entry.id); }).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id));
    }).slice(0, 500);
    const serviceHistoryKm = history.reduce(function (highest, entry) {
      return entry.type === "service" && entry.oilChanged ? Math.max(highest, Number(entry.km) || 0) : highest;
    }, 0);
    const correctionTimes = [first.historyCorrectedAt || "", second.historyCorrectedAt || ""].sort();
    const historyCorrectedAt = correctionTimes.pop() || "";
    const odometerFloorKm = Math.max(Number(first.odometerFloorKm) || 0, Number(second.odometerFloorKm) || 0);
    const corrected = correctedBikeMetrics(history, odometerFloorKm);
    const lastServiceKm = historyCorrectedAt
      ? corrected.lastServiceKm
      : Math.max(Number(first.lastServiceKm) || 0, Number(second.lastServiceKm) || 0, serviceHistoryKm);
    return normalizeBike(Object.assign({}, latest, {
      lastServiceKm: lastServiceKm,
      currentKm: historyCorrectedAt ? corrected.currentKm : Math.max(Number(first.currentKm) || 0, Number(second.currentKm) || 0, lastServiceKm),
      nextServiceKm: lastServiceKm + Number(latest.intervalKm),
      lastCheckedAt: historyCorrectedAt ? corrected.lastCheckedAt : [first.lastCheckedAt || "", second.lastCheckedAt || ""].sort().pop(),
      createdAt: [first.createdAt, second.createdAt].filter(Boolean).sort()[0],
      updatedAt: [first.updatedAt, second.updatedAt].filter(Boolean).sort().pop(),
      history: history,
      historyDeletedIds: historyDeletedIds,
      historyCorrectedAt: historyCorrectedAt,
      odometerFloorKm: odometerFloorKm
    }));
  }

  function mergeFleets(localBikes, remoteBikes) {
    const merged = new Map();
    localBikes.forEach(function (bike) { merged.set(bike.id, normalizeBike(bike)); });
    remoteBikes.forEach(function (bike) {
      const normalized = normalizeBike(bike);
      if (!normalized) return;
      const current = merged.get(normalized.id);
      merged.set(normalized.id, current ? mergeBikeRecords(current, normalized) : normalized);
    });
    return Array.from(merged.values()).filter(Boolean).slice(0, MAX_BIKES);
  }

  function setSyncState(state, message) {
    elements.syncIndicator.className = "sync-indicator " + state;
    elements.syncStatus.textContent = message;
    elements.syncIndicator.title = message;
  }

  function renderAccessState() {
    if (isEmbedded) {
      elements.webAccessButton.classList.add("is-hidden");
      elements.downloadApkButton.classList.add("is-hidden");
      elements.installButton.classList.add("is-hidden");
      elements.pinSettingsButton.classList.add("is-hidden");
      elements.connectionSettingsButton.classList.add("is-hidden");
      return;
    }
    if (isAndroidApp) {
      elements.webAccessButton.classList.remove("is-hidden");
      elements.downloadApkButton.classList.add("is-hidden");
      elements.pinSettingsButton.classList.add("is-hidden");
      elements.connectionSettingsButton.classList.toggle("is-hidden", !webToken);
      elements.webAccessButton.classList.toggle("unlocked", Boolean(webToken));
      elements.webAccessLabel.textContent = webToken ? "Admin Panel" : "Σύνδεση";
      return;
    }
    elements.pinSettingsButton.classList.add("is-hidden");
    elements.connectionSettingsButton.classList.add("is-hidden");
    elements.webAccessButton.classList.remove("is-hidden");
    elements.downloadApkButton.classList.toggle("is-hidden", !webToken);
    elements.webAccessButton.classList.toggle("unlocked", Boolean(webToken));
    elements.webAccessLabel.textContent = webToken ? "Admin Panel" : "Σύνδεση";
    elements.webAccessButton.setAttribute(
      "aria-label",
      webToken ? "Επιστροφή στο Admin Panel" : "Σύνδεση στο Fleet Control"
    );
  }

  function requestHeaders(includeWriteCredentials, adminPin) {
    const headers = { "Content-Type": "application/json" };
    if (includeWriteCredentials && webToken) headers.Authorization = "Bearer " + webToken;
    if (includeWriteCredentials && adminPin) headers["X-Admin-Pin"] = adminPin;
    return headers;
  }

  function updateInvoiceFileName(input, target) {
    if (!input || !target) return;
    const files = selectedInvoiceFiles(input);
    const buttonLabel = input.closest(".invoice-picker")?.querySelector(".invoice-picker-button span");
    if (!files.length) {
      target.textContent = "Δεν έχει επιλεγεί αρχείο";
      target.classList.remove("has-file");
      if (buttonLabel) buttonLabel.textContent = "Επίλεξε τιμολόγιο";
      return;
    }
    const sizeMb = files.reduce(function (total, file) { return total + Number(file.size || 0); }, 0) / (1024 * 1024);
    target.textContent = (files.length > 1 ? files.length + " τιμολόγια: " : "") + files.map(function (file) { return file.name; }).join(", ") + (sizeMb > 0 ? " · " + sizeMb.toFixed(2) + " MB" : "");
    target.classList.add("has-file");
    if (buttonLabel) buttonLabel.textContent = files.length > 1 ? "Αλλαγή τιμολογίων" : "Αλλαγή τιμολογίου";
  }

  function selectedInvoiceFiles(input) {
    return Array.from(input && input.files || []);
  }

  function invoiceSelectionError(entry, files, qrValue) {
    const existing = Array.isArray(entry && entry.attachments) ? entry.attachments : [];
    const qrUrl = normalizeQrUrl(qrValue);
    const duplicateQr = qrUrl && existing.some(function (file) { return normalizeQrUrl(file.qrUrl || file.qrValue) === qrUrl; });
    const additions = files.length || (normalizeQrValue(qrValue) && !duplicateQr ? 1 : 0);
    if (existing.length + additions > MAX_SERVICE_ATTACHMENTS) {
      return "Μπορείς να κρατήσεις έως " + MAX_SERVICE_ATTACHMENTS + " τιμολόγια σε ένα service. Υπάρχουν ήδη " + existing.length + ".";
    }
    if (additions && navigator.onLine === false) return "Για την προσθήκη τιμολογίων χρειάζεται σύνδεση. Τα επιλεγμένα αρχεία παραμένουν εδώ για να ξαναδοκιμάσεις.";
    return "";
  }

  function normalizeQrValue(value) {
    return String(value || "").trim().slice(0, 4000);
  }

  function normalizeQrUrl(value) {
    const candidate = normalizeQrValue(value);
    try {
      const parsed = new URL(candidate);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString().slice(0, 2000) : "";
    } catch (error) {
      return "";
    }
  }

  function invoiceContextElements(context) {
    return context === "history"
      ? {
          input: elements.historyEntryInvoiceFile,
          qrInput: elements.historyEntryInvoiceQrValue,
          status: elements.historyEntryInvoiceQrStatus
        }
      : {
          input: elements.serviceInvoiceFile,
          qrInput: elements.serviceInvoiceQrValue,
          status: elements.serviceInvoiceQrStatus
        };
  }

  function setInvoiceQrStatus(context, value) {
    const target = invoiceContextElements(context);
    const qrUrl = normalizeQrUrl(value);
    if (target.qrInput) target.qrInput.value = qrUrl || normalizeQrValue(value);
    if (target.status) {
      target.status.textContent = qrUrl
        ? "✓ QR διαβάστηκε. Θα γίνει αυτόματη άντληση και, αν αποτύχει, μπορείς να ανεβάσεις φωτογραφία/PDF."
        : "";
      target.status.classList.toggle("has-qr", Boolean(qrUrl));
    }
  }

  function clearInvoiceQrStatus(context) {
    const target = invoiceContextElements(context);
    if (target.qrInput) target.qrInput.value = "";
    if (target.status) {
      target.status.textContent = "";
      target.status.classList.remove("has-qr");
    }
  }

  function invoiceLineText(value, limit) {
    const max = Number(limit) || 500;
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return stripInvoicePartCode(String(value).trim().slice(0, max));
    if (typeof value === "object" && !Array.isArray(value)) {
      const preferred = ["description", "name", "item", "text", "label", "title", "work", "service", "part", "product", "details", "value"];
      for (let i = 0; i < preferred.length; i += 1) {
        const key = preferred[i];
        if (value[key] != null && String(value[key]).trim()) return stripInvoicePartCode(String(value[key]).trim().slice(0, max));
      }
      try {
        return stripInvoicePartCode(Object.entries(value).filter(function (pair) { return pair[1] != null && String(pair[1]).trim(); }).map(function (pair) { return pair[0] + ": " + pair[1]; }).join(" · ").slice(0, max));
      } catch (error) { return ""; }
    }
    return stripInvoicePartCode(String(value).replace(/\[object Object\]/g, "").trim().slice(0, max));
  }

  function stopQrScanner(closeDialog) {
    if (qrScannerFrame) {
      cancelAnimationFrame(qrScannerFrame);
      qrScannerFrame = 0;
    }
    if (qrScannerStream) {
      qrScannerStream.getTracks().forEach(function (track) { track.stop(); });
      qrScannerStream = null;
    }
    if (elements.qrScannerVideo) elements.qrScannerVideo.srcObject = null;
    if (closeDialog && elements.qrScannerDialog && elements.qrScannerDialog.open) elements.qrScannerDialog.close();
  }

  function scanQrVideoFrame() {
    if (!qrScannerStream || !elements.qrScannerVideo || !elements.qrScannerDialog.open) return;
    const video = elements.qrScannerVideo;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      qrScannerFrame = requestAnimationFrame(scanQrVideoFrame);
      return;
    }
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = typeof window.jsQR === "function"
        ? window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" })
        : null;
      if (result && result.data) {
        const value = normalizeQrValue(result.data);
        setInvoiceQrStatus(qrScannerContext, value);
        stopQrScanner(true);
        showToast("Το QR διαβάστηκε και το παράθυρο έκλεισε. Με την καταχώρηση θα ξεκινήσει η άντληση στο παρασκήνιο.");
        return;
      }
    } catch (error) {}
    qrScannerFrame = requestAnimationFrame(scanQrVideoFrame);
  }

  async function openQrScanner(context) {
    qrScannerContext = context === "history" ? "history" : "service";
    if (!elements.qrScannerDialog) return;
    stopQrScanner(false);
    elements.qrScannerStatus.textContent = "Ενεργοποίηση κάμερας…";
    elements.qrScannerError.textContent = "";
    if (!elements.qrScannerDialog.open) elements.qrScannerDialog.showModal();
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      elements.qrScannerStatus.textContent = "Η ζωντανή κάμερα δεν είναι διαθέσιμη εδώ.";
      elements.qrScannerError.textContent = "Χρησιμοποίησε «Χρήση φωτογραφίας/PDF» για να συνεχίσεις.";
      return;
    }
    try {
      qrScannerStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      elements.qrScannerVideo.srcObject = qrScannerStream;
      await elements.qrScannerVideo.play();
      elements.qrScannerStatus.textContent = "Στρέψε την κάμερα στο QR του τιμολογίου.";
      qrScannerFrame = requestAnimationFrame(scanQrVideoFrame);
    } catch (error) {
      stopQrScanner(false);
      elements.qrScannerStatus.textContent = "Δεν ενεργοποιήθηκε η κάμερα.";
      elements.qrScannerError.textContent = "Έλεγξε την άδεια κάμερας ή χρησιμοποίησε φωτογραφία/PDF.";
    }
  }

  function openManualInvoicePicker() {
    const target = invoiceContextElements(qrScannerContext);
    stopQrScanner(true);
    if (target.input) target.input.click();
  }

  function normalizeInvoiceData(value) {
    if (!value || typeof value !== "object") return null;
    const result = {};
    ["supplier", "invoiceNumber", "invoiceDate", "mark", "plate", "odometerKm", "workPerformed", "comments", "laborAmount", "vatAmount", "totalAmount", "notes", "rawText", "source", "qrUrl", "confirmedAt", "reviewedBy", "reviewStatus", "ocrReprocessedAt", "qrJobId", "qrProcessingStatus", "qrProcessingStartedAt", "qrProcessingUpdatedAt", "qrProcessingError", "qrProcessingAttempts", "qrProcessingProgress", "qrProcessingStage", "reviewSeenAt", "plateResolution", "plateResolutionBikeId", "plateResolutionPlate", "plateResolutionRead", "correctedByUserAt", "serviceKmBeforeCorrection", "serviceKmAfterCorrection", "plateAutoCorrectedFrom"].forEach(function (field) {
      if (value[field] != null && String(value[field]).trim()) result[field] = String(value[field]).trim().slice(0, field === "rawText" ? 12000 : 2000);
    });
    if (Array.isArray(value.parts)) result.parts = value.parts.map(function (part) { return invoiceLineText(part, 500); }).filter(Boolean).slice(0, 50);
    if (Array.isArray(value.lineItems)) result.lineItems = value.lineItems.map(function (part) { return invoiceLineText(part, 500); }).filter(Boolean).slice(0, 50);
    if (result.plate && !result.confirmedAt && !/^[ABEZHIKMNOPTYX]{3}[0-9]{3,4}$/.test(invoicePlateKey(result.plate))) delete result.plate;
    return Object.keys(result).length ? result : null;
  }

  function mergeInvoiceData(primary, fallback) {
    const first = normalizeInvoiceData(primary) || {};
    const second = normalizeInvoiceData(fallback) || {};
    const merged = { ...second, ...first };
    ["supplier", "invoiceNumber", "invoiceDate", "mark", "plate", "odometerKm", "workPerformed", "comments", "laborAmount", "vatAmount", "totalAmount", "notes", "rawText", "source", "qrUrl", "confirmedAt", "reviewedBy", "reviewStatus", "ocrReprocessedAt", "qrJobId", "qrProcessingStatus", "qrProcessingStartedAt", "qrProcessingUpdatedAt", "qrProcessingError", "qrProcessingAttempts", "qrProcessingProgress", "qrProcessingStage", "reviewSeenAt", "plateResolution", "plateResolutionBikeId", "plateResolutionPlate", "plateResolutionRead", "correctedByUserAt", "serviceKmBeforeCorrection", "serviceKmAfterCorrection", "plateAutoCorrectedFrom"].forEach(function (field) {
      if (!String(first[field] || "").trim() && String(second[field] || "").trim()) merged[field] = second[field];
    });
    if (!Array.isArray(first.parts) && Array.isArray(second.parts)) merged.parts = second.parts;
    if (!Array.isArray(first.lineItems) && Array.isArray(second.lineItems)) merged.lineItems = second.lineItems;
    return normalizeInvoiceData(merged);
  }

  function invoiceDataFromAttachment(attachment) {
    if (!attachment) return null;
    const ocr = normalizeInvoiceData(attachment.ocr) || {};
    const qr = normalizeInvoiceData(attachment.qrData) || {};
    const merged = mergeInvoiceData(ocr, qr) || {};
    if (!merged.qrUrl && attachment.qrUrl) merged.qrUrl = attachment.qrUrl;
    if (!merged.source) merged.source = attachment.qrUrl ? "qr+ocr" : "ocr";
    return normalizeInvoiceData(merged);
  }

  function ensureAttachmentQr(attachment, qrValue) {
    if (!attachment) return attachment;
    const value = normalizeQrValue(qrValue || attachment.qrValue || attachment.qrUrl || (attachment.ocr && attachment.ocr.qrUrl));
    const url = normalizeQrUrl(attachment.qrUrl || value);
    if (value) attachment.qrValue = value;
    if (url) attachment.qrUrl = url;
    if (attachment.ocr && url && !attachment.ocr.qrUrl) attachment.ocr.qrUrl = url;
    return attachment;
  }

  function invoiceDataForEntry(entry) {
    if (!entry) return null;
    let merged = normalizeInvoiceData(entry.invoiceData) || null;
    (Array.isArray(entry.attachments) ? entry.attachments : []).forEach(function (file) {
      const attachmentData = invoiceDataFromAttachment(file);
      if (attachmentData) merged = mergeInvoiceData(merged, attachmentData);
    });
    return merged;
  }

  function serviceSupplier(entry) {
    const data = invoiceDataForEntry(entry) || {};
    if (data.supplier) return { label: "Προμηθευτής", value: data.supplier };
    if (entry && entry.workshop) return { label: "Συνεργείο", value: entry.workshop };
    return null;
  }

  function splitImportedWork(value) {
    return String(value || "")
      .split(/\r?\n|\s*[•;]+\s*|\s*,\s*/)
      .map(function (part) { return part.trim(); })
      .filter(Boolean)
      .slice(0, 50);
  }

  function cleanInvoiceWorkText(value) {
    const text = String(value || "");
    const folded = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const match = /οροι\s+πληρωμης|τροπος\s+πληρωμης|πληρωμης\s+συναλλαγης|τοις\s+μετρητοις|payment\s+terms|cash\s+payment/.exec(folded);
    if (!match) return text.trim();
    // Convert the folded index back to the original, preserving Greek accents.
    let index = 0, length = 0;
    for (const letter of text) { if (length >= match.index) break; index += letter.length; length += letter.normalize("NFD").replace(/[\u0300-\u036f]/g, "").length; }
    return text.slice(0, index).replace(/[\s:;·—–-]+$/, "").trim();
  }

  function invoiceWorkItems(data) {
    const values = [];
    values.push.apply(values, splitImportedWork(data && data.workPerformed));
    if (Array.isArray(data && data.lineItems)) values.push.apply(values, data.lineItems);
    if (Array.isArray(data && data.parts)) values.push.apply(values, data.parts);
    return values.map(function (item) { return cleanInvoiceWorkText(invoiceLineText(item, 180)); }).filter(Boolean).slice(0, 50);
  }

  function taskKey(value) {
    return String(value || "").toLocaleLowerCase("el")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9α-ω]+/g, "");
  }

  function isOilTask(value) {
    const text = String(value || "");
    if (/^\s*φίλτρ(?:ο|ου|ων|α)?\s+λ[άα]δι(?:ού|ών|ων|α)?/iu.test(text)) return false;
    return /\b(?:ladi|oil|yamalube)\b|λ[άα]δι(?:ού|ών|ων|α)?|λιπαντικ/i.test(text);
  }

  function mergeServiceTasks(existing, imported) {
    const result = [];
    const oilDetail = function (value) {
      return String(value || "")
        .replace(/\b(change|changed|replacement|replace)\s+oil(s)?\b/ig, "")
        .replace(/\b(oil|ladi)\s+change\b/ig, "")
        .replace(/αλλαγ(?:η|ή)\s+λαδι(?:ών|ων|α)/ig, "")
        .replace(/λαδι(?:ών|ων|α)/ig, "")
        .replace(/[–—:;,·]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const add = function (raw) {
      const task = cleanInvoiceWorkText(invoiceLineText(raw, 180));
      if (!task) return;
      const oilIndex = result.findIndex(function (item) { return isOilTask(item); });
      if (isOilTask(task) && oilIndex >= 0) {
        const current = result[oilIndex];
        const currentDetail = oilDetail(current);
        const nextDetail = oilDetail(task);
        const detail = currentDetail.length >= nextDetail.length ? currentDetail : nextDetail;
        result[oilIndex] = (detail ? "Αλλαγή λαδιών — " + detail : "Αλλαγή λαδιών").slice(0, 180);
        return;
      }
      const key = taskKey(task);
      if (!key || result.some(function (item) {
        const existingKey = taskKey(item);
        return existingKey === key || existingKey.includes(key) || key.includes(existingKey);
      })) return;
      result.push(task);
    };
    (Array.isArray(existing) ? existing : []).forEach(add);
    (Array.isArray(imported) ? imported : []).forEach(add);
    return result.slice(0, 30);
  }

  function appendInvoiceWork(entry, data) {
    const existing = Array.isArray(entry && entry.tasks)
      ? entry.tasks
      : splitImportedWork(entry && entry.notes);
    entry.tasks = mergeServiceTasks(existing, invoiceWorkItems(data));
    entry.notes = entry.tasks.join("\n");
  }

  function serviceTasksForEntry(entry) {
    if (!entry || entry.type === "check") return [];
    const existing = Array.isArray(entry.tasks) ? entry.tasks : splitImportedWork(entry.notes);
    return mergeServiceTasks(existing, invoiceWorkItems(invoiceDataForEntry(entry)));
  }

  function historyEntriesForDisplay(entries) {
    return (Array.isArray(entries) ? entries : []).slice().sort(function (left, right) {
      const leftService = left && left.type !== "check";
      const rightService = right && right.type !== "check";
      if (leftService && rightService) {
        const leftKm = Number(left.km) || parseInvoiceKm((invoiceDataForEntry(left) || {}).odometerKm) || 0;
        const rightKm = Number(right.km) || parseInvoiceKm((invoiceDataForEntry(right) || {}).odometerKm) || 0;
        const kmDifference = rightKm - leftKm;
        if (kmDifference) return kmDifference;
      }
      const rightDate = String((right && (right.date || right.createdAt)) || "");
      const leftDate = String((left && (left.date || left.createdAt)) || "");
      return rightDate.localeCompare(leftDate);
    });
  }

  function parseInvoiceKm(value) {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  }

  function compactInvoicePlate(value) {
    return String(value || "").trim().toLocaleUpperCase("el")
      .replace(/[\s_]+/g, "-")
      .replace(/[^A-Z0-9Α-ΩΆΈΉΊΌΎΏΪΫ-]+/g, "")
      .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ΜΗΧΑΝΑΚΙ";
  }

  function invoiceDateForName(value, fallback) {
    const candidate = String(value || "").trim();
    const iso = candidate.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const match = candidate.match(/(^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\D|$)/);
    if (match) return match[4] + "-" + String(match[3]).padStart(2, "0") + "-" + String(match[2]).padStart(2, "0");
    return /^\d{4}-\d{2}-\d{2}$/.test(String(fallback || "")) ? fallback : today();
  }

  function invoiceDisplayName(bike, data, entry, fallback) {
    const plate = compactInvoicePlate(bike && bike.name || (data && data.plate) || "ΜΗΧΑΝΑΚΙ");
    const date = invoiceDateForName(data && data.invoiceDate, entry && entry.date);
    const candidate = plate + "_" + date + ".pdf";
    const attachments = Array.isArray(entry && entry.attachments) ? entry.attachments : [];
    const taken = new Set(attachments.filter(function (item) { return String(item.key || "") !== String(fallback && fallback.key || ""); }).map(function (item) { return String(item.name || "").toLocaleLowerCase("el"); }));
    if (!taken.has(candidate.toLocaleLowerCase("el"))) return candidate;
    for (let index = 2; index <= 99; index += 1) {
      const next = plate + "_" + date + "_" + index + ".pdf";
      if (!taken.has(next.toLocaleLowerCase("el"))) return next;
    }
    return plate + "_" + date + "_" + Date.now() + ".pdf";
  }

  function invoicePlateKey(value) {
    const greek = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ";
    const latin = "ABEZHIKMNOPTYX";
    return String(value || "").normalize("NFKC").toUpperCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (letter) => latin.charAt(greek.indexOf(letter)))
      .replace(/[^A-Z0-9Α-Ω]/g, "");
  }

  function invoiceWarnings(bike, entry, data) {
    const warnings = [];
    const invoicePlate = invoicePlateKey(data && data.plate);
    const selectedPlate = invoicePlateKey(bike && bike.name);
    const plateResolved = data && data.confirmedAt && data.plateResolution === "kept-current" &&
      data.plateResolutionBikeId === String(bike && bike.id) && data.plateResolutionPlate === selectedPlate && data.plateResolutionRead === invoicePlate;
    if (data && data.plate && bike && bike.name && invoicePlate !== selectedPlate && !plateResolved) {
      warnings.push("Η πινακίδα του τιμολογίου (" + data.plate + ") δεν ταιριάζει με το επιλεγμένο μηχανάκι (" + bike.name + ").");
    }
    const invoiceKm = parseInvoiceKm(data && data.odometerKm);
    const serviceKm = Math.round(Number(entry && entry.km) || 0);
    if (invoiceKm && serviceKm && invoiceKm !== serviceKm) {
      warnings.push("Τα χιλιόμετρα του τιμολογίου (" + formatKm(invoiceKm) + ") διαφέρουν από την καταχώρηση service (" + formatKm(serviceKm) + ").");
    }
    return warnings;
  }

  function applyInvoiceReviewToEntry(bike, entry, attachment, reviewData) {
    const data = mergeInvoiceData(reviewData, attachment ? attachment.ocr : entry && entry.invoiceData);
    if (!bike || !entry || !data) return;
    const now = new Date().toISOString();
    if (reviewData.applyServiceKmCorrection === true && data.confirmedAt && data.serviceKmAfterCorrection && Number(data.serviceKmBeforeCorrection) === Number(entry.km)) {
      entry.km = parseInvoiceKm(data.serviceKmAfterCorrection);
      bike.historyCorrectedAt = now;
      recalculateCorrectedBike(bike);
    }
    appendInvoiceWork(entry, data);
    entry.invoiceData = data;
    if (data.supplier) entry.workshop = data.supplier;
    if (attachment) {
      attachment.ocr = mergeInvoiceData(data, attachment.ocr);
      attachment.qrData = data;
      if (data.qrUrl) attachment.qrUrl = data.qrUrl;
      attachment.name = invoiceDisplayName(bike, data, entry, attachment);
      ensureAttachmentQr(attachment, data.qrUrl);
    }
    entry.updatedAt = now;
    bike.updatedAt = now;
    refreshMajorTracking(bike);
  }

  function canManageHistory() {
    if (!currentUser || !["owner", "manager", "fleet_manager"].includes(String(currentUser.role || ""))) return false;
    const permissions = Array.isArray(currentUser.permissions) ? currentUser.permissions : [];
    return permissions.includes("*") || permissions.includes("fleet.manage");
  }

  function renderArchiveAccess() {
    const visible = canManageHistory();
    if (elements.archivedBikesSection) elements.archivedBikesSection.classList.toggle("is-hidden", !visible);
    if (elements.detailArchiveButton) elements.detailArchiveButton.classList.toggle("is-hidden", !visible || !activeBikeId);
  }

  async function loadArchivedBikes() {
    if (!canManageHistory() || navigator.onLine === false) return;
    if (elements.refreshArchivedButton) {
      elements.refreshArchivedButton.disabled = true;
      elements.refreshArchivedButton.textContent = "Φόρτωση…";
    }
    try {
      const response = await fetch(apiBase + "/api/admin/vehicles/archived", {
        headers: requestHeaders(true), cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Δεν φορτώθηκαν τα διαγραμμένα μηχανάκια.");
      archivedBikes = Array.isArray(payload.vehicles) ? payload.vehicles : [];
      if (elements.archivedBikeList) {
        elements.archivedBikeList.innerHTML = archivedBikes.length ? archivedBikes.map(function (bike) {
          return '<article class="archived-bike-row"><div><strong>' + escapeHtml(bike.name) + '</strong><small>' + formatKm(bike.odometer) + ' · διαγράφηκε ' + escapeHtml(formatDate(bike.archivedAt)) + '</small>' + (bike.reason ? '<small>' + escapeHtml(bike.reason) + '</small>' : '') + '</div><button class="secondary-action compact-action" type="button" data-restore-bike="' + escapeHtml(bike.id) + '">Ανάκτηση</button></article>';
        }).join("") : '<p class="archived-empty">Δεν υπάρχουν διαγραμμένα μηχανάκια.</p>';
      }
    } catch (error) {
      if (elements.archivedBikeList) elements.archivedBikeList.innerHTML = '<p class="archived-empty">' + escapeHtml(error && error.message ? error.message : "Δεν φορτώθηκαν τα διαγραμμένα μηχανάκια.") + '</p>';
    } finally {
      if (elements.refreshArchivedButton) {
        elements.refreshArchivedButton.disabled = false;
        elements.refreshArchivedButton.textContent = "Ανανέωση";
      }
    }
  }

  async function archiveActiveBike() {
    const bike = getBike(activeBikeId);
    if (!bike || !canManageHistory()) return;
    if (!window.confirm("Να αφαιρεθεί το «" + bike.name + "» από τον ενεργό στόλο; Θα μεταφερθεί στα Διαγραμμένα και θα μπορείς να το ανακτήσεις.")) return;
    elements.detailArchiveButton.disabled = true;
    try {
      const response = await fetch(apiBase + "/api/admin/vehicles/" + encodeURIComponent(bike.id) + "/archive", {
        method: "POST", headers: requestHeaders(true),
        body: JSON.stringify({ confirmArchive: true, reason: "Αφαίρεση από τον ενεργό στόλο" }), cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Η διαγραφή δεν ολοκληρώθηκε.");
      bikes = bikes.filter(function (item) { return item.id !== bike.id; });
      saveBikes(false);
      showHome();
      await loadArchivedBikes();
      showToast("Το μηχανάκι μεταφέρθηκε στα διαγραμμένα. Μπορείς να το ανακτήσεις.");
    } catch (error) {
      showToast(error && error.message ? error.message : "Η διαγραφή δεν ολοκληρώθηκε.");
    } finally {
      elements.detailArchiveButton.disabled = false;
    }
  }

  async function restoreBike(bikeId) {
    if (!canManageHistory()) return;
    const archived = archivedBikes.find(function (item) { return String(item.id) === String(bikeId); });
    if (!archived || !window.confirm("Να ανακτηθεί το «" + archived.name + "» στον ενεργό στόλο;")) return;
    const button = elements.archivedBikeList && Array.from(elements.archivedBikeList.querySelectorAll("[data-restore-bike]")).find(function (item) {
      return String(item.dataset.restoreBike) === String(bikeId);
    });
    if (button) button.disabled = true;
    try {
      const response = await fetch(apiBase + "/api/admin/vehicles/" + encodeURIComponent(bikeId) + "/restore", {
        method: "POST", headers: requestHeaders(true), body: JSON.stringify({ reason: "Ανάκτηση από τα διαγραμμένα" }), cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Η ανάκτηση δεν ολοκληρώθηκε.");
      const restored = normalizeBike(payload.bike);
      if (restored) bikes = mergeFleets(bikes, [restored]);
      saveBikes(false);
      renderHome();
      await loadArchivedBikes();
      showToast("Το μηχανάκι ανακτήθηκε στον ενεργό στόλο.");
    } catch (error) {
      showToast(error && error.message ? error.message : "Η ανάκτηση δεν ολοκληρώθηκε.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function refreshCurrentUser() {
    if (!webToken || navigator.onLine === false) return;
    try {
      const response = await fetch(apiBase + "/api/auth/me", {
        headers: { Authorization: "Bearer " + webToken }, cache: "no-store"
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.user) return;
      currentUser = payload.user;
      try { localStorage.setItem(USER_CACHE, JSON.stringify(currentUser)); } catch (error) {}
      renderArchiveAccess();
      loadArchivedBikes();
      if (activeBikeId) renderDetail();
    } catch (error) {}
  }

  async function syncNow() {
    if (syncRunning) {
      syncQueued = true;
      return;
    }
    if (navigator.onLine === false) {
      setSyncState("offline", "Χωρίς σύνδεση");
      return;
    }
    syncRunning = true;
    setSyncState("syncing", "Συγχρονισμός…");
    const wantsUpload = Boolean(webToken && pendingFleetChange);
    const canUpload = wantsUpload;
    try {
      const response = await fetch(apiBase + "/api/sync", {
        method: canUpload ? "POST" : "GET",
        headers: canUpload ? requestHeaders(true) : { Authorization: "Bearer " + webToken },
        body: canUpload ? JSON.stringify({ bikes: bikes }) : undefined,
        cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401) {
          webToken = "";
          currentUser = null;
          bikes = [];
          try {
            localStorage.removeItem(AUTH_TOKEN_PERSIST);
            sessionStorage.removeItem(AUTH_TOKEN_SESSION);
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(DIRTY_KEY);
            localStorage.removeItem(USER_CACHE);
            sessionStorage.setItem("fleet-control-return-to-fleet", "1");
          } catch (error) {}
          try {
            if (window.AndroidFleet && typeof window.AndroidFleet.clearAuthToken === "function") window.AndroidFleet.clearAuthToken();
          } catch (error) {}
          renderAccessState();
          returnToPortal(true);
        }
        throw new Error(payload.error || "Αποτυχία συγχρονισμού");
      }
      const remote = Array.isArray(payload.bikes) ? payload.bikes : [];
      bikes = mergeFleets(bikes, remote);
      const archivedIds = new Set(Array.isArray(payload.archivedBikeIds) ? payload.archivedBikeIds.map(function (id) { return String(id); }) : []);
      if (archivedIds.size) bikes = bikes.filter(function (bike) { return !archivedIds.has(String(bike.id)); });
      persistBikes();
      if (canUpload) {
        pendingFleetChange = false;
        try { localStorage.removeItem(DIRTY_KEY); } catch (error) {}
      }
      renderHome();
      if (activeBikeId) renderDetail();
      setSyncState("synced", "Συγχρονίστηκε");
    } catch (error) {
      setSyncState(navigator.onLine === false ? "offline" : "error", navigator.onLine === false ? "Χωρίς σύνδεση" : "Εκκρεμεί");
    } finally {
      syncRunning = false;
      if (syncQueued) {
        syncQueued = false;
        setTimeout(syncNow, 80);
      }
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    if (navigator.onLine === false) {
      setSyncState("offline", "Χωρίς σύνδεση");
      return;
    }
    setSyncState("syncing", "Εκκρεμεί…");
    syncTimer = setTimeout(syncNow, 280);
  }

  function hasEditAccess() {
    return Boolean(webToken);
  }

  function openUnlockDialog(action) {
    pendingEditAction = typeof action === "function" ? action : null;
    elements.unlockForm.reset();
    elements.unlockError.textContent = "";
    elements.unlockDialog.showModal();
    setTimeout(function () { elements.unlockPin.focus(); }, 60);
  }

  function requireEditAccess(action) {
    if (hasEditAccess()) return action();
    try { sessionStorage.setItem("fleet-control-return-to-fleet", "1"); } catch (error) {}
    returnToPortal(false);
  }

  function requireAccountAccess(action) {
    if (hasEditAccess()) return action();
    try { sessionStorage.setItem("fleet-control-return-to-fleet", "1"); } catch (error) {}
    returnToPortal(false);
  }

  async function handleUnlockSubmit(event) {
    event.preventDefault();
    const pin = elements.unlockPin.value.trim();
    elements.unlockError.textContent = "";
    if (!/^\d{4,6}$/.test(pin)) {
      elements.unlockError.textContent = "Το PIN έχει 4 έως 6 αριθμούς.";
      elements.unlockPin.focus();
      return;
    }
    elements.unlockSubmitButton.disabled = true;
    elements.unlockSubmitButton.textContent = "Έλεγχος…";
    try {
      if (navigator.onLine !== false) {
        const response = await fetch(apiBase + "/api/auth/verify-admin-pin", {
          method: "POST", headers: requestHeaders(true, pin), body: "{}", cache: "no-store"
        });
        const payload = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(payload.error || "Το PIN δεν είναι σωστό.");
      }
      elements.unlockDialog.close();
      const action = pendingEditAction;
      pendingEditAction = null;
      if (action) action();
      if (navigator.onLine === false) showToast("Η αλλαγή θα επιβεβαιωθεί όταν επανέλθει η σύνδεση.");
    } catch (error) {
      elements.unlockError.textContent = error && error.message ? error.message : "Δεν ήταν δυνατό το ξεκλείδωμα.";
      elements.unlockPin.focus();
      elements.unlockPin.select();
    } finally {
      elements.unlockSubmitButton.disabled = false;
      elements.unlockSubmitButton.textContent = "Ξεκλείδωμα";
    }
  }

  function openPinSettings() {
    elements.pinSettingsForm.reset();
    elements.pinSettingsError.textContent = "";
    elements.pinSettingsDialog.showModal();
    setTimeout(function () { elements.newPin.focus(); }, 60);
  }

  async function handlePinSettingsSubmit(event) {
    event.preventDefault();
    const pin = elements.newPin.value.trim();
    const confirmation = elements.confirmPin.value.trim();
    elements.pinSettingsError.textContent = "";
    if (!/^\d{4,6}$/.test(pin)) {
      elements.pinSettingsError.textContent = "Το PIN πρέπει να έχει 4 έως 6 αριθμούς.";
      elements.newPin.focus();
      return;
    }
    if (pin !== confirmation) {
      elements.pinSettingsError.textContent = "Τα δύο PIN δεν είναι ίδια.";
      elements.confirmPin.focus();
      return;
    }
    if (navigator.onLine === false) {
      elements.pinSettingsError.textContent = "Χρειάζεται σύνδεση στο ίντερνετ για αλλαγή PIN.";
      return;
    }
    elements.pinSettingsSubmitButton.disabled = true;
    elements.pinSettingsSubmitButton.textContent = "Αποθήκευση…";
    try {
      const response = await fetch(apiBase + "/api/pin", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ pin: pin }),
        cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Δεν ήταν δυνατή η αλλαγή PIN.");
      elements.pinSettingsDialog.close();
      showToast("Το PIN της διαδικτυακής έκδοσης άλλαξε.");
    } catch (error) {
      elements.pinSettingsError.textContent = error && error.message ? error.message : "Δεν ήταν δυνατή η αλλαγή PIN.";
    } finally {
      elements.pinSettingsSubmitButton.disabled = false;
      elements.pinSettingsSubmitButton.textContent = "Αποθήκευση PIN";
    }
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function today() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function formatKm(value) {
    return numberFormat.format(Math.round(Number(value) || 0)) + " χλμ.";
  }

  function formatDate(value) {
    if (!value) return "—";
    const parts = String(value).split("-").map(Number);
    if (parts.length !== 3 || parts.some(function (part) { return !Number.isFinite(part); })) {
      return value;
    }
    return dateFormat.format(new Date(parts[0], parts[1] - 1, parts[2]));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderInvoiceOcrDetails(file, entry) {
    const fallback = (entry && entry.attachments || []).length <= 1 ? entry && entry.invoiceData : null;
    const data = mergeInvoiceData(invoiceDataFromAttachment(file), fallback);
    if (!data) return "";
    const fields = [
      ["Προμηθευτής", data.supplier],
      ["Αριθμός τιμολογίου", data.invoiceNumber],
      ["Ημερομηνία", data.invoiceDate],
      ["ΜΑΡΚ", data.mark],
      ["Πινακίδα", data.plate],
      ["Χιλιόμετρα", data.odometerKm],
      ["Κόστος εργασιών", data.laborAmount],
      ["ΦΠΑ", data.vatAmount],
      ["Σύνολο", data.totalAmount],
      ["Σχόλια", data.comments || data.notes]
    ].filter(function (item) { return String(item[1] || "").trim(); });
    const fieldRows = fields.map(function (item) {
      return '<div class="invoice-ocr-item"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>';
    }).join("");
    const workItems = invoiceWorkItems(data);
    const work = workItems.length
      ? '<div class="invoice-ocr-long"><span>Εργασίες / γραμμές τιμολογίου</span><ul class="invoice-bullet-list">' + workItems.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul></div>'
      : "";
    const warnings = invoiceWarnings(getBike(activeBikeId), entry, data);
    const warningMarkup = warnings.length
      ? '<div class="invoice-ocr-warning" role="alert">' + warnings.map(function (item) { return '⚠ ' + escapeHtml(item); }).join('<br>') + '</div>'
      : "";
    const raw = data.rawText
      ? '<details class="invoice-raw-details"><summary>Πλήρες αναγνωρισμένο κείμενο</summary><pre>' + escapeHtml(data.rawText) + '</pre></details>'
      : "";
    const needsReview = Boolean(file && file.ocr && data && !data.confirmedAt);
    const review = needsReview
      ? '<button type="button" class="document-review-button" data-review-document="' + escapeHtml(file.key) + '" data-review-document-entry="' + escapeHtml(entry && entry.id || "") + '">Έλεγχος &amp; αποθήκευση στοιχείων</button>'
      : "";
    return '<details class="invoice-ocr-details"><summary>Αναλυτικά αποτελέσματα OCR</summary><div class="invoice-ocr-grid">' + fieldRows + '</div>' + warningMarkup + work + raw + review + '</details>';
  }

  function getBike(id) {
    return bikes.find(function (bike) { return bike.id === id; });
  }

  function getStatus(bike) {
    const remainingKm = Number(bike.nextServiceKm) - Number(bike.currentKm);
    if (remainingKm < 0) {
      return {
        key: "overdue",
        label: "Εκπρόθεσμο",
        remainingKm: remainingKm,
        short: "Πέρασε κατά " + formatKm(Math.abs(remainingKm)),
        message: "Έχει ξεπεράσει το όριο του σέρβις κατά " + formatKm(Math.abs(remainingKm)) + "."
      };
    }
    if (remainingKm <= URGENT_KM) {
      return {
        key: "urgent",
        label: remainingKm === 0 ? "Σέρβις τώρα" : "Άμεσα",
        remainingKm: remainingKm,
        short: remainingKm === 0 ? "Έφτασε στο σέρβις" : "Απομένουν " + formatKm(remainingKm),
        message: remainingKm === 0
          ? "Έφτασε στα χιλιόμετρα του σέρβις."
          : "Είναι πολύ κοντά στο σέρβις. Απομένουν " + formatKm(remainingKm) + "."
      };
    }
    if (remainingKm <= WARNING_KM) {
      return {
        key: "soon",
        label: "Πλησιάζει",
        remainingKm: remainingKm,
        short: "Απομένουν " + formatKm(remainingKm),
        message: "Πλησιάζει το σέρβις. Απομένουν " + formatKm(remainingKm) + "."
      };
    }
    return {
      key: "ok",
      label: "Εντάξει",
      remainingKm: remainingKm,
      short: "Απομένουν " + formatKm(remainingKm),
      message: "Δεν πλησιάζει ακόμη το σέρβις. Απομένουν " + formatKm(remainingKm) + "."
    };
  }

  function severity(statusKey) {
    if (statusKey === "overdue") return 0;
    if (statusKey === "urgent") return 1;
    if (statusKey === "soon") return 2;
    return 3;
  }

  function majorNeedsAttention(bike) {
    const plan = getMajorServicePlan(bike);
    return Boolean(plan.hasMajorService) && Number(plan.remainingKm) <= WARNING_KM;
  }

  function sortedBikes() {
    return bikes.slice().sort(function (a, b) {
      const remainingA = Number(getStatus(a).remainingKm);
      const remainingB = Number(getStatus(b).remainingKm);
      return remainingA - remainingB ||
        a.name.localeCompare(b.name, "el");
    });
  }

  function mileageCheckAgeDays(bike) {
    const reference = String(bike && (bike.lastCheckedAt || bike.createdAt) || "");
    const time = Date.parse(reference);
    if (!Number.isFinite(time)) return 0;
    return Math.floor(Math.max(0, Date.now() - time) / 86400000);
  }

  function mileageCheckIsStale(bike) {
    return mileageCheckAgeDays(bike) >= MILEAGE_CHECK_STALE_DAYS;
  }

  function staleMileageChecks() {
    return sortedBikes().filter(mileageCheckIsStale);
  }

  function overviewBikes(filter) {
    return sortedBikes().filter(function (bike) {
      const key = getStatus(bike).key;
      if (filter === "ok") return key === "ok" && !majorNeedsAttention(bike);
      if (filter === "attention") return key === "soon" || key === "urgent" || majorNeedsAttention(bike);
      if (filter === "overdue") return key === "overdue";
      return true;
    });
  }

  function openOverviewDialog(filter, records, customCopy) {
    const safeFilter = ["all", "ok", "attention", "overdue"].includes(filter) ? filter : "all";
    const filtered = Array.isArray(records) ? records : overviewBikes(safeFilter);
    const copy = customCopy || {
      all: ["Σύνολο στόλου", "Όλα τα μηχανάκια, ταξινομημένα με προτεραιότητα όσα χρειάζονται service."],
      ok: ["Κανονική λειτουργία", "Μηχανάκια που απέχουν περισσότερο από 500 χλμ. από το επόμενο service."],
      attention: ["Πλησιάζει service", "Μηχανάκια που έχουν έως 500 χλμ. μέχρι το επόμενο service."],
      overdue: ["Εκπρόθεσμα", "Μηχανάκια που έχουν ξεπεράσει τα χιλιόμετρα του επόμενου service."]
    }[safeFilter];
    elements.overviewDialogTitle.textContent = copy[0] + " · " + filtered.length;
    elements.overviewDialogContext.textContent = copy[1];
    elements.overviewDialogList.innerHTML = filtered.length ? filtered.map(function (bike) {
      const status = getStatus(bike);
      const major = getMajorServicePlan(bike);
      const majorCopy = majorNeedsAttention(bike)
        ? '<small class="overview-major-copy">' + escapeHtml(major.label) + ' · ορόσημο ' + formatKm(major.nextMajorServiceKm) + '</small>'
        : "";
      return `
        <button class="picker-bike-option overview-bike-option" type="button" data-overview-bike="${escapeHtml(bike.id)}" aria-label="Άνοιγμα καρτέλας ${escapeHtml(bike.name)}">
          <span class="picker-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M4 17h2l2-7h8l2 7h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 10l2-4h3l2 4"/></svg>
          </span>
          <span class="picker-option-copy">
            <strong>${escapeHtml(bike.name)}</strong>
            <small>${formatKm(bike.currentKm)} τώρα · επόμενο ${formatKm(bike.nextServiceKm)}</small>
            ${majorCopy}
          </span>
          <span class="picker-option-state">
            <span class="status-pill ${status.key}">${escapeHtml(status.label)}</span>
            <small>${escapeHtml(status.short)}</small>
          </span>
        </button>
      `;
    }).join("") : '<p class="picker-empty">Δεν υπάρχουν μηχανάκια σε αυτή την κατηγορία.</p>';
    elements.overviewDialog.showModal();
  }

  function openMileageCheckOverview() {
    const staleChecks = staleMileageChecks();
    openOverviewDialog(
      "all",
      staleChecks,
      [
        "Έλεγχος χιλιομέτρων · " + staleChecks.length,
        "Δεν έχει καταχωρηθεί έλεγχος για τουλάχιστον " + MILEAGE_CHECK_STALE_DAYS + " ημέρες."
      ]
    );
  }

  function setDetailPresentation(active, view) {
    document.documentElement.classList.toggle("fleet-detail-view", Boolean(active));
    if (!isEmbedded || window.parent === window) return;
    try {
      window.parent.postMessage({ type: "fleet-control:embedded-view", view: view || (active ? "detail" : "home") }, "*");
    } catch (error) {}
  }

  function serviceDateKey(entry) {
    const value = String(entry && entry.date || "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const parsed = new Date(value + "T12:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
  }

  function latestServiceRows(records) {
    return (Array.isArray(records) ? records : []).map(function (bike) {
      const deleted = new Set(bike.historyDeletedIds || []);
      const services = (Array.isArray(bike.history) ? bike.history : []).filter(function (entry) {
        return entry && entry.type === "service" && !deleted.has(entry.id)
          && !/^Αρχικ[ήη]\s+(?:ένδειξη|ενδειξη|καταχώρηση|καταχωρηση)/iu.test(String(entry.notes || "").trim());
      }).slice().sort(function (a, b) {
        // Mileage, upload time and OCR/invoice dates must never determine recency.
        return serviceDateKey(b).localeCompare(serviceDateKey(a)) || String(a.id || "").localeCompare(String(b.id || ""));
      });
      const latest = services[0] || null;
      const oil = services.find(function (entry) { return entry.oilChanged && serviceDateKey(entry); }) || null;
      const mileageWarning = Boolean(oil && Number(bike.lastServiceKm) > Number(oil.km));
      return { bike: bike, latest: latest, oil: oil, date: serviceDateKey(latest), mileageWarning: mileageWarning };
    }).sort(function (a, b) {
      return b.date.localeCompare(a.date) || String(a.bike.name || "").localeCompare(String(b.bike.name || ""), "el") || String(a.bike.id || "").localeCompare(String(b.bike.id || ""));
    });
  }

  function renderServiceOrder() {
    const rows = latestServiceRows(bikes);
    elements.serviceOrderSummary.textContent = rows.length + " μηχανάκια · " + rows.filter(function (row) { return row.date; }).length + " με ημερομηνία service";
    elements.serviceOrderList.innerHTML = rows.length ? rows.map(function (row, index) {
      const entry = row.latest;
      const date = row.date ? formatDate(row.date) : entry ? "Χωρίς έγκυρη ημερομηνία service" : "Χωρίς καταχωρημένο service";
      return '<button class="service-order-row' + (row.mileageWarning ? ' has-mileage-warning' : '') + '" type="button" data-service-order-bike="' + escapeHtml(row.bike.id) + '">' +
        '<span class="service-order-rank">' + (index + 1) + '</span><span class="service-order-copy"><strong>' + escapeHtml(row.bike.name) + '</strong><span>' + escapeHtml(date) + '</span>' +
        (entry ? '<small>Χιλιόμετρα service: ' + escapeHtml(formatKm(entry.km)) + '</small>' : '') +
        (row.oil ? '<small>Τελευταία αλλαγή λαδιών: ' + escapeHtml(formatDate(serviceDateKey(row.oil))) + ' · ' + escapeHtml(formatKm(row.oil.km)) + '</small>' : '') +
        (row.mileageWarning ? '<span class="service-order-warning">Έλεγξε τα χιλιόμετρα: η καρτέλα υπολογίζει τελευταία λάδια στα ' + escapeHtml(formatKm(row.bike.lastServiceKm)) + ', πάνω από τη χρονολογικά τελευταία αλλαγή.</span>' : '') +
        '</span><span class="service-order-arrow" aria-hidden="true">→</span></button>';
    }).join("") : '<div class="service-order-note">Δεν υπάρχουν μηχανάκια στον στόλο.</div>';
  }

  function openServiceOrder(pushState) {
    if (pushState !== false) serviceOrderHomeScroll = window.scrollY || 0;
    activeBikeId = null;
    elements.homeView.classList.add("is-hidden");
    elements.quickCheckView.classList.add("is-hidden");
    elements.detailView.classList.add("is-hidden");
    elements.serviceOrderView.classList.remove("is-hidden");
    setDetailPresentation(true, "service-order");
    renderServiceOrder();
    window.scrollTo(0, 0);
    if (pushState !== false) {
      try { history.pushState({ view: "service-order" }, "", "#latest-services"); } catch (error) {}
    }
  }

  function backFromServiceOrder() {
    if (history.state && history.state.view === "service-order") history.back();
    else { showHome(); window.scrollTo(0, serviceOrderHomeScroll); }
  }

  function renderHome() {
    if (!elements.serviceOrderView.classList.contains("is-hidden")) renderServiceOrder();
    const ordered = sortedBikes();
    const staleChecks = ordered.filter(mileageCheckIsStale);
    const majorAttention = ordered.filter(majorNeedsAttention);
    const attention = ordered.filter(function (bike) { return getStatus(bike).key !== "ok" || majorNeedsAttention(bike); });
    const totalAttention = new Set(attentionIds(attention.concat(staleChecks))).size;
    const upcoming = ordered.filter(function (bike) {
      const key = getStatus(bike).key;
      return ["soon", "urgent"].includes(key) || (key === "ok" && majorNeedsAttention(bike));
    });
    const healthy = ordered.filter(function (bike) { return getStatus(bike).key === "ok" && !majorNeedsAttention(bike); });
    const overdue = ordered.filter(function (bike) { return getStatus(bike).key === "overdue"; });

    elements.bikeCount.textContent = String(bikes.length);
    elements.healthyCount.textContent = String(healthy.length);
    elements.attentionCount.textContent = String(upcoming.length);
    elements.overdueCount.textContent = String(overdue.length);
    elements.attentionMeter.classList.toggle("has-alerts", upcoming.length > 0);
    elements.overviewMessage.textContent = bikes.length
      ? (totalAttention ? totalAttention + " χρειάζονται την προσοχή σου." : "Ο στόλος είναι ενημερωμένος.")
      : "Όλα οργανωμένα σε ένα σημείο.";
    elements.listStatus.textContent = bikes.length + (bikes.length === 1 ? " όχημα" : " οχήματα");
    elements.emptyState.classList.toggle("is-hidden", bikes.length > 0);
    elements.bikeList.classList.toggle("is-hidden", bikes.length === 0);
    elements.addBikeButton.disabled = bikes.length >= MAX_BIKES;

    renderFleetAlert(attention, overdue, majorAttention);
    renderMileageCheckAlert(staleChecks);
    renderQuickBikeSelect();

    elements.bikeList.innerHTML = ordered.map(function (bike) {
      const status = getStatus(bike);
      const major = getMajorServicePlan(bike);
      const checkText = bike.lastCheckedAt
        ? "Έλεγχος " + formatDate(bike.lastCheckedAt)
        : "Χωρίς πρόσφατο έλεγχο";
      return `
        <button class="bike-card" type="button" data-bike-id="${escapeHtml(bike.id)}" data-status="${status.key}"${mileageCheckIsStale(bike) ? ' data-mileage-check="stale"' : ''} aria-label="Άνοιγμα καρτέλας ${escapeHtml(bike.name)}">
          <div class="bike-card-main">
            <div class="bike-avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M4 17h2l2-7h8l2 7h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 10l2-4h3l2 4"/></svg>
            </div>
            <div class="bike-card-title">
              <div class="bike-card-title-row">
                <h3>${escapeHtml(bike.name)}</h3>
                ${mileageCheckIsStale(bike) ? '<span class="mileage-check-badge" title="Χρειάζεται έλεγχος χιλιομέτρων" aria-label="Χρειάζεται έλεγχος χιλιομέτρων"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg><span>Έλεγχος</span></span>' : ''}
              </div>
              <p>${escapeHtml(checkText)}</p>
            </div>
            <svg class="bike-card-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </div>
          <div class="bike-card-metrics">
            <div class="bike-mini-metric">
              <span>Χιλιόμετρα τώρα</span>
              <strong>${formatKm(bike.currentKm)}</strong>
            </div>
            <div class="bike-mini-metric">
              <span>Επόμενο σέρβις</span>
              <strong>${formatKm(bike.nextServiceKm)}</strong>
            </div>
          </div>
          <div class="bike-card-footer">
            <span class="bike-status-stack">
              <span class="status-pill ${status.key}">${escapeHtml(status.label)}</span>
              ${majorNeedsAttention(bike) ? '<span class="major-service-chip ' + escapeHtml(major.key) + '">' + escapeHtml(major.label) + '</span>' : ''}
            </span>
            <small>${majorNeedsAttention(bike) ? escapeHtml(major.message) : escapeHtml(status.short)}</small>
          </div>
        </button>
      `;
    }).join("");
  }

  function attentionIds(records) {
    return records.map(function (bike) { return String(bike && bike.id || ""); }).filter(Boolean);
  }

  function renderFleetAlert(attention, overdue, majorAttention) {
    if (!attention.length) {
      elements.fleetAlert.classList.add("is-hidden");
      elements.fleetAlert.dataset.alertFilter = "";
      return;
    }

    const target = overdue.length ? overdue : (majorAttention.length ? majorAttention : attention);
    const names = target.slice(0, 3).map(function (bike) { return bike.name; }).join(", ");
    const extra = target.length > 3 ? " +" + (target.length - 3) : "";
    elements.fleetAlert.classList.remove("is-hidden", "danger");
    elements.fleetAlert.dataset.alertFilter = overdue.length ? "overdue" : "attention";

    if (overdue.length) {
      elements.fleetAlert.classList.add("danger");
      elements.fleetAlertTitle.textContent = overdue.length === 1
        ? "1 μηχανάκι έχει περάσει το σέρβις"
        : overdue.length + " μηχανάκια έχουν περάσει το σέρβις";
      elements.fleetAlertText.textContent = names + extra;
    } else if (majorAttention.length) {
      elements.fleetAlertTitle.textContent = majorAttention.length === 1
        ? "1 μηχανάκι χρειάζεται μεγάλο service"
        : majorAttention.length + " μηχανάκια χρειάζονται μεγάλο service";
      elements.fleetAlertText.textContent = names + extra + " · η υπενθύμιση παραμένει μέχρι να δηλωθεί ότι έγινε";
    } else {
      elements.fleetAlertTitle.textContent = attention.length === 1
        ? "1 μηχανάκι πλησιάζει το σέρβις"
        : attention.length + " μηχανάκια πλησιάζουν το σέρβις";
      elements.fleetAlertText.textContent = names + extra;
    }
  }

  function renderMileageCheckAlert(staleChecks) {
    if (!elements.mileageCheckAlert) return;
    if (!staleChecks.length) {
      elements.mileageCheckAlert.classList.add("is-hidden");
      try { localStorage.removeItem(MILEAGE_CHECK_ALERT_SIGNATURE_KEY); } catch (error) {}
      return;
    }
    const names = staleChecks.slice(0, 3).map(function (bike) { return bike.name; }).join(", ");
    const extra = staleChecks.length > 3 ? " +" + (staleChecks.length - 3) : "";
    elements.mileageCheckAlert.classList.remove("is-hidden");
    elements.mileageCheckAlert.dataset.alertFilter = "mileage";
    elements.mileageCheckAlertTitle.textContent = staleChecks.length === 1
      ? "Χρειάζεται έλεγχος χιλιομέτρων"
      : staleChecks.length + " μηχανάκια χρειάζονται έλεγχο χιλιομέτρων";
    elements.mileageCheckAlertText.textContent = names + extra + " · δεν έχει γίνει έλεγχος για τουλάχιστον " + MILEAGE_CHECK_STALE_DAYS + " ημέρες.";

    if (window.AndroidFleet && typeof window.AndroidFleet.notifyAlert === "function") {
      const signature = staleChecks.map(function (bike) { return String(bike.id) + ":" + String(bike.lastCheckedAt || bike.createdAt || ""); }).sort().join("|");
      try {
        const previous = localStorage.getItem(MILEAGE_CHECK_ALERT_SIGNATURE_KEY) || "";
        if (signature !== previous) {
          localStorage.setItem(MILEAGE_CHECK_ALERT_SIGNATURE_KEY, signature);
          window.AndroidFleet.notifyAlert(
            "mileage-check-stale",
            "Έλεγχος χιλιομέτρων",
            names + extra + " · δεν έχει γίνει έλεγχος για " + MILEAGE_CHECK_STALE_DAYS + "+ ημέρες.",
            "warning"
          );
        }
      } catch (error) {}
    }
  }

  function renderQuickBikeSelect() {
    const selected = elements.quickBikeSelect.value;
    const bike = getBike(selected);
    if (!bike) elements.quickBikeSelect.value = "";
    elements.quickBikePicker.disabled = bikes.length === 0;
    elements.quickCurrentKm.disabled = bikes.length === 0;
    elements.quickCheckForm.querySelector('button[type="submit"]').disabled = bikes.length === 0;
    if (bike) {
      const status = getStatus(bike);
      elements.quickBikePickerLabel.textContent = bike.name;
      elements.quickBikePickerMeta.textContent = formatKm(bike.currentKm) + " τώρα · επόμενο " + formatKm(bike.nextServiceKm);
      elements.quickBikePickerStatus.textContent = status.label;
      elements.quickBikePickerStatus.className = "picker-status " + status.key;
    } else {
      elements.quickBikePickerLabel.textContent = bikes.length ? "Διάλεξε μηχανάκι" : "Δεν υπάρχουν μηχανάκια";
      elements.quickBikePickerMeta.textContent = bikes.length ? "Πάτησε για να ανοίξει η λίστα" : "Πρόσθεσε πρώτα ένα μηχανάκι";
      elements.quickBikePickerStatus.className = "picker-status is-hidden";
    }
    if (elements.quickMajorHint) {
      if (bike) {
        const major = getMajorServicePlan(bike);
        elements.quickMajorHint.className = "major-service-hint " + major.key;
        elements.quickMajorHint.innerHTML = "<strong>" + escapeHtml(major.label) + "</strong><span>" + escapeHtml(major.message) + "</span>";
      } else {
        elements.quickMajorHint.className = "major-service-hint is-hidden";
        elements.quickMajorHint.textContent = "";
      }
    }
    renderBikePickerList(elements.bikePickerSearch.value || "");
  }

  function renderBikePickerList(query) {
    const needle = String(query || "").trim().toLocaleLowerCase("el");
    const matches = sortedBikes().filter(function (bike) {
      return !needle || bike.name.toLocaleLowerCase("el").includes(needle);
    });
    if (!matches.length) {
      elements.bikePickerList.innerHTML = '<p class="picker-empty">Δεν βρέθηκε μηχανάκι.</p>';
      return;
    }
    elements.bikePickerList.innerHTML = matches.map(function (bike) {
      const status = getStatus(bike);
      const selected = elements.quickBikeSelect.value === bike.id;
      return `
        <button class="picker-bike-option${selected ? " selected" : ""}" type="button" data-pick-bike="${escapeHtml(bike.id)}">
          <span class="picker-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M4 17h2l2-7h8l2 7h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 10l2-4h3l2 4"/></svg>
          </span>
          <span class="picker-option-copy">
            <strong>${escapeHtml(bike.name)}</strong>
            <small>${formatKm(bike.currentKm)} τώρα · σέρβις ${formatKm(bike.nextServiceKm)}</small>
          </span>
          <span class="picker-option-state">
            <span>${escapeHtml(status.label)}</span>
            <small>${escapeHtml(status.short)}</small>
          </span>
        </button>
      `;
    }).join("");
  }

  function openBikePicker() {
    if (!bikes.length) return;
    elements.bikePickerSearch.value = "";
    renderBikePickerList("");
    elements.bikePickerDialog.showModal();
  }

  function selectQuickBike(bikeId) {
    const bike = getBike(bikeId);
    if (!bike) return;
    elements.quickBikeSelect.value = bike.id;
    elements.quickCheckError.textContent = "";
    elements.quickCheckResult.classList.add("is-hidden");
    elements.quickCurrentKm.value = bike.currentKm;
    renderQuickBikeSelect();
    elements.bikePickerDialog.close();
  }

  function openQuickCheck(pushState, bikeId) {
    const requestedBike = bikeId ? getBike(bikeId) : getBike(elements.quickBikeSelect.value);
    elements.serviceOrderView.classList.add("is-hidden");
    if (requestedBike) {
      elements.quickBikeSelect.value = requestedBike.id;
      elements.quickCurrentKm.value = requestedBike.currentKm;
    }
    elements.homeView.classList.add("is-hidden");
    elements.detailView.classList.add("is-hidden");
    elements.quickCheckView.classList.remove("is-hidden");
    setDetailPresentation(true, "quick-check");
    renderQuickBikeSelect();
    window.scrollTo(0, 0);
    if (pushState !== false) {
      try {
        history.pushState({ view: "quick-check", bikeId: requestedBike ? requestedBike.id : "" }, "", "#kilometers");
      } catch (error) {}
    }
    setTimeout(function () {
      if (requestedBike) elements.quickCurrentKm.focus();
      else elements.quickBikePicker.focus();
    }, 60);
  }

  function showHome() {
    activeBikeId = null;
    elements.serviceOrderView.classList.add("is-hidden");
    elements.quickCheckView.classList.add("is-hidden");
    elements.detailView.classList.add("is-hidden");
    elements.homeView.classList.remove("is-hidden");
    setDetailPresentation(false, "home");
    renderArchiveAccess();
    renderHome();
    window.scrollTo(0, 0);
  }

  function openDetail(bikeId, pushState) {
    const bike = getBike(bikeId);
    if (!bike) {
      showHome();
      return;
    }
    activeBikeId = bikeId;
    activeHistoryFilter = "service";
    renderDetail();
    elements.serviceOrderView.classList.add("is-hidden");
    elements.homeView.classList.add("is-hidden");
    elements.quickCheckView.classList.add("is-hidden");
    elements.detailView.classList.remove("is-hidden");
    setDetailPresentation(true, "detail");
    renderArchiveAccess();
    window.scrollTo(0, 0);
    if (pushState !== false) {
      try {
        history.pushState({ view: "detail", bikeId: bikeId }, "", "#bike=" + encodeURIComponent(bikeId));
      } catch (error) {}
    }
  }

  function stripInvoicePartCode(value) {
    const original = String(value || "").trim();
    let text = original;
    text = text.replace(/^\s*(?:κωδ(?:ικός)?|κωδ\.?|code|sku|item\s*code|ref(?:erence)?)[\s:#№-]*[A-ZΑ-Ω0-9][A-ZΑ-Ω0-9./_-]{1,}\s*(?:[-–—:|]\s*)?/iu, "");
    text = text.replace(/^\s*[A-ZΑ-Ω]{1,6}[-_/]?\d{3,}\s*[-–—:|]\s*/iu, "");
    text = text.replace(/^\s*\d{4,}\s*[-–—:|]\s*/, "");
    text = text.replace(/^\s*\d{4,}\s+(?=[A-Za-zΑ-ΩΆΈΉΊΌΎΏΪΫα-ωάέήίόύώϊϋ])/u, "");
    return (text.trim() || original).slice(0, 500);
  }

  function qrTimestampMs(value) {
    const raw = String(value == null ? "" : value).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function qrElapsedLabelValue(seconds) {
    const numeric = Number(seconds);
    if (!Number.isFinite(numeric)) return "Χρόνος: —";
    const safeSeconds = Math.max(0, Math.floor(numeric));
    if (safeSeconds > 600) return "Χρόνος: >10:00";
    const minutes = Math.floor(safeSeconds / 60);
    const rest = String(safeSeconds % 60).padStart(2, "0");
    return minutes ? "Χρόνος: " + minutes + ":" + rest : "Χρόνος: 00:" + rest;
  }

  function qrProgressModel(data, now) {
    const value = data || {};
    const status = String(value.qrProcessingStatus || "processing");
    const rawProgress = Number(value.qrProcessingProgress);
    const reported = Math.max(5, Math.min(100, Number.isFinite(rawProgress) ? rawProgress : 5));
    const started = qrTimestampMs(value.qrProcessingStartedAt);
    const updated = qrTimestampMs(value.qrProcessingUpdatedAt || value.qrProcessingStartedAt);
    const current = Number.isFinite(now) ? now : Date.now();
    const elapsedSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((current - started) / 1000)) : 0;
    if (status === "completed") return { progress: 100, elapsedSeconds: elapsedSeconds, estimated: false };
    if (status === "error") return { progress: reported, elapsedSeconds: elapsedSeconds, estimated: false };
    const sinceUpdate = Number.isFinite(updated) ? Math.max(0, Math.floor((current - updated) / 1000)) : elapsedSeconds;
    const cap = reported <= 5 ? 55 : reported <= 55 ? 70 : reported <= 70 ? 95 : 98;
    const estimated = reported + Math.min(Math.max(0, cap - reported), Math.floor(sinceUpdate / 3));
    const progress = Math.max(reported, Math.min(cap, estimated));
    return { progress: progress, elapsedSeconds: elapsedSeconds, estimated: progress !== reported };
  }

  function qrElapsedLabel(data) {
    const model = qrProgressModel(data);
    const seconds = model.elapsedSeconds;
    if (!seconds && !String(data && data.qrProcessingStartedAt || "").trim()) return "Μόλις ξεκίνησε";
    return qrElapsedLabelValue(seconds);
  }

  const wigglyProgressRings = new Set();
  let wigglyProgressFrame = 0;
  const requestWigglyFrame = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : function (callback) { return window.setTimeout(function () { callback(Date.now()); }, 32); };

  function wigglyProgressReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function clampWigglyProgress(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
  }

  function isWigglyProgressAttached(canvas) {
    return Boolean(canvas && (typeof canvas.isConnected === "boolean"
      ? canvas.isConnected
      : document.documentElement.contains(canvas)));
  }

  function drawWigglyProgressRing(canvas, time) {
    if (!isWigglyProgressAttached(canvas)) {
      wigglyProgressRings.delete(canvas);
      return;
    }
    let geometry = canvas.__wigglyGeometry;
    const deviceScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
    if (!geometry || geometry.viewportWidth !== window.innerWidth || geometry.scale !== deviceScale) {
      const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      const computed = window.getComputedStyle ? window.getComputedStyle(canvas) : null;
      const cssWidth = Number(rect && rect.width) || Number(canvas.clientWidth) || Number.parseFloat(computed && computed.width) || 48;
      const cssHeight = Number(rect && rect.height) || Number(canvas.clientHeight) || Number.parseFloat(computed && computed.height) || cssWidth;
      geometry = { size: Math.max(24, Math.round(Math.min(cssWidth, cssHeight))), viewportWidth: window.innerWidth, scale: deviceScale };
      canvas.__wigglyGeometry = geometry;
    }
    const size = geometry.size;
    const pixelSize = Math.max(1, Math.round(size * deviceScale));
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }
    const context = canvas.getContext && canvas.getContext("2d");
    if (!context) return;
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    context.clearRect(0, 0, size, size);

    const targetProgress = clampWigglyProgress(canvas.dataset.progress);
    let displayedProgress = Number(canvas.__wigglyProgress);
    if (!Number.isFinite(displayedProgress)) displayedProgress = targetProgress;
    if (wigglyProgressReducedMotion()) displayedProgress = targetProgress;
    else displayedProgress += (targetProgress - displayedProgress) * .12;
    if (Math.abs(displayedProgress - targetProgress) < .05) displayedProgress = targetProgress;
    canvas.__wigglyProgress = displayedProgress;

    const status = String(canvas.dataset.status || "processing");
    const colors = status === "error"
      ? { track: "#f0d9de", value: "#c44052", glow: "rgba(196,64,82,.72)" }
      : status === "delayed"
        ? { track: "#f2e2bd", value: "#d9941b", glow: "rgba(217,148,27,.72)" }
        : status === "completed" || status === "confirmed"
          ? { track: "#d8ece7", value: "#0f9f82", glow: "rgba(15,159,130,.68)" }
          : { track: "#d8ece7", value: "#12bfa5", glow: "rgba(18,191,165,.76)" };
    const center = size / 2;
    const radius = size * .355;
    const lineWidth = Math.max(2.5, size * .078);
    const reducedMotion = wigglyProgressReducedMotion();
    const phase = reducedMotion ? 0 : (Number(time) || 0) * .00105;
    const rotation = reducedMotion || ["completed", "confirmed", "error"].includes(status) ? 0 : phase * .72;
    const steps = 180;
    const pointAt = function (fraction) {
      const angle = -Math.PI / 2 + ((fraction % 1 + 1) % 1) * Math.PI * 2;
      const wave = Math.sin(angle * 5 + phase * 3.2) * size * .026
        + Math.sin(angle * 9 - phase * 2.1) * size * .014
        + Math.sin(angle * 16 + phase * 1.25) * size * .006;
      const pulse = 1 + Math.sin(phase * 1.35) * .018;
      const distance = (radius + wave) * pulse;
      return { x: center + Math.cos(angle) * distance, y: center + Math.sin(angle) * distance };
    };
    const trace = function (fraction, start) {
      const count = Math.max(1, Math.round(steps * Math.max(0, Math.min(1, fraction))));
      context.beginPath();
      for (let index = 0; index <= count; index += 1) {
        const point = pointAt(index / steps + (start || 0));
        if (!index) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
    };

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    trace(1);
    context.strokeStyle = colors.track;
    context.lineWidth = lineWidth;
    context.stroke();
    if (displayedProgress > 0) {
      trace(displayedProgress / 100, rotation / (Math.PI * 2));
      context.strokeStyle = colors.value;
      context.lineWidth = lineWidth;
      context.shadowColor = colors.glow;
      context.shadowBlur = size * .09;
      context.stroke();
      context.shadowBlur = 0;
      context.globalAlpha = .86;
      context.setLineDash([Math.max(1, size * .035), Math.max(2, size * .085)]);
      context.lineDashOffset = -(phase * size * 1.8);
      context.strokeStyle = colors.glow;
      context.lineWidth = Math.max(1.1, lineWidth * .34);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    context.restore();
  }

  function animateWigglyProgressRings(time) {
    wigglyProgressFrame = 0;
    wigglyProgressRings.forEach(function (canvas) { drawWigglyProgressRing(canvas, time); });
    if (wigglyProgressRings.size && !wigglyProgressReducedMotion()) {
      wigglyProgressFrame = requestWigglyFrame(animateWigglyProgressRings);
    }
  }

  function refreshWigglyProgressRings(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll("[data-wiggly-progress]").forEach(function (canvas) { wigglyProgressRings.add(canvas); });
    if (wigglyProgressReducedMotion()) {
      wigglyProgressRings.forEach(function (canvas) { drawWigglyProgressRing(canvas, Date.now()); });
    } else if (!wigglyProgressFrame) {
      wigglyProgressFrame = requestWigglyFrame(animateWigglyProgressRings);
    }
  }

  function qrProcessingMarkup(entry) {
    const data = normalizeInvoiceData(entry && entry.invoiceData) || {};
    const status = String(data.qrProcessingStatus || "processing");
    const progressModel = qrProgressModel(data);
    const progress = progressModel.progress;
    const delayed = status === "delayed";
    const failed = status === "error";
    const statusClass = failed ? " error" : delayed ? " delayed" : "";
    const statusLabel = failed ? "Αποτυχία επεξεργασίας" : delayed ? "Καθυστέρηση · ελέγξτε ή επαναλάβετε" : "Το PDF δημιουργείται στον Server";
    const error = data.qrProcessingError ? '<p class="qr-processing-error">' + escapeHtml(data.qrProcessingError) + '</p>' : "";
    const retry = (failed || delayed) && data.qrJobId && canManageHistory()
      ? '<button type="button" class="document-retry-button" data-retry-qr="' + escapeHtml(data.qrJobId) + '" data-retry-qr-entry="' + escapeHtml(entry && entry.id || "") + '">Επανάληψη</button>'
      : "";
    return '<div class="history-documents"><div class="history-document-row qr-processing-card' + statusClass + '"><div class="qr-processing-main"><div class="qr-progress-ring" style="--progress:' + progress + '" aria-label="' + progress + '%"><canvas class="qr-progress-canvas" data-wiggly-progress data-progress="' + progress + '" data-status="' + escapeHtml(status) + '" width="96" height="96" aria-hidden="true"></canvas><strong>' + progress + '%</strong></div><div><strong>' + statusLabel + '</strong><span>' + escapeHtml(String(data.qrProcessingStage || "Αναμονή από τον Server")) + '</span><small>' + qrElapsedLabel(data) + (progressModel.estimated ? " · εκτίμηση" : "") + '</small>' + error + '</div></div>' + retry + '</div></div>';
  }

  function renderDetail() {
    const bike = getBike(activeBikeId);
    if (!bike) return;
    const status = getStatus(bike);
    const major = getMajorServicePlan(bike);
    renderArchiveAccess();
    const allHistoryEntries = Array.isArray(bike.history) ? bike.history : [];
    const historyEntries = historyEntriesForDisplay(allHistoryEntries.filter(function (entry) {
      return activeHistoryFilter === "all" || entry.type === activeHistoryFilter;
    }));
    elements.historyFilterButtons.forEach(function (button) {
      const selected = button.dataset.historyFilter === activeHistoryFilter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });

    elements.detailName.textContent = bike.name;
    elements.detailStatusCard.className = "detail-status-card status-" + status.key;
    elements.detailStatusBadge.textContent = status.label;
    elements.detailLastCheck.textContent = bike.lastCheckedAt
      ? "Τελευταίος έλεγχος " + formatDate(bike.lastCheckedAt)
      : "Δεν έχει γίνει έλεγχος";
    elements.detailCurrentKm.textContent = formatKm(bike.currentKm);
    elements.detailNextService.textContent = formatKm(bike.nextServiceKm);
    elements.detailRemaining.textContent = status.remainingKm < 0
      ? "Πέρασε " + formatKm(Math.abs(status.remainingKm))
      : formatKm(status.remainingKm);
    elements.detailLastService.textContent = formatKm(bike.lastServiceKm);
    elements.detailInterval.textContent = formatKm(bike.intervalKm);
    elements.detailMajorService.textContent = major.label;
    elements.detailMajorServiceHint.textContent = major.message;
    elements.detailMajorServiceHint.className = "detail-major-hint " + major.key;
    elements.historyCount.textContent = historyEntries.length +
      (historyEntries.length === 1 ? " εγγραφή" : " εγγραφές");

    if (!historyEntries.length) {
      elements.detailHistory.innerHTML = '<p class="history-empty">Δεν υπάρχουν ακόμη καταχωρήσεις.</p>';
      return;
    }

    elements.detailHistory.innerHTML = historyEntries.map(function (entry) {
      const isService = entry.type !== "check";
      const shiftManaged = String(entry.id || "").startsWith("shift-");
      const title = isService
        ? (/^Αρχική/.test(entry.notes || "") ? "Αρχική ένδειξη" : "Σέρβις")
        : "Έλεγχος χιλιομέτρων";
      const icon = isService
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3 3-3-3 3-3Z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h2l2-7h8l2 7h2M7 17a2 2 0 1 0 0 .01M17 17a2 2 0 1 0 0 .01M9 10l2-4h3l2 4"/></svg>';
      const tasks = isService ? serviceTasksForEntry(entry) : [];
      const taskList = tasks.length
        ? '<ul class="service-task-list">' + tasks.map(function (task) { return "<li>" + escapeHtml(task) + "</li>"; }).join("") + "</ul>"
        : "";
      const oilBadge = isService && entry.oilChanged
        ? '<span class="oil-reset-badge">Νέος κύκλος λαδιών</span>'
        : "";
      const majorBadge = isService && entry.majorService
        ? '<span class="major-service-history-badge">Μεγάλο service · καταγράφηκε στα ' + formatKm(majorEntryMilestone(entry)) + '</span>'
        : "";
      const supplier = isService ? serviceSupplier(entry) : null;
      const workshop = supplier
        ? '<p class="history-workshop">' + escapeHtml(supplier.label) + ': ' + escapeHtml(supplier.value) + '</p>'
        : "";
      const entryInvoiceData = isService ? invoiceDataForEntry(entry) : null;
      const serviceCost = isService ? reportCost(entry) : "—";
      const costMarkup = isService && serviceCost !== "—"
        ? '<p class="history-cost"><strong>Κόστος service:</strong> ' + escapeHtml(serviceCost) + '</p>'
        : "";
      const mismatchWarnings = isService ? Array.from(new Set((entry.attachments || []).length
        ? entry.attachments.flatMap(function (file) { return invoiceWarnings(bike, entry, invoiceDataFromAttachment(file) || {}); })
        : invoiceWarnings(bike, entry, entryInvoiceData || {}))) : [];
      const warningMarkup = mismatchWarnings.length
        ? '<div class="history-invoice-warning" role="alert">' + mismatchWarnings.map(function (item) { return '⚠ ' + escapeHtml(item); }).join('<br>') + '</div>'
        : "";
      const sourceBadge = shiftManaged ? '<span class="history-source-badge">Από βάρδια</span>' : "";
      const attachments = isService && Array.isArray(entry.attachments) && entry.attachments.length
        ? '<div class="history-documents">' + entry.attachments.map(function (file) {
            const ocr = file.ocr && file.ocr.workPerformed ? ' · ' + escapeHtml(String(file.ocr.workPerformed).slice(0, 160)) : '';
            const safeName = escapeHtml(file.name);
            const viewButton = '<button type="button" class="document-button" data-view-document="' + escapeHtml(file.key) + '">📎 ' + safeName + ocr + '</button>';
            const downloadButton = '<button type="button" class="document-download-button" data-download-document="' + escapeHtml(file.key) + '" data-download-document-name="' + safeName + '" aria-label="Λήψη τιμολογίου">Λήψη</button>';
            const deleteButton = canManageHistory() && !shiftManaged
              ? '<button type="button" class="document-delete-button" data-delete-document="' + escapeHtml(file.key) + '" data-delete-document-entry="' + escapeHtml(entry.id) + '" aria-label="Διαγραφή τιμολογίου">Διαγραφή</button>'
              : '';
            return '<div class="history-document-row"><div class="history-document-main">' + viewButton + downloadButton + '</div>' + deleteButton + renderInvoiceOcrDetails(file, entry) + '</div>';
          }).join("") + '</div>'
        : "";
      const qrData = normalizeInvoiceData(entry && entry.invoiceData) || {};
      const qrProgress = isService && qrData.qrUrl && (!attachments || ["processing", "delayed", "error"].includes(String(qrData.qrProcessingStatus || "")))
        ? qrProcessingMarkup(entry) : "";
      const historyActions = canManageHistory() && !shiftManaged
        ? '<div class="history-entry-actions"><button type="button" data-edit-history="' + escapeHtml(entry.id) + '" aria-label="Επεξεργασία καταχώρησης">Επεξεργασία</button><button class="danger" type="button" data-delete-history="' + escapeHtml(entry.id) + '" aria-label="Διαγραφή καταχώρησης">Διαγραφή</button></div>'
        : "";
      const backgroundSaveMarkup = backgroundHistorySaveMarkup(bike.id, entry.id);
      return `
        <article class="history-entry ${isService ? "service" : "check"}">
          <div class="history-icon">${icon}</div>
          <div class="history-content">
            <div class="history-top">
              <strong>${escapeHtml(title)}</strong>
              <time datetime="${escapeHtml(entry.date)}">${formatDate(entry.date)}</time>
            </div>
            <span class="history-km">${formatKm(entry.km)}</span>
            ${workshop}
            ${costMarkup}
            ${warningMarkup}
            ${entryInvoiceData && entryInvoiceData.correctedByUserAt ? '<small class="invoice-user-correction">✓ Ελέγχθηκε / διορθώθηκε από χρήστη</small>' : ""}
            ${oilBadge}
            ${majorBadge}
            ${sourceBadge}
            ${taskList}
            ${attachments}
            ${qrProgress}
            ${backgroundSaveMarkup}
            ${historyActions}
          </div>
        </article>
      `;
    }).join("");
    refreshWigglyProgressRings(elements.detailHistory);
  }

  function getHistoryEntry(bike, entryId) {
    return bike && Array.isArray(bike.history)
      ? bike.history.find(function (entry) { return String(entry.id) === String(entryId); })
      : null;
  }

  function ensureLocalOilBaseline(bike, now) {
    if ((bike.history || []).some(function (entry) { return entry.type === "service" && entry.oilChanged; })) return;
    const previousKm = Math.max(0, Math.round(Number(bike.lastServiceKm) || 0));
    if (!previousKm) return;
    bike.history.push({
      id: uid(), type: "service", km: previousKm,
      date: /^\d{4}-\d{2}-\d{2}/.test(String(bike.createdAt || "")) ? String(bike.createdAt).slice(0, 10) : today(),
      notes: "Ιστορικό τελευταίας αλλαγής λαδιών", tasks: ["Ιστορικό τελευταίας αλλαγής λαδιών"],
      workshop: "", oilChanged: true, createdAt: now, updatedAt: now
    });
  }

  function recalculateCorrectedBike(bike) {
    const deleted = new Set(deletedHistoryIds(bike.historyDeletedIds));
    bike.history = (Array.isArray(bike.history) ? bike.history : []).filter(function (entry) { return !deleted.has(entry.id); });
    const metrics = correctedBikeMetrics(bike.history, bike.odometerFloorKm);
    bike.lastServiceKm = metrics.lastServiceKm;
    bike.currentKm = Math.max(metrics.lastServiceKm, metrics.currentKm);
    bike.nextServiceKm = bike.lastServiceKm + Number(bike.intervalKm);
    bike.lastCheckedAt = metrics.lastCheckedAt;
    bike.historyDeletedIds = Array.from(deleted).slice(0, 500);
    bike.updatedAt = new Date().toISOString();
    refreshMajorTracking(bike);
    return bike;
  }

  function openHistoryEntryDialog(entryId) {
    const bike = getBike(activeBikeId);
    const entry = getHistoryEntry(bike, entryId);
    if (!bike || !entry || !canManageHistory() || String(entry.id).startsWith("shift-")) return;
    const isService = entry.type !== "check";
    elements.historyEntryForm.reset();
    updateInvoiceFileName(elements.historyEntryInvoiceFile, elements.historyEntryInvoiceFileName);
    clearInvoiceQrStatus("history");
    elements.historyEntryError.textContent = "";
    elements.historyEntryBikeId.value = bike.id;
    elements.historyEntryId.value = entry.id;
    elements.historyEntryType.value = isService ? "service" : "check";
    elements.historyEntryDialogTitle.textContent = isService ? "Επεξεργασία σέρβις" : "Επεξεργασία ελέγχου χιλιομέτρων";
    elements.historyEntryContext.textContent = bike.name;
    elements.historyEntryKm.value = entry.km;
    elements.historyEntryDate.value = entry.date || today();
    elements.historyEntryServiceFields.classList.toggle("is-hidden", !isService);
    elements.historyEntryWorkshop.value = isService ? entry.workshop || "" : "";
    elements.historyEntryCost.value = isService ? entry.cost || "" : "";
    const tasks = isService && Array.isArray(entry.tasks) ? entry.tasks.filter(Boolean) : [];
    const common = new Set(Array.from(elements.historyEntryTaskInputs).map(function (input) { return input.value; }));
    elements.historyEntryTaskInputs.forEach(function (input) { input.checked = tasks.includes(input.value); });
    elements.historyEntryOilChanged.checked = isService && Boolean(entry.oilChanged);
    elements.historyEntryMajorService.checked = isService && Boolean(entry.majorService);
    elements.historyEntryNotes.value = tasks.filter(function (task) { return !common.has(task); }).join("\n");
    elements.historyEntryReason.value = "";
    elements.historyEntryDialog.showModal();
  }

  function localHistoryEdit(bike, entryId, payload) {
    const entry = getHistoryEntry(bike, entryId);
    if (!entry) throw new Error("Η καταχώρηση δεν βρέθηκε.");
    const now = new Date().toISOString();
    ensureLocalOilBaseline(bike, now);
    entry.km = payload.km;
    entry.date = payload.date;
    entry.createdAt = normalizedIso(entry.createdAt) || now;
    entry.updatedAt = now;
    if (entry.type === "service") {
      entry.tasks = payload.tasks;
      entry.notes = payload.tasks.join("\n");
      entry.workshop = payload.workshop;
      entry.cost = payload.cost;
      entry.oilChanged = payload.oilChanged;
      entry.majorService = payload.majorService;
      entry.majorServiceMilestoneKm = payload.majorService ? payload.km : 0;
    }
    bike.historyCorrectedAt = now;
    return recalculateCorrectedBike(bike);
  }

  function localHistoryDelete(bike, entryId) {
    const entry = getHistoryEntry(bike, entryId);
    if (!entry) throw new Error("Η καταχώρηση δεν βρέθηκε.");
    const now = new Date().toISOString();
    ensureLocalOilBaseline(bike, now);
    bike.history = bike.history.filter(function (item) { return item.id !== entryId; });
    bike.historyDeletedIds = deletedHistoryIds([entryId].concat(bike.historyDeletedIds || []));
    bike.historyCorrectedAt = now;
    return recalculateCorrectedBike(bike);
  }

  async function remoteHistoryAction(bikeId, entryId, action, payload) {
    const response = await fetch(apiBase + "/api/admin/fleet/" + encodeURIComponent(bikeId) + "/history/" + encodeURIComponent(entryId) + "/" + action, {
      method: "POST", headers: requestHeaders(true), body: JSON.stringify(payload), cache: "no-store"
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      if (response.status === 401) {
        try { sessionStorage.setItem("fleet-control-return-to-fleet", "1"); } catch (error) {}
        returnToPortal(true);
      }
      throw new Error(data.error || "Η διόρθωση δεν ολοκληρώθηκε.");
    }
    return data;
  }

  async function readQrFromFile(file) {
    const isImage = file && (String(file.type || "").startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(String(file.name || "")));
    if (!isImage || typeof window.jsQR !== "function") return "";
    let source;
    let objectUrl = "";
    try {
      if (typeof createImageBitmap === "function") {
        try { source = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (error) { source = null; }
      }
      if (!source) {
        objectUrl = URL.createObjectURL(file);
        source = await new Promise(function (resolve, reject) {
          const image = new Image();
          image.onload = function () { resolve(image); };
          image.onerror = reject;
          image.src = objectUrl;
        });
      }
      const maxSide = 2400;
      const sourceWidth = Number(source.width || source.videoWidth || 0);
      const sourceHeight = Number(source.height || source.videoHeight || 0);
      if (!sourceWidth || !sourceHeight) return "";
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
      return normalizeQrValue(result && result.data);
    } catch (error) {
      return "";
    } finally {
      if (source && typeof source.close === "function") source.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function resolveQrValue(value) {
    const qrValue = normalizeQrValue(value);
    if (!qrValue) return null;
    try {
      const response = await fetch(apiBase + "/api/service-documents/resolve-qr", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ value: qrValue }),
        cache: "no-store"
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) return { qrValue: qrValue, qrUrl: normalizeQrUrl(qrValue), error: data.error || "Δεν ήταν δυνατή η ανάγνωση της ηλεκτρονικής σελίδας." };
      return data;
    } catch (error) {
      return { qrValue: qrValue, qrUrl: normalizeQrUrl(qrValue), error: "Δεν ήταν δυνατή η επικοινωνία με την ηλεκτρονική σελίδα." };
    }
  }

  async function importQrDocument(bikeId, entryId, value) {
    const qrValue = normalizeQrValue(value);
    if (!qrValue) return null;
    try {
      const response = await fetch(apiBase + "/api/service-documents/import-qr", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ bikeId: String(bikeId), entryId: String(entryId), value: qrValue }),
        cache: "no-store"
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "Δεν ήταν δυνατή η άντληση του τιμολογίου από το QR.");
      return data;
    } catch (error) {
      return { ok: false, qrValue: qrValue, qrUrl: normalizeQrUrl(qrValue), error: error && error.message ? error.message : "Δεν ήταν δυνατή η άντληση του τιμολογίου από το QR." };
    }
  }

  function updateQrProcessingLocal(bikeId, entryId, state) {
    const bike = getBike(bikeId);
    const entry = getHistoryEntry(bike, entryId);
    if (!bike || !entry) return;
    const current = normalizeInvoiceData(entry.invoiceData) || {};
    const rawProgress = Number(state && state.progress);
    const storedProgress = Number(current.qrProcessingProgress);
    const safeProgress = Number.isFinite(rawProgress) ? rawProgress : Number.isFinite(storedProgress) ? storedProgress : 5;
    const next = Object.assign({}, current, {
      qrJobId: String(state && (state.jobId || state.id) || current.qrJobId || ""),
      qrProcessingStatus: String(state && state.status || "processing"),
      qrProcessingStartedAt: String(state && state.startedAt || current.qrProcessingStartedAt || new Date().toISOString()),
      qrProcessingUpdatedAt: new Date().toISOString(),
      qrProcessingError: String(state && (state.error || state.message) || ""),
      qrProcessingAttempts: String(Number(state && state.attempts || current.qrProcessingAttempts || 0)),
      qrProcessingProgress: String(Math.max(0, Math.min(100, safeProgress))),
      qrProcessingStage: String(state && (state.stage || state.progressStage) || current.qrProcessingStage || "Σε επεξεργασία από τον Server")
    });
    if (state && state.qrUrl && !next.qrUrl) next.qrUrl = normalizeQrUrl(state.qrUrl);
    entry.invoiceData = normalizeInvoiceData(next);
    entry.updatedAt = new Date().toISOString();
    bike.updatedAt = entry.updatedAt;
    saveBikes(false);
    if (activeBikeId && String(activeBikeId) === String(bikeId) && elements.detailHistory) renderDetail();
  }

  async function waitForQrDocumentJob(jobId, bikeId, entryId) {
    if (!jobId) return { status: "error", error: "Δεν βρέθηκε αναγνωριστικό εργασίας QR." };
    const attempts = 42;
    let latest = { status: "processing", jobId: jobId, progress: 5, stage: "Σε επεξεργασία από τον Server", attempts: 0 };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise(function (resolve) { setTimeout(resolve, 3000); });
      try {
        const response = await fetch(apiBase + "/api/service-documents/jobs/" + encodeURIComponent(jobId), {
          headers: requestHeaders(true), cache: "no-store"
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          latest = { status: "delayed", jobId: jobId, progress: latest.progress, stage: "Δεν απαντά ο Server · θα ξαναδοκιμάσει", error: "Δεν ήταν δυνατή η ενημέρωση της εργασίας." };
          updateQrProcessingLocal(bikeId, entryId, latest);
          continue;
        }
        latest = Object.assign({ jobId: jobId }, data);
        updateQrProcessingLocal(bikeId, entryId, latest);
        if (data.status === "completed" && data.attachment) {
          const attachment = data.attachment;
          attachment.qrValue = attachment.qrValue || data.qrValue || "";
          attachment.qrUrl = attachment.qrUrl || data.qrUrl || normalizeQrUrl(attachment.qrValue);
          attachment.qrData = data.extracted || attachment.ocr || null;
          return { status: "completed", jobId: jobId, attachment: attachment, progress: 100, stage: "Ολοκληρώθηκε", attempts: data.attempts || 0 };
        }
        if (data.status === "error") return latest;
      } catch (error) {
        // The service is already saved. A later normal sync can still deliver
        // the attachment if the temporary status request is interrupted.
      }
    }
    latest.status = latest.status === "error" ? "error" : "delayed";
    latest.stage = latest.stage || "Καθυστέρηση · άνοιξε την καρτέλα για επανάληψη";
    latest.error = latest.error || "Η επεξεργασία διαρκεί περισσότερο από το αναμενόμενο.";
    updateQrProcessingLocal(bikeId, entryId, latest);
    return latest;
  }

  async function uploadServiceDocument(bikeId, entryId, file, qrOverride) {
    if (!file) return null;
    const qrValue = normalizeQrValue(qrOverride) || await readQrFromFile(file);
    const body = new FormData();
    body.append("bikeId", String(bikeId));
    body.append("entryId", String(entryId));
    if (qrValue) body.append("qrValue", qrValue);
    body.append("file", file, file.name || "invoice");
    const headers = {};
    if (webToken) headers.Authorization = "Bearer " + webToken;
    const response = await fetch(apiBase + "/api/service-documents", {
      method: "POST", headers: headers, body: body, cache: "no-store"
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Η επισύναψη του τιμολογίου απέτυχε.");
    const attachment = data.attachment || null;
    if (!attachment) return null;
    if (qrValue) {
      attachment.qrValue = qrValue;
      attachment.qrUrl = normalizeQrUrl(qrValue);
      const qrResult = await resolveQrValue(qrValue);
      if (qrResult) {
        attachment.qrUrl = qrResult.qrUrl || attachment.qrUrl;
        attachment.qrData = qrResult.extracted || null;
        attachment.qrError = qrResult.error || "";
      }
    }
    if (attachment.contentType === "application/pdf" || (attachment.contentType && attachment.contentType.indexOf("image/") === 0)) {
      try {
        const ocrResponse = await fetch(apiBase + "/api/service-documents/ocr", { method: "POST", headers: { "Content-Type": "application/json", ...(webToken ? { Authorization: "Bearer " + webToken } : {}) }, body: JSON.stringify({ key: attachment.key }), cache: "no-store" });
        const ocr = await ocrResponse.json().catch(function () { return {}; });
        if (ocrResponse.ok && ocr.extracted) attachment.ocr = ocr.extracted;
        if (ocr.error) attachment.ocrError = ocr.error;
      } catch (error) {
        attachment.ocrError = "Δεν ολοκληρώθηκε η ανάγνωση OCR.";
      }
    }
    return attachment;
  }

  async function attachInvoiceToEntry(bikeId, entryId, file, qrValue, options) {
    options = options || {};
    let attachment = null;
    let qrFallbackMessage = "";
    let queuedQrJob = null;
    const normalizedQr = normalizeQrValue(qrValue);
    const localBike = getBike(bikeId);
    const localEntry = getHistoryEntry(localBike, entryId);
    if (normalizedQr && localBike && localEntry) {
      const qrUrl = normalizeQrUrl(normalizedQr);
      if (qrUrl) {
        localEntry.invoiceData = mergeInvoiceData({ qrUrl: qrUrl, source: "qr" }, localEntry.invoiceData);
        localEntry.updatedAt = new Date().toISOString();
        localBike.updatedAt = localEntry.updatedAt;
        saveBikes(false);
      }
    }
    if (normalizedQr && !(file && options.preferFile)) {
      const imported = await importQrDocument(bikeId, entryId, normalizedQr);
      if (imported && imported.attachment) {
        attachment = imported.attachment;
        attachment.qrValue = imported.qrValue || normalizedQr;
        attachment.qrUrl = imported.qrUrl || normalizeQrUrl(normalizedQr);
        attachment.qrData = imported.extracted || null;
        attachment.ocrError = imported.extractionError || "";
        if (imported.extracted && !attachment.ocr) attachment.ocr = imported.extracted;
        ensureAttachmentQr(attachment, normalizedQr);
      } else if (imported && imported.queued && imported.jobId) {
        queuedQrJob = imported.jobId;
        updateQrProcessingLocal(bikeId, entryId, {
          jobId: imported.jobId,
          status: "processing",
          progress: imported.progress || 5,
          stage: imported.stage || "QR αποθηκεύτηκε · αναμονή Server",
          qrUrl: imported.qrUrl || normalizeQrUrl(normalizedQr)
        });
        showToast("Το QR στάλθηκε στον Server για δημιουργία PDF…");
      } else {
        qrFallbackMessage = imported && imported.error
          ? imported.error
          : "Δεν βρέθηκε διαθέσιμο PDF από το QR.";
      }
    }
    if (!attachment && file) {
      attachment = await uploadServiceDocument(bikeId, entryId, file, normalizedQr);
      ensureAttachmentQr(attachment, normalizedQr);
      if (qrFallbackMessage) showToast("Το QR δεν έδωσε αρχείο. Χρησιμοποιήθηκε η φωτογραφία/PDF.");
    }
    if (!attachment && queuedQrJob && !file) {
      if (options.deferQrCompletion) {
        return { queued: true, jobId: queuedQrJob, status: "processing", qrValue: normalizedQr, qrUrl: normalizeQrUrl(normalizedQr) };
      }
      // The service form has already closed. Poll in this background task so
      // the local history is enriched as soon as the Server finishes the PDF.
      const jobResult = await waitForQrDocumentJob(queuedQrJob, bikeId, entryId);
      if (jobResult && jobResult.attachment) {
        attachment = jobResult.attachment;
        ensureAttachmentQr(attachment, normalizedQr);
      } else {
        const delayed = jobResult || { status: "delayed", jobId: queuedQrJob, progress: 5, stage: "Ο Server συνεχίζει στο παρασκήνιο" };
        showToast(delayed.status === "error" ? "Η επεξεργασία του QR απέτυχε. Υπάρχει κουμπί επανάληψης στο ιστορικό." : "Το QR αποθηκεύτηκε. Ο Server συνεχίζει στο παρασκήνιο.");
        return { queued: true, jobId: queuedQrJob, status: delayed.status, error: delayed.error || "", progress: delayed.progress || 5, stage: delayed.stage || "Σε επεξεργασία", qrValue: normalizedQr, qrUrl: normalizeQrUrl(normalizedQr) };
      }
    }
    if (!attachment) {
      if (qrFallbackMessage) throw new Error(qrFallbackMessage);
      return null;
    }
    const latestBike = getBike(bikeId);
    const latestEntry = getHistoryEntry(latestBike, entryId);
    if (!latestBike || !latestEntry) throw new Error("Το service δεν βρέθηκε μετά τον συγχρονισμό.");
    const reviewData = options.background
      ? invoiceDataFromAttachment(attachment)
      : await reviewInvoiceAttachment(attachment, latestBike, latestEntry);
    if (reviewData) applyInvoiceReviewToEntry(latestBike, latestEntry, attachment, reviewData);
    latestEntry.invoiceData = normalizeInvoiceData(Object.assign({}, latestEntry.invoiceData || {}, {
      qrJobId: queuedQrJob || (attachment && attachment.renderJobId) || "",
      qrProcessingStatus: "completed",
      qrProcessingProgress: "100",
      qrProcessingStage: "Ολοκληρώθηκε",
      qrProcessingError: "",
      qrProcessingUpdatedAt: new Date().toISOString()
    }));
    const existingAttachments = Array.isArray(latestEntry.attachments)
      ? latestEntry.attachments.filter(function (item) { return String(item.key) !== String(attachment.key); })
      : [];
    latestEntry.attachments = existingAttachments.concat([attachment]);
    latestEntry.updatedAt = new Date().toISOString();
    latestBike.updatedAt = latestEntry.updatedAt;
    saveBikes();
    return attachment;
  }

  async function attachInvoicesToEntry(bikeId, entryId, files, qrValue, options) {
    files = Array.from(files || []);
    options = options || {};
    const entry = getHistoryEntry(getBike(bikeId), entryId);
    const selectionError = invoiceSelectionError(entry, files, qrValue);
    if (selectionError) throw new Error(selectionError);
    const items = files.length ? files.map(function (file, index) {
      return { file: file, qrValue: index === 0 ? qrValue : "" };
    }) : normalizeQrValue(qrValue) ? [{ file: null, qrValue: qrValue }] : [];
    const result = { total: items.length, attachments: [], queued: [], failures: [] };
    for (const item of items) {
      try {
        const attachment = await attachInvoiceToEntry(bikeId, entryId, item.file, item.qrValue, Object.assign({}, options, { preferFile: Boolean(item.file) }));
        if (!attachment) throw new Error("Δεν αποθηκεύτηκε το τιμολόγιο.");
        if (attachment.queued) result.queued.push(attachment);
        else result.attachments.push(attachment);
      } catch (error) {
        result.failures.push({ file: item.file, qrValue: item.qrValue, name: item.file && item.file.name || "QR", error: error && error.message || "Η προσθήκη απέτυχε." });
      }
    }
    return result;
  }

  function invoiceBatchMessage(result) {
    const saved = result.attachments.length;
    if (result.failures.length) return "Προστέθηκαν " + saved + " από " + result.total + " τιμολόγια. Απέτυχε: " + result.failures.map(function (item) { return item.name; }).join(", ") + ". " + result.failures[0].error;
    if (result.queued.length) return "Το QR στάλθηκε στον Server. Η επεξεργασία συνεχίζεται στο παρασκήνιο.";
    return saved === 1 ? "Το τιμολόγιο προστέθηκε στο service." : "Προστέθηκαν " + saved + " τιμολόγια στο service.";
  }

  async function retryQrDocumentJob(bikeId, entryId, jobId) {
    if (!jobId) return;
    updateQrProcessingLocal(bikeId, entryId, { jobId: jobId, status: "processing", progress: 5, stage: "Επανάληψη · αναμονή Server", error: "" });
    try {
      const response = await fetch(apiBase + "/api/service-documents/jobs/" + encodeURIComponent(jobId) + "/retry", {
        method: "POST", headers: requestHeaders(true), body: JSON.stringify({}), cache: "no-store"
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "Δεν ήταν δυνατή η επανάληψη του QR.");
      updateQrProcessingLocal(bikeId, entryId, data);
      const result = await waitForQrDocumentJob(jobId, bikeId, entryId);
      if (!result || !result.attachment) {
        showToast(result && result.status === "error" ? "Η επανάληψη απέτυχε. Δες το σφάλμα στο ιστορικό." : "Η επανάληψη συνεχίζεται στο παρασκήνιο.");
        return;
      }
      const bike = getBike(bikeId);
      const entry = getHistoryEntry(bike, entryId);
      if (!bike || !entry) throw new Error("Το service δεν βρέθηκε.");
      const attachment = result.attachment;
      ensureAttachmentQr(attachment, attachment.qrValue || attachment.qrUrl);
      const dataFromAttachment = invoiceDataFromAttachment(attachment);
      if (dataFromAttachment) applyInvoiceReviewToEntry(bike, entry, attachment, dataFromAttachment);
      entry.invoiceData = normalizeInvoiceData(Object.assign({}, entry.invoiceData || {}, { qrJobId: jobId, qrProcessingStatus: "completed", qrProcessingProgress: "100", qrProcessingStage: "Ολοκληρώθηκε", qrProcessingError: "", qrProcessingUpdatedAt: new Date().toISOString() }));
      entry.attachments = (Array.isArray(entry.attachments) ? entry.attachments.filter(function (file) { return String(file.key) !== String(attachment.key); }) : []).concat([attachment]).slice(-10);
      entry.updatedAt = new Date().toISOString();
      bike.updatedAt = entry.updatedAt;
      saveBikes();
      showToast("Το PDF του τιμολογίου δημιουργήθηκε και προστέθηκε στο service.");
    } catch (error) {
      updateQrProcessingLocal(bikeId, entryId, { jobId: jobId, status: "error", progress: 5, stage: "Αποτυχία · χρειάζεται επανάληψη", error: error && error.message ? error.message : "Η επανάληψη απέτυχε." });
      showToast(error && error.message ? error.message : "Η επανάληψη απέτυχε.");
    }
  }

  function invoiceReviewPayload(attachment) {
    const data = invoiceDataFromAttachment(attachment) || {};
    return {
      ...data,
      supplier: String(data.supplier || "").trim(),
      invoiceNumber: String(data.invoiceNumber || "").trim(),
      invoiceDate: String(data.invoiceDate || "").trim(),
      mark: String(data.mark || "").trim(),
      plate: String(data.plate || "").trim(),
      odometerKm: String(data.odometerKm || "").trim(),
      totalAmount: String(data.totalAmount || "").trim(),
      workPerformed: String(data.workPerformed || "").trim(),
      comments: String(data.comments || data.notes || "").trim(),
      laborAmount: String(data.laborAmount || "").trim(),
      vatAmount: String(data.vatAmount || "").trim(),
      parts: Array.isArray(data.parts) ? data.parts.slice() : [],
      rawText: String(data.rawText || "").trim(),
      source: String(data.source || (attachment.qrUrl ? "qr+ocr" : "ocr")),
      qrUrl: String(attachment.qrUrl || data.qrUrl || "").trim()
    };
  }

  function reviewInvoiceAttachment(attachment, bike, entry) {
    const initial = invoiceReviewPayload(attachment);
    const hasData = Object.keys(initial).some(function (key) { return !["source", "qrUrl", "parts", "rawText"].includes(key) && String(initial[key] || "").trim(); }) || initial.rawText;
    if (!hasData && !initial.qrUrl) return Promise.resolve(null);
    if (elements.serviceDialog.open) elements.serviceDialog.close();
    if (elements.historyEntryDialog.open) elements.historyEntryDialog.close();
    elements.invoiceReviewContext.textContent = (bike ? bike.name : "Το service") + " · " + (attachment.name || "τιμολόγιο");
    elements.invoiceReviewSource.textContent = initial.qrUrl
      ? "Βρέθηκε QR και ηλεκτρονική σελίδα τιμολογίου. Έλεγξε τα στοιχεία πριν αποθηκευτούν."
      : "Τα στοιχεία διαβάστηκαν από το αρχείο. Έλεγξε τα πριν αποθηκευτούν.";
    elements.invoiceReviewPlate.value = initial.plate;
    elements.invoiceReviewOdometerKm.value = initial.odometerKm;
    elements.invoiceReviewSupplier.value = initial.supplier;
    elements.invoiceReviewNumber.value = initial.invoiceNumber;
    elements.invoiceReviewDate.value = initial.invoiceDate;
    elements.invoiceReviewTotal.value = initial.totalAmount;
    elements.invoiceReviewWorkPerformed.value = invoiceWorkItems(initial).join("\n");
    elements.invoiceReviewComments.value = initial.comments;
    elements.invoiceReviewRawText.textContent = initial.rawText || "Δεν επιστράφηκε πλήρες κείμενο.";
    elements.invoiceReviewRawDetails.classList.toggle("is-hidden", !initial.rawText);
    const warning = invoiceWarnings(bike, entry, initial).map(function (item) { return "⚠ " + item; }).join("\n");
    elements.invoiceReviewMismatch.textContent = warning;
    elements.invoiceReviewMismatch.classList.toggle("is-hidden", !warning);
    elements.invoiceReviewError.textContent = attachment.ocrError || attachment.qrError || "";
    elements.invoiceReviewDialog.showModal();
    return new Promise(function (resolve) {
      let settled = false;
      const finish = function (accepted) {
        if (settled) return;
        settled = true;
        if (elements.invoiceReviewDialog.open) elements.invoiceReviewDialog.close();
        elements.invoiceReviewForm.removeEventListener("submit", onSubmit);
        elements.invoiceReviewKeepFileButton.removeEventListener("click", onKeep);
        elements.invoiceReviewDialog.removeEventListener("cancel", onCancel);
        elements.invoiceReviewDialog.removeEventListener("close", onClose);
        if (!accepted) return resolve(null);
        const result = {
          ...initial,
          correctedByUserAt: new Date().toISOString(),
          supplier: elements.invoiceReviewSupplier.value.trim(),
          invoiceNumber: elements.invoiceReviewNumber.value.trim(),
          invoiceDate: elements.invoiceReviewDate.value.trim(),
          mark: initial.mark,
          plate: elements.invoiceReviewPlate.value.trim(),
          odometerKm: elements.invoiceReviewOdometerKm.value.trim(),
          totalAmount: elements.invoiceReviewTotal.value.trim(),
          workPerformed: elements.invoiceReviewWorkPerformed.value.trim(),
          lineItems: elements.invoiceReviewWorkPerformed.value.split(/\r?\n/).map(function (item) { return item.trim(); }).filter(Boolean),
          comments: elements.invoiceReviewComments.value.trim(),
          laborAmount: initial.laborAmount,
          vatAmount: initial.vatAmount,
          parts: initial.parts,
          rawText: initial.rawText,
          source: initial.source,
          qrUrl: initial.qrUrl,
          confirmedAt: new Date().toISOString()
        };
        resolve(Object.assign(normalizeInvoiceData(result), { applyServiceKmCorrection: Boolean(initial.serviceKmAfterCorrection) }));
      };
      const onSubmit = function (event) {
        event.preventDefault();
        delete initial.serviceKmBeforeCorrection;
        delete initial.serviceKmAfterCorrection;
        const nextKm = parseInvoiceKm(elements.invoiceReviewOdometerKm.value);
        if (nextKm > 2000000000) { elements.invoiceReviewError.textContent = "Γράψε σωστά τα χιλιόμετρα."; return; }
        if (nextKm && nextKm !== Number(entry.km)) {
          if (!window.confirm("Να διορθωθούν τα χιλιόμετρα του service από " + formatKm(entry.km) + " σε " + formatKm(nextKm) + ";")) return;
          initial.serviceKmBeforeCorrection = String(entry.km);
          initial.serviceKmAfterCorrection = String(nextKm);
        }
        if (elements.invoiceReviewPlate.value && invoicePlateKey(elements.invoiceReviewPlate.value) !== invoicePlateKey(bike.name)) {
          if (!window.confirm("Η πινακίδα διαφέρει. Να κρατηθεί το τιμολόγιο στο " + bike.name + ";")) return;
          initial.plateResolution = "kept-current";
          initial.plateResolutionBikeId = String(bike.id);
          initial.plateResolutionPlate = invoicePlateKey(bike.name);
          initial.plateResolutionRead = invoicePlateKey(elements.invoiceReviewPlate.value);
        }
        finish(true);
      };
      const onKeep = function () { finish(false); };
      const onCancel = function (event) { event.preventDefault(); finish(false); };
      const onClose = function () { finish(false); };
      elements.invoiceReviewForm.addEventListener("submit", onSubmit);
      elements.invoiceReviewKeepFileButton.addEventListener("click", onKeep);
      elements.invoiceReviewDialog.addEventListener("cancel", onCancel);
      elements.invoiceReviewDialog.addEventListener("close", onClose);
    });
  }

  async function reviewStoredServiceDocument(entryId, key) {
    const bike = getBike(activeBikeId);
    const entry = getHistoryEntry(bike, entryId);
    const attachment = entry && Array.isArray(entry.attachments)
      ? entry.attachments.find(function (file) { return String(file.key) === String(key); })
      : null;
    if (!bike || !entry || !attachment) return;
    const reviewData = await reviewInvoiceAttachment(attachment, bike, entry);
    if (!reviewData) return;
    applyInvoiceReviewToEntry(bike, entry, attachment, reviewData);
    saveBikes();
    renderDetail();
    showToast("Τα στοιχεία του τιμολογίου αποθηκεύτηκαν στο service.");
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const value = String(reader.result || "");
        resolve(value.indexOf(",") >= 0 ? value.slice(value.indexOf(",") + 1) : value);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function openServiceDocument(attachment) {
    if (!attachment || !attachment.key) return;
    try {
      const headers = webToken ? { Authorization: "Bearer " + webToken } : {};
      const response = await fetch(apiBase + "/api/service-documents/" + attachment.key.split("/").map(encodeURIComponent).join("/"), { headers: headers, cache: "no-store" });
      if (!response.ok) throw new Error("Το τιμολόγιο δεν είναι διαθέσιμο.");
      const blob = await response.blob();
      if (window.AndroidFleet && typeof window.AndroidFleet.openPdf === "function") {
        window.AndroidFleet.openPdf(await blobToBase64(blob), attachment.name || "τιμολόγιο.pdf");
        return;
      }
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (error) { showToast(error.message || "Δεν ήταν δυνατή η προβολή του τιμολογίου."); }
  }

  async function downloadServiceDocument(attachment) {
    if (!attachment || !attachment.key) return;
    try {
      const headers = webToken ? { Authorization: "Bearer " + webToken } : {};
      const response = await fetch(apiBase + "/api/service-documents/" + attachment.key.split("/").map(encodeURIComponent).join("/"), { headers: headers, cache: "no-store" });
      if (!response.ok) throw new Error("Το τιμολόγιο δεν είναι διαθέσιμο.");
      const blob = await response.blob();
      if (window.AndroidFleet && typeof window.AndroidFleet.savePdf === "function") {
        window.AndroidFleet.savePdf(await blobToBase64(blob), attachment.name || "τιμολόγιο.pdf");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.name || "τιμολόγιο";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (error) { showToast(error.message || "Δεν ήταν δυνατή η λήψη του τιμολογίου."); }
  }

  async function deleteServiceDocument(entryId, key) {
    const bike = getBike(activeBikeId);
    const entry = getHistoryEntry(bike, entryId);
    if (!bike || !entry || !key || !canManageHistory() || navigator.onLine === false) {
      if (navigator.onLine === false) showToast("Η διαγραφή τιμολογίου απαιτεί σύνδεση.");
      return;
    }
    const attachment = Array.isArray(entry.attachments)
      ? entry.attachments.find(function (file) { return String(file.key) === String(key); })
      : null;
    if (!attachment) return;
    if (!window.confirm("Να διαγραφεί οριστικά το τιμολόγιο «" + attachment.name + "» από το ιδιωτικό R2;")) return;
    const button = Array.from(elements.detailHistory.querySelectorAll("[data-delete-document]"))
      .find(function (candidate) { return candidate.dataset.deleteDocument === key; });
    if (button) button.disabled = true;
    try {
      const response = await fetch(apiBase + "/api/service-documents", {
        method: "DELETE",
        headers: requestHeaders(true),
        body: JSON.stringify({ bikeId: bike.id, entryId: entry.id, key: key }),
        cache: "no-store"
      });
      const data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "Η διαγραφή του τιμολογίου απέτυχε.");
      if (data.bike) replaceCorrectedBike(data.bike);
      showToast("Το τιμολόγιο διαγράφηκε οριστικά.");
    } catch (error) {
      if (button) button.disabled = false;
      showToast(error && error.message ? error.message : "Η διαγραφή του τιμολογίου απέτυχε.");
    }
  }

  function replaceCorrectedBike(value) {
    const normalized = normalizeBike(value);
    const index = bikes.findIndex(function (bike) { return bike.id === normalized.id; });
    if (index >= 0) bikes[index] = normalized;
    persistBikes();
    renderHome();
    renderDetail();
  }

  function mergeBackgroundBike(value) {
    const incoming = normalizeBike(value);
    if (!incoming) throw new Error("Δεν επιστράφηκε η ενημερωμένη μηχανή.");
    const index = bikes.findIndex(function (bike) { return bike.id === incoming.id; });
    if (index >= 0) bikes[index] = mergeBikeRecords(bikes[index], incoming);
    else bikes.push(incoming);
    persistBikes();
    renderHome();
    if (activeBikeId) renderDetail();
  }

  function backgroundHistorySaveMarkup(bikeId, entryId) {
    return Array.from(backgroundHistorySaves.values()).filter(function (job) {
      return job.bikeId === bikeId && job.entryId === entryId;
    }).map(function (job) {
      if (job.status === "error") return '<div class="history-invoice-warning" role="alert">Η αποθήκευση δεν ολοκληρώθηκε: ' + escapeHtml(job.error) + ' <button type="button" class="document-retry-button" data-retry-service-save="' + escapeHtml(job.id) + '">Επανάληψη</button></div>';
      return '<div class="history-invoice-warning" role="status">' + (job.saved ? "Αποστολή τιμολογίων / QR στο παρασκήνιο…" : "Αποθήκευση αλλαγών στο παρασκήνιο…") + '</div>';
    }).join("");
  }

  function enqueueHistoryEntrySave(job) {
    job.status = "queued";
    backgroundHistorySaves.set(job.id, job);
    if (activeBikeId) renderDetail();
    historyEntrySaveQueue = historyEntrySaveQueue.catch(function () {}).then(function () {
      return runBackgroundHistorySave(job);
    });
  }

  async function runBackgroundHistorySave(job) {
    job.status = "running";
    try {
      if (!job.saved) {
        const result = await remoteHistoryAction(job.bikeId, job.entryId, "edit", job.payload);
        mergeBackgroundBike(result.bike);
        job.saved = true;
      }
      let invoiceResult = null;
      if (job.files.length || normalizeQrValue(job.qrValue)) {
        invoiceResult = await attachInvoicesToEntry(job.bikeId, job.entryId, job.files, job.qrValue, { background: true, deferQrCompletion: true });
        if (invoiceResult.failures.length) {
          job.files = invoiceResult.failures.filter(function (item) { return item.file; }).map(function (item) { return item.file; });
          job.qrValue = invoiceResult.failures.find(function (item) { return item.qrValue; })?.qrValue || "";
          throw new Error(invoiceBatchMessage(invoiceResult));
        }
      }
      backgroundHistorySaves.delete(job.id);
      showToast(job.label + " · " + (invoiceResult ? invoiceBatchMessage(invoiceResult) : "Οι αλλαγές αποθηκεύτηκαν."));
    } catch (error) {
      job.status = "error";
      job.error = error && error.message || "Η αποθήκευση απέτυχε.";
      showToast(job.label + " · " + job.error + " Μπορείς να πατήσεις Επανάληψη στο ιστορικό.");
    } finally {
      renderHome();
      if (activeBikeId) renderDetail();
    }
  }

  async function handleHistoryEntrySubmit(event) {
    event.preventDefault();
    const bike = getBike(elements.historyEntryBikeId.value);
    const entry = getHistoryEntry(bike, elements.historyEntryId.value);
    if (!bike || !entry || !canManageHistory()) return;
    const km = Math.round(Number(elements.historyEntryKm.value));
    const date = elements.historyEntryDate.value;
    const isService = entry.type === "service";
    const selected = isService ? Array.from(elements.historyEntryTaskInputs).filter(function (input) { return input.checked; }).map(function (input) { return input.value; }) : [];
    const custom = isService ? elements.historyEntryNotes.value.split(/\r?\n/).map(function (task) { return task.trim(); }).filter(Boolean) : [];
    let tasks = Array.from(new Set(selected.concat(custom))).slice(0, 30);
    if (isService) {
      tasks = elements.historyEntryOilChanged.checked
        ? ["Αλλαγή λαδιών"].concat(tasks.filter(function (task) { return task !== "Αλλαγή λαδιών"; })).slice(0, 30)
        : tasks.filter(function (task) { return task !== "Αλλαγή λαδιών"; });
      tasks = elements.historyEntryMajorService.checked
        ? ["Μεγάλο service"].concat(tasks.filter(function (task) { return task !== "Μεγάλο service"; })).slice(0, 30)
        : tasks.filter(function (task) { return task !== "Μεγάλο service"; });
    }
    elements.historyEntryError.textContent = "";
    if (!Number.isFinite(km) || km < 0 || elements.historyEntryKm.value === "") {
      elements.historyEntryError.textContent = "Γράψε σωστά τα χιλιόμετρα.";
      return elements.historyEntryKm.focus();
    }
    if (!date) {
      elements.historyEntryError.textContent = "Διάλεξε ημερομηνία.";
      return elements.historyEntryDate.focus();
    }
    if (isService && !tasks.length) {
      elements.historyEntryError.textContent = "Διάλεξε ή γράψε τουλάχιστον μία εργασία.";
      return;
    }
    const invoiceFiles = isService ? selectedInvoiceFiles(elements.historyEntryInvoiceFile) : [];
    const invoiceQrValue = isService && elements.historyEntryInvoiceQrValue ? elements.historyEntryInvoiceQrValue.value : "";
    const selectionError = invoiceSelectionError(entry, invoiceFiles, invoiceQrValue);
    if (selectionError) {
      elements.historyEntryError.textContent = selectionError;
      return;
    }
    const payload = {
      km: km, date: date, tasks: tasks,
      workshop: isService ? elements.historyEntryWorkshop.value.trim().slice(0, 120) : "",
      cost: isService ? elements.historyEntryCost.value.trim().slice(0, 60) : "",
      oilChanged: isService && elements.historyEntryOilChanged.checked,
      majorService: isService && elements.historyEntryMajorService.checked,
      reason: elements.historyEntryReason.value.trim().slice(0, 500)
    };
    if (navigator.onLine === false) {
      localHistoryEdit(bike, entry.id, payload);
      saveBikes();
      elements.historyEntryDialog.close();
      renderHome();
      if (activeBikeId) renderDetail();
      showToast("Η διόρθωση αποθηκεύτηκε και θα συγχρονιστεί.");
      return;
    }
    const job = { id: uid(), bikeId: bike.id, entryId: entry.id, payload: payload, files: invoiceFiles.slice(), qrValue: String(invoiceQrValue || ""), saved: false, label: bike.name + " · " + formatDate(date) };
    elements.historyEntryDialog.close();
    showToast("Οι αλλαγές αποθηκεύονται στο παρασκήνιο. Μπορείς να συνεχίσεις στο επόμενο service.");
    enqueueHistoryEntrySave(job);
  }

  async function deleteHistoryEntry(entryId) {
    const bike = getBike(activeBikeId);
    const entry = getHistoryEntry(bike, entryId);
    if (!bike || !entry || !canManageHistory() || String(entry.id).startsWith("shift-")) return;
    if (navigator.onLine === false) {
      elements.historyEntryError.textContent = "Η ασφαλής διαγραφή απαιτεί σύνδεση, ώστε να αποθηκευτεί στον Κάδο ανακύκλωσης.";
      return;
    }
    const entryLabel = entry.type === "service" ? "το σέρβις" : "τον έλεγχο χιλιομέτρων";
    if (!window.confirm("Να μεταφερθεί " + entryLabel + " στα " + formatKm(entry.km) + " στον Κάδο ανακύκλωσης;")) return;
    elements.historyEntryError.textContent = "";
    elements.historyEntrySaveButton.disabled = true;
    elements.historyEntryDeleteButton.disabled = true;
    try {
      const result = await remoteHistoryAction(bike.id, entry.id, "delete", {
        confirmDelete: true,
        reason: elements.historyEntryReason.value.trim().slice(0, 500)
      });
      replaceCorrectedBike(result.bike);
      if (elements.historyEntryDialog.open) elements.historyEntryDialog.close();
      showToast("Η καταχώρηση μεταφέρθηκε στον Κάδο ανακύκλωσης.");
    } catch (error) {
      elements.historyEntryError.textContent = error && error.message ? error.message : "Η διαγραφή δεν ολοκληρώθηκε.";
      if (!elements.historyEntryDialog.open) showToast(elements.historyEntryError.textContent);
    } finally {
      elements.historyEntrySaveButton.disabled = false;
      elements.historyEntryDeleteButton.disabled = false;
    }
  }

  function updateMileage(bike, km, date) {
    const now = new Date().toISOString();
    bike.currentKm = Math.max(Number(bike.currentKm) || 0, km);
    bike.lastCheckedAt = date;
    bike.updatedAt = now;
    bike.history = Array.isArray(bike.history) ? bike.history : [];
    bike.history.unshift({
      id: uid(),
      type: "check",
      km: km,
      date: date,
      notes: "",
      tasks: [],
      workshop: "",
      oilChanged: false,
      majorService: false,
      majorServiceMilestoneKm: 0,
      createdAt: now,
      updatedAt: now
    });
    refreshMajorTracking(bike);
    saveBikes();
    const status = getStatus(bike);
    status.majorPlan = getMajorServicePlan(bike);
    return status;
  }

  function showCheckResult(bike, status) {
    const majorCopy = status.majorPlan && majorNeedsAttention(bike)
      ? "<small class=\"check-major-note\">" + escapeHtml(status.majorPlan.label + ": " + status.majorPlan.message) + "</small>"
      : "";
    elements.quickCheckResult.className = "check-result " + status.key;
    elements.quickCheckResult.innerHTML =
      "<div><strong>" + escapeHtml(bike.name) + " — " + escapeHtml(status.label) +
      "</strong><span>" + escapeHtml(status.message) + "</span>" + majorCopy + "</div>";
  }

  function handleQuickCheck(event) {
    event.preventDefault();
    elements.quickCheckError.textContent = "";
    elements.quickCheckResult.classList.add("is-hidden");

    const bike = getBike(elements.quickBikeSelect.value);
    const km = Math.round(Number(elements.quickCurrentKm.value));
    if (!bike) {
      elements.quickCheckError.textContent = "Διάλεξε ποιο μηχανάκι έλεγξες.";
      elements.quickBikePicker.focus();
      return;
    }
    if (!Number.isFinite(km) || km < 0 || elements.quickCurrentKm.value === "") {
      elements.quickCheckError.textContent = "Γράψε σωστά τα τωρινά χιλιόμετρα.";
      elements.quickCurrentKm.focus();
      return;
    }
    if (km < bike.lastServiceKm) {
      elements.quickCheckError.textContent = "Τα χιλιόμετρα δεν γίνεται να είναι λιγότερα από την τελευταία αλλαγή λαδιών.";
      elements.quickCurrentKm.focus();
      return;
    }

    const status = updateMileage(bike, km, today());
    renderHome();
    elements.quickBikeSelect.value = bike.id;
    elements.quickCurrentKm.value = bike.currentKm;
    showCheckResult(bike, status);
    showToast(status.key === "ok" ? "Ο έλεγχος αποθηκεύτηκε." : bike.name + ": " + status.message);
    if ((status.key !== "ok" || majorNeedsAttention(bike)) && window.AndroidFleet && typeof window.AndroidFleet.notifyService === "function") {
      const notificationMessage = majorNeedsAttention(bike)
        ? status.message + " " + status.majorPlan.message
        : status.message;
      window.AndroidFleet.notifyService(bike.name, notificationMessage, status.key === "ok" ? "soon" : status.key);
    }
  }

  function openConnectionSettings() {
    elements.connectionSettingsForm.reset();
    elements.connectionSettingsError.textContent = "";
    elements.serverTestResult.classList.add("is-hidden");
    elements.serverUrlInput.value = apiBase;
    elements.connectionSettingsDialog.showModal();
  }

  function normalizedServerUrl(value) {
    const url = String(value || "").trim().replace(/\/$/, "");
    if (!/^https:\/\/[^\s/]+(?:\/.*)?$/i.test(url)) throw new Error("Η διεύθυνση πρέπει να αρχίζει με https://");
    return url;
  }

  async function testServerUrl() {
    elements.connectionSettingsError.textContent = "";
    elements.serverTestResult.className = "check-result is-hidden";
    let candidate;
    try {
      candidate = normalizedServerUrl(elements.serverUrlInput.value);
    } catch (error) {
      elements.connectionSettingsError.textContent = error.message;
      return;
    }
    elements.testServerButton.disabled = true;
    elements.testServerButton.textContent = "Έλεγχος…";
    try {
      const response = await fetch(candidate + "/api/status", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Ο server δεν απάντησε.");
      elements.serverTestResult.className = "check-result " + (payload.serverOnline ? "ok" : "soon");
      elements.serverTestResult.innerHTML = "<div><strong>" +
        (payload.serverOnline ? "Ο server είναι συνδεδεμένος" : "Η web πύλη λειτουργεί") +
        "</strong><span>" +
        (payload.serverOnline ? "Η σύνδεση είναι έτοιμη." : "Το κινητό-server είναι προσωρινά εκτός σύνδεσης.") +
        "</span></div>";
    } catch (error) {
      elements.connectionSettingsError.textContent = error && error.message ? error.message : "Δεν ήταν δυνατή η σύνδεση.";
    } finally {
      elements.testServerButton.disabled = false;
      elements.testServerButton.textContent = "Έλεγχος σύνδεσης";
    }
  }

  function saveServerSettings(event) {
    event.preventDefault();
    try {
      apiBase = normalizedServerUrl(elements.serverUrlInput.value);
      localStorage.setItem(SERVER_URL_KEY, apiBase);
      elements.connectionSettingsDialog.close();
      showToast("Η διεύθυνση του server αποθηκεύτηκε.");
      syncNow();
    } catch (error) {
      elements.connectionSettingsError.textContent = error.message;
    }
  }

  async function requestServerBackup() {
    elements.connectionSettingsError.textContent = "";
    elements.requestBackupButton.disabled = true;
    elements.requestBackupButton.textContent = "Αποστολή…";
    try {
      const response = await fetch(apiBase + "/api/backup/request", {
        method: "POST",
        headers: requestHeaders(true),
        body: "{}",
        cache: "no-store"
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Το αίτημα backup απέτυχε.");
      showToast("Το αίτημα backup στάλθηκε στον server.");
    } catch (error) {
      elements.connectionSettingsError.textContent = error && error.message ? error.message : "Το αίτημα backup απέτυχε.";
    } finally {
      elements.requestBackupButton.disabled = false;
      elements.requestBackupButton.textContent = "Backup τώρα";
    }
  }

  async function importLegacyFleet() {
    const legacyBase = String(config.legacyApiBase || "").replace(/\/$/, "");
    if (!legacyBase) return;
    elements.connectionSettingsError.textContent = "";
    elements.legacyImportButton.disabled = true;
    elements.legacyImportButton.textContent = "Μεταφορά…";
    try {
      const response = await fetch(legacyBase + "/api/sync", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.bikes)) throw new Error("Δεν βρέθηκαν τα δεδομένα της παλιάς εφαρμογής.");
      bikes = mergeFleets(bikes, payload.bikes);
      saveBikes();
      renderHome();
      showToast("Η μεταφορά ολοκληρώθηκε: " + payload.bikes.length + " μηχανάκια.");
    } catch (error) {
      elements.connectionSettingsError.textContent = error && error.message ? error.message : "Η μεταφορά απέτυχε.";
    } finally {
      elements.legacyImportButton.disabled = false;
      elements.legacyImportButton.textContent = "Μεταφορά δεδομένων από την παλιά εφαρμογή";
    }
  }

  async function downloadLatestApk() {
    if (!webToken) return void returnToPortal(false);
    elements.downloadApkButton.disabled = true;
    try {
      const response = await fetch(apiBase + "/download/client.apk", {
        headers: { Authorization: "Bearer " + webToken },
        cache: "no-store"
      });
      if (!response.ok) {
        const payload = await response.json().catch(function () { return {}; });
        throw new Error(payload.error || "Η λήψη απέτυχε.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "Fleet_Control.apk";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    } catch (error) {
      showToast(error && error.message ? error.message : "Η λήψη απέτυχε.");
    } finally {
      elements.downloadApkButton.disabled = false;
    }
  }

  function openBikeDialog(bike) {
    elements.bikeForm.reset();
    elements.bikeFormError.textContent = "";
    elements.nextPreview.textContent = "—";
    if (bike) {
      elements.bikeDialogTitle.textContent = "Επεξεργασία μηχανής";
      elements.bikeId.value = bike.id;
      elements.bikeName.value = bike.name;
      elements.serviceInterval.value = bike.intervalKm;
      elements.lastServiceKm.value = bike.lastServiceKm;
      elements.nextPreview.textContent = formatKm(Number(bike.lastServiceKm) + Number(bike.intervalKm));
    } else {
      if (bikes.length >= MAX_BIKES) {
        showToast("Έχεις φτάσει το όριο των 40 μηχανών.");
        return;
      }
      elements.bikeDialogTitle.textContent = "Νέο μηχανάκι";
      elements.bikeId.value = "";
    }
    elements.bikeDialog.showModal();
    setTimeout(function () { elements.bikeName.focus(); }, 60);
  }

  function updateBikePreview() {
    const interval = Math.round(Number(elements.serviceInterval.value));
    const lastKm = Math.round(Number(elements.lastServiceKm.value));
    elements.nextPreview.textContent =
      interval > 0 && lastKm >= 0 && elements.lastServiceKm.value !== ""
        ? formatKm(lastKm + interval)
        : "—";
  }

  function handleBikeSubmit(event) {
    event.preventDefault();
    const id = elements.bikeId.value;
    const name = elements.bikeName.value.trim();
    const intervalKm = Math.round(Number(elements.serviceInterval.value));
    const lastServiceKm = Math.round(Number(elements.lastServiceKm.value));

    elements.bikeFormError.textContent = "";
    if (!name) {
      elements.bikeFormError.textContent = "Γράψε έναν κωδικό ή την πινακίδα.";
      elements.bikeName.focus();
      return;
    }
    if (!Number.isFinite(intervalKm) || intervalKm < 1) {
      elements.bikeFormError.textContent = "Γράψε σωστό διάστημα σέρβις.";
      elements.serviceInterval.focus();
      return;
    }
    if (!Number.isFinite(lastServiceKm) || lastServiceKm < 0 || elements.lastServiceKm.value === "") {
      elements.bikeFormError.textContent = "Γράψε σωστά τα χιλιόμετρα του τελευταίου σέρβις.";
      elements.lastServiceKm.focus();
      return;
    }

    const duplicate = bikes.find(function (bike) {
      return bike.id !== id &&
        bike.name.toLocaleLowerCase("el") === name.toLocaleLowerCase("el");
    });
    if (duplicate) {
      elements.bikeFormError.textContent = "Υπάρχει ήδη μηχανάκι με αυτόν τον κωδικό ή πινακίδα.";
      elements.bikeName.focus();
      return;
    }

    if (id) {
      const bike = getBike(id);
      if (!bike) return;
      const previousLastServiceKm = Number(bike.lastServiceKm || 0);
      const now = new Date().toISOString();
      bike.name = name;
      bike.intervalKm = intervalKm;
      if (bike.historyCorrectedAt && previousLastServiceKm !== lastServiceKm) {
        const oilEntries = (bike.history || []).filter(function (entry) { return entry.type === "service" && entry.oilChanged; })
          .sort(function (a, b) { return Number(b.km || 0) - Number(a.km || 0); });
        if (oilEntries.length) {
          oilEntries[0].km = lastServiceKm;
          oilEntries[0].updatedAt = now;
        } else {
          bike.history = Array.isArray(bike.history) ? bike.history : [];
          bike.history.unshift({
            id: uid(), type: "service", km: lastServiceKm, date: today(),
            notes: "Διόρθωση τελευταίας αλλαγής λαδιών", tasks: ["Διόρθωση τελευταίας αλλαγής λαδιών"],
            workshop: "", oilChanged: true, createdAt: now, updatedAt: now
          });
        }
        bike.historyCorrectedAt = now;
        recalculateCorrectedBike(bike);
      } else {
        bike.lastServiceKm = lastServiceKm;
        bike.currentKm = Math.max(bike.currentKm, lastServiceKm);
        bike.nextServiceKm = lastServiceKm + intervalKm;
      }
      bike.updatedAt = now;
      showToast("Οι αλλαγές αποθηκεύτηκαν.");
    } else {
      const now = new Date().toISOString();
      bikes.push(normalizeBike({
        id: uid(),
        name: name,
        intervalKm: intervalKm,
        lastServiceKm: lastServiceKm,
        currentKm: lastServiceKm,
        nextServiceKm: lastServiceKm + intervalKm,
        lastCheckedAt: "",
        createdAt: now,
        updatedAt: now,
        history: [{
          id: uid(),
          type: "service",
          km: lastServiceKm,
          date: today(),
          notes: "Αρχική ένδειξη αλλαγής λαδιών",
          tasks: ["Αρχική ένδειξη αλλαγής λαδιών"],
          workshop: "",
          oilChanged: true,
          majorService: false,
          majorServiceMilestoneKm: 0,
          createdAt: now,
          updatedAt: now
        }]
      }));
      showToast("Το μηχανάκι προστέθηκε στον στόλο.");
    }

    saveBikes();
    renderHome();
    if (activeBikeId) renderDetail();
    elements.bikeDialog.close();
  }

  function openServiceDialog(bike) {
    elements.serviceForm.reset();
    updateInvoiceFileName(elements.serviceInvoiceFile, elements.serviceInvoiceFileName);
    clearInvoiceQrStatus("service");
    elements.serviceFormError.textContent = "";
    elements.serviceBikeId.value = bike.id;
    elements.serviceBikeName.textContent = bike.name + " · κάθε " + formatKm(bike.intervalKm);
    elements.serviceKm.value = Math.max(bike.currentKm, bike.lastServiceKm);
    elements.serviceKm.min = 0;
    elements.serviceDate.value = today();
    elements.serviceNextPreview.textContent = "Δεν αλλάζει — " + formatKm(bike.nextServiceKm);
    elements.serviceDialog.showModal();
    updateServicePreview();
    setTimeout(function () {
      elements.serviceKm.focus();
      elements.serviceKm.select();
    }, 60);
  }

  function updateServicePreview() {
    const bike = getBike(elements.serviceBikeId.value);
    const serviceKm = Math.round(Number(elements.serviceKm.value));
    elements.serviceNextPreview.textContent =
      bike && elements.serviceOilChanged.checked && Number.isFinite(serviceKm) && serviceKm >= Number(bike.lastServiceKm || 0) && elements.serviceKm.value !== ""
        ? formatKm(serviceKm + Number(bike.intervalKm))
        : bike ? "Δεν αλλάζει — " + formatKm(bike.nextServiceKm) : "—";
    if (elements.serviceMileageWarning) {
      const earlier = bike && elements.serviceKm.value !== "" && Number.isFinite(serviceKm) && serviceKm >= 0 && serviceKm < Number(bike.lastServiceKm || 0);
      elements.serviceMileageWarning.classList.toggle("is-hidden", !earlier);
      elements.serviceMileageWarning.textContent = earlier ? "Προειδοποίηση: το service είναι πριν από την τελευταία αλλαγή λαδιών (" + formatKm(bike.lastServiceKm) + "). Μπορείς να το καταχωρήσεις στο ιστορικό με επιβεβαίωση." : "";
    }
    if (!bike || !elements.serviceMajorHint) return;
    const plan = getMajorServicePlan(bike, Number.isFinite(serviceKm) ? serviceKm : bike.currentKm);
    if (elements.serviceMajorService.checked) {
      elements.serviceMajorHint.className = "major-service-hint selected";
      elements.serviceMajorHint.innerHTML = "<strong>Μεγάλο service επιλεγμένο</strong><span>Θα καταγραφεί στα " + formatKm(serviceKm) + " και από εκεί θα ξεκινήσει νέος κύκλος 10.000 χλμ. Δεν αλλάζει τον κύκλο λαδιών.</span>";
      return;
    }
    elements.serviceMajorHint.className = "major-service-hint " + plan.key;
    elements.serviceMajorHint.innerHTML = "<strong>" + escapeHtml(plan.label) + "</strong><span>" + escapeHtml(plan.message) + "</span>";
  }

  async function handleServiceSubmit(event) {
    event.preventDefault();
    const bike = getBike(elements.serviceBikeId.value);
    if (!bike) return;
    const serviceKm = Math.round(Number(elements.serviceKm.value));
    const serviceDate = elements.serviceDate.value;
    const oilChanged = elements.serviceOilChanged.checked;
    const majorService = elements.serviceMajorService.checked;
    const selectedTasks = Array.from(elements.serviceTaskInputs).filter(function (input) {
      return input.checked;
    }).map(function (input) { return input.value; });
    const customTasks = elements.serviceNotes.value.split(/\r?\n/).map(function (task) {
      return task.trim();
    }).filter(Boolean);
    const tasks = Array.from(new Set(selectedTasks.concat(customTasks))).slice(0, 30);
    elements.serviceFormError.textContent = "";

    if (!Number.isFinite(serviceKm) || serviceKm < 0 || elements.serviceKm.value === "") {
      elements.serviceFormError.textContent = "Γράψε σωστά τα χιλιόμετρα του σέρβις.";
      elements.serviceKm.focus();
      return;
    }
    if (!serviceDate) {
      elements.serviceFormError.textContent = "Διάλεξε ημερομηνία.";
      elements.serviceDate.focus();
      return;
    }
    if (!tasks.length) {
      elements.serviceFormError.textContent = "Διάλεξε ή γράψε τουλάχιστον μία εργασία.";
      return;
    }
    const invoiceFiles = selectedInvoiceFiles(elements.serviceInvoiceFile);
    const invoiceQrValue = elements.serviceInvoiceQrValue && elements.serviceInvoiceQrValue.value;
    const selectionError = invoiceSelectionError(null, invoiceFiles, invoiceQrValue);
    if (selectionError) {
      elements.serviceFormError.textContent = selectionError;
      return;
    }
    if (serviceKm < Number(bike.lastServiceKm || 0) && !window.confirm("Προειδοποίηση: το service στα " + formatKm(serviceKm) + " έχει λιγότερα χιλιόμετρα από την τελευταία αλλαγή λαδιών στα " + formatKm(bike.lastServiceKm) + ". Θα προστεθεί στο ιστορικό χωρίς να μειωθούν τα τρέχοντα χιλιόμετρα ή η ενεργή μέτρηση λαδιών. Θέλεις να συνεχίσεις;")) {
      elements.serviceKm.focus();
      return;
    }

    const now = new Date().toISOString();
    const startsOilCycle = oilChanged && serviceKm >= Number(bike.lastServiceKm || 0);
    if (startsOilCycle) {
      bike.lastServiceKm = serviceKm;
      bike.nextServiceKm = serviceKm + Number(bike.intervalKm);
    }
    bike.currentKm = Math.max(bike.currentKm, serviceKm);
    bike.updatedAt = now;
    bike.history = Array.isArray(bike.history) ? bike.history : [];
    const entryId = uid();
    const hasInvoice = Boolean(invoiceFiles.length || invoiceQrValue);
    const newEntry = {
      id: entryId,
      type: "service",
      km: serviceKm,
      date: serviceDate,
      notes: tasks.join("\n"),
      tasks: tasks,
      workshop: elements.serviceWorkshop.value.trim().slice(0, 120),
      cost: elements.serviceCost.value.trim().slice(0, 60),
      oilChanged: oilChanged,
      majorService: majorService,
      majorServiceMilestoneKm: majorService ? serviceKm : 0,
      attachments: [],
      createdAt: now,
      updatedAt: now
    };
    if (invoiceQrValue) {
      newEntry.invoiceData = mergeInvoiceData({ qrUrl: normalizeQrUrl(invoiceQrValue), source: "qr" }, null);
    }
    bike.history.unshift(newEntry);
    refreshMajorTracking(bike);
    saveBikes();
    renderHome();
    if (activeBikeId === bike.id) renderDetail();
    elements.serviceDialog.close();
    const normalMessage = startsOilCycle
      ? "Νέο επόμενο σέρβις: " + formatKm(bike.nextServiceKm)
      : "Το σέρβις καταχωρήθηκε. Η μέτρηση λαδιών δεν άλλαξε.";
    showToast(majorService ? normalMessage + " Καταγράφηκε και μεγάλο service στα " + formatKm(serviceKm) + "." : normalMessage);
    if (hasInvoice) {
      if (navigator.onLine === false) {
        showToast("Το service αποθηκεύτηκε. Το τιμολόγιο θα ανέβει όταν υπάρχει σύνδεση.");
      } else {
        showToast(invoiceQrValue
          ? "Το service καταχωρήθηκε. Το QR επεξεργάζεται στο παρασκήνιο."
          : "Το service καταχωρήθηκε. Το τιμολόγιο επεξεργάζεται στο παρασκήνιο.");
        Promise.resolve().then(async function () {
          try {
            await syncNow();
            const result = await attachInvoicesToEntry(bike.id, entryId, invoiceFiles, invoiceQrValue, { background: true, deferQrCompletion: true });
            renderHome();
            if (activeBikeId === bike.id) renderDetail();
            showToast(invoiceBatchMessage(result));
          } catch (error) {
            showToast(error && error.message ? error.message : "Το service αποθηκεύτηκε, αλλά το τιμολόγιο δεν ολοκληρώθηκε.");
          }
        });
      }
    }
  }

  function openCheckDialog(bike) {
    // Keep the old entry point for links/bookmarks, but use the same full
    // screen flow as the home action.
    openQuickCheck(true, bike && bike.id);
  }

  function handleCheckDialogSubmit(event) {
    event.preventDefault();
    const bike = getBike(elements.checkDialogBikeId.value);
    if (!bike) return;
    const km = Math.round(Number(elements.checkDialogKm.value));
    elements.checkDialogError.textContent = "";

    if (!Number.isFinite(km) || km < 0 || elements.checkDialogKm.value === "") {
      elements.checkDialogError.textContent = "Γράψε σωστά τα τωρινά χιλιόμετρα.";
      elements.checkDialogKm.focus();
      return;
    }
    if (km < bike.lastServiceKm) {
      elements.checkDialogError.textContent = "Τα χιλιόμετρα δεν γίνεται να είναι λιγότερα από την τελευταία αλλαγή λαδιών.";
      elements.checkDialogKm.focus();
      return;
    }

    const status = updateMileage(bike, km, today());
    renderHome();
    renderDetail();
    elements.checkDialog.close();
    showToast(bike.name + ": " + status.message);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = setTimeout(function () {
      elements.toast.classList.remove("show");
    }, 3400);
  }

  function reportQrSvg(value) {
    const qrValue = normalizeQrValue(value);
    if (!qrValue || typeof window.qrcode !== "function") return "";
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(qrValue);
      qr.make();
      return qr.createSvgTag(3, 4, "QR ηλεκτρονικού τιμολογίου");
    } catch (error) {
      return "";
    }
  }

  function reportInvoiceBlock(file, entry) {
    const data = mergeInvoiceData(invoiceDataFromAttachment(file), (entry && entry.attachments || []).length <= 1 ? entry && entry.invoiceData : null) || {};
    const qrValue = (file && (file.qrUrl || file.qrValue)) || data.qrUrl;
    const qr = reportQrSvg(qrValue);
    const meta = [
      data.supplier ? "Προμηθευτής: " + data.supplier : "",
      data.invoiceNumber ? "Αρ.: " + data.invoiceNumber : "",
      data.totalAmount ? "Σύνολο: " + data.totalAmount : ""
    ].filter(Boolean).join(" · ");
    const actions = file && file.key
      ? '<div class="report-invoice-actions"><button type="button" data-report-view-document="' + escapeHtml(file.key) + '">Άνοιγμα PDF</button><button type="button" data-report-download-document="' + escapeHtml(file.key) + '" data-report-download-name="' + escapeHtml(file.name || "τιμολόγιο.pdf") + '">Λήψη PDF</button></div>'
      : "";
    const qrBlock = qr
      ? '<div class="report-qr-wrap">' + qr + '<span>Σάρωση για ηλεκτρονικό τιμολόγιο</span></div>'
      : '<div class="report-qr-missing">Δεν αποθηκεύτηκε QR</div>';
    return '<div class="report-invoice-block"><div class="report-invoice-copy"><strong>' + escapeHtml(file.name || "τιμολόγιο") + '</strong>' + (meta ? '<small>' + escapeHtml(meta) + '</small>' : '') + actions + '</div>' + qrBlock + '</div>';
  }

  function reportInvoiceCell(entry) {
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    if (attachments.length) return attachments.map(function (file) { return reportInvoiceBlock(file, entry); }).join("");
    const data = normalizeInvoiceData(entry && entry.invoiceData) || {};
    return data.qrUrl ? reportInvoiceBlock({ name: "QR τιμολογίου", qrUrl: data.qrUrl, ocr: data }, entry) : "—";
  }

  function reportCost(entry) {
    const files = Array.isArray(entry && entry.attachments) ? entry.attachments : [];
    const seen = new Set();
    const amounts = [];
    let missing = false;
    files.forEach(function (file, index) {
      const key = String(file.key || file.id || index);
      if (seen.has(key)) return;
      seen.add(key);
      const data = invoiceDataFromAttachment(file) || {};
      const cents = invoiceMoneyCents(data.totalAmount);
      if (cents !== null) amounts.push(cents); else missing = true;
    });
    if (amounts.length) return ((amounts.reduce(function (total, cents) { return total + cents; }, 0)) / 100).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €" + (missing ? " · εκκρεμεί κόστος τιμολογίου" : "");
    const data = normalizeInvoiceData(entry && entry.invoiceData) || {};
    return entry && entry.cost || (files.length <= 1 && data.totalAmount) || "—";
  }

  function invoiceMoneyCents(value) {
    let text = String(value == null ? "" : value).replace(/€|EUR|ευρώ|\s/gi, "");
    if (!/^\d+(?:[.,]\d+)*$/.test(text)) return null;
    const last = Math.max(text.lastIndexOf(","), text.lastIndexOf("."));
    const decimal = last >= 0 && text.length - last - 1 <= 2;
    let whole = decimal ? text.slice(0, last) : text;
    const fraction = decimal ? text.slice(last + 1).padEnd(2, "0") : "00";
    if (decimal && whole.includes(text[last])) return null;
    if (/[.,]/.test(whole) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(whole)) return null;
    whole = whole.replace(/[.,]/g, "");
    const cents = Number(whole) * 100 + Number(fraction);
    return Number.isSafeInteger(cents) ? cents : null;
  }

  function reportServiceDateCell(entry) {
    const seen = new Set();
    const files = Array.isArray(entry.attachments) ? entry.attachments : [];
    const dataList = files.length ? files.map(invoiceDataFromAttachment) : [entry.invoiceData];
    dataList.forEach(function (data) {
      const value = String(data && data.invoiceDate || "").trim();
      if (!value) return;
      const valid = /^\d{4}-\d{2}-\d{2}/.test(value) || /(^|\D)\d{1,2}[./-]\d{1,2}[./-]\d{4}(?:\D|$)/.test(value);
      seen.add(valid ? formatDate(invoiceDateForName(value, "")) : value);
    });
    return '<strong>' + escapeHtml(formatDate(entry.date)) + '</strong>' + Array.from(seen).map(function (date) {
      return '<small class="report-invoice-date">Τιμολόγιο: ' + escapeHtml(date) + '</small>';
    }).join("");
  }

  function reportHeaderMarkup(title, subtitle, items) {
    return '<header class="history-report-header"><div class="history-report-brand"><span class="history-report-brand-mark">FC</span><span><strong>FLEET CONTROL</strong><small>SERVICE HISTORY</small></span></div><div class="history-report-heading"><span class="history-report-kicker">ΑΝΑΛΥΤΙΚΗ ΑΝΑΦΟΡΑ</span><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(subtitle || "Ιστορικό συντήρησης στόλου") + '</p></div><div class="history-report-meta">' + (items || []).map(function (item) { return '<span><small>' + escapeHtml(item[0]) + '</small><strong>' + escapeHtml(item[1] == null || item[1] === "" ? "—" : item[1]) + '</strong></span>'; }).join("") + '</div></header>';
  }

  function reportRowsForBike(bike) {
    return historyEntriesForDisplay((bike.history || []).filter(function (entry) { return entry.type === "service"; })).map(function (entry) {
      const tasks = serviceTasksForEntry(entry);
      const taskMarkup = tasks.length
        ? '<ul class="report-task-list report-task-list-compact">' + tasks.map(function (task) { return '<li>' + escapeHtml(task) + '</li>'; }).join("") + '</ul>'
        : "—";
      const supplier = serviceSupplier(entry);
      return `<tr><td>${reportServiceDateCell(entry)}</td><td>${escapeHtml(formatKm(entry.km))}</td><td>${taskMarkup}</td><td>${escapeHtml(supplier ? supplier.value : "—")}</td><td>${escapeHtml(reportCost(entry))}</td><td>${reportInvoiceCell(entry)}</td></tr>`;
    }).join("");
  }

  function showHistoryReport(title, markup) {
    if (!elements.historyReportDialog || !elements.historyReportBody) return;
    elements.historyReportTitle.textContent = title;
    elements.historyReportBody.innerHTML = markup;
    elements.historyReportDialog.showModal();
    historyReportOpen = true;
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.setHistoryReportOpen === "function") window.AndroidFleet.setHistoryReportOpen(true);
    } catch (error) {}
    try { history.pushState({ view: "fleet-report" }, "", "#fleet-report"); } catch (error) {}
  }

  function closeHistoryReport(fromHistory) {
    if (!historyReportOpen) return;
    historyReportOpen = false;
    if (elements.historyReportDialog && elements.historyReportDialog.open) elements.historyReportDialog.close();
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.setHistoryReportOpen === "function") window.AndroidFleet.setHistoryReportOpen(false);
    } catch (error) {}
    if (!fromHistory && history.state && history.state.view === "fleet-report") {
      try { history.back(); } catch (error) {}
    }
  }

  window.FleetControlCloseHistoryReport = function () {
    closeHistoryReport(false);
  };

  function exportActiveBikeHistory() {
    const bike = getBike(activeBikeId);
    if (!bike) return;
    const rows = reportRowsForBike(bike);
    const serviceCount = (bike.history || []).filter(function (entry) { return entry.type === "service"; }).length;
    const created = new Date().toLocaleString("el-GR");
    showHistoryReport("Ιστορικό service · " + bike.name, '<div class="history-report-content">' + reportHeaderMarkup("Ιστορικό Service", "Αναλυτικό ιστορικό συντήρησης για το επιλεγμένο μηχανάκι", [["Μηχανάκι", bike.name], ["Καταχωρήσεις", serviceCount + " service"], ["Δημιουργήθηκε", created]]) + '<div class="history-report-section-intro"><strong>Εργασίες, κόστος και ψηφιακά τιμολόγια</strong><span>Οι εργασίες εμφανίζονται ανά γραμμή. Το QR παραμένει διαθέσιμο δίπλα στο αντίστοιχο τιμολόγιο.</span></div><table><thead><tr><th>Ημερομηνία</th><th>Χιλιόμετρα</th><th>Εργασίες</th><th>Προμηθευτής</th><th>Κόστος</th><th>Τιμολόγιο / QR</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6">Δεν υπάρχουν service.</td></tr>') + '</tbody></table><footer class="history-report-footer">Fleet Control • Εσωτερική αναφορά συντήρησης</footer></div>');
  }

  function openFleetExportDialog() {
    elements.fleetExportList.innerHTML = bikes.map(function (bike) {
      const serviceCount = (bike.history || []).filter(function (entry) { return entry.type === "service"; }).length;
      const status = getStatus(bike);
      return '<label class="fleet-export-card"><input type="checkbox" value="' + escapeHtml(bike.id) + '" data-export-bike><span class="fleet-export-check" aria-hidden="true">✓</span><span class="fleet-export-card-copy"><strong>' + escapeHtml(bike.name) + '</strong><small>' + escapeHtml(formatKm(bike.currentKm) + ' · επόμενο ' + formatKm(bike.nextServiceKm)) + '</small><em>' + serviceCount + (serviceCount === 1 ? ' service' : ' service') + '</em></span><span class="fleet-export-status status-' + escapeHtml(status.key) + '">' + escapeHtml(status.label) + '</span></label>';
    }).join("") || '<p class="history-empty">Δεν υπάρχουν μηχανάκια.</p>';
    updateFleetExportSelection();
    elements.fleetExportDialog.showModal();
  }

  function updateFleetExportSelection() {
    const allInputs = elements.fleetExportList ? Array.from(elements.fleetExportList.querySelectorAll("[data-export-bike]")) : [];
    allInputs.forEach(function (input) { input.closest(".fleet-export-card")?.classList.toggle("is-selected", input.checked); });
    const selected = allInputs.filter(function (input) { return input.checked; }).length;
    const count = document.getElementById("fleetExportSelectionCount");
    if (count) count.textContent = selected + (selected === 1 ? " επιλεγμένο" : " επιλεγμένα");
    const selectAll = document.getElementById("fleetExportSelectAll");
    if (selectAll) selectAll.textContent = selected && selected === allInputs.length ? "Κατάργηση όλων" : "Επιλογή όλων";
  }

  function exportSelectedFleetHistory() {
    const ids = Array.from(elements.fleetExportList.querySelectorAll("[data-export-bike]:checked")).map(function (input) { return input.value; });
    const selected = bikes.filter(function (bike) { return ids.includes(String(bike.id)); });
    if (!selected.length) return showToast("Επίλεξε τουλάχιστον ένα μηχανάκι.");
    const serviceCount = selected.reduce(function (total, bike) { return total + (bike.history || []).filter(function (entry) { return entry.type === "service"; }).length; }, 0);
    const created = new Date().toLocaleString("el-GR");
    const sections = selected.map(function (bike) {
      const rows = reportRowsForBike(bike);
      const count = (bike.history || []).filter(function (entry) { return entry.type === "service"; }).length;
      return `<section class="history-report-bike-section"><div class="history-report-bike-heading"><div><span class="history-report-kicker">ΜΗΧΑΝΑΚΙ</span><h2>${escapeHtml(bike.name)}</h2></div><span>${count} service</span></div><table><thead><tr><th>Ημερομηνία</th><th>Χλμ.</th><th>Εργασίες</th><th>Προμηθευτής</th><th>Κόστος</th><th>Τιμολόγιο / QR</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Δεν υπάρχουν service.</td></tr>'}</tbody></table></section>`;
    }).join("<hr>");
    showHistoryReport("Αναλυτικό ιστορικό στόλου", '<div class="history-report-content">' + reportHeaderMarkup("Αναλυτικό Ιστορικό Service", "Συγκεντρωτική αναφορά συντήρησης επιλεγμένων μηχανών", [["Μηχανάκια", String(selected.length)], ["Καταχωρήσεις", serviceCount + " service"], ["Δημιουργήθηκε", created]]) + '<div class="history-report-section-intro"><strong>Συγκεντρωτικά στοιχεία στόλου</strong><span>Κάθε μηχανάκι έχει ξεχωριστή ενότητα με εργασίες, κόστος, PDF τιμολογίων και QR.</span></div>' + sections + '<footer class="history-report-footer">Fleet Control • Εσωτερική αναφορά συντήρησης</footer></div>');
    elements.fleetExportDialog.close();
  }

  document.querySelectorAll("[data-close-dialog]").forEach(function (button) {
    button.addEventListener("click", function () {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog && dialog.open) dialog.close();
    });
  });

  [
    elements.bikeDialog,
    elements.serviceDialog,
    elements.checkDialog,
    elements.historyEntryDialog,
    elements.bikePickerDialog,
    elements.overviewDialog,
    elements.fleetExportDialog,
    elements.invoiceReviewDialog,
    elements.unlockDialog,
    elements.pinSettingsDialog,
    elements.connectionSettingsDialog
  ].forEach(function (dialog) {
    dialog.addEventListener("click", function (event) {
      const rect = dialog.getBoundingClientRect();
      const isBackdrop =
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom;
      if (isBackdrop) dialog.close();
    });
  });

  elements.addBikeButton.addEventListener("click", function () {
    requireAccountAccess(function () { openBikeDialog(null); });
  });
  elements.openQuickCheckButton.addEventListener("click", function () {
    requireEditAccess(function () { openQuickCheck(true); });
  });
  elements.quickCheckForm.addEventListener("submit", function (event) {
    event.preventDefault();
    requireEditAccess(function () {
      handleQuickCheck({ preventDefault: function () {} });
    });
  });
  elements.quickBikePicker.addEventListener("click", openBikePicker);
  elements.overviewStats.forEach(function (card) {
    card.addEventListener("click", function () {
      openOverviewDialog(card.dataset.overviewFilter);
    });
  });
  elements.fleetAlert.addEventListener("click", function () {
    openOverviewDialog(elements.fleetAlert.dataset.alertFilter || "attention");
  });
  elements.mileageCheckAlert.addEventListener("click", openMileageCheckOverview);
  elements.bikePickerSearch.addEventListener("input", function () {
    renderBikePickerList(elements.bikePickerSearch.value);
  });
  elements.bikePickerList.addEventListener("click", function (event) {
    const option = event.target.closest("[data-pick-bike]");
    if (option) selectQuickBike(option.dataset.pickBike);
  });
  elements.overviewDialogList.addEventListener("click", function (event) {
    const option = event.target.closest("[data-overview-bike]");
    if (!option) return;
    elements.overviewDialog.close();
    openDetail(option.dataset.overviewBike, true);
  });
  elements.bikeList.addEventListener("click", function (event) {
    const card = event.target.closest("[data-bike-id]");
    if (card) openDetail(card.dataset.bikeId, true);
  });
  if (elements.archivedBikesSection) elements.archivedBikesSection.addEventListener("click", function (event) {
    const restore = event.target.closest("[data-restore-bike]");
    if (restore) restoreBike(restore.dataset.restoreBike);
  });
  if (elements.refreshArchivedButton) elements.refreshArchivedButton.addEventListener("click", loadArchivedBikes);
  elements.detailHistory.addEventListener("click", function (event) {
    const retrySave = event.target.closest("[data-retry-service-save]");
    if (retrySave) return requireEditAccess(function () {
      const job = backgroundHistorySaves.get(retrySave.dataset.retryServiceSave);
      if (job && job.status === "error") enqueueHistoryEntrySave(job);
    });
    const retryQr = event.target.closest("[data-retry-qr]");
    if (retryQr) return requireEditAccess(function () { retryQrDocumentJob(activeBikeId, retryQr.dataset.retryQrEntry, retryQr.dataset.retryQr); });
    const deleteDocument = event.target.closest("[data-delete-document]");
    if (deleteDocument) return deleteServiceDocument(deleteDocument.dataset.deleteDocumentEntry, deleteDocument.dataset.deleteDocument);
    const reviewDocument = event.target.closest("[data-review-document]");
    if (reviewDocument) return reviewStoredServiceDocument(reviewDocument.dataset.reviewDocumentEntry, reviewDocument.dataset.reviewDocument);
    const downloadDocument = event.target.closest("[data-download-document]");
    if (downloadDocument) return downloadServiceDocument({ key: downloadDocument.dataset.downloadDocument, name: downloadDocument.dataset.downloadDocumentName || "τιμολόγιο" });
    const documentButton = event.target.closest("[data-view-document]");
    if (documentButton) return openServiceDocument({ key: documentButton.dataset.viewDocument });
    const edit = event.target.closest("[data-edit-history]");
    if (edit) return openHistoryEntryDialog(edit.dataset.editHistory);
    const remove = event.target.closest("[data-delete-history]");
    if (remove) deleteHistoryEntry(remove.dataset.deleteHistory);
  });
  elements.detailBackButton.addEventListener("click", function () {
    if (history.state && history.state.view === "detail") {
      history.back();
    } else {
      showHome();
    }
  });
  elements.serviceOrderButton.addEventListener("click", function () { openServiceOrder(true); });
  elements.serviceOrderBackButton.addEventListener("click", backFromServiceOrder);
  elements.serviceOrderList.addEventListener("click", function (event) {
    const button = event.target.closest("[data-service-order-bike]");
    if (button) openDetail(button.dataset.serviceOrderBike, true);
  });
  elements.quickCheckBackButton.addEventListener("click", function () {
    if (history.state && history.state.view === "quick-check") {
      history.back();
    } else {
      showHome();
    }
  });
  elements.detailEditButton.addEventListener("click", function () {
    const bike = getBike(activeBikeId);
    if (bike) requireAccountAccess(function () { openBikeDialog(bike); });
  });
  elements.detailCheckButton.addEventListener("click", function () {
    const bike = getBike(activeBikeId);
    if (bike) requireAccountAccess(function () { openQuickCheck(true, bike.id); });
  });
  elements.detailServiceButton.addEventListener("click", function () {
    const bike = getBike(activeBikeId);
    if (bike) requireAccountAccess(function () { openServiceDialog(bike); });
  });
  elements.detailArchiveButton.addEventListener("click", archiveActiveBike);
  elements.detailExportButton.addEventListener("click", exportActiveBikeHistory);
  elements.exportFleetButton.addEventListener("click", openFleetExportDialog);
  elements.fleetExportList.addEventListener("change", updateFleetExportSelection);
  document.getElementById("fleetExportSelectAll").addEventListener("click", function () {
    const inputs = Array.from(elements.fleetExportList.querySelectorAll("[data-export-bike]"));
    const selectAll = inputs.some(function (input) { return !input.checked; });
    inputs.forEach(function (input) { input.checked = selectAll; });
    updateFleetExportSelection();
  });
  elements.createFleetExportButton.addEventListener("click", exportSelectedFleetHistory);
  elements.historyReportCloseButton.addEventListener("click", function () {
    closeHistoryReport(false);
  });
  elements.historyReportPrintButton.addEventListener("click", function () {
    if (window.AndroidFleet && typeof window.AndroidFleet.printCurrentPage === "function") {
      window.AndroidFleet.printCurrentPage();
    } else {
      window.print();
    }
  });
  elements.historyReportDialog.addEventListener("click", function (event) {
    const rect = elements.historyReportDialog.getBoundingClientRect();
    const isBackdrop = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (isBackdrop) closeHistoryReport(false);
  });
  elements.historyReportBody.addEventListener("click", function (event) {
    const view = event.target.closest("[data-report-view-document]");
    if (view) return openServiceDocument({ key: view.dataset.reportViewDocument });
    const download = event.target.closest("[data-report-download-document]");
    if (download) return downloadServiceDocument({ key: download.dataset.reportDownloadDocument, name: download.dataset.reportDownloadName || "τιμολόγιο.pdf" });
  });
  elements.bikeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    requireEditAccess(function () {
      handleBikeSubmit({ preventDefault: function () {} });
    });
  });
  elements.serviceForm.addEventListener("submit", function (event) {
    event.preventDefault();
    requireEditAccess(function () {
      handleServiceSubmit({ preventDefault: function () {} });
    });
  });
  elements.serviceInvoiceFile.addEventListener("change", function () {
    updateInvoiceFileName(elements.serviceInvoiceFile, elements.serviceInvoiceFileName);
  });
  elements.serviceQrScanButton.addEventListener("click", function () {
    openQrScanner("service");
  });
  elements.checkDialogForm.addEventListener("submit", function (event) {
    event.preventDefault();
    requireEditAccess(function () {
      handleCheckDialogSubmit({ preventDefault: function () {} });
    });
  });
  elements.historyEntryForm.addEventListener("submit", handleHistoryEntrySubmit);
  elements.historyEntryInvoiceFile.addEventListener("change", function () {
    updateInvoiceFileName(elements.historyEntryInvoiceFile, elements.historyEntryInvoiceFileName);
  });
  elements.historyEntryQrScanButton.addEventListener("click", function () {
    openQrScanner("history");
  });
  elements.qrScannerManualButton.addEventListener("click", openManualInvoicePicker);
  elements.qrScannerCancelButton.addEventListener("click", function () {
    stopQrScanner(true);
  });
  elements.qrScannerCloseButton.addEventListener("click", function () {
    stopQrScanner(true);
  });
  elements.qrScannerDialog.addEventListener("close", function () {
    stopQrScanner(false);
  });
  elements.historyEntryDeleteButton.addEventListener("click", function () {
    deleteHistoryEntry(elements.historyEntryId.value);
  });
  elements.unlockForm.addEventListener("submit", handleUnlockSubmit);
  elements.pinSettingsForm.addEventListener("submit", handlePinSettingsSubmit);
  elements.pinSettingsButton.addEventListener("click", openPinSettings);
  elements.connectionSettingsButton.addEventListener("click", openConnectionSettings);
  elements.connectionSettingsForm.addEventListener("submit", saveServerSettings);
  elements.testServerButton.addEventListener("click", testServerUrl);
  elements.requestBackupButton.addEventListener("click", requestServerBackup);
  elements.legacyImportButton.addEventListener("click", importLegacyFleet);
  elements.downloadApkButton.addEventListener("click", downloadLatestApk);
  elements.syncIndicator.addEventListener("click", function () {
    syncNow();
  });
  elements.webAccessButton.addEventListener("click", function () {
    returnToPortal(false);
  });
  elements.serviceInterval.addEventListener("input", updateBikePreview);
  elements.lastServiceKm.addEventListener("input", updateBikePreview);
  elements.serviceKm.addEventListener("input", updateServicePreview);
  elements.serviceOilChanged.addEventListener("change", updateServicePreview);
  elements.serviceMajorService.addEventListener("change", updateServicePreview);
  elements.historyFilterButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      activeHistoryFilter = button.dataset.historyFilter;
      renderDetail();
    });
  });

  function handleFleetNavigation(event) {
    const leavingServiceOrder = !elements.serviceOrderView.classList.contains("is-hidden");
    if (historyReportOpen) {
      closeHistoryReport(true);
      return;
    }
    if (event.state && event.state.view === "detail" && getBike(event.state.bikeId)) {
      openDetail(event.state.bikeId, false);
    } else if (event.state && event.state.view === "quick-check") {
      openQuickCheck(false, event.state.bikeId);
    } else if (event.state && event.state.view === "service-order") {
      openServiceOrder(false);
    } else {
      showHome();
      if (leavingServiceOrder) window.scrollTo(0, serviceOrderHomeScroll);
    }
  }
  window.addEventListener("popstate", handleFleetNavigation);

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installButton.classList.remove("is-hidden");
  });

  elements.installButton.addEventListener("click", async function () {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      elements.installButton.classList.add("is-hidden");
      return;
    }
    showToast("Chrome: μενού ⋮ και «Προσθήκη στην αρχική οθόνη».");
  });

  window.addEventListener("appinstalled", function () {
    elements.installButton.classList.add("is-hidden");
    showToast("Το Fleet Control εγκαταστάθηκε.");
  });

  if (window.matchMedia("(display-mode: standalone)").matches) {
    elements.installButton.classList.add("is-hidden");
  }

  if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./service-worker.js").catch(function () {});
    });
  }

  window.addEventListener("online", function () {
    refreshCurrentUser();
    syncNow();
  });
  window.addEventListener("offline", function () {
    setSyncState("offline", "Χωρίς σύνδεση");
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") syncNow();
  });
  function hasVisibleQrProcessing() {
    const bike = getBike(activeBikeId);
    return Boolean(bike && Array.isArray(bike.history) && bike.history.some(function (entry) {
      const data = normalizeInvoiceData(entry && entry.invoiceData) || {};
      return entry && entry.type !== "check" && ["processing", "delayed"].includes(String(data.qrProcessingStatus || "")) && data.qrJobId;
    }));
  }
  let qrProgressRefreshRunning = false;
  async function refreshVisibleQrProgress() {
    if (qrProgressRefreshRunning || document.hidden || !webToken || !activeBikeId || !hasVisibleQrProcessing()) return;
    const bike = getBike(activeBikeId);
    const bikeId = bike && bike.id;
    const jobs = (bike && Array.isArray(bike.history) ? bike.history : []).map(function (entry) {
      const data = normalizeInvoiceData(entry && entry.invoiceData) || {};
      return entry && entry.type !== "check" && ["processing", "delayed"].includes(String(data.qrProcessingStatus || "")) && data.qrJobId
        ? { entry: entry, jobId: data.qrJobId } : null;
    }).filter(Boolean);
    if (!jobs.length) return;
    qrProgressRefreshRunning = true;
    let completed = false;
    try {
      await Promise.all(jobs.slice(0, 5).map(async function (job) {
        try {
          const response = await fetch(apiBase + "/api/service-documents/jobs/" + encodeURIComponent(job.jobId), {
            headers: requestHeaders(true), cache: "no-store"
          });
          const data = await response.json().catch(function () { return {}; });
          if (response.ok) {
            updateQrProcessingLocal(bikeId, job.entry.id, Object.assign({ jobId: job.jobId }, data));
            if (data.status === "completed" && data.attachment) completed = true;
          } else {
            updateQrProcessingLocal(bikeId, job.entry.id, {
              jobId: job.jobId,
              status: "delayed",
              progress: 5,
              stage: "Δεν απαντά ο Server · θα ξαναδοκιμάσει",
              error: data.error || "Δεν ήταν δυνατή η ενημέρωση της εργασίας."
            });
          }
        } catch (error) {}
      }));
      if (completed) await syncNow();
    } finally {
      qrProgressRefreshRunning = false;
    }
  }
  setInterval(function () {
    if (document.hidden || !activeBikeId || !elements.detailView || elements.detailView.classList.contains("is-hidden") || !hasVisibleQrProcessing()) return;
    renderDetail();
  }, 1000);
  setInterval(refreshVisibleQrProgress, 3000);
  setInterval(syncNow, 30000);

  try {
    history.replaceState({ view: "home" }, "");
  } catch (error) {}
  saveBikes(false);
  renderHome();
  renderAccessState();
  renderArchiveAccess();
  refreshCurrentUser();
  syncNow();
}());
