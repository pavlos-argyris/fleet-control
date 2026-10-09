(function () {
  "use strict";

  const config = window.FLEET_CONFIG || {};
  const apiBase = String(config.apiBase || (location.protocol === "file:" ? "" : location.origin)).replace(/\/$/, "");
  const TOKEN_PERSIST = "fleet-control-auth-token";
  const TOKEN_SESSION = "fleet-control-session-token";
  const DEVICE_KEY = "fleet-control-device-id";
  const USER_CACHE = "fleet-control-user-cache";
  const ALERT_NOTIFICATION_IDS = "fleet-control-alert-notification-ids";
  const BROWSER_NOTIFICATIONS = "fleet-control-browser-notifications";
  const VIEW_CACHE_MS = {
    dashboard: 30000, "employee-home": 15000, shifts: 15000, schedules: 60000,
    employees: 300000, fleet: 60000, invoices: 30000, payroll: 120000, reports: 120000,
    alerts: 30000, audit: 60000, recycle: 30000, server: 30000, settings: 300000
  };
  const numberFormat = new Intl.NumberFormat("el-GR");
  const moneyFormat = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
  const dateTimeFormat = new Intl.DateTimeFormat("el-GR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const dateFormat = new Intl.DateTimeFormat("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeFormat = new Intl.DateTimeFormat("el-GR", { hour: "2-digit", minute: "2-digit" });
  const roleLabels = { owner: "Owner / Super Admin", manager: "Manager", payroll_manager: "Payroll Manager", fleet_manager: "Fleet Manager", employee: "Employee" };
  const alertTypeLabels = {
    forgotten_clock_out: "Ξεχασμένο Clock Out", overtime: "Υπερωρία", auto_close: "Αυτόματο κλείσιμο",
    missing_km: "Εκκρεμή χιλιόμετρα", out_of_schedule: "Εκτός προγράμματος", vehicle_conflict: "Σύγκρουση μηχανής",
    schedule_conflict: "Σύγκρουση προγράμματος", invalid_km: "Μη έγκυρα χιλιόμετρα", unusual_distance: "Ασυνήθιστη απόσταση",
    service_conflict: "Σύγκρουση service", service_due: "Service που πλησιάζει", major_service_due: "Μεγάλο service", payroll_correction: "Διόρθωση μισθοδοσίας",
    correction_request: "Αίτημα διόρθωσης", backup_failed: "Αποτυχία backup", db_problem: "Πρόβλημα βάσης",
    server_offline: "Server offline", server_restart: "Επανεκκίνηση Server",
    server_temperature: "Θερμοκρασία Server", server_storage: "Χώρος Server",
    server_battery: "Μπαταρία Server", server_restriction: "Περιορισμός Android"
  };
  const permissionLabels = {
    "dashboard.view": "Dashboard", "employees.view": "Προβολή εργαζομένων", "employees.manage": "Διαχείριση εργαζομένων",
    clock_in_out: "Clock In / Clock Out", select_vehicle: "Επιλογή μηχανής", view_own_history: "Προσωπικό ιστορικό",
    view_hours: "Ώρες", view_history: "Ιστορικό", view_kilometers: "Χιλιόμετρα", view_pay: "Πληρωμή",
    request_correction: "Αίτημα διόρθωσης", "shifts.view": "Προβολή βαρδιών", "shifts.manage": "Διαχείριση βαρδιών",
    "shifts.vehicle.change": "Αλλαγή μηχανής σε βάρδια", "schedules.view": "Προβολή προγράμματος", "schedules.manage": "Διαχείριση προγράμματος",
    "fleet.view": "Προβολή Fleet", "fleet.manage": "Διαχείριση Fleet", "service.manage": "Διαχείριση service",
    "payroll.view": "Προβολή μισθοδοσίας", "payroll.manage": "Διαχείριση μισθοδοσίας", "payroll.lock": "Κλείδωμα μισθοδοσίας",
    "reports.view": "Αναφορές", "alerts.view": "Προβολή ειδοποιήσεων", "alerts.manage": "Διαχείριση ειδοποιήσεων",
    "audit.view": "Audit Log", "backup.manage": "Backup", "server.manage": "Server", "settings.manage": "Ρυθμίσεις", "security.manage": "Ασφάλεια"
  };
  const navDefinitions = [
    { id: "dashboard", label: "Dashboard", icon: "⌂", permission: "dashboard.view" },
    { id: "employee-home", label: "Η βάρδιά μου", icon: "◉", permission: "clock_in_out", employeeOnly: true },
    { id: "shifts", label: "Βάρδιες", icon: "◷", permission: "shifts.view" },
    { id: "schedules", label: "Πρόγραμμα", icon: "▦", permission: "schedules.view" },
    { id: "employees", label: "Εργαζόμενοι", icon: "♙", permission: "employees.view" },
    { id: "fleet", label: "Μηχανάκια / Fleet", icon: "◇", permission: "fleet.view" },
    { id: "invoices", label: "Τιμολόγια service", icon: "▤", permission: "fleet.view" },
    { id: "payroll", label: "Μισθοδοσία", icon: "€", permission: "payroll.view" },
    { id: "reports", label: "Αναφορές", icon: "▥", permission: "reports.view" },
    { id: "alerts", label: "Ειδοποιήσεις", icon: "!", permission: "alerts.view" },
    { id: "audit", label: "Audit Log", icon: "≡", permission: "audit.view" },
    { id: "recycle", label: "Κάδος & Ιστορικό", icon: "↶", permission: "audit.view" },
    { id: "server", label: "Backup & Server", icon: "↥", permission: "backup.manage" },
    { id: "settings", label: "Ρυθμίσεις & Ασφάλεια", icon: "⚙", permission: "settings.manage" }
  ];
  const viewTitles = {
    dashboard: ["ADMIN PANEL", "Dashboard"], "employee-home": ["EMPLOYEE", "Η βάρδιά μου"],
    shifts: ["OPERATIONS", "Βάρδιες"], schedules: ["TEAM PLANNING", "Πρόγραμμα"],
    employees: ["TEAM", "Εργαζόμενοι"], fleet: ["ΔΙΑΧΕΙΡΙΣΗ ΣΤΟΛΟΥ", "Fleet Control"],
    invoices: ["FLEET DOCUMENTS", "Τιμολόγια service"], payroll: ["PAYROLL", "Μισθοδοσία"], reports: ["REPORTING", "Αναφορές"],
    alerts: ["ACTION CENTER", "Ειδοποιήσεις"], audit: ["SECURITY", "Audit Log"],
    recycle: ["RECOVERY", "Κάδος & Ιστορικό"],
    server: ["SYSTEM", "Backup & Server"], settings: ["CONFIGURATION", "Ρυθμίσεις & Ασφάλεια"]
  };

  const state = {
    token: loadToken(), user: null, view: "dashboard", employees: [], vehicles: [], alerts: [],
    shifts: [], schedules: [], payroll: null, report: null, selectedReport: "shifts", pinResolver: null,
    simpleResolver: null, lastStatus: null, completion: null, allPermissions: [], rolePermissions: {}, payRules: [],
    viewLoadedAt: {}, weekData: null, scheduleBuilderMode: "shift", templateEditingId: null,
    lastScheduleConflict: null, scheduleEditingId: null, scheduleEditConflict: null,
    scheduleImportRows: null, scheduleImportPreview: null, dashboard: null,
    dashboardDetailTarget: "", coverage: null, coverageDay: 0, recycle: [], invoiceDocuments: [], invoiceView: "review", invoiceCollapsedGroups: new Set(), invoiceGroupAnimationUntil: 0, invoiceGroupRenderTimer: 0, invoiceReprocessStarting: false, invoiceReprocessBusy: false, invoiceReprocessProgress: null, invoiceReprocessHideTimer: 0, invoiceReprocessActiveIds: [], invoiceReprocessPreviousFilter: "", invoiceReprocessBatchId: "", invoiceReprocessOwner: false, invoiceReprocessSyncRunning: false, invoiceReprocessCompletedBatchId: "", apiTimings: [], employeeAllowedPermissions: [
      "clock_in_out", "select_vehicle", "view_own_history", "view_hours",
      "view_history", "view_kilometers", "view_pay", "request_correction"
    ]
  };
  let toastTimer = null;
  let navigationSequence = 0;
  let deferredInstallPrompt = null;
  let fleetPreloadTimer = null;
  let invoiceLiveRefreshRunning = false;

  const $ = function (id) { return document.getElementById(id); };

  function loadToken() {
    try {
      const browserToken = localStorage.getItem(TOKEN_PERSIST) || sessionStorage.getItem(TOKEN_SESSION) || "";
      if (browserToken) return browserToken;
      if (window.AndroidFleet && typeof window.AndroidFleet.getAuthToken === "function") {
        return String(window.AndroidFleet.getAuthToken() || "");
      }
      return "";
    } catch (error) { return ""; }
  }

  function loadCachedUser() {
    try {
      const cached = JSON.parse(localStorage.getItem(USER_CACHE) || "null");
      return cached && cached.id && Array.isArray(cached.permissions) ? cached : null;
    } catch (error) { return null; }
  }

  function saveToken(token, remember) {
    try {
      localStorage.removeItem(TOKEN_PERSIST);
      sessionStorage.removeItem(TOKEN_SESSION);
      (remember ? localStorage : sessionStorage).setItem(remember ? TOKEN_PERSIST : TOKEN_SESSION, token);
    } catch (error) {}
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.saveAuthToken === "function") {
        window.AndroidFleet.saveAuthToken(token, Boolean(remember));
      }
    } catch (error) {}
    state.token = token;
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_PERSIST);
      sessionStorage.removeItem(TOKEN_SESSION);
      localStorage.removeItem(USER_CACHE);
      localStorage.removeItem("moto-service-tracker-v1");
      localStorage.removeItem("fleet-control-pending-fleet-change");
    } catch (error) {}
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.clearAuthToken === "function") window.AndroidFleet.clearAuthToken();
    } catch (error) {}
    state.token = "";
    state.user = null;
    state.dashboard = null;
    state.employees = [];
    state.vehicles = [];
    state.alerts = [];
    state.shifts = [];
    state.schedules = [];
    state.payroll = null;
    state.report = null;
    state.payRules = [];
    state.coverage = null;
    state.apiTimings = [];
    state.recycle = [];
    state.invoiceDocuments = [];
    state.viewLoadedAt = {};
    state.pinResolver = null;
    state.simpleResolver = null;
    document.querySelectorAll("dialog[open]").forEach(function (dialog) { dialog.close(); });
    ["dashboardHero", "actionSection", "dashboardMetrics", "realtimeShifts", "dailySchedule",
      "employeeList", "employeeStats", "shiftsTable", "scheduleList", "scheduleSummary",
      "fleetQuickStats", "fleetStatusList", "payrollSummaryCards", "payrollTable",
      "reportResult", "alertList", "auditTable", "recycleList", "recycleSummary", "invoiceQueueList", "invoiceQueueSummary",
      "coverageSummary", "coverageDays", "coverageTimeline", "serverHealth", "serverWarnings"].forEach(function (id) {
      const element = $(id);
      if (element) element.innerHTML = "";
    });
    setFleetDetailMode(false);
    resetFleetModule();
  }

  function deviceId() {
    try {
      let value = localStorage.getItem(DEVICE_KEY);
      if (!value) {
        value = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem(DEVICE_KEY, value);
      }
      return value;
    } catch (error) { return "device-" + Date.now().toString(36); }
  }

  function platform() {
    if (window.AndroidFleet) return "android";
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "ios" : "web";
  }

  function deviceName() {
    return (platform() === "android" ? "Android" : platform() === "ios" ? "iPhone / iPad" : "Web") + " • " + (navigator.platform || "Browser");
  }

  function can(permission) {
    const values = state.user && Array.isArray(state.user.permissions) ? state.user.permissions : [];
    return values.includes("*") || values.includes(permission);
  }

  async function api(path, options) {
    const settings = options || {};
    const startedAt = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    if (navigator.onLine === false) throw new Error("Δεν υπάρχει σύνδεση με τον Server. Η ενέργεια δεν ολοκληρώθηκε.");
    const headers = new Headers(settings.headers || {});
    if (state.token) headers.set("Authorization", "Bearer " + state.token);
    if (settings.body !== undefined) headers.set("Content-Type", "application/json");
    if (settings.pin) headers.set("X-Admin-Pin", settings.pin);
    if (settings.idempotency) headers.set("X-Idempotency-Key", settings.idempotency);
    let response;
    try {
      response = await fetch(apiBase + path, {
        method: settings.method || (settings.body === undefined ? "GET" : "POST"),
        headers: headers,
        body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
        cache: "no-store"
      });
    } catch (error) {
      throw new Error("Δεν ήταν δυνατή η σύνδεση με τον Server. Η ενέργεια δεν ολοκληρώθηκε.");
    }
    const payload = await response.json().catch(function () { return {}; });
    recordApiTiming(path, response, startedAt);
    if (!response.ok) {
      if (response.status === 401 && settings.keepSession !== true) {
        clearSession();
        showAuth();
      }
      const error = new Error(payload.error || "Η ενέργεια δεν ολοκληρώθηκε.");
      error.code = payload.code || "";
      error.status = response.status;
      error.conflict = payload.conflict || null;
      error.suggestedVehicles = Array.isArray(payload.suggestedVehicles) ? payload.suggestedVehicles : [];
      error.missingVehicles = Array.isArray(payload.missingVehicles) ? payload.missingVehicles : [];
      error.validationErrors = Array.isArray(payload.errors) ? payload.errors : [];
      const validationIssue = error.validationErrors.find(function (item) {
        return item && item.message && (item.code === "vehicle_conflict" || item.code === "employee_conflict" || item.code === "vehicle" || item.code === "time");
      });
      if (validationIssue) {
        error.message = validationIssue.message;
        error.conflict = validationIssue.conflict || error.conflict;
        if (!error.suggestedVehicles.length && Array.isArray(validationIssue.suggestedVehicles)) error.suggestedVehicles = validationIssue.suggestedVehicles;
      }
      throw error;
    }
    return payload;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function initials(value) {
    return String(value || "FC").split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0); }).join("").toLocaleUpperCase("el");
  }

  function money(cents) { return moneyFormat.format(Number(cents || 0) / 100); }
  function km(value) { return numberFormat.format(Number(value || 0)) + " χλμ."; }
  function hours(value) { return numberFormat.format(Math.round(Number(value || 0) * 100) / 100) + " ώρες"; }
  function formatDateTime(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? dateTimeFormat.format(date) : "—"; }
  function formatDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "—"; }
  function datetimeInput(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""; }
  function inputDate(offset) { const date = new Date(Date.now() + Number(offset || 0) * 86400000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function idempotency(action) { return action + "-" + deviceId() + "-" + Date.now() + "-" + Math.random().toString(36).slice(2); }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.add("show");
    toastTimer = setTimeout(function () { $("toast").classList.remove("show"); }, 3800);
  }

  function recordApiTiming(path, response, startedAt) {
    const elapsed = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startedAt);
    state.apiTimings = (state.apiTimings || []).concat([{
      path: path,
      status: response.status,
      elapsedMs: elapsed,
      serverTiming: response.headers.get("Server-Timing") || ""
    }]).slice(-24);
  }

  function roleLabel(role) { return roleLabels[role] || role || "—"; }

  function isManagementAccount() {
    return Boolean(state.user && ["owner", "manager", "fleet_manager", "payroll_manager"].includes(state.user.role));
  }

  function applyAuthMetadata(payload) {
    state.allPermissions = Array.isArray(payload.allPermissions) ? payload.allPermissions : state.allPermissions;
    state.employeeAllowedPermissions = Array.isArray(payload.employeeAllowedPermissions)
      ? payload.employeeAllowedPermissions : state.employeeAllowedPermissions;
    state.rolePermissions = payload.rolePermissions && typeof payload.rolePermissions === "object" ? payload.rolePermissions : state.rolePermissions;
  }

  function applyRoleChrome() {
    const employee = Boolean(state.user && state.user.role === "employee");
    const showNotifications = !employee && can("alerts.view");
    $("notificationButton").classList.toggle("is-hidden", !showNotifications);
    $("notificationButton").setAttribute("aria-hidden", showNotifications ? "false" : "true");
    $("serverMini").classList.toggle("is-hidden", employee);
    if (!showNotifications) {
      $("notificationCount").textContent = "0";
      $("notificationCount").classList.add("is-hidden");
    }
  }

  function showAuth() {
    setFleetDetailMode(false);
    $("bootScreen").classList.add("is-hidden");
    $("portal").classList.add("is-hidden");
    $("authScreen").classList.remove("is-hidden");
    $("loginForm").classList.remove("is-hidden");
    $("bootstrapForm").classList.add("is-hidden");
  }

  function showPortal() {
    $("bootScreen").classList.add("is-hidden");
    $("authScreen").classList.add("is-hidden");
    $("portal").classList.remove("is-hidden");
    $("profileInitials").textContent = initials(state.user.fullName);
    $("profileName").textContent = state.user.fullName;
    $("profileRole").textContent = roleLabel(state.user.role);
    renderNavigation();
    applyRoleChrome();
    let returnToFleet = false;
    try {
      returnToFleet = sessionStorage.getItem("fleet-control-return-to-fleet") === "1" || new URLSearchParams(location.search).get("next") === "fleet";
      sessionStorage.removeItem("fleet-control-return-to-fleet");
    } catch (error) {}
    goTo(returnToFleet && can("fleet.view") ? "fleet" : state.user.role === "employee" ? "employee-home" : "dashboard");
    if (state.user.role !== "employee") {
      loadStatus();
      scheduleFleetPreload();
    }
  }

  function availableNavigation() {
    return navDefinitions.filter(function (item) {
      if (item.employeeOnly && state.user.role !== "employee") return false;
      if (!item.employeeOnly && state.user.role === "employee") return false;
      return can(item.permission);
    });
  }

  function renderNavigation() {
    const items = availableNavigation();
    $("sideNav").innerHTML = items.map(function (item) {
      return '<button class="nav-button" type="button" data-go="' + item.id + '"><span>' + item.icon + '</span><span>' + escapeHtml(item.label) + '</span></button>';
    }).join("");
    const quick = state.user.role === "employee" ? items.slice(0, 2) : items.filter(function (item) { return ["dashboard", "shifts", "employees", "fleet", "invoices", "alerts"].includes(item.id); }).slice(0, 5);
    $("bottomNav").innerHTML = quick.map(function (item) {
      return '<button type="button" data-go="' + item.id + '"><span>' + item.icon + '</span><span>' + escapeHtml(item.label.replace("Μηχανάκια / ", "")) + '</span></button>';
    }).join("");
  }

  async function goTo(view) {
    const allowed = availableNavigation().some(function (item) { return item.id === view; });
    if (!allowed) return;
    const navigationId = ++navigationSequence;
    state.view = view;
    $("portal").classList.toggle("fleet-focus-mode", view === "fleet");
    if (view !== "fleet") setFleetDetailMode(false);
    document.querySelectorAll("[data-view]").forEach(function (section) { section.classList.toggle("is-hidden", section.dataset.view !== view); });
    document.querySelectorAll("[data-go]").forEach(function (button) { button.classList.toggle("active", button.dataset.go === view); });
    const title = viewTitles[view] || ["FLEET CONTROL", "Αρχική"];
    $("pageOverline").textContent = title[0];
    $("pageTitle").textContent = title[1];
    $("portal").classList.remove("sidebar-open");
    window.scrollTo(0, 0);
    if (view === "fleet") ensureFleetModule();
    const ttl = Number(VIEW_CACHE_MS[view] || 0);
    if (ttl && Date.now() - Number(state.viewLoadedAt[view] || 0) < ttl) {
      if (view === "invoices") refreshInvoiceReprocessBatch();
      $("portal").classList.remove("view-loading");
      return;
    }
    $("portal").classList.add("view-loading");
    try {
      if (view === "dashboard") await loadDashboard();
      if (view === "employee-home") await loadEmployeeHome();
      if (view === "shifts") await loadShifts();
      if (view === "schedules") await loadSchedules();
      if (view === "employees") await loadEmployees();
      if (view === "fleet") await loadFleetSummary();
      if (view === "invoices") {
        await loadInvoices();
        await refreshInvoiceReprocessBatch();
      }
      if (view === "payroll") await loadPayroll();
      if (view === "reports") await prepareReports();
      if (view === "alerts") await loadAlerts();
      if (view === "audit") await loadAudit();
      if (view === "recycle") await loadRecycle();
      if (view === "server") await loadStatus(true);
      if (view === "settings") await loadSettings();
      state.viewLoadedAt[view] = Date.now();
    } catch (error) { toast(error.message); }
    finally { if (navigationId === navigationSequence) $("portal").classList.remove("view-loading"); }
  }

  async function initialize() {
    const bootstrapPromise = api("/api/auth/bootstrap-status", { keepSession: true }).then(function (bootstrap) {
      $("showBootstrap").classList.toggle("is-hidden", bootstrap.configured);
      return bootstrap;
    }).catch(function () { return null; });
    try {
      if (!state.token) {
        await bootstrapPromise;
        return showAuth();
      }
      const me = await api("/api/auth/me");
      state.user = me.user;
      applyAuthMetadata(me);
      try { localStorage.setItem(USER_CACHE, JSON.stringify(state.user)); } catch (error) {}
      showPortal();
    } catch (error) {
      const confirmedExpiry = error && (error.status === 401 || /σύνδεση έληξε|Χρειάζεται σύνδεση/i.test(error.message));
      if (confirmedExpiry) {
        clearSession();
        showAuth();
        return;
      }
      const cached = loadCachedUser();
      if (state.token && cached) {
        state.user = cached;
        showPortal();
        toast("Προσωρινό πρόβλημα σύνδεσης. Η συνεδρία σου διατηρήθηκε.");
        return;
      }
      showAuth();
      $("loginError").textContent = error.message;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const button = $("loginButton");
    $("loginError").textContent = "";
    button.disabled = true;
    button.querySelector("span").textContent = "Σύνδεση…";
    try {
      const payload = await api("/api/auth/user-login", {
        method: "POST", keepSession: true,
        body: {
          username: $("loginUsername").value.trim(), password: $("loginPassword").value,
          remember: $("rememberDevice").checked, deviceId: deviceId(), deviceName: deviceName(), platform: platform()
        }
      });
      saveToken(payload.token, $("rememberDevice").checked);
      state.user = payload.user;
      applyAuthMetadata(payload);
      try { localStorage.setItem(USER_CACHE, JSON.stringify(state.user)); } catch (error) {}
      $("loginForm").reset();
      showPortal();
    } catch (error) {
      $("loginError").textContent = error.message;
    } finally {
      button.disabled = false;
      button.querySelector("span").textContent = "Σύνδεση";
    }
  }

  async function handleBootstrap(event) {
    event.preventDefault();
    const button = $("bootstrapButton");
    $("bootstrapError").textContent = "";
    button.disabled = true;
    button.querySelector("span").textContent = "Δημιουργία…";
    try {
      const payload = await api("/api/auth/bootstrap", {
        method: "POST", keepSession: true, pin: $("bootstrapPin").value.trim(),
        body: {
          fullName: $("bootstrapName").value.trim(), username: $("bootstrapUsername").value.trim(),
          email: $("bootstrapEmail").value.trim(), password: $("bootstrapPassword").value,
          remember: true, deviceId: deviceId(), deviceName: deviceName(), platform: platform()
        }
      });
      saveToken(payload.token, true);
      state.user = payload.user;
      applyAuthMetadata(payload);
      showPortal();
      toast("Ο ασφαλής λογαριασμός Owner δημιουργήθηκε.");
    } catch (error) {
      $("bootstrapError").textContent = error.message;
    } finally {
      button.disabled = false;
      button.querySelector("span").textContent = "Δημιουργία ασφαλούς λογαριασμού";
    }
  }

  async function logout() {
    try { await api("/api/auth/user-logout", { method: "POST" }); } catch (error) {}
    clearSession();
    showAuth();
    toast("Έγινε αποσύνδεση.");
  }

  async function showIosInstallGuide() {
    if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) {
      toast("Το Fleet Control είναι ήδη εγκατεστημένο ως Web App.");
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      return;
    }
    if ($("installGuideDialog")) $("installGuideDialog").showModal();
  }

  async function openIosShareMenu() {
    const url = location.origin && /^https?:/.test(location.protocol) ? location.origin + "/" : "https://fleet-control.pavlosargyris.workers.dev/";
    if (!navigator.share) {
      toast("Στο Safari πάτησε Κοινοποίηση και μετά Προσθήκη στην οθόνη Αφετηρίας.");
      return;
    }
    try {
      await navigator.share({ title: "Fleet Control", text: "Fleet Control Web App", url: url });
    } catch (error) {
      if (error && error.name !== "AbortError") toast("Άνοιξε τη σελίδα στο Safari και πάτησε Κοινοποίηση.");
    }
  }

  async function copyIosInstallLink() {
    const url = location.origin && /^https?:/.test(location.protocol) ? location.origin + "/" : "https://fleet-control.pavlosargyris.workers.dev/";
    try {
      await navigator.clipboard.writeText(url);
      toast("Ο σύνδεσμος αντιγράφηκε.");
    } catch (error) {
      window.prompt("Αντέγραψε τον σύνδεσμο:", url);
    }
  }

  async function downloadClientApk() {
    const buttons = [$("loginAndroidDownload"), $("portalDownloadApk")].filter(Boolean);
    buttons.forEach(function (button) { button.disabled = true; });
    try {
      const response = await fetch(apiBase + "/download/client.apk", { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(function () { return {}; });
        throw new Error(payload.error || "Η λήψη του APK απέτυχε.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "Fleet_Control_Client_Latest.apk";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
      toast("Ξεκίνησε η λήψη του Android APK.");
    } catch (error) { toast(error.message); }
    finally { buttons.forEach(function (button) { button.disabled = false; }); }
  }

  function requestPin(reasonRequired) {
    if (isManagementAccount()) {
      return Promise.resolve({
        pin: "",
        reason: reasonRequired === false ? "" : "Επιβεβαίωση από συνδεδεμένο διαχειριστή"
      });
    }
    return new Promise(function (resolve, reject) {
      state.pinResolver = { resolve: resolve, reject: reject, reasonRequired: reasonRequired !== false };
      $("pinForm").reset();
      $("pinError").textContent = "";
      $("criticalReason").closest("label").classList.toggle("is-hidden", reasonRequired === false);
      $("pinDialog").showModal();
      setTimeout(function () { $("criticalPin").focus(); }, 80);
    });
  }

  function cancelPin() {
    if (state.pinResolver) state.pinResolver.reject(new Error("Η ενέργεια ακυρώθηκε."));
    state.pinResolver = null;
    if ($("pinDialog").open) $("pinDialog").close();
  }

  function submitPin(event) {
    event.preventDefault();
    if (!state.pinResolver) return;
    const pin = $("criticalPin").value.trim();
    const reason = $("criticalReason").value.trim();
    if (!/^\d{4,6}$/.test(pin)) return void ($("pinError").textContent = "Το PIN πρέπει να έχει 4 έως 6 αριθμούς.");
    if (state.pinResolver.reasonRequired && !reason) return void ($("pinError").textContent = "Γράψε σύντομη αιτιολογία.");
    const resolver = state.pinResolver;
    state.pinResolver = null;
    $("pinDialog").close();
    resolver.resolve({ pin: pin, reason: reason });
  }

  function simpleEditor(options) {
    return new Promise(function (resolve, reject) {
      state.simpleResolver = { resolve: resolve, reject: reject, collect: options.collect || null };
      $("simpleOverline").textContent = options.overline || "ΕΝΕΡΓΕΙΑ";
      $("simpleTitle").textContent = options.title || "Επεξεργασία";
      $("simpleFields").innerHTML = options.html || "";
      $("simpleDialog").classList.toggle("wide-dialog", Boolean(options.wide));
      $("simpleSubmit").textContent = options.submit || "Αποθήκευση";
      $("simpleSubmit").classList.toggle("danger-button", Boolean(options.danger));
      $("simpleError").textContent = "";
      $("simpleDialog").showModal();
    });
  }

  function cancelSimple() {
    if (state.simpleResolver) state.simpleResolver.reject(new Error("Η ενέργεια ακυρώθηκε."));
    state.simpleResolver = null;
    if ($("simpleDialog").open) $("simpleDialog").close();
  }

  function submitSimple(event) {
    event.preventDefault();
    if (!state.simpleResolver) return;
    try {
      const value = state.simpleResolver.collect ? state.simpleResolver.collect() : {};
      const resolver = state.simpleResolver;
      state.simpleResolver = null;
      $("simpleDialog").close();
      resolver.resolve(value);
    } catch (error) { $("simpleError").textContent = error.message; }
  }

  function statusPill(status) {
    const labels = {
      active: "Working", completed: "Completed", pending_overtime: "Υπερωρία", pending_km: "Εκκρεμή χλμ.",
      pending_correction: "Διόρθωση", cancelled: "Cancelled", planned: "Planned", awaiting: "Awaiting Clock In",
      working: "Working", absent: "Absent", available: "Available", in_use: "In use", reserved: "Reserved",
      service: "Service", inactive: "Inactive", open: "Open", locked: "Locked"
    };
    const warning = ["pending_overtime", "pending_km", "pending_correction", "awaiting", "reserved", "service"].includes(status);
    const critical = ["cancelled", "inactive", "absent"].includes(status);
    return '<span class="status-pill ' + (critical ? "critical" : warning ? "warning" : "") + '">' + escapeHtml(labels[status] || status || "—") + '</span>';
  }

  function metric(label, value, hint, icon, dashboardDetail, tone) {
    const content = '<span>' + escapeHtml(label) + '<i>' + (icon || "•") + '</i></span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(hint || "") + '</small>';
    if (!dashboardDetail) return '<article class="metric-card">' + content + '</article>';
    return '<button class="metric-card metric-card-action' + (tone ? ' metric-card-' + escapeHtml(tone) : '') + '" type="button" data-dashboard-detail="' + escapeHtml(dashboardDetail) + '" aria-label="' + escapeHtml(label) + ' — προβολή λεπτομερειών">' + content + '<em>Λεπτομέρειες <b>→</b></em></button>';
  }

  async function loadStatus(renderFull) {
    try {
      const status = await api("/api/status", { keepSession: true });
      let device = null;
      if (renderFull) {
        try { device = await api("/api/admin/server-health", { keepSession: true }); } catch (error) {}
      }
      state.lastStatus = status;
      $("serverMini").classList.toggle("online", Boolean(status.serverOnline));
      $("serverMini").querySelector("small").textContent = status.serverOnline ? "Online • συγχρονισμένο" : "Εκτός σύνδεσης";
      if (renderFull && $("serverHealth")) {
        const cards = [
          ["Server Online", status.serverOnline, status.lastSeen ? formatDateTime(status.lastSeen) : "Δεν έχει συνδεθεί"],
          ["Database", status.databaseOk, status.databaseOk ? "D1 λειτουργεί" : "Πρόβλημα"],
          ["Storage", status.storageOk, status.storageOk ? "R2 λειτουργεί" : "Δεν έχει συνδεθεί R2"],
          ["Fleet Control", status.fleetControlOk, status.bikes + " μηχανάκια"],
          ["PWA", status.pwaConnected, status.pwaLastSeen ? formatDateTime(status.pwaLastSeen) : "Χωρίς σύνδεση"],
          ["Watchdog", status.watchdogActive, status.watchdogActive ? "Ενεργό" : "Χρειάζεται έλεγχος"],
          ["Backup", Boolean(status.lastBackup), status.lastBackup ? formatDateTime(status.lastBackup) : "Δεν έχει αναφερθεί"],
          ["Ενεργές βάρδιες", true, String(status.activeShifts || 0)],
          ["Ειδοποιήσεις", Number(status.pendingAlerts || 0) === 0, String(status.pendingAlerts || 0)]
        ];
        if (device && device.health) {
          const health = device.health;
          const bytes = function (value) {
            const number = Number(value || 0);
            if (!number) return "—";
            return (number / 1073741824).toLocaleString("el-GR", { maximumFractionDigits: 1 }) + " GB";
          };
          cards.push(
            ["Μπαταρία", Number(health.batteryPercent) > 15 || Boolean(health.batteryCharging), health.batteryPercent == null ? "—" : Math.round(Number(health.batteryPercent)) + "%" + (health.batteryCharging ? " • φορτίζει" : "")],
            ["Θερμοκρασία", Number(health.batteryTemperatureC) < 42, health.batteryTemperatureC == null ? "—" : Number(health.batteryTemperatureC).toFixed(1) + " °C"],
            ["Ελεύθερος χώρος", Number(health.storageFreePercent) > 10, bytes(health.storageFreeBytes) + (health.storageFreePercent == null ? "" : " • " + health.storageFreePercent + "%")],
            ["Android restriction", health.ignoringBatteryOptimizations !== false && !health.powerSaveMode, health.ignoringBatteryOptimizations === false ? "Χρειάζεται εξαίρεση μπαταρίας" : health.powerSaveMode ? "Ενεργή εξοικονόμηση" : "Χωρίς περιορισμό"],
            ["Δίκτυο Server", Boolean(health.networkConnected), health.networkConnected ? (health.networkType || "Συνδεδεμένο") : "Χωρίς σύνδεση"]
          );
        }
        $("serverHealth").innerHTML = cards.map(function (card) {
          return '<article class="health-card ' + (card[1] ? "ok" : "") + '"><i></i><span><strong>' + escapeHtml(card[0]) + '</strong><small>' + escapeHtml(card[2]) + '</small></span></article>';
        }).join("");
        const warnings = device && Array.isArray(device.warnings) ? device.warnings : [];
        $("serverWarnings").classList.toggle("is-hidden", !warnings.length);
        $("serverWarnings").innerHTML = warnings.map(function (warning) { return '<p><b>!</b><span>' + escapeHtml(warning.message) + '</span></p>'; }).join("");
      }
    } catch (error) {
      $("serverMini").classList.remove("online");
      $("serverMini").querySelector("small").textContent = "Χωρίς σύνδεση";
      if (renderFull) toast(error.message);
    }
  }

  async function loadDashboard() {
    const data = await api("/api/workforce/dashboard");
    state.dashboard = data;
    const missedClockIns = missedClockInGroups(data);
    $("dashboardHero").innerHTML = '<span>ΚΑΛΩΣ ΗΡΘΕΣ</span><h2>' + escapeHtml(state.user.fullName) + '</h2><p>Η σημερινή εικόνα του Fleet Control είναι συγκεντρωμένη εδώ.</p>';
    $("actionSection").innerHTML = data.actionCount
      ? '<div class="action-card"><i>!</i><span><strong>Χρειάζεται ενέργεια</strong><small>' + data.actionCount + ' εκκρεμότητες χρειάζονται έλεγχο.</small></span><button class="secondary-button" type="button" data-go="alerts">Προβολή</button></div>'
      : '<div class="action-card ok"><i>✓</i><span><strong>Όλα λειτουργούν κανονικά</strong><small>Δεν υπάρχει εκκρεμότητα αυτή τη στιγμή.</small></span></div>';
    const vehicle = data.today.vehicles || {};
    $("dashboardMetrics").innerHTML = [
      metric("Εργαζόμενοι", String(data.today.workingNow || 0), "Σε βάρδια τώρα", "♙", "employees"),
      metric("Δεν έκαναν Clock In", String(missedClockIns.length), missedClockIns.length ? "Χρειάζεται έλεγχος" : "Όλοι στην ώρα τους", "!", "missed-clock-ins", missedClockIns.length ? "warning" : ""),
      metric("Μηχανάκια σε χρήση", String(vehicle.in_use || 0), (vehicle.available || 0) + " διαθέσιμα", "◇", "vehicles"),
      metric("Payable ώρες εβδομάδας", String(data.currentWeek.payableHours || 0), data.currentWeek.startDate + " – " + data.currentWeek.endDate, "◷", "hours"),
      metric("Μισθοδοσία εβδομάδας", money(data.currentWeek.payrollCents), km(data.currentWeek.kilometers), "€", "payroll")
    ].join("");
    $("notificationCount").textContent = data.actionCount || 0;
    $("notificationCount").classList.toggle("is-hidden", !data.actionCount);
    $("realtimeShifts").innerHTML = data.realtime.length ? data.realtime.map(function (item) {
      return '<div class="data-row"><span><strong>' + escapeHtml(item.employee_name) + '</strong><small>' + escapeHtml(item.vehicle_name) + '</small></span><span><strong>' + formatDateTime(item.actual_clock_in) + '</strong><small>' + (item.out_of_schedule ? "Εκτός προγράμματος" : "Κανονική βάρδια") + '</small></span>' + statusPill(item.out_of_schedule ? "pending_correction" : item.status) + '</div>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχει ενεργή βάρδια.</p>';
    $("dailySchedule").innerHTML = data.dailySchedule.length ? data.dailySchedule.map(function (item) {
      return '<div class="data-row"><span><strong>' + escapeHtml(item.employee_name) + '</strong><small>' + escapeHtml(item.vehicle_name || "Χωρίς προανάθεση") + '</small></span><span><strong>' + formatDateTime(item.start_at) + '</strong><small>έως ' + formatDateTime(item.end_at) + '</small></span>' + statusPill(item.status) + '</div>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχει πρόγραμμα για σήμερα.</p>';
    $("coverageTimeline").innerHTML = '<p class="empty-copy">Φόρτωση κάλυψης χωρίς καθυστέρηση του Dashboard…</p>';
    loadCoverage().catch(function (error) {
      $("coverageTimeline").innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>';
    });
  }

  function renderCoverage() {
    const data = state.coverage;
    if (!data || !Array.isArray(data.days)) return;
    const summary = data.summary || {};
    $("coverageSummary").innerHTML = [
      ["Κάλυψη", String(summary.coveragePercent == null ? 100 : summary.coveragePercent) + "%", "covered"],
      ["Κενά μισάωρα", String(summary.undercoveredSlots || 0), "under"],
      ["Υπερκάλυψη", String(summary.overcoveredSlots || 0), "over"],
      ["Επερχόμενα", String(summary.upcomingSlots || 0), "planned"]
    ].map(function (item) {
      return '<span class="coverage-summary-card ' + item[2] + '"><small>' + item[0] + '</small><strong>' + item[1] + '</strong></span>';
    }).join("");
    const weekdayNames = ["Δευ", "Τρι", "Τετ", "Πεμ", "Παρ", "Σαβ", "Κυρ"];
    $("coverageDays").innerHTML = data.days.map(function (day, index) {
      const issues = day.buckets.filter(function (bucket) { return bucket.status === "under"; }).length;
      const upcoming = day.buckets.filter(function (bucket) { return bucket.status === "planned"; }).length;
      const marker = issues ? '<b>' + issues + '</b>' : upcoming ? '<i class="planned-day-marker">◷</i>' : '<i>✓</i>';
      return '<button type="button" role="tab" aria-selected="' + (index === state.coverageDay ? "true" : "false") + '" class="' + (index === state.coverageDay ? "active" : "") + '" data-coverage-day="' + index + '"><strong>' + weekdayNames[index] + '</strong><small>' + escapeHtml(String(day.date || "").slice(8, 10) + "/" + String(day.date || "").slice(5, 7)) + '</small>' + marker + '</button>';
    }).join("");
    const selected = data.days[state.coverageDay] || data.days[0];
    const activeBuckets = selected.buckets.filter(function (bucket) { return bucket.planned || bucket.actual; });
    $("coverageTimeline").innerHTML = activeBuckets.length ? activeBuckets.map(function (bucket) {
      const label = bucket.status === "under" ? "Κενό" : bucket.status === "over" ? "Υπερκάλυψη" : bucket.status === "planned" ? "Προγραμματισμένο" : "Καλυμμένο";
      const people = '<span><small>Πρόγραμμα</small><strong>' + escapeHtml(bucket.plannedEmployees.join(", ") || "—") + '</strong></span><span><small>Παρόντες</small><strong>' + escapeHtml(bucket.actualEmployees.join(", ") || "—") + '</strong></span>';
      return '<article class="coverage-row ' + bucket.status + '"><time>' + escapeHtml(bucket.time) + (bucket.nextDay ? '<small>+1</small>' : '') + '</time><div class="coverage-counts"><span><b>' + bucket.planned + '</b><small>planned</small></span><span><b>' + bucket.actual + '</b><small>actual</small></span></div><div class="coverage-people">' + people + '</div><em>' + label + '</em></article>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχει πρόγραμμα ή πραγματική βάρδια για αυτή την ημέρα.</p>';
  }

  async function loadCoverage() {
    const panel = document.querySelector(".coverage-panel");
    if (!can("schedules.view")) {
      if (panel) panel.classList.add("is-hidden");
      return;
    }
    if (panel) panel.classList.remove("is-hidden");
    if (!$("coverageWeek").value) $("coverageWeek").value = mondayDate();
    const data = await api("/api/admin/staffing-coverage?week=" + encodeURIComponent($("coverageWeek").value));
    state.coverage = data;
    $("coverageWeek").value = data.weekStart;
    const today = inputDate(0);
    state.coverageDay = today >= data.weekStart && today <= data.weekEnd ? Math.max(0, Math.min(6, Math.round((new Date(today + "T12:00:00") - new Date(data.weekStart + "T12:00:00")) / 86400000))) : Math.max(0, Math.min(6, state.coverageDay || 0));
    renderCoverage();
  }

  function dashboardFacts(items) {
    return '<div class="dashboard-detail-facts">' + items.map(function (item) {
      return '<span><small>' + escapeHtml(item[0]) + '</small><strong>' + escapeHtml(item[1]) + '</strong></span>';
    }).join("") + '</div>';
  }

  function dashboardRows(items, renderer) {
    if (!items.length) return '<p class="empty-copy">Δεν υπάρχουν αναλυτικές εγγραφές.</p>';
    return '<div class="dashboard-detail-list">' + items.slice(0, 12).map(renderer).join("") + '</div>' +
      (items.length > 12 ? '<p class="dashboard-more-copy">Εμφανίζονται οι πρώτες 12 από ' + items.length + ' εγγραφές.</p>' : '');
  }

  function clockOnly(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? timeFormat.format(date) : "—";
  }

  function missedClockInGroups(data) {
    const source = Array.isArray(data && data.missedClockIns)
      ? data.missedClockIns
      : ((data && data.dailySchedule) || []).filter(function (item) {
          const start = new Date(item.start_at || item.startAt).getTime();
          return ["planned", "awaiting", "absent"].includes(String(item.status || "")) && Number.isFinite(start) && start <= Date.now();
        });
    const grouped = new Map();
    source.forEach(function (item) {
      const employeeId = String(item.employee_id || item.employeeId || item.employee_name || item.employeeName || "");
      if (!employeeId) return;
      if (!grouped.has(employeeId)) grouped.set(employeeId, {
        employeeId: employeeId,
        employeeName: item.employee_name || item.employeeName || "—",
        starts: []
      });
      const start = item.start_at || item.startAt;
      if (start && !grouped.get(employeeId).starts.includes(start)) grouped.get(employeeId).starts.push(start);
    });
    return Array.from(grouped.values()).map(function (item) {
      item.starts.sort();
      return item;
    }).sort(function (left, right) {
      return String(left.starts[0] || "").localeCompare(String(right.starts[0] || "")) || String(left.employeeName).localeCompare(String(right.employeeName), "el");
    });
  }

  function activeClockInPreview(items) {
    const active = (items || []).slice().sort(function (left, right) { return String(left.actual_clock_in || "").localeCompare(String(right.actual_clock_in || "")); });
    return '<div class="clock-preview-count live"><strong>' + active.length + '</strong><span>' + (active.length === 1 ? "εργαζόμενος σε βάρδια" : "εργαζόμενοι σε βάρδια") + '</span></div>' +
      (active.length ? '<div class="clock-preview-list">' + active.map(function (item) {
        return '<div class="clock-preview-row"><i aria-hidden="true"></i><span><strong>' + escapeHtml(item.employee_name || "—") + '</strong><small>Clock In στις ' + escapeHtml(clockOnly(item.actual_clock_in)) + '</small></span></div>';
      }).join("") + '</div>' : '<p class="clock-preview-empty">Κανένας εργαζόμενος δεν έχει κάνει Clock In αυτή τη στιγμή.</p>');
  }

  function missedClockInPreview(items) {
    return '<div class="clock-preview-count warning"><strong>' + items.length + '</strong><span>' + (items.length === 1 ? "εργαζόμενος δεν έκανε Clock In" : "εργαζόμενοι δεν έκαναν Clock In") + '</span></div>' +
      (items.length ? '<div class="clock-preview-list warning">' + items.map(function (item) {
        const starts = item.starts.map(clockOnly).join(" · ");
        return '<div class="clock-preview-row"><i aria-hidden="true"></i><span><strong>' + escapeHtml(item.employeeName) + '</strong><small>Προγραμματισμένη έναρξη: ' + escapeHtml(starts || "—") + '</small></span></div>';
      }).join("") + '</div>' : '<p class="clock-preview-empty success">Δεν υπάρχει εργαζόμενος που να έπρεπε ήδη να ξεκινήσει χωρίς Clock In.</p>');
  }

  async function openDashboardDetail(kind) {
    const data = state.dashboard;
    if (!data) return;
    const vehicle = data.today.vehicles || {};
    const configs = {
      employees: { title: "Σε βάρδια τώρα", target: "", permission: "dashboard.view", action: "" },
      "missed-clock-ins": { title: "Δεν έκαναν Clock In", target: "", permission: "dashboard.view", action: "" },
      vehicles: { title: "Κατάσταση μηχανών", target: "fleet", permission: "fleet.view", action: "Άνοιγμα Fleet Control" },
      hours: { title: "Ώρες εβδομάδας", target: "shifts", permission: "shifts.view", action: "Άνοιγμα βαρδιών" },
      payroll: { title: "Μισθοδοσία εβδομάδας", target: "payroll", permission: "payroll.view", action: "Άνοιγμα μισθοδοσίας" }
    };
    const config = configs[kind];
    if (!config) return;
    state.dashboardDetailTarget = can(config.permission) ? config.target : "";
    $("dashboardDetailTitle").textContent = config.title;
    $("dashboardDetailOpen").textContent = config.action;
    $("dashboardDetailOpen").classList.toggle("is-hidden", !state.dashboardDetailTarget);
    $("dashboardDetailContent").innerHTML = '<p class="empty-copy">Φόρτωση λεπτομερειών…</p>';
    $("dashboardDetailDialog").showModal();
    try {
      if (kind === "employees") {
        $("dashboardDetailContent").innerHTML = activeClockInPreview(data.realtime || []);
        return;
      }
      if (kind === "missed-clock-ins") {
        $("dashboardDetailContent").innerHTML = missedClockInPreview(missedClockInGroups(data));
        return;
      }
      if (kind === "vehicles") {
        const response = can("fleet.view") ? await api("/api/workforce/vehicles") : { vehicles: [] };
        const vehicles = response.vehicles || [];
        state.vehicles = vehicles;
        const ordered = vehicles.slice().sort(function (a, b) {
          const priority = { in_use: 0, service: 1, reserved: 2, available: 3, inactive: 4 };
          return (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || String(a.name).localeCompare(String(b.name), "el");
        });
        $("dashboardDetailContent").innerHTML = dashboardFacts([
          ["Σε χρήση", String(vehicle.in_use || 0)], ["Διαθέσιμα", String(vehicle.available || 0)],
          ["Δεσμευμένα", String(vehicle.reserved || 0)], ["Service / ανενεργά", String(Number(vehicle.service || 0) + Number(vehicle.inactive || 0))]
        ]) + dashboardRows(ordered, function (item) {
          return '<div class="dashboard-detail-row"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(km(item.odometer)) + '</small></span>' + statusPill(item.status) + '</div>';
        });
        return;
      }
      if (kind === "hours") {
        const response = can("shifts.view") ? await api("/api/admin/shifts?from=" + encodeURIComponent(data.currentWeek.startDate) + "&to=" + encodeURIComponent(data.currentWeek.endDate)) : { shifts: [] };
        const shifts = response.shifts || [];
        $("dashboardDetailContent").innerHTML = dashboardFacts([
          ["Περίοδος", data.currentWeek.startDate + " – " + data.currentWeek.endDate],
          ["Payable ώρες", hours(data.currentWeek.payableHours || 0)], ["Χιλιόμετρα", km(data.currentWeek.kilometers || 0)]
        ]) + dashboardRows(shifts, function (item) {
          return '<div class="dashboard-detail-row"><span><strong>' + escapeHtml(item.employeeName || "—") + '</strong><small>' + escapeHtml(item.vehicleName || "Χωρίς μηχανάκι") + '</small></span><span><strong>' + escapeHtml(hours(item.payableHours || 0)) + '</strong><small>' + escapeHtml(item.actualClockIn ? formatDateTime(item.actualClockIn) : "—") + '</small></span></div>';
        });
        return;
      }
      const response = can("payroll.view") ? await api("/api/admin/payroll?start=" + encodeURIComponent(data.currentWeek.startDate) + "&end=" + encodeURIComponent(data.currentWeek.endDate)) : { employees: [] };
      const payroll = response.employees || [];
      $("dashboardDetailContent").innerHTML = dashboardFacts([
        ["Περίοδος", data.currentWeek.startDate + " – " + data.currentWeek.endDate],
        ["Σύνολο", money(data.currentWeek.payrollCents || 0)], ["Payable ώρες", hours(data.currentWeek.payableHours || 0)],
        ["Χιλιόμετρα", km(data.currentWeek.kilometers || 0)]
      ]) + dashboardRows(payroll, function (item) {
        return '<div class="dashboard-detail-row"><span><strong>' + escapeHtml(item.employeeName || "—") + '</strong><small>' + escapeHtml(hours(item.payableHours || 0)) + '</small></span><span><strong>' + escapeHtml(money(item.finalCents || 0)) + '</strong><small>' + escapeHtml(km(item.kilometers || 0)) + '</small></span></div>';
      });
    } catch (error) {
      $("dashboardDetailContent").innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>';
    }
  }

  function activeShiftHtml(shift) {
    const ownVehicle = Boolean(shift.ownVehicle);
    const details = ownVehicle
      ? '<div class="shift-details"><span><small>Start</small><strong>' + formatDateTime(shift.actualClockIn) + '</strong></span><span><small>Καταγραφή</small><strong>Χωρίς χιλιόμετρα</strong></span></div>'
      : '<div class="shift-details"><span><small>Start</small><strong>' + formatDateTime(shift.actualClockIn) + '</strong></span><span><small>Initial km</small><strong>' + km(shift.initialKm) + '</strong></span></div>';
    const clockOut = ownVehicle
      ? '<form id="clockOutForm" class="clockout-form"><p class="own-vehicle-note">Η βάρδια καταγράφεται χωρίς αρχικά/τελικά χιλιόμετρα και χωρίς ενημέρωση μηχανής στόλου.</p><button class="clock-button" type="submit">CLOCK OUT</button><p id="clockOutError" class="form-error"></p></form>'
      : '<form id="clockOutForm" class="clockout-form"><label class="field"><span>Τρέχοντα χιλιόμετρα</span><input id="clockOutKm" type="number" min="' + Number(shift.initialKm) + '" inputmode="numeric" required></label><button class="clock-button" type="submit">CLOCK OUT</button><p id="clockOutError" class="form-error"></p></form>';
    return '<section class="active-shift-card"><div class="active-banner"><i></i> Η βάρδια σας είναι ενεργή</div>' +
      '<div class="shift-machine"><small>Μηχανάκι</small><strong>' + escapeHtml(shift.vehicleName) + '</strong></div>' +
      details + clockOut +
      (state.user.canChangeVehicle && !ownVehicle ? '<button id="employeeChangeVehicle" class="secondary-button" type="button">Αλλαγή μηχανής</button>' : '') +
      '<button id="correctionButton" class="text-button" type="button">Αίτημα διόρθωσης</button></section>';
  }

  function completionHtml(completion) {
    const metrics = [];
    if (completion.actualClockIn) metrics.push(["Clock In", formatDateTime(completion.actualClockIn)]);
    if (completion.actualClockOut) metrics.push(["Clock Out", formatDateTime(completion.actualClockOut)]);
    if (completion.payableHours != null) metrics.push(["Payable", hours(completion.payableHours)]);
    if (completion.paymentCents != null) metrics.push(["Πληρωμή", money(completion.paymentCents)]);
    if (completion.shiftKilometers != null) metrics.push(["Χιλιόμετρα", km(completion.shiftKilometers)]);
    return '<section class="completion-card"><div class="check">✓</div><h2>Η βάρδια ολοκληρώθηκε επιτυχώς.</h2><p>Η καταγραφή σας αποθηκεύτηκε.' + (completion.pendingOvertime ? '<br>Η υπερωρία περιμένει έγκριση Admin.' : '') + '</p>' +
      (metrics.length ? '<div class="completion-metrics">' + metrics.map(function (item) { return '<span><small>' + item[0] + '</small><strong>' + item[1] + '</strong></span>'; }).join("") + '</div>' : '') +
      '<button id="completionBack" class="primary-button large" type="button"><span>Επιστροφή στην αρχική</span><b>→</b></button></section>';
  }

  function renderEmployeeActiveShift(shift) {
    $("employeeHome").innerHTML = activeShiftHtml(shift);
    $("clockOutForm").addEventListener("submit", handleClockOut);
    $("correctionButton").addEventListener("click", openCorrection);
    if ($("employeeChangeVehicle")) $("employeeChangeVehicle").addEventListener("click", changeEmployeeVehicle);
  }

  async function loadEmployeeHome() {
    if (state.completion) {
      $("employeeHome").innerHTML = completionHtml(state.completion);
      $("completionBack").addEventListener("click", function () { state.completion = null; loadEmployeeHome(); });
      return;
    }
    const data = await api("/api/employee/home");
    state.user = data.user || state.user;
    if (data.activeShift) {
      renderEmployeeActiveShift(data.activeShift);
      return;
    }
    const weekly = data.scheduleWeek && data.scheduleWeek.entries && data.scheduleWeek.entries.length
      ? '<section class="panel employee-week-schedule"><div class="panel-heading"><span><small>ΕΒΔΟΜΑΔΑ ' + escapeHtml(data.scheduleWeek.weekStart) + '</small><h3>Το πρόγραμμά μου</h3></span>' + (data.scheduleWeek.revision && !data.scheduleWeek.acknowledged ? '<button id="ackScheduleButton" class="secondary-button" type="button">Το είδα</button>' : (data.scheduleWeek.acknowledged ? '<span class="status-pill available">Επιβεβαιώθηκε</span>' : "")) + '</div><div class="data-list">' + data.scheduleWeek.entries.map(function (entry) { return '<div class="data-row"><span><strong>' + escapeHtml(formatDateTime(entry.startAt)) + '</strong><small>' + escapeHtml(entry.vehicleName || "Χωρίς μηχανάκι") + '</small></span><span>' + statusPill(entry.status) + '</span></div>'; }).join("") + '</div></section>' : "";
    const schedule = (data.schedule ? '<div class="panel" style="margin-bottom:14px"><span class="overline">ΠΡΟΓΡΑΜΜΑΤΙΣΜΕΝΗ ΒΑΡΔΙΑ</span><h3>' + formatDateTime(data.schedule.startAt) + ' – ' + formatDateTime(data.schedule.endAt) + '</h3></div>' : "") + weekly;
    const ownVehicle = Boolean(data.user && data.user.usesOwnVehicle);
    const choices = ownVehicle
      ? '<div class="own-vehicle-home-note"><strong>Ιδιόκτητο μηχανάκι</strong><span>Δεν χρειάζεται επιλογή μηχανής και δεν θα ζητηθούν χιλιόμετρα.</span></div>'
      : data.vehicles.length ? '<div class="vehicle-choice-list">' + data.vehicles.map(function (vehicle, index) {
      return '<label class="vehicle-choice"><input type="radio" name="clockVehicle" value="' + escapeHtml(vehicle.id) + '" ' + (index === 0 ? "checked" : "") + '><span><strong>' + escapeHtml(vehicle.name) + '</strong><small>' + km(vehicle.odometer) + (vehicle.assigned ? " • Ανατεθειμένο" : "") + '</small></span></label>';
    }).join("") + '</div>' : '<p class="empty-copy">Δεν υπάρχει διαθέσιμο μηχανάκι.</p>';
    $("employeeHome").innerHTML = schedule + '<section class="employee-shift-hero"><span class="shift-state">● ΕΤΟΙΜΟΣ ΓΙΑ ΒΑΡΔΙΑ</span><h2>Δεν υπάρχει ενεργή βάρδια</h2><p>' + (ownVehicle ? 'Πάτησε CLOCK IN για να ξεκινήσεις με το ιδιόκτητο μηχανάκι σου.' : 'Διάλεξε διαθέσιμο μηχανάκι και ξεκίνησε.') + '</p></section><section class="panel" style="margin-top:15px"><span class="overline">' + (ownVehicle ? 'ΙΔΙΟΚΤΗΤΟ ΜΗΧΑΝΑΚΙ' : 'ΔΙΑΘΕΣΙΜΑ ΜΗΧΑΝΑΚΙΑ') + '</span>' + choices + '<button id="clockInButton" class="clock-button" type="button" ' + (ownVehicle || data.vehicles.length ? "" : "disabled") + '>CLOCK IN</button><p id="clockInError" class="form-error"></p></section>';
    $("clockInButton").addEventListener("click", handleClockIn);
    if ($("ackScheduleButton")) $("ackScheduleButton").addEventListener("click", async function () {
      try { await api("/api/employee/schedule-acknowledge", { method: "POST", body: { weekStart: data.scheduleWeek.weekStart } }); toast("Το πρόγραμμα επιβεβαιώθηκε."); await loadEmployeeHome(); }
      catch (error) { toast(error.message); }
    });
  }

  async function handleClockIn() {
    const selected = document.querySelector('[name="clockVehicle"]:checked');
    const ownVehicle = Boolean(state.user && state.user.usesOwnVehicle);
    if (!ownVehicle && !selected) return void ($("clockInError").textContent = "Διάλεξε μηχανάκι.");
    const button = $("clockInButton");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Καταχώρηση…";
    try {
      const result = await api("/api/employee/clock-in", { method: "POST", idempotency: idempotency("clock-in"), body: ownVehicle ? {} : { vehicleId: selected.value } });
      toast("Η βάρδια ξεκίνησε.");
      if (result.shift) {
        // The Worker response is already authoritative. Show it immediately
        // and reconcile the full home payload in the background.
        state.viewLoadedAt["employee-home"] = Date.now();
        renderEmployeeActiveShift(result.shift);
        loadEmployeeHome().catch(function () {});
      } else {
        await loadEmployeeHome();
      }
    } catch (error) {
      $("clockInError").textContent = error.message;
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
      button.textContent = "CLOCK IN";
    }
  }

  async function handleClockOut(event) {
    event.preventDefault();
    const ownVehicle = Boolean(state.user && state.user.usesOwnVehicle);
    const finalKmField = $("clockOutKm");
    const finalKm = finalKmField ? Number(finalKmField.value) : null;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Καταχώρηση…";
    try {
      state.completion = await api("/api/employee/clock-out", { method: "POST", idempotency: idempotency("clock-out"), body: ownVehicle ? {} : { finalKm: finalKm } });
      await loadEmployeeHome();
    } catch (error) {
      $("clockOutError").textContent = error.message;
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
      button.textContent = "CLOCK OUT";
    }
  }

  async function openCorrection() {
    try {
      const data = await simpleEditor({
        overline: "ΑΙΤΗΜΑ ΕΡΓΑΖΟΜΕΝΟΥ", title: "Αίτημα διόρθωσης", submit: "Αποστολή",
        html: '<label class="field"><span>Τύπος</span><select id="correctionType"><option value="forgot_clock_out">Ξέχασα Clock Out</option><option value="wrong_km">Λάθος χιλιόμετρα</option><option value="other">Άλλο</option></select></label><label class="field"><span>Περιγραφή</span><textarea id="correctionMessage" rows="4" required></textarea></label>',
        collect: function () { const message = $("correctionMessage").value.trim(); if (!message) throw new Error("Γράψε τι χρειάζεται διόρθωση."); return { type: $("correctionType").value, message: message }; }
      });
      await api("/api/employee/corrections", { method: "POST", body: data });
      toast("Το αίτημα διόρθωσης στάλθηκε.");
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function changeEmployeeVehicle() {
    try {
      const vehicles = (await api("/api/workforce/vehicles")).vehicles || [];
      const available = vehicles.filter(function (item) { return item.available; });
      const data = await simpleEditor({
        overline: "ACTIVE SHIFT", title: "Αλλαγή μηχανής", submit: "Επιβεβαίωση αλλαγής",
        html: '<label class="field"><span>Τρέχοντα χιλιόμετρα παλιάς μηχανής</span><input id="employeeOldKm" type="number" inputmode="numeric" required></label><label class="field"><span>Νέο μηχανάκι</span><select id="employeeNextVehicle">' + available.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + ' • ' + escapeHtml(km(item.odometer)) + '</option>'; }).join("") + '</select></label>',
        collect: function () { if (!available.length) throw new Error("Δεν υπάρχει άλλο διαθέσιμο μηχανάκι."); const currentKm = Number($("employeeOldKm").value); if (!Number.isFinite(currentKm)) throw new Error("Γράψε τα χιλιόμετρα."); return { currentKm: currentKm, vehicleId: $("employeeNextVehicle").value }; }
      });
      await api("/api/employee/change-vehicle", { method: "POST", idempotency: idempotency("employee-change-vehicle"), body: data });
      toast("Η αλλαγή μηχανής επιβεβαιώθηκε από τον Server.");
      await loadEmployeeHome();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function loadAdminLists() {
    const tasks = [];
    if (!state.employees.length && can("employees.view")) tasks.push(api("/api/admin/employees").then(function (data) { state.employees = data.employees || []; }));
    if (!state.vehicles.length && (can("fleet.view") || can("fleet.manage") || can("select_vehicle"))) tasks.push(api("/api/workforce/vehicles").then(function (data) { state.vehicles = data.vehicles || []; }));
    if (!state.payRules.length && can("payroll.view")) tasks.push(api("/api/admin/pay-rules").then(function (data) { state.payRules = data.rules || []; }));
    await Promise.all(tasks);
  }

  async function loadEmployees() {
    const [data, vehicleData, rulesData] = await Promise.all([
      api("/api/admin/employees"),
      !state.vehicles.length && (can("fleet.view") || can("fleet.manage")) ? api("/api/workforce/vehicles") : Promise.resolve(null),
      !state.payRules.length && can("payroll.view") ? api("/api/admin/pay-rules") : Promise.resolve(null)
    ]);
    state.employees = data.employees || [];
    if (vehicleData) state.vehicles = vehicleData.vehicles || [];
    if (rulesData) state.payRules = rulesData.rules || [];
    const active = state.employees.filter(function (item) { return item.active; }).length;
    const employees = state.employees.filter(function (item) { return item.role === "employee"; }).length;
    const managers = state.employees.filter(function (item) { return item.role !== "employee"; }).length;
    $("newEmployeeButton").classList.toggle("is-hidden", !can("employees.manage"));
    $("employeeStats").innerHTML = [
      metric("Ενεργοί λογαριασμοί", String(active), state.employees.length + " συνολικά", "●"),
      metric("Εργαζόμενοι", String(employees), "Ρόλος Employee", "♙"),
      metric("Διαχειριστές", String(managers), "Owner / Managers", "⌾")
    ].join("");
    function vehicleLabel(item) {
      if (item.usesOwnVehicle) return "Ιδιόκτητο μηχανάκι";
      const vehicle = state.vehicles.find(function (entry) { return String(entry.id) === String(item.assignedVehicleId); });
      return vehicle ? vehicle.name : "Χωρίς ανάθεση";
    }
    $("employeeList").innerHTML = state.employees.length ? state.employees.map(function (item) {
      const rule = state.payRules.find(function (entry) { return String(entry.id) === String(item.payRuleId); });
      const editActions = (can("employees.manage") ? '<button type="button" data-employee-edit="' + escapeHtml(item.id) + '">Επεξεργασία</button>' : '') + (can("security.manage") ? '<button type="button" data-password-reset="' + escapeHtml(item.id) + '">Νέος κωδικός</button><button type="button" data-force-logout="' + escapeHtml(item.id) + '">Αποσύνδεση</button>' : '');
      return '<article class="employee-card ' + (item.active ? "" : "disabled") + '"><div class="employee-card-head"><div class="employee-avatar">' + escapeHtml(initials(item.fullName)) + '</div><div class="employee-identity"><strong>' + escapeHtml(item.fullName) + '</strong><small>@' + escapeHtml(item.username) + ' • ' + escapeHtml(roleLabel(item.role)) + '</small></div>' + statusPill(item.active ? "available" : "inactive") + '</div><div class="employee-meta"><span><small>Μηχανάκι</small><strong>' + escapeHtml(vehicleLabel(item)) + '</strong></span><span><small>Κανόνας πληρωμής</small><strong>' + escapeHtml(rule ? rule.name + " • v" + rule.version : item.payRuleId || "Αυτόματος") + '</strong></span><span><small>Ομάδα</small><strong>' + escapeHtml(item.employeeGroup || "Χωρίς ομάδα") + '</strong></span><span><small>Τελευταία σύνδεση</small><strong>' + escapeHtml(item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "Ποτέ") + '</strong></span></div><div class="employee-card-actions"><button type="button" data-employee-detail="' + escapeHtml(item.id) + '">Προβολή</button>' + editActions + '</div></article>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχουν λογαριασμοί.</p>';
  }

  function employeeFacts(items) {
    return '<div class="employee-detail-facts">' + items.map(function (item) {
      return '<span><small>' + escapeHtml(item[0]) + '</small><strong>' + escapeHtml(item[1] == null || item[1] === "" ? "—" : item[1]) + '</strong></span>';
    }).join("") + '</div>';
  }

  async function openEmployeeDetail(id) {
    const item = state.employees.find(function (entry) { return String(entry.id) === String(id); });
    if (!item) return;
    state.employeeDetailId = item.id;
    $("employeeDetailTitle").textContent = item.fullName;
    $("employeeDetailTabs").querySelectorAll("[data-tab-permission]").forEach(function (button) {
      button.classList.toggle("is-hidden", !can(button.dataset.tabPermission));
    });
    $("employeeDetailTabs").querySelectorAll("button").forEach(function (button) { button.classList.toggle("active", button.dataset.employeeDetailTab === "details"); });
    $("employeeDetailDialog").showModal();
    await loadEmployeeDetail("details");
  }

  async function loadEmployeeDetail(tab) {
    const item = state.employees.find(function (entry) { return String(entry.id) === String(state.employeeDetailId); });
    if (!item) return;
    $("employeeDetailContent").innerHTML = '<p class="empty-copy">Φόρτωση…</p>';
    try {
      if (tab === "details") {
        const vehicle = state.vehicles.find(function (entry) { return String(entry.id) === String(item.assignedVehicleId); });
        const rule = state.payRules.find(function (entry) { return String(entry.id) === String(item.payRuleId); });
        $("employeeDetailContent").innerHTML = employeeFacts([
          ["Ονοματεπώνυμο", item.fullName], ["Username", item.username], ["Email", item.email], ["Τηλέφωνο", item.phone],
          ["Ρόλος", roleLabel(item.role)], ["Κατάσταση", item.active ? "Ενεργός" : "Ανενεργός"],
          ["Ομάδα", item.employeeGroup || "Χωρίς ομάδα"], ["Κανόνας πληρωμής", rule ? rule.name + " • v" + rule.version : item.payRuleId || "Αυτόματος"],
          ["Μηχανάκι", item.usesOwnVehicle ? "Ιδιόκτητο μηχανάκι — χωρίς χιλιόμετρα" : (vehicle ? vehicle.name : "Χωρίς ανάθεση")], ["Πρόσληψη", item.hireDate ? formatDate(item.hireDate) : "—"],
          ["Τελευταία σύνδεση", item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "Ποτέ"], ["Σημειώσεις", item.notes || "—"]
        ]);
        return;
      }
      if (tab === "permissions") {
        const values = Array.isArray(item.permissions) ? item.permissions : [];
        const visiblePermissions = permissionsForRole(item.role);
        $("employeeDetailContent").innerHTML = '<div class="permission-chip-list">' + visiblePermissions.map(function (permission) {
          const enabled = values.includes("*") || values.includes(permission);
          return '<span class="permission-chip ' + (enabled ? "enabled" : "") + '">' + (enabled ? "✓ " : "— ") + escapeHtml(permissionLabels[permission] || permission) + '</span>';
        }).join("") + '</div>';
        return;
      }
      if (tab === "shifts") {
        const data = await api("/api/admin/shifts?from=" + inputDate(-90) + "&to=" + inputDate(1) + "&employeeId=" + encodeURIComponent(item.id));
        $("employeeDetailContent").innerHTML = (data.shifts || []).length ? '<div class="data-list">' + data.shifts.map(function (shift) {
          return '<div class="data-row"><span><strong>' + escapeHtml(formatDateTime(shift.actualClockIn)) + '</strong><small>' + escapeHtml(shift.vehicleName || "Χωρίς μηχανάκι") + '</small></span><span><strong>' + escapeHtml(shift.actualClockOut ? formatDateTime(shift.actualClockOut) : "Σε εξέλιξη") + '</strong><small>' + escapeHtml(shift.shiftKm == null ? "—" : km(shift.shiftKm)) + '</small></span>' + statusPill(shift.status) + '</div>';
        }).join("") + '</div>' : '<p class="empty-copy">Δεν υπάρχουν βάρδιες στις τελευταίες 90 ημέρες.</p>';
        return;
      }
      if (tab === "schedules") {
        const data = await api("/api/admin/schedules?from=" + inputDate(-30) + "&to=" + inputDate(60) + "&employeeId=" + encodeURIComponent(item.id));
        $("employeeDetailContent").innerHTML = (data.schedules || []).length ? '<div class="data-list">' + data.schedules.map(function (schedule) {
          return '<div class="data-row"><span><strong>' + escapeHtml(formatDateTime(schedule.start_at)) + '</strong><small>' + escapeHtml(schedule.vehicle_name || "Χωρίς προανάθεση") + '</small></span><span><strong>' + escapeHtml(formatDateTime(schedule.end_at)) + '</strong><small>' + escapeHtml(schedule.notes || "—") + '</small></span>' + statusPill(schedule.status) + '</div>';
        }).join("") + '</div>' : '<p class="empty-copy">Δεν υπάρχει πρόγραμμα στο επιλεγμένο διάστημα.</p>';
        return;
      }
      if (tab === "payroll") {
        const start = mondayDate();
        const data = await api("/api/admin/payroll?start=" + start + "&end=" + datePlus(start, 6));
        const pay = (data.employees || []).find(function (entry) { return String(entry.employeeId) === String(item.id); });
        $("employeeDetailContent").innerHTML = pay ? employeeFacts([
          ["Περίοδος", start + " – " + datePlus(start, 6)], ["Βάρδιες", String(pay.shifts || 0)],
          ["Κανονικές ώρες", hours(pay.normalHours)], ["Ειδικές ώρες", hours(pay.specialHours)], ["Payable ώρες", hours(pay.payableHours)],
          ["Χιλιόμετρα", km(pay.kilometers)], ["Βασική αμοιβή", money(pay.basePayCents)], ["Ειδική αμοιβή", money(pay.specialPayCents)],
          ["Bonus", money(pay.bonusCents)], ["Κρατήσεις", money(pay.deductionCents)], ["Προκαταβολές", money(pay.advanceCents)], ["Τελικό", money(pay.finalCents)]
        ]) : '<p class="empty-copy">Δεν υπάρχουν στοιχεία μισθοδοσίας για αυτή την εβδομάδα.</p>';
        return;
      }
      if (tab === "history") {
        const data = await api("/api/admin/audit?userId=" + encodeURIComponent(item.id));
        $("employeeDetailContent").innerHTML = (data.entries || []).length ? '<div class="data-list">' + data.entries.map(function (entry) {
          return '<div class="data-row"><span><strong>' + escapeHtml(entry.action) + '</strong><small>' + escapeHtml(formatDateTime(entry.timestamp)) + '</small></span><span><strong>' + escapeHtml(entry.object_type + (entry.object_id ? " • " + entry.object_id : "")) + '</strong><small>' + escapeHtml(entry.reason || "—") + '</small></span></div>';
        }).join("") + '</div>' : '<p class="empty-copy">Δεν υπάρχουν εγγραφές ιστορικού.</p>';
      }
    } catch (error) { $("employeeDetailContent").innerHTML = '<p class="form-error">' + escapeHtml(error.message) + '</p>'; }
  }

  function applyOwnVehicleEmployeeState() {
    const own = $("usesOwnVehicle").checked;
    $("employeeVehicle").disabled = own;
    if (own) $("employeeVehicle").value = "";
    $("showKm").disabled = own;
    $("canChangeVehicle").disabled = own;
    if (own) {
      $("showKm").checked = false;
      $("canChangeVehicle").checked = false;
    }
  }

  async function openEmployeeDialog(id) {
    const item = id ? state.employees.find(function (entry) { return String(entry.id) === String(id); }) : null;
    if (id && !item) return toast("Ο εργαζόμενος δεν βρέθηκε.");
    state.editingEmployee = item || null;
    const employeeSubmitButton = $("employeeForm").querySelector('button[type="submit"]');
    employeeSubmitButton.disabled = true;
    $("employeeForm").reset();
    $("employeeId").value = item ? item.id : "";
    $("employeeDialogTitle").textContent = item ? "Επεξεργασία εργαζομένου" : "Νέος εργαζόμενος";
    $("employeeName").value = item ? item.fullName : "";
    $("employeeUsername").value = item ? item.username : "";
    $("employeeEmail").value = item ? item.email : "";
    $("employeePhone").value = item ? item.phone : "";
    $("employeeRole").value = item ? item.role : "employee";
    $("employeeGroup").value = item ? item.employeeGroup || "" : "";
    $("employeeHireDate").value = item && item.hireDate ? item.hireDate : inputDate(0);
    $("employeeNotes").value = item ? item.notes : "";
    $("usesOwnVehicle").checked = item ? Boolean(item.usesOwnVehicle) : false;
    $("employeePasswordWrap").classList.toggle("is-hidden", Boolean(item));
    $("employeePassword").required = !item;
    $("employeeVehicle").innerHTML = '<option value="">Φόρτωση μηχανών…</option>';
    $("employeePayRule").innerHTML = '<option value="">Φόρτωση κανόνων…</option>';
    $("showSchedule").checked = item ? item.showSchedule : true;
    $("showActualIn").checked = item ? item.showActualClockIn : false;
    $("showActualOut").checked = item ? item.showActualClockOut : false;
    $("showPayable").checked = item ? item.showPayableHours : false;
    $("showPayment").checked = item ? item.showPaymentAmount : false;
    $("showKm").checked = item ? item.showShiftKilometers : false;
    $("canChangeVehicle").checked = item ? item.canChangeVehicle : false;
    $("employeeActive").checked = item ? item.active : true;
    renderEmployeePermissions(item ? item.permissions : null, $("employeeRole").value);
    $("employeeError").textContent = "";
    $("employeeDialog").showModal();
    try {
      await loadAdminLists();
      $("employeeVehicle").innerHTML = '<option value="">Χωρίς μόνιμη ανάθεση</option>' + state.vehicles.map(function (vehicle) { return '<option value="' + escapeHtml(vehicle.id) + '">' + escapeHtml(vehicle.name) + ' • ' + escapeHtml(km(vehicle.odometer)) + '</option>'; }).join("");
      $("employeeVehicle").value = item && item.assignedVehicleId ? item.assignedVehicleId : "";
      applyOwnVehicleEmployeeState();
      $("employeePayRule").innerHTML = '<option value="">Αυτόματη επιλογή βάσει προτεραιότητας</option>' + state.payRules.filter(function (rule) { return rule.active; }).map(function (rule) { return '<option value="' + escapeHtml(rule.id) + '">' + escapeHtml(rule.name + " • v" + rule.version) + '</option>'; }).join("");
      $("employeePayRule").value = item && item.payRuleId ? item.payRuleId : "";
      employeeSubmitButton.disabled = false;
    } catch (error) {
      $("employeeError").textContent = error.message;
    }
  }

  function roleAllows(role, permission) {
    const base = Array.isArray(state.rolePermissions[role]) ? state.rolePermissions[role] : [];
    return base.includes("*") || base.includes(permission);
  }

  function permissionsForRole(role) {
    if (role !== "employee") return state.allPermissions;
    const allowed = new Set(state.employeeAllowedPermissions || []);
    return state.allPermissions.filter(function (permission) { return allowed.has(permission); });
  }

  function renderEmployeePermissions(effective, role) {
    const selected = Array.isArray(effective) ? effective : [];
    const owner = role === "owner";
    $("employeePermissionGrid").innerHTML = permissionsForRole(role).map(function (permission) {
      const checked = effective == null ? roleAllows(role, permission) : selected.includes("*") || selected.includes(permission);
      return '<label><input type="checkbox" data-employee-permission="' + escapeHtml(permission) + '" ' + (checked ? "checked" : "") + (owner ? " disabled" : "") + '> ' + escapeHtml(permissionLabels[permission] || permission) + '</label>';
    }).join("");
  }

  function permissionOverridesForRole(role) {
    if (role === "owner") return [];
    const selected = new Set(Array.from(document.querySelectorAll("[data-employee-permission]:checked")).map(function (input) { return input.dataset.employeePermission; }));
    const overrides = [];
    permissionsForRole(role).forEach(function (permission) {
      const inherited = roleAllows(role, permission);
      if (selected.has(permission) && !inherited) overrides.push(permission);
      if (!selected.has(permission) && inherited) overrides.push("!" + permission);
    });
    return overrides;
  }

  function employeePayload() {
    const role = $("employeeRole").value;
    const usesOwnVehicle = $("usesOwnVehicle").checked;
    return {
      fullName: $("employeeName").value.trim(), username: $("employeeUsername").value.trim(),
      email: $("employeeEmail").value.trim(), phone: $("employeePhone").value.trim(),
      role: role, employeeGroup: $("employeeGroup").value.trim(), payRuleId: $("employeePayRule").value || null, hireDate: $("employeeHireDate").value || null,
      assignedVehicleId: usesOwnVehicle ? null : ($("employeeVehicle").value || null),
      usesOwnVehicle: usesOwnVehicle, notes: $("employeeNotes").value.trim(),
      active: $("employeeActive").checked, showSchedule: $("showSchedule").checked,
      showActualClockIn: $("showActualIn").checked, showActualClockOut: $("showActualOut").checked,
      showPayableHours: $("showPayable").checked, showPaymentAmount: $("showPayment").checked,
      showShiftKilometers: $("showKm").checked, canChangeVehicle: $("canChangeVehicle").checked,
      permissions: permissionOverridesForRole(role)
    };
  }

  async function saveEmployee(event) {
    event.preventDefault();
    const current = state.editingEmployee;
    const payload = employeePayload();
    if (!payload.fullName || !payload.username) return void ($("employeeError").textContent = "Συμπλήρωσε ονοματεπώνυμο και username.");
    if (!current) payload.password = $("employeePassword").value;
    const critical = !current ? payload.role !== "employee" || payload.permissions.length > 0 || payload.employeeGroup || payload.payRuleId || payload.assignedVehicleId || payload.usesOwnVehicle || payload.canChangeVehicle || payload.showActualClockIn || payload.showActualClockOut || payload.showPayableHours || payload.showPaymentAmount || payload.showShiftKilometers
      : payload.role !== current.role || payload.active !== current.active || payload.assignedVehicleId !== current.assignedVehicleId || payload.usesOwnVehicle !== Boolean(current.usesOwnVehicle) ||
        payload.employeeGroup !== (current.employeeGroup || "") || payload.payRuleId !== current.payRuleId ||
        payload.canChangeVehicle !== current.canChangeVehicle || payload.showSchedule !== current.showSchedule ||
        payload.showActualClockIn !== current.showActualClockIn || payload.showActualClockOut !== current.showActualClockOut ||
        payload.showPayableHours !== current.showPayableHours || payload.showPaymentAmount !== current.showPaymentAmount ||
        payload.showShiftKilometers !== current.showShiftKilometers ||
        JSON.stringify(payload.permissions) !== JSON.stringify(current.permissionOverrides || []);
    try {
      let confirmation = { pin: "", reason: "" };
      if (critical) confirmation = await requestPin(true);
      payload.reason = confirmation.reason;
      await api(current ? "/api/admin/employees/" + encodeURIComponent(current.id) : "/api/admin/employees", {
        method: current ? "PUT" : "POST", pin: confirmation.pin, body: payload
      });
      $("employeeDialog").close();
      state.editingEmployee = null;
      toast(current ? "Τα στοιχεία ενημερώθηκαν." : "Ο εργαζόμενος δημιουργήθηκε.");
      await loadEmployees();
    } catch (error) {
      if (!/ακυρώθηκε/.test(error.message)) $("employeeError").textContent = error.message;
    }
  }

  async function resetPassword(userId) {
    const item = state.employees.find(function (entry) { return String(entry.id) === String(userId); });
    try {
      const data = await simpleEditor({
        overline: "ΑΣΦΑΛΕΙΑ", title: "Νέος κωδικός για " + (item ? item.fullName : "χρήστη"), submit: "Αλλαγή κωδικού",
        html: '<label class="field"><span>Νέος κωδικός (τουλάχιστον 8 χαρακτήρες)</span><input id="newUserPassword" type="password" minlength="8" required></label>',
        collect: function () { const password = $("newUserPassword").value; if (password.length < 8) throw new Error("Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες."); return { password: password }; }
      });
      const confirmation = await requestPin(true);
      data.reason = confirmation.reason;
      await api("/api/admin/employees/" + encodeURIComponent(userId) + "/password", { method: "POST", pin: confirmation.pin, body: data });
      toast("Ο κωδικός άλλαξε και οι παλιές συνδέσεις έκλεισαν.");
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function forceLogout(userId) {
    try {
      const confirmation = await requestPin(true);
      await api("/api/auth/force-logout", { method: "POST", pin: confirmation.pin, body: { userId: userId, reason: confirmation.reason } });
      toast("Όλες οι συνδέσεις του χρήστη τερματίστηκαν.");
      await loadEmployees();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  const scheduleDayNames = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"];

  function addIsoDays(value, days) {
    const date = new Date(String(value) + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
  }

  function mondayIso(value) {
    const date = new Date(String(value || inputDate(0)) + "T12:00:00Z");
    const day = date.getUTCDay();
    return addIsoDays(date.toISOString().slice(0, 10), day === 0 ? -6 : 1 - day);
  }

  function isoDateLabel(value, includeYear) {
    const date = new Date(String(value) + "T12:00:00Z");
    return new Intl.DateTimeFormat("el-GR", includeYear ? { day: "2-digit", month: "2-digit", year: "numeric" } : { day: "2-digit", month: "2-digit" }).format(date);
  }

  function scheduleDates() {
    const start = state.weekData && state.weekData.weekStart ? state.weekData.weekStart : mondayIso($("scheduleWeekDate").value || inputDate(0));
    return scheduleDayNames.map(function (name, index) { return { name: name, short: name.slice(0, 2), date: addIsoDays(start, index), index: index }; });
  }

  function assignmentGroups() {
    const groups = new Map();
    (state.weekData && state.weekData.schedules || []).forEach(function (item) {
      const key = [item.assignment_id || item.series_id || item.id, item.employee_id, item.work_date].join("|");
      if (!groups.has(key)) groups.set(key, {
        key: key, assignmentId: item.assignment_id || item.series_id || item.id, employeeId: item.employee_id,
        employeeName: item.employee_name, workDate: item.work_date, vehicleId: item.vehicle_id || "",
        vehicleName: item.vehicle_name || "", templateId: item.template_id || "", templateName: item.template_name || "",
        color: item.template_color || "#315D67", status: item.status, notes: item.notes || "",
        managed: item.managed_assignment === true || Number(item.managed_assignment) === 1,
        hasShift: Number(item.has_shift || 0) === 1, canEdit: true, segments: []
      });
      const group = groups.get(key);
      group.hasShift = group.hasShift || Number(item.has_shift || 0) === 1;
      group.canEdit = group.canEdit && ["planned", "awaiting", "absent"].includes(item.status);
      group.segments.push({ start: item.start_time, end: item.end_time, startAt: item.start_at, endAt: item.end_at });
    });
    return Array.from(groups.values()).map(function (group) {
      group.segments.sort(function (a, b) { return a.startAt.localeCompare(b.startAt); });
      // Legacy rows have no schedule_assignments metadata.  They are still
      // safe to edit/delete when no real Clock In is linked; the API performs
      // the final row/date check.  Only an actual shift locks the chip.
      group.canEdit = !group.hasShift && group.canEdit;
      return group;
    });
  }

  function renderWeekPlanner() {
    const data = state.weekData;
    if (!data) return;
    const dates = scheduleDates();
    const groups = assignmentGroups();
    const scheduledIds = new Set(groups.map(function (item) { return String(item.employeeId); }));
    const employees = (data.employees || []).filter(function (item) { return item.role === "employee" || scheduledIds.has(String(item.id)); });
    const assignedEmployees = new Set(groups.map(function (item) { return item.employeeId; }));
    const assignedVehicles = new Set(groups.map(function (item) { return item.vehicleId; }).filter(Boolean));
    $("scheduleWeekRange").textContent = isoDateLabel(data.weekStart, true) + " - " + isoDateLabel(data.weekEnd, true);
    $("scheduleSummary").innerHTML = [
      '<span><strong>' + numberFormat.format(assignedEmployees.size) + '</strong><small>ΔΙΑΝΟΜΕΙΣ ΜΕ ΠΡΟΓΡΑΜΜΑ</small></span>',
      '<span><strong>' + numberFormat.format(groups.length) + '</strong><small>ΑΝΑΘΕΣΕΙΣ ΕΒΔΟΜΑΔΑΣ</small></span>',
      '<span><strong>' + numberFormat.format(assignedVehicles.size) + '</strong><small>ΠΡΟΑΝΑΤΕΘΕΙΜΕΝΑ ΜΗΧΑΝΑΚΙΑ</small></span>'
    ].join("");
    $("newScheduleButton").classList.toggle("is-hidden", !can("schedules.manage"));
    $("scheduleTemplatesButton").classList.toggle("is-hidden", !can("schedules.manage"));
    $("scheduleCopyButton").classList.toggle("is-hidden", !can("schedules.manage"));
    $("scheduleImportButton").classList.toggle("is-hidden", !can("schedules.manage"));
    $("schedulePublishButton").classList.toggle("is-hidden", !can("schedules.manage") || data.scheduleState !== "draft");
    $("schedulePdfButton").disabled = data.scheduleState !== "published";
    const status = $("schedulePublicationStatus");
    status.classList.remove("is-hidden", "draft");
    if (data.scheduleState === "draft") {
      status.classList.add("draft");
      const missing = data.draft && data.draft.missingVehicles ? data.draft.missingVehicles.length : 0;
      status.innerHTML = '<strong>ΠΡΟΧΕΙΡΟ</strong><small>Δεν έχει δημοσιευτεί ακόμη.</small><span class="status-spacer"></span>' + (missing ? '<small>Λείπει μηχανάκι σε ' + missing + ' βάρδιες.</small>' : '<small>Οι αναθέσεις μηχανών ελέγχθηκαν.</small>');
    } else if (data.scheduleState === "published") {
      status.innerHTML = '<strong>ΔΗΜΟΣΙΕΥΜΕΝΟ</strong><small>Revision ' + escapeHtml(data.publication && data.publication.revision || "—") + ' • ' + escapeHtml(data.publication && formatDateTime(data.publication.publishedAt) || "") + '</small>';
    } else {
      status.classList.add("is-hidden");
      status.innerHTML = "";
    }
    if (!employees.length) {
      $("scheduleList").innerHTML = '<div class="roster-empty">Δεν υπάρχουν ενεργοί διανομείς.</div>';
      return;
    }
    const header = dates.map(function (day) {
      return '<th class="' + (day.index > 4 ? "weekend" : "") + '">' + escapeHtml(day.name) + '<span>' + escapeHtml(isoDateLabel(day.date, false)) + '</span></th>';
    }).join("");
    const rows = employees.map(function (employee) {
      const cells = dates.map(function (day) {
        const entries = groups.filter(function (group) { return String(group.employeeId) === String(employee.id) && group.workDate === day.date; });
        return '<td><div class="roster-cell">' + entries.map(function (group) {
          const hoursText = group.segments.map(function (segment) { return segment.start + "-" + segment.end; }).join(" / ");
          const editable = can("schedules.manage") && group.canEdit && data.scheduleState !== "draft";
          const tag = editable ? "button" : "article";
          const attributes = editable
            ? ' type="button" data-schedule-edit="' + escapeHtml(group.assignmentId) + '" title="Επεξεργασία ή διαγραφή βάρδιας"'
            : (group.hasShift ? ' title="Η βάρδια έχει πραγματική καταγραφή και αλλάζει από την καρτέλα Βάρδιες"' : "");
          const cue = editable ? '<i class="roster-edit-cue" aria-hidden="true">•••</i>' : "";
          return '<' + tag + ' class="roster-shift-chip" style="--template-color:' + escapeHtml(group.color) + '"' + attributes + '><strong>' + escapeHtml(hoursText) + '</strong><small>' + escapeHtml(group.vehicleName || "Χωρίς μηχανάκι") + '</small>' + cue + '</' + tag + '>';
        }).join("") + '</div></td>';
      }).join("");
      return '<tr><td><span class="roster-person"><strong>' + escapeHtml(employee.full_name) + '</strong><small>' + escapeHtml(employee.employee_group || "Διανομέας") + '</small></span></td>' + cells + '</tr>';
    }).join("");
    $("scheduleList").innerHTML = '<table class="week-roster-table"><thead><tr><th>Διανομέας</th>' + header + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function loadSchedules(force) {
    if (!$("scheduleWeekDate").value) $("scheduleWeekDate").value = mondayIso(inputDate(0));
    const week = mondayIso($("scheduleWeekDate").value);
    $("scheduleWeekDate").value = week;
    if (force) state.viewLoadedAt.schedules = 0;
    const data = await api("/api/admin/schedule-week?week=" + encodeURIComponent(week));
    state.weekData = data;
    state.schedules = data.schedules || [];
    renderWeekPlanner();
  }

  function csvRows(textValue) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const value = String(textValue || "").replace(/^\uFEFF/, "");
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === "\"") {
        if (quoted && value[index + 1] === "\"") { cell += "\""; index += 1; }
        else quoted = !quoted;
      } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
      else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && value[index + 1] === "\n") index += 1;
        row.push(cell); if (row.some(function (item) { return String(item).trim() !== ""; })) rows.push(row);
        row = []; cell = "";
      } else cell += char;
    }
    if (cell !== "" || row.length) { row.push(cell); if (row.some(function (item) { return String(item).trim() !== ""; })) rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map(function (item) { return String(item).trim(); });
    return rows.map(function (items) { const result = {}; headers.forEach(function (header, index) { if (header) result[header] = items[index] == null ? "" : String(items[index]).trim(); }); return result; });
  }

  function zipEntries(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let end = -1;
    for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65558); index -= 1) {
      if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
    }
    if (end < 0) throw new Error("Το αρχείο Excel δεν είναι έγκυρο ZIP.");
    const directorySize = view.getUint32(end + 12, true);
    const directoryOffset = view.getUint32(end + 16, true);
    const entries = new Map();
    let cursor = directoryOffset;
    const limit = directoryOffset + directorySize;
    let count = 0;
    while (cursor < limit && count < 200) {
      if (view.getUint32(cursor, true) !== 0x02014b50) break;
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const expandedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      if (expandedSize > 4 * 1024 * 1024 || compressedSize > 4 * 1024 * 1024) throw new Error("Το Excel περιέχει υπερβολικά μεγάλο φύλλο.");
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Το Excel έχει κατεστραμμένη εγγραφή.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      entries.set(name, { method, bytes: bytes.slice(start, start + compressedSize), expandedSize });
      cursor += 46 + nameLength + extraLength + commentLength;
      count += 1;
    }
    if (!entries.size) throw new Error("Το Excel δεν περιέχει φύλλα.");
    return entries;
  }

  async function unzipText(entry) {
    if (!entry) return "";
    if (entry.method === 0) return new TextDecoder().decode(entry.bytes);
    if (entry.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("Το πρόγραμμα περιήγησης δεν υποστηρίζει αυτό το Excel.");
    const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  function xmlChildren(element, name) {
    return Array.from(element.getElementsByTagNameNS("*", name));
  }

  async function xlsxRows(buffer) {
    const entries = zipEntries(buffer);
    const workbookXml = new DOMParser().parseFromString(await unzipText(entries.get("xl/workbook.xml")), "application/xml");
    const relsXml = new DOMParser().parseFromString(await unzipText(entries.get("xl/_rels/workbook.xml.rels")), "application/xml");
    const sharedXml = entries.get("xl/sharedStrings.xml") ? new DOMParser().parseFromString(await unzipText(entries.get("xl/sharedStrings.xml")), "application/xml") : null;
    const shared = sharedXml ? xmlChildren(sharedXml, "si").map(function (item) { return xmlChildren(item, "t").map(function (node) { return node.textContent || ""; }).join(""); }) : [];
    const sheets = xmlChildren(workbookXml, "sheet");
    if (!sheets.length) throw new Error("Το Excel δεν περιέχει φύλλο.");
    const relItems = xmlChildren(relsXml, "Relationship");
    const relationId = sheets[0].getAttribute("r:id") || sheets[0].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const relation = relItems.find(function (item) { return item.getAttribute("Id") === relationId; });
    let target = relation && relation.getAttribute("Target") || "worksheets/sheet1.xml";
    target = target.replace(/^\//, "").replace(/^\.\//, "");
    const sheetPath = target.startsWith("xl/") ? target : "xl/" + target;
    const sheetXml = new DOMParser().parseFromString(await unzipText(entries.get(sheetPath)), "application/xml");
    const rows = xmlChildren(sheetXml, "row").map(function (row) {
      const result = [];
      xmlChildren(row, "c").forEach(function (cell) {
        const ref = cell.getAttribute("r") || "";
        const columnLetters = (ref.match(/^[A-Z]+/i) || ["A"])[0].toUpperCase();
        let column = 0; for (let index = 0; index < columnLetters.length; index += 1) column = column * 26 + columnLetters.charCodeAt(index) - 64;
        column -= 1;
        while (result.length <= column) result.push("");
        const type = cell.getAttribute("t") || "";
        const valueNode = xmlChildren(cell, "v")[0];
        const inline = xmlChildren(cell, "is").map(function (item) { return xmlChildren(item, "t").map(function (node) { return node.textContent || ""; }).join(""); }).join("");
        const raw = inline || (valueNode ? valueNode.textContent || "" : "");
        result[column] = type === "s" ? (shared[Number(raw)] || "") : raw;
      });
      return result;
    });
    if (!rows.length) return [];
    const headers = rows.shift().map(function (item) { return String(item || "").trim(); });
    return rows.filter(function (items) { return items.some(function (item) { return String(item || "").trim() !== ""; }); }).map(function (items) {
      const result = {}; headers.forEach(function (header, index) { if (header) result[header] = items[index] == null ? "" : items[index]; }); return result;
    });
  }

  async function parseScheduleFile(file) {
    if (!file || file.size > 5 * 1024 * 1024) throw new Error("Το αρχείο πρέπει να είναι έως 5 MB.");
    if (/\\.csv$/i.test(file.name) || file.type === "text/csv") return csvRows(await file.text());
    if (!/\\.xlsx$/i.test(file.name)) throw new Error("Επίλεξε αρχείο .xlsx ή .csv.");
    return xlsxRows(await file.arrayBuffer());
  }

  function renderImportPreview(data) {
    const box = $("scheduleImportPreview");
    box.classList.remove("is-hidden");
    const errors = data.errors || [];
    box.innerHTML = '<strong>' + (data.valid ? "✓ Η προεπισκόπηση είναι έγκυρη." : "⚠ Χρειάζονται διορθώσεις πριν την εισαγωγή.") + '</strong>' +
      '<span>Γραμμές που θα μπουν στο Πρόχειρο: ' + numberFormat.format((data.assignments || []).length) + '</span>' +
      (errors.length ? '<ul>' + errors.slice(0, 12).map(function (item) { return '<li>Γραμμή ' + escapeHtml(item.row || "—") + ': ' + escapeHtml(item.message) + '</li>'; }).join("") + '</ul>' : "");
    $("scheduleImportCommit").disabled = !data.valid;
  }

  async function openScheduleImportDialog() {
    state.scheduleImportRows = null; state.scheduleImportPreview = null;
    $("scheduleImportFile").value = ""; $("scheduleImportFileName").textContent = "Δεν έχει επιλεγεί αρχείο.";
    $("scheduleImportPreview").classList.add("is-hidden"); $("scheduleImportError").textContent = ""; $("scheduleImportCommit").disabled = true;
    $("scheduleImportDialog").showModal();
  }

  async function handleScheduleImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    $("scheduleImportFileName").textContent = file.name;
    $("scheduleImportError").textContent = "";
    try {
      const rows = await parseScheduleFile(file);
      if (!rows.length) throw new Error("Το αρχείο δεν περιέχει γραμμές εισαγωγής.");
      const preview = await api("/api/admin/schedule-import/preview", { method: "POST", body: { rows: rows } });
      state.scheduleImportRows = rows; state.scheduleImportPreview = preview; renderImportPreview(preview);
    } catch (error) { $("scheduleImportError").textContent = error.message; $("scheduleImportCommit").disabled = true; }
  }

  async function commitScheduleImport(event) {
    event.preventDefault();
    if (!state.scheduleImportRows || !state.scheduleImportPreview) return;
    try {
      let replace = false;
      if (state.scheduleImportPreview.target && state.scheduleImportPreview.target.state !== "empty") {
        if (!window.confirm("Η εβδομάδα έχει ήδη πρόγραμμα. Να αντικατασταθεί το Πρόχειρο; Το δημοσιευμένο πρόγραμμα μένει μέχρι τη Δημοσίευση.")) return;
        replace = true;
      }
      const result = await api("/api/admin/schedule-import/commit", { method: "POST", body: {
        rows: state.scheduleImportRows, confirm: true, replace, reason: "Εισαγωγή εβδομαδιαίου προγράμματος από Excel"
      } });
      $("scheduleImportDialog").close();
      $("scheduleWeekDate").value = result.draft.weekStart;
      toast("Το Excel αποθηκεύτηκε ως Πρόχειρο. Έλεγξε τις μηχανές και δημοσίευσέ το.");
      await loadSchedules(true);
    } catch (error) { $("scheduleImportError").textContent = error.message; }
  }

  async function copyPreviousScheduleWeek() {
    const targetWeek = mondayIso($("scheduleWeekDate").value || inputDate(0));
    if (state.weekData && state.weekData.scheduleState === "draft" && !window.confirm("Υπάρχει ήδη Πρόχειρο. Να αντικατασταθεί από την προηγούμενη εβδομάδα;")) return;
    try {
      const result = await api("/api/admin/schedule-week/copy", { method: "POST", body: { targetWeek, sourceWeek: addIsoDays(targetWeek, -7), preserveVehicles: true, reason: "Αντιγραφή προηγούμενης εβδομάδας" } });
      toast("Η προηγούμενη εβδομάδα αντιγράφηκε ως Πρόχειρο.");
      await loadSchedules(true);
    } catch (error) { toast(error.message); }
  }

  async function publishCurrentScheduleWeek() {
    const weekStart = mondayIso($("scheduleWeekDate").value || inputDate(0));
    try {
      await api("/api/admin/schedule-week/publish", { method: "POST", body: { weekStart, reason: "Δημοσίευση εβδομαδιαίου προγράμματος" } });
      toast("Το πρόγραμμα δημοσιεύτηκε.");
      await loadSchedules(true);
    } catch (error) {
      if (error.code === "schedule_vehicle_required" && error.missingVehicles) {
        $("scheduleConflictNotice").textContent = "Λείπει μηχανάκι σε " + error.missingVehicles.length + " βάρδιες. Άνοιξε Καταχώρηση, επίλεξε μηχανάκι ή «Χωρίς μηχανάκι» και αποθήκευσε ξανά.";
        $("scheduleConflictNotice").classList.remove("is-hidden");
      } else toast(error.message);
    }
  }

  function moveScheduleWeek(days) {
    $("scheduleWeekDate").value = addIsoDays(mondayIso($("scheduleWeekDate").value || inputDate(0)), days);
    loadSchedules(true).catch(function (error) { toast(error.message); });
  }

  function activeScheduleVehicles() {
    return (state.weekData && state.weekData.vehicles || []).filter(function (item) { return !["service", "inactive"].includes(item.status); });
  }

  function assignedVehicleId(employee) {
    if (employee && employee.uses_own_vehicle) return "";
    const value = employee && (employee.assigned_vehicle_id || employee.assignedVehicleId) || "";
    return activeScheduleVehicles().some(function (item) { return String(item.id) === String(value); }) ? String(value) : "";
  }

  function assignedVehicle(employee) {
    const id = assignedVehicleId(employee);
    return activeScheduleVehicles().find(function (item) { return String(item.id) === id; }) || null;
  }

  function vehicleOptions(selected, preferred, ownVehicle) {
    if (ownVehicle) return '<option value="__no_vehicle__" selected>Ιδιόκτητο μηχανάκι • χωρίς χιλιόμετρα</option>';
    return '<option value="">Δεν έχει ανατεθεί ακόμη</option><option value="__no_vehicle__" ' + (selected === "__no_vehicle__" ? "selected" : "") + '>Χωρίς μηχανάκι • ρητή εξαίρεση</option>' + activeScheduleVehicles().map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '" ' + (String(selected || "") === String(item.id) ? "selected" : "") + '>' + escapeHtml(item.name) + (String(preferred || "") === String(item.id) ? " • προανατεθειμένο" : "") + (item.status === "in_use" ? " • τώρα σε χρήση" : "") + '</option>';
    }).join("");
  }

  function templateOptions(selected, allowRest) {
    return (allowRest ? '<option value="">Ρεπό / χωρίς βάρδια</option>' : "") + (state.weekData && state.weekData.templates || []).map(function (item) {
      return '<option value="' + escapeHtml(item.id) + '" ' + (String(selected || "") === String(item.id) ? "selected" : "") + '>' + escapeHtml(item.name) + '</option>';
    }).join("");
  }

  function selectedBulkEmployees() {
    return Array.from(document.querySelectorAll('#bulkScheduleEmployees input:checked')).map(function (input) { return input.value; });
  }

  function selectedBulkDays() {
    return Array.from(document.querySelectorAll('#bulkScheduleDays input:checked')).map(function (input) { return input.value; });
  }

  function renderBulkVehicleAssignments() {
    const prior = {};
    document.querySelectorAll('[data-assignment-vehicle]').forEach(function (select) { prior[select.dataset.assignmentVehicle] = select.value; });
    const mode = $("bulkVehicleMode").value;
    const employees = selectedBulkEmployees();
    const days = selectedBulkDays();
    if (mode === "none" || !employees.length || !days.length) {
      $("bulkVehicleAssignments").innerHTML = mode === "none" ? "" : '<p class="empty-copy">Διάλεξε ημέρες και διανομείς για να ορίσεις μηχανάκια.</p>';
      return;
    }
    const employeeMap = new Map((state.weekData.employees || []).map(function (item) { return [String(item.id), item]; }));
    const rows = [];
    employees.forEach(function (employeeId) {
      const employee = employeeMap.get(String(employeeId));
      if (!employee) return;
      const preferred = assignedVehicle(employee);
      const preferredId = preferred ? preferred.id : "";
      if (mode === "employee") {
        const key = employeeId + "|*";
        const selected = Object.prototype.hasOwnProperty.call(prior, key) ? prior[key] : preferredId;
        rows.push('<label class="vehicle-assignment-row"><span><strong>' + escapeHtml(employee.full_name) + '</strong><small>' + escapeHtml(employee.uses_own_vehicle ? "Ιδιόκτητο μηχανάκι • χωρίς χιλιόμετρα" : (preferred ? "Προανατεθειμένο: " + preferred.name + " • ίδιο στις επιλεγμένες ημέρες" : "Ίδιο σε όλες τις επιλεγμένες ημέρες")) + '</small></span><select data-assignment-vehicle="' + escapeHtml(key) + '">' + vehicleOptions(selected, preferredId, employee.uses_own_vehicle) + '</select></label>');
        return;
      }
      days.forEach(function (date) {
        const key = employeeId + "|" + date;
        const employeeKey = employeeId + "|*";
        const inherited = Object.prototype.hasOwnProperty.call(prior, key) ? prior[key]
          : Object.prototype.hasOwnProperty.call(prior, employeeKey) ? prior[employeeKey] : preferredId;
        const day = scheduleDates().find(function (item) { return item.date === date; });
        rows.push('<label class="vehicle-assignment-row"><span><strong>' + escapeHtml(employee.full_name) + '</strong><small>' + escapeHtml(day.name + " " + isoDateLabel(date, false) + (employee.uses_own_vehicle ? " • ιδιόκτητο μηχανάκι" : (preferred ? " • προανατεθειμένο: " + preferred.name : ""))) + '</small></span><select data-assignment-vehicle="' + escapeHtml(key) + '">' + vehicleOptions(inherited, preferredId, employee.uses_own_vehicle) + '</select></label>');
      });
    });
    $("bulkVehicleAssignments").innerHTML = rows.join("");
  }

  function groupTemplateId(group) {
    if (group.templateId) return group.templateId;
    const signature = group.segments.map(function (segment) { return segment.start + "-" + segment.end; }).join("|");
    const template = (state.weekData.templates || []).find(function (item) {
      return item.segments.map(function (segment) { return segment.start + "-" + segment.end; }).join("|") === signature;
    });
    return template ? template.id : "";
  }

  function renderEmployeeWeekRows() {
    const employeeId = $("weekScheduleEmployee").value;
    const employee = (state.weekData.employees || []).find(function (item) { return String(item.id) === String(employeeId); });
    const preferred = assignedVehicle(employee);
    const preferredId = preferred ? preferred.id : "";
    const groups = assignmentGroups();
    const rows = scheduleDates().map(function (day) {
      const existing = groups.filter(function (group) { return String(group.employeeId) === String(employeeId) && group.workDate === day.date; });
      const selectedTemplate = existing.length === 1 ? groupTemplateId(existing[0]) : "";
      const selectedVehicle = existing.length === 1 ? existing[0].vehicleId : preferredId;
      const unmatched = existing.length && !selectedTemplate;
      return '<div class="employee-week-row" data-employee-day="' + escapeHtml(day.date) + '" data-existing-unmatched="' + (unmatched ? "1" : "0") + '"><span class="employee-week-day"><strong>' + escapeHtml(day.name) + '</strong><small>' + escapeHtml(isoDateLabel(day.date, false)) + (unmatched ? " • διάλεξε πρότυπο" : existing.length ? " • καταχωρημένο" : employee && employee.uses_own_vehicle ? " • ιδιόκτητο μηχανάκι" : preferred ? " • " + preferred.name : "") + '</small></span><select data-day-template="' + escapeHtml(day.date) + '">' + templateOptions(selectedTemplate, true) + '</select><select data-day-vehicle="' + escapeHtml(day.date) + '">' + vehicleOptions(selectedVehicle, preferredId, employee && employee.uses_own_vehicle) + '</select></div>';
    }).join("");
    $("employeeWeekRows").innerHTML = rows;
    const usedVehicles = Array.from(document.querySelectorAll('[data-day-template]')).filter(function (select) { return select.value; }).map(function (select) {
      return document.querySelector('[data-day-vehicle="' + CSS.escape(select.dataset.dayTemplate) + '"]');
    }).filter(Boolean).map(function (select) { return select.value; }).filter(Boolean);
    const allSame = usedVehicles.length ? usedVehicles.every(function (value) { return value === usedVehicles[0]; }) : Boolean(preferredId);
    $("sameVehicleAllWeek").checked = allSame;
    $("sameWeekVehicle").innerHTML = vehicleOptions(usedVehicles.length && allSame ? usedVehicles[0] : preferredId, preferredId, employee && employee.uses_own_vehicle);
    applySameWeekVehicleState();
  }

  function applySameWeekVehicleState() {
    const same = $("sameVehicleAllWeek").checked;
    $("sameWeekVehicle").disabled = !same;
    document.querySelectorAll('[data-day-vehicle]').forEach(function (select) {
      select.disabled = same;
      if (same) select.value = $("sameWeekVehicle").value;
    });
  }

  function setScheduleBuilderMode(mode) {
    state.scheduleBuilderMode = mode === "employee" ? "employee" : "shift";
    $("scheduleModeTabs").querySelectorAll("button").forEach(function (button) { button.classList.toggle("active", button.dataset.builderMode === state.scheduleBuilderMode); });
    $("scheduleByShift").classList.toggle("is-hidden", state.scheduleBuilderMode !== "shift");
    $("scheduleByEmployee").classList.toggle("is-hidden", state.scheduleBuilderMode !== "employee");
    $("scheduleSuggestionBox").classList.add("is-hidden");
    $("scheduleError").textContent = "";
  }

  async function openScheduleDialog(mode) {
    if (!state.weekData) await loadSchedules(true);
    $("scheduleForm").reset();
    const templates = state.weekData.templates || [];
    $("bulkScheduleTemplate").innerHTML = templateOptions(templates[0] && templates[0].id, false);
    $("bulkScheduleDays").innerHTML = scheduleDates().map(function (day, index) {
      return '<label><input type="checkbox" value="' + escapeHtml(day.date) + '" ' + (index === 0 ? "checked" : "") + '><span>' + escapeHtml(day.short) + '</span><small>' + escapeHtml(isoDateLabel(day.date, false)) + '</small></label>';
    }).join("");
    const employees = (state.weekData.employees || []).filter(function (item) { return item.role === "employee"; });
    $("bulkScheduleEmployees").innerHTML = employees.map(function (item) {
      const preferred = assignedVehicle(item);
      const detail = (item.employee_group || "Διανομέας") + (preferred ? " • " + preferred.name : "");
      return '<label><input type="checkbox" value="' + escapeHtml(item.id) + '"><span><strong>' + escapeHtml(item.full_name) + '</strong><small>' + escapeHtml(detail) + '</small></span></label>';
    }).join("");
    $("weekScheduleEmployee").innerHTML = employees.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.full_name) + '</option>'; }).join("");
    $("sameWeekVehicle").innerHTML = vehicleOptions("");
    $("bulkVehicleMode").value = "employee";
    $("bulkVehicleAssignments").innerHTML = '<p class="empty-copy">Διάλεξε διανομείς και θα εμφανιστούν αυτόματα τα προανατεθειμένα μηχανάκια τους.</p>';
    $("scheduleSuggestionBox").classList.add("is-hidden");
    $("scheduleError").textContent = "";
    renderEmployeeWeekRows();
    setScheduleBuilderMode(mode || "shift");
    $("scheduleDialog").showModal();
  }

  function collectScheduleAssignments() {
    if (state.scheduleBuilderMode === "shift") {
      const employees = selectedBulkEmployees();
      const days = selectedBulkDays();
      const templateId = $("bulkScheduleTemplate").value;
      if (!templateId || !employees.length || !days.length) throw new Error("Διάλεξε βάρδια, τουλάχιστον μία ημέρα και τουλάχιστον έναν διανομέα.");
      const mode = $("bulkVehicleMode").value;
      const notes = $("bulkScheduleNotes").value.trim();
      const assignments = [];
      employees.forEach(function (employeeId) {
        days.forEach(function (date) {
          let vehicleId = "";
          const select = document.querySelector('[data-assignment-vehicle="' + CSS.escape(employeeId + "|" + (mode === "employee" ? "*" : date)) + '"]');
          if (mode !== "none" && select) vehicleId = select.value;
          assignments.push({ employeeId: employeeId, date: date, templateId: templateId, vehicleId: vehicleId || null, withoutVehicle: vehicleId === "__no_vehicle__", notes: notes });
        });
      });
      return { assignments: assignments };
    }
    const employeeId = $("weekScheduleEmployee").value;
    if (!employeeId) throw new Error("Διάλεξε διανομέα.");
    const unresolved = Array.from(document.querySelectorAll('[data-existing-unmatched="1"]')).find(function (row) { return !row.querySelector('[data-day-template]').value; });
    if (unresolved) throw new Error("Υπάρχει παλιό ωράριο που δεν αντιστοιχεί σε πρότυπο. Διάλεξε τη σωστή βάρδια στη συγκεκριμένη ημέρα πριν την αποθήκευση.");
    const same = $("sameVehicleAllWeek").checked;
    const masterVehicle = $("sameWeekVehicle").value;
    const assignments = Array.from(document.querySelectorAll('[data-day-template]')).filter(function (select) { return select.value; }).map(function (select) {
      const date = select.dataset.dayTemplate;
      const vehicle = document.querySelector('[data-day-vehicle="' + CSS.escape(date) + '"]');
      const selectedVehicle = (same ? masterVehicle : vehicle && vehicle.value) || "";
      return { employeeId: employeeId, date: date, templateId: select.value, vehicleId: selectedVehicle || null, withoutVehicle: selectedVehicle === "__no_vehicle__" };
    });
    if (!assignments.length) throw new Error("Διάλεξε τουλάχιστον μία βάρδια για την εβδομάδα.");
    return { assignments: assignments, replaceEmployeeId: employeeId, replaceWeekStart: state.weekData.weekStart };
  }

  function showScheduleSuggestions(error) {
    state.lastScheduleConflict = error.conflict || null;
    const suggestions = error.suggestedVehicles || [];
    if (!suggestions.length) {
      $("scheduleSuggestionBox").classList.add("is-hidden");
      return;
    }
    $("scheduleSuggestionBox").innerHTML = '<strong>Διαθέσιμα μηχανάκια για τη συγκεκριμένη βάρδια:</strong><div class="suggestion-buttons">' + suggestions.map(function (item) {
      return '<button data-suggested-vehicle="' + escapeHtml(item.id) + '" type="button">' + escapeHtml(item.name) + '</button>';
    }).join("") + '</div>';
    $("scheduleSuggestionBox").classList.remove("is-hidden");
  }

  function useSuggestedVehicle(vehicleId) {
    const conflict = state.lastScheduleConflict;
    if (!conflict) return;
    if (state.scheduleBuilderMode === "employee") {
      $("sameVehicleAllWeek").checked = false;
      applySameWeekVehicleState();
      const select = document.querySelector('[data-day-vehicle="' + CSS.escape(conflict.date || "") + '"]');
      if (select) select.value = vehicleId;
    } else {
      if ($("bulkVehicleMode").value === "employee") {
        $("bulkVehicleMode").value = "daily";
        renderBulkVehicleAssignments();
      }
      const key = conflict.employeeId + "|" + ($("bulkVehicleMode").value === "daily" ? conflict.date : "*");
      const select = document.querySelector('[data-assignment-vehicle="' + CSS.escape(key) + '"]');
      if (select) select.value = vehicleId;
    }
    $("scheduleSuggestionBox").classList.add("is-hidden");
    $("scheduleError").textContent = "Το προτεινόμενο μηχανάκι επιλέχθηκε. Πάτησε ξανά Αποθήκευση.";
  }

  async function saveSchedule(event) {
    event.preventDefault();
    $("scheduleError").textContent = "";
    $("scheduleSuggestionBox").classList.add("is-hidden");
    try {
      const body = collectScheduleAssignments();
      body.draft = true;
      body.reason = "Αποθήκευση Πρόχειρου εβδομαδιαίου προγράμματος";
      const result = await api("/api/admin/schedule-week", { method: "POST", body: body });
      $("scheduleDialog").close();
      toast("Αποθηκεύτηκαν " + result.created + " αναθέσεις στο κοινό Πρόχειρο. Δημοσίευσέ το μόνο όταν ολοκληρώσεις όλους τους διανομείς.");
      state.viewLoadedAt.schedules = 0;
      await loadSchedules(true);
    } catch (error) {
      $("scheduleError").textContent = error.message;
      showScheduleSuggestions(error);
    }
  }

  function scheduleGroup(assignmentId) {
    return assignmentGroups().find(function (group) { return String(group.assignmentId) === String(assignmentId); }) || null;
  }

  function refreshScheduleEditVehicle(useEmployeeDefault) {
    const employeeId = $("scheduleEditEmployee").value;
    const employee = (state.weekData && state.weekData.employees || []).find(function (item) { return String(item.id) === String(employeeId); });
    const preferred = assignedVehicle(employee);
    const current = useEmployeeDefault ? (preferred ? preferred.id : "") : $("scheduleEditVehicle").value;
    $("scheduleEditVehicle").innerHTML = vehicleOptions(current, preferred && preferred.id, employee && employee.uses_own_vehicle);
    $("scheduleEditVehicleHint").textContent = employee && employee.uses_own_vehicle
      ? "Ιδιόκτητο μηχανάκι: δεν καταγράφονται χιλιόμετρα."
      : preferred
      ? "Προανατεθειμένο στον εργαζόμενο: " + preferred.name
      : "Ο εργαζόμενος δεν έχει προανατεθειμένο μηχανάκι.";
  }

  function openScheduleEditDialog(assignmentId) {
    const group = scheduleGroup(assignmentId);
    if (!group) return void toast("Η προγραμματισμένη βάρδια δεν βρέθηκε.");
    if (!group.canEdit) return void toast(group.hasShift
      ? "Η βάρδια έχει ήδη πραγματική καταγραφή. Άλλαξέ την από την καρτέλα Βάρδιες."
      : "Η συγκεκριμένη βάρδια δεν μπορεί πλέον να αλλάξει.");
    const employees = (state.weekData.employees || []).filter(function (item) { return item.role === "employee" || String(item.id) === String(group.employeeId); });
    state.scheduleEditingId = group.assignmentId;
    state.scheduleEditConflict = null;
    $("scheduleEditForm").reset();
    $("scheduleEditId").value = group.assignmentId;
    $("scheduleEditEmployee").innerHTML = employees.map(function (item) {
      const preferred = assignedVehicle(item);
      return '<option value="' + escapeHtml(item.id) + '" ' + (String(item.id) === String(group.employeeId) ? "selected" : "") + '>' + escapeHtml(item.full_name + (preferred ? " • " + preferred.name : "")) + '</option>';
    }).join("");
    $("scheduleEditDate").value = group.workDate;
    const resolvedTemplateId = groupTemplateId(group);
    const templateExists = (state.weekData.templates || []).some(function (item) { return String(item.id) === String(resolvedTemplateId); });
    $("scheduleEditTemplate").innerHTML = (!templateExists && resolvedTemplateId
      ? '<option value="" selected disabled>Το παλιό πρότυπο δεν είναι πλέον ενεργό</option>' : "") + templateOptions(templateExists ? resolvedTemplateId : "", false);
    const employee = employees.find(function (item) { return String(item.id) === String(group.employeeId); });
    const preferred = assignedVehicle(employee);
    $("scheduleEditVehicle").innerHTML = vehicleOptions(group.vehicleId, preferred && preferred.id, employee && employee.uses_own_vehicle);
    $("scheduleEditVehicleHint").textContent = employee && employee.uses_own_vehicle
      ? "Ιδιόκτητο μηχανάκι: δεν καταγράφονται χιλιόμετρα."
      : preferred
      ? "Προανατεθειμένο στον εργαζόμενο: " + preferred.name
      : "Ο εργαζόμενος δεν έχει προανατεθειμένο μηχανάκι.";
    $("scheduleEditNotes").value = group.notes || "";
    $("scheduleEditMeta").textContent = group.employeeName + " • " + isoDateLabel(group.workDate, true) + " • " + group.segments.map(function (segment) { return segment.start + "–" + segment.end; }).join(" / ");
    $("scheduleEditSuggestionBox").classList.add("is-hidden");
    $("scheduleEditError").textContent = "";
    $("scheduleEditDialog").showModal();
  }

  function showScheduleEditSuggestions(error) {
    state.scheduleEditConflict = error.conflict || null;
    const suggestions = error.suggestedVehicles || [];
    if (!suggestions.length) {
      $("scheduleEditSuggestionBox").classList.add("is-hidden");
      return;
    }
    $("scheduleEditSuggestionBox").innerHTML = '<strong>Διαθέσιμα μηχανάκια για αυτή τη βάρδια:</strong><div class="suggestion-buttons">' + suggestions.map(function (item) {
      return '<button data-edit-suggested-vehicle="' + escapeHtml(item.id) + '" type="button">' + escapeHtml(item.name) + '</button>';
    }).join("") + '</div>';
    $("scheduleEditSuggestionBox").classList.remove("is-hidden");
  }

  async function saveScheduleEdit(event) {
    event.preventDefault();
    const assignmentId = $("scheduleEditId").value;
    $("scheduleEditError").textContent = "";
    $("scheduleEditSuggestionBox").classList.add("is-hidden");
    try {
      const body = {
        employeeId: $("scheduleEditEmployee").value,
        date: $("scheduleEditDate").value,
        templateId: $("scheduleEditTemplate").value,
        vehicleId: $("scheduleEditVehicle").value || null,
        notes: $("scheduleEditNotes").value.trim(),
        reason: "Μεμονωμένη επεξεργασία προγραμματισμένης βάρδιας"
      };
      if (!body.employeeId || !body.date || !body.templateId) throw new Error("Συμπλήρωσε διανομέα, ημερομηνία και βάρδια.");
      const result = await api("/api/admin/schedule-assignments/" + encodeURIComponent(assignmentId) + "/edit", { method: "POST", body: body });
      $("scheduleEditDialog").close();
      state.scheduleEditingId = null;
      $("scheduleWeekDate").value = mondayIso(result.assignment.workDate);
      toast("Η συγκεκριμένη βάρδια ενημερώθηκε.");
      await loadSchedules(true);
    } catch (error) {
      $("scheduleEditError").textContent = error.message;
      showScheduleEditSuggestions(error);
    }
  }

  async function removeScheduleAssignment() {
    const group = scheduleGroup($("scheduleEditId").value);
    if (!group) return void toast("Η προγραμματισμένη βάρδια δεν βρέθηκε.");
    try {
      await simpleEditor({
        overline: "ΠΡΟΓΡΑΜΜΑ", title: "Αφαίρεση προγραμματισμένης βάρδιας", submit: "Αφαίρεση", danger: true,
        html: '<div class="delete-warning"><strong>Η βάρδια θα αφαιρεθεί από το εβδομαδιαίο πρόγραμμα.</strong><p>Δεν διαγράφεται εργαζόμενος, πραγματική βάρδια ή ιστορικό.</p></div>'
      });
      await api("/api/admin/schedule-assignments/" + encodeURIComponent(group.assignmentId) + "/delete", { method: "POST", body: {
        employeeId: group.employeeId, date: group.workDate, reason: "Αφαίρεση από εβδομαδιαίο πρόγραμμα"
      } });
      $("scheduleEditDialog").close();
      state.scheduleEditingId = null;
      toast("Η προγραμματισμένη βάρδια αφαιρέθηκε.");
      await loadSchedules(true);
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) $("scheduleEditError").textContent = error.message; }
  }

  function renderTemplateSegments(segments) {
    const values = Array.isArray(segments) && segments.length ? segments : [{ start: "09:00", end: "17:00" }];
    $("templateSegments").innerHTML = values.map(function (item, index) {
      return '<div class="template-segment-row"><label>Έναρξη<input data-template-start type="time" value="' + escapeHtml(item.start) + '" required></label><label>Λήξη<input data-template-end type="time" value="' + escapeHtml(item.end) + '" required></label><button data-remove-template-segment="' + index + '" type="button" title="Αφαίρεση">×</button></div>';
    }).join("");
    document.querySelectorAll('[data-remove-template-segment]').forEach(function (button) { button.disabled = values.length === 1; });
  }

  function renderTemplateManager(selectedId) {
    const templates = state.templateCatalog || [];
    $("templateList").innerHTML = templates.map(function (item) {
      const hoursText = item.segments.map(function (segment) { return segment.start + "-" + segment.end; }).join(" / ");
      return '<button class="template-list-item ' + (String(item.id) === String(selectedId) ? "active" : "") + '" style="--template-color:' + escapeHtml(item.color) + '" data-template-edit="' + escapeHtml(item.id) + '" type="button"><i></i><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(hoursText) + '</small></span><b>' + (item.active ? "ΕΝΕΡΓΟ" : "ΑΝΕΝΕΡΓΟ") + '</b></button>';
    }).join("");
  }

  function editTemplate(templateId) {
    const item = (state.templateCatalog || []).find(function (entry) { return String(entry.id) === String(templateId); });
    state.templateEditingId = item ? item.id : null;
    $("templateId").value = item ? item.id : "";
    $("templateName").value = item ? item.name : "";
    $("templateColor").value = item ? item.color : "#0d8f82";
    $("templateActive").checked = item ? item.active : true;
    $("deleteTemplateButton").classList.toggle("is-hidden", !item || !item.active);
    renderTemplateSegments(item ? item.segments : [{ start: "09:00", end: "17:00" }]);
    renderTemplateManager(item && item.id);
    $("templateError").textContent = "";
  }

  async function openTemplateManager() {
    const data = await api("/api/admin/shift-templates?includeInactive=1");
    state.templateCatalog = data.templates || [];
    editTemplate(state.templateCatalog[0] && state.templateCatalog[0].id);
    $("templateDialog").showModal();
  }

  function addTemplateSegment() {
    const values = Array.from(document.querySelectorAll('[data-template-start]')).map(function (start, index) {
      const end = document.querySelectorAll('[data-template-end]')[index];
      return { start: start.value, end: end.value };
    });
    if (values.length >= 4) return void toast("Κάθε πρότυπο υποστηρίζει έως 4 τμήματα.");
    values.push({ start: "18:00", end: "00:00" });
    renderTemplateSegments(values);
  }

  async function saveTemplate(event) {
    event.preventDefault();
    const segments = Array.from(document.querySelectorAll('[data-template-start]')).map(function (start, index) {
      return { start: start.value, end: document.querySelectorAll('[data-template-end]')[index].value };
    });
    const current = (state.templateCatalog || []).find(function (item) { return String(item.id) === String($("templateId").value); });
    const body = { name: $("templateName").value.trim(), color: $("templateColor").value, active: $("templateActive").checked, segments: segments, sortOrder: current ? current.sortOrder : state.templateCatalog ? state.templateCatalog.length * 10 + 10 : 10 };
    try {
      const id = $("templateId").value;
      await api("/api/admin/shift-templates" + (id ? "/" + encodeURIComponent(id) : ""), { method: id ? "PUT" : "POST", body: body });
      const data = await api("/api/admin/shift-templates?includeInactive=1");
      state.templateCatalog = data.templates || [];
      editTemplate(id || (state.templateCatalog[state.templateCatalog.length - 1] && state.templateCatalog[state.templateCatalog.length - 1].id));
      toast(id ? "Το πρότυπο ενημερώθηκε." : "Το πρότυπο δημιουργήθηκε.");
      await loadSchedules(true);
    } catch (error) { $("templateError").textContent = error.message; }
  }

  async function disableTemplate() {
    const id = $("templateId").value;
    if (!id) return;
    try {
      await api("/api/admin/shift-templates/" + encodeURIComponent(id) + "/delete", { method: "POST", body: {} });
      const data = await api("/api/admin/shift-templates?includeInactive=1");
      state.templateCatalog = data.templates || [];
      editTemplate(id);
      toast("Το πρότυπο απενεργοποιήθηκε. Τα ήδη αποθηκευμένα προγράμματα δεν άλλαξαν.");
      await loadSchedules(true);
    } catch (error) { $("templateError").textContent = error.message; }
  }

  function xmlEscape(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function shortText(value, limit) {
    const input = String(value || "");
    return input.length > limit ? input.slice(0, Math.max(1, limit - 1)) + "…" : input;
  }

  function schedulePdfSvg() {
    const width = 2382;
    const height = 1684;
    const margin = 64;
    const firstColumn = 318;
    const tableTop = 238;
    const tableHeader = 74;
    const footer = 48;
    const dates = scheduleDates();
    const groups = assignmentGroups();
    const scheduledIds = new Set(groups.map(function (item) { return String(item.employeeId); }));
    const employees = (state.weekData.employees || []).filter(function (item) { return item.role === "employee" || scheduledIds.has(String(item.id)); });
    const rowHeight = Math.min(52, (height - tableTop - tableHeader - footer - margin) / Math.max(1, employees.length));
    const dayWidth = (width - margin * 2 - firstColumn) / 7;
    const fontSize = Math.max(12, Math.min(18, rowHeight * .32));
    const smallFont = Math.max(10, fontSize - 3);
    const range = isoDateLabel(state.weekData.weekStart, true) + " - " + isoDateLabel(state.weekData.weekEnd, true);
    const assignedVehicles = new Set(groups.map(function (item) { return item.vehicleId; }).filter(Boolean));
    const assignedPeople = new Set(groups.map(function (item) { return item.employeeId; }));
    const svg = [];
    svg.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
    svg.push('<rect width="100%" height="100%" fill="#f4f8f7"/>');
    svg.push('<rect x="' + margin + '" y="50" width="' + (width - margin * 2) + '" height="142" rx="28" fill="#08262d"/>');
    svg.push('<rect x="92" y="81" width="78" height="78" rx="22" fill="#c7f36d"/><text x="131" y="133" text-anchor="middle" font-family="Arial,DejaVu Sans,sans-serif" font-size="30" font-weight="800" fill="#08262d">FC</text>');
    svg.push('<text x="195" y="105" font-family="Arial,DejaVu Sans,sans-serif" font-size="19" font-weight="700" letter-spacing="3" fill="#8eb7b5">FLEET CONTROL</text>');
    svg.push('<text x="195" y="148" font-family="Arial,DejaVu Sans,sans-serif" font-size="34" font-weight="800" fill="#ffffff">Εβδομαδιαίο πρόγραμμα προσωπικού</text>');
    svg.push('<text x="' + (width - margin - 32) + '" y="106" text-anchor="end" font-family="Arial,DejaVu Sans,sans-serif" font-size="18" font-weight="700" fill="#c7f36d">' + xmlEscape(range) + '</text>');
    svg.push('<text x="' + (width - margin - 32) + '" y="145" text-anchor="end" font-family="Arial,DejaVu Sans,sans-serif" font-size="17" fill="#b7cecc">' + assignedPeople.size + ' διανομείς  •  ' + groups.length + ' βάρδιες  •  ' + assignedVehicles.size + ' μηχανάκια</text>');
    svg.push('<rect x="' + margin + '" y="' + tableTop + '" width="' + (width - margin * 2) + '" height="' + (tableHeader + rowHeight * employees.length) + '" rx="18" fill="#ffffff" stroke="#ccdcda" stroke-width="2"/>');
    svg.push('<rect x="' + margin + '" y="' + tableTop + '" width="' + (width - margin * 2) + '" height="' + tableHeader + '" rx="18" fill="#eaf2f0"/>');
    svg.push('<text x="' + (margin + 18) + '" y="' + (tableTop + 44) + '" font-family="Arial,DejaVu Sans,sans-serif" font-size="18" font-weight="800" fill="#29494e">ΔΙΑΝΟΜΕΑΣ</text>');
    dates.forEach(function (day, index) {
      const x = margin + firstColumn + index * dayWidth;
      if (index > 4) svg.push('<rect x="' + x + '" y="' + tableTop + '" width="' + dayWidth + '" height="' + (tableHeader + rowHeight * employees.length) + '" fill="#f7f4fc"/>');
      svg.push('<line x1="' + x + '" y1="' + tableTop + '" x2="' + x + '" y2="' + (tableTop + tableHeader + rowHeight * employees.length) + '" stroke="#d6e3e1" stroke-width="1"/>');
      svg.push('<text x="' + (x + dayWidth / 2) + '" y="' + (tableTop + 31) + '" text-anchor="middle" font-family="Arial,DejaVu Sans,sans-serif" font-size="16" font-weight="800" fill="#29494e">' + xmlEscape(day.name.toLocaleUpperCase("el")) + '</text>');
      svg.push('<text x="' + (x + dayWidth / 2) + '" y="' + (tableTop + 55) + '" text-anchor="middle" font-family="Arial,DejaVu Sans,sans-serif" font-size="15" fill="#6d8184">' + xmlEscape(isoDateLabel(day.date, false)) + '</text>');
    });
    employees.forEach(function (employee, rowIndex) {
      const y = tableTop + tableHeader + rowIndex * rowHeight;
      if (rowIndex % 2) svg.push('<rect x="' + margin + '" y="' + y + '" width="' + (width - margin * 2) + '" height="' + rowHeight + '" fill="#fbfdfc"/>');
      svg.push('<line x1="' + margin + '" y1="' + y + '" x2="' + (width - margin) + '" y2="' + y + '" stroke="#e2ebea" stroke-width="1"/>');
      svg.push('<text x="' + (margin + 18) + '" y="' + (y + rowHeight * .58) + '" font-family="Arial,DejaVu Sans,sans-serif" font-size="' + fontSize + '" font-weight="700" fill="#17373d">' + xmlEscape(shortText(employee.full_name, 29)) + '</text>');
      dates.forEach(function (day, columnIndex) {
        const entries = groups.filter(function (group) { return String(group.employeeId) === String(employee.id) && group.workDate === day.date; });
        if (!entries.length) return;
        const x = margin + firstColumn + columnIndex * dayWidth;
        const color = entries[0].color || "#0D8F82";
        const times = entries.map(function (entry) { return entry.segments.map(function (segment) { return segment.start + "-" + segment.end; }).join(" / "); }).join(" + ");
        const vehicles = entries.map(function (entry) { return entry.vehicleName || "Χωρίς μηχανάκι"; }).join(" / ");
        svg.push('<rect x="' + (x + 7) + '" y="' + (y + 5) + '" width="5" height="' + Math.max(10, rowHeight - 10) + '" rx="3" fill="' + xmlEscape(color) + '"/>');
        svg.push('<text x="' + (x + 19) + '" y="' + (y + rowHeight * .43) + '" font-family="Arial,DejaVu Sans,sans-serif" font-size="' + fontSize + '" font-weight="800" fill="#17373d">' + xmlEscape(shortText(times, 31)) + '</text>');
        svg.push('<text x="' + (x + 19) + '" y="' + (y + rowHeight * .75) + '" font-family="Arial,DejaVu Sans,sans-serif" font-size="' + smallFont + '" fill="#657b7f">' + xmlEscape(shortText(vehicles, 31)) + '</text>');
      });
    });
    svg.push('<text x="' + margin + '" y="' + (height - 30) + '" font-family="Arial,DejaVu Sans,sans-serif" font-size="14" fill="#708488">Fleet Control • Αυτόματη δημιουργία εβδομαδιαίου προγράμματος</text>');
    svg.push('<text x="' + (width - margin) + '" y="' + (height - 30) + '" text-anchor="end" font-family="Arial,DejaVu Sans,sans-serif" font-size="14" fill="#708488">Μία σελίδα • A3 landscape</text>');
    svg.push('</svg>');
    return { svg: svg.join(""), width: width, height: height };
  }

  function concatPdfParts(parts) {
    const length = parts.reduce(function (sum, item) { return sum + item.length; }, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    parts.forEach(function (item) { result.set(item, offset); offset += item.length; });
    return result;
  }

  function imagePdf(jpeg, imageWidth, imageHeight) {
    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [0];
    let length = 0;
    function append(value) { const bytes = typeof value === "string" ? encoder.encode(value) : value; parts.push(bytes); length += bytes.length; }
    function object(number, content) { offsets[number] = length; append(number + " 0 obj\n" + content + "\nendobj\n"); }
    append("%PDF-1.4\n%FleetControl\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
    offsets[4] = length;
    append("4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + imageWidth + " /Height " + imageHeight + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpeg.length + " >>\nstream\n");
    append(jpeg);
    append("\nendstream\nendobj\n");
    const content = "q\n1191 0 0 842 0 0 cm\n/Im0 Do\nQ\n";
    object(5, "<< /Length " + encoder.encode(content).length + " >>\nstream\n" + content + "endstream");
    const xref = length;
    append("xref\n0 6\n0000000000 65535 f \n");
    for (let index = 1; index <= 5; index += 1) append(String(offsets[index]).padStart(10, "0") + " 00000 n \n");
    append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    return concatPdfParts(parts);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    return btoa(binary);
  }

  async function downloadSchedulePdf() {
    if (!state.weekData || !assignmentGroups().length) return void toast("Καταχώρησε πρώτα το εβδομαδιαίο πρόγραμμα.");
    const button = $("schedulePdfButton");
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = "Δημιουργία PDF…";
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const layout = schedulePdfSvg();
      const url = URL.createObjectURL(new Blob([layout.svg], { type: "image/svg+xml;charset=utf-8" }));
      const image = await new Promise(function (resolve, reject) {
        const value = new Image();
        value.onload = function () { resolve(value); };
        value.onerror = function () { reject(new Error("Δεν δημιουργήθηκε η προεπισκόπηση PDF.")); };
        value.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = layout.width;
      canvas.height = layout.height;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      const jpegBlob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", .94); });
      if (!jpegBlob) throw new Error("Δεν ήταν δυνατή η δημιουργία του PDF.");
      const pdf = imagePdf(new Uint8Array(await jpegBlob.arrayBuffer()), canvas.width, canvas.height);
      const fileName = "Fleet_Control_Πρόγραμμα_" + state.weekData.weekStart + ".pdf";
      if (window.AndroidFleet && typeof window.AndroidFleet.savePdf === "function") {
        window.AndroidFleet.savePdf(bytesToBase64(pdf), fileName);
      } else {
        const pdfUrl = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
        const link = document.createElement("a");
        link.href = pdfUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(pdfUrl); }, 2000);
      }
      toast("Το επαγγελματικό PDF δημιουργήθηκε σε μία σελίδα.");
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = oldText; }
  }

  function shiftActions(item) {
    const buttons = [];
    if (item.status === "active" && can("shifts.manage")) buttons.push('<button data-shift-action="close" data-shift-id="' + escapeHtml(item.id) + '" type="button">Κλείσιμο</button>');
    if (item.status === "active" && !item.ownVehicle && can("shifts.vehicle.change")) buttons.push('<button data-shift-action="vehicle" data-shift-id="' + escapeHtml(item.id) + '" type="button">Αλλαγή μηχανής</button>');
    if (item.overtimeStatus === "pending" && (can("shifts.manage") || can("payroll.manage"))) {
      buttons.push('<button data-shift-action="approve-overtime" data-shift-id="' + escapeHtml(item.id) + '" type="button">Έγκριση</button>');
      buttons.push('<button data-shift-action="reject-overtime" data-shift-id="' + escapeHtml(item.id) + '" type="button">Απόρριψη</button>');
    }
    if (item.missingKm && !item.ownVehicle && can("shifts.manage")) buttons.push('<button data-shift-action="kilometers" data-shift-id="' + escapeHtml(item.id) + '" type="button">Χιλιόμετρα</button>');
    if (can("shifts.manage")) {
      buttons.push('<button data-shift-action="edit" data-shift-id="' + escapeHtml(item.id) + '" type="button">Επεξεργασία</button>');
      buttons.push('<button class="danger-action" data-shift-action="delete" data-shift-id="' + escapeHtml(item.id) + '" type="button">Διαγραφή</button>');
    }
    return buttons.length ? '<div class="table-actions">' + buttons.join("") + '</div>' : "—";
  }

  async function loadShifts() {
    if (!$("shiftFrom").value) $("shiftFrom").value = inputDate(-7);
    if (!$("shiftTo").value) $("shiftTo").value = inputDate(7);
    $("manualClockInButton").classList.toggle("is-hidden", !can("shifts.manage"));
    const query = new URLSearchParams({ from: $("shiftFrom").value, to: $("shiftTo").value });
    if ($("shiftStatus").value) query.set("status", $("shiftStatus").value);
    const data = await api("/api/admin/shifts?" + query.toString());
    state.shifts = data.shifts || [];
    $("shiftsTable").innerHTML = state.shifts.length ? '<table class="data-table"><thead><tr><th>Εργαζόμενος</th><th>Μηχανάκι</th><th>Clock In</th><th>Clock Out</th><th>Payable</th><th>Χλμ.</th><th>Κατάσταση</th><th>Ενέργειες</th></tr></thead><tbody>' + state.shifts.map(function (item) {
      return '<tr><td><strong>' + escapeHtml(item.employeeName) + '</strong></td><td>' + escapeHtml(item.vehicleName || "—") + '</td><td>' + escapeHtml(formatDateTime(item.actualClockIn)) + (item.outOfSchedule ? '<br><small>Εκτός προγράμματος</small>' : '') + '</td><td>' + escapeHtml(item.actualClockOut ? formatDateTime(item.actualClockOut) : "—") + '</td><td>' + escapeHtml(item.payableHours == null ? "—" : hours(item.payableHours)) + '</td><td>' + escapeHtml(item.shiftKm == null ? "—" : km(item.shiftKm)) + '</td><td>' + statusPill(item.status) + '</td><td>' + shiftActions(item) + '</td></tr>';
    }).join("") + '</tbody></table>' : '<p class="empty-copy">Δεν βρέθηκαν βάρδιες.</p>';
  }

  async function manualClockIn() {
    try {
      await loadAdminLists();
      const from = $("shiftFrom").value || inputDate(-7);
      const to = $("shiftTo").value || inputDate(7);
      const scheduleData = await api("/api/admin/schedules?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to));
      const schedules = (scheduleData.schedules || []).filter(function (item) {
        return !["cancelled", "completed", "working"].includes(String(item.status));
      });
      if (!schedules.length) throw new Error("Δεν βρέθηκε διαθέσιμη προγραμματισμένη βάρδια για χειροκίνητο Clock In.");
      const scheduleById = new Map(schedules.map(function (item) { return [String(item.id), item]; }));
      const options = schedules.map(function (item) {
        const vehicle = item.vehicle_name || (item.vehicle_id ? "Μηχανάκι" : "Χωρίς μηχανάκι");
        return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.employee_name || "—") + ' • ' + escapeHtml(formatDateTime(item.start_at)) + '–' + escapeHtml(formatDateTime(item.end_at)) + ' • ' + escapeHtml(vehicle) + '</option>';
      }).join("");
      const first = schedules[0];
      const editor = simpleEditor({
        overline: "ΔΙΟΡΘΩΣΗ ΠΑΡΟΥΣΙΑΣ", title: "Χειροκίνητο Clock In", submit: "Καταχώρηση Clock In", wide: false,
        html: '<label class="field"><span>Προγραμματισμένη βάρδια</span><select id="manualClockInSchedule">' + options + '</select><small>Χρησιμοποίησε το όταν ο εργαζόμενος ξέχασε να πατήσει Clock In.</small></label>' +
          '<div id="manualClockInInfo" class="shift-edit-summary"></div>' +
          '<label class="field"><span>Πραγματική ώρα Clock In</span><input id="manualClockInTime" type="datetime-local" value="' + escapeHtml(datetimeInput(first.start_at)) + '" required></label>' +
          '<div id="manualClockInVehicleFields"></div><p id="manualClockInOwnHint" class="editor-hint is-hidden"></p>' +
          '<label class="field"><span>Αιτιολογία</span><textarea id="manualClockInReason" rows="3" maxlength="500" placeholder="π.χ. Ξέχασε το Clock In και επιβεβαιώθηκε από τον υπεύθυνο." required></textarea></label>',
        collect: function () {
          const schedule = scheduleById.get(String($("manualClockInSchedule").value));
          const value = $("manualClockInTime").value;
          const time = new Date(value);
          const reason = $("manualClockInReason").value.trim();
          if (!schedule || !value || !Number.isFinite(time.getTime())) throw new Error("Διάλεξε σωστή βάρδια και ώρα Clock In.");
          if (!reason) throw new Error("Γράψε αιτιολογία.");
          const ownVehicle = Boolean(schedule.uses_own_vehicle);
          const result = { scheduleId: schedule.id, actualClockIn: time.toISOString(), reason: reason };
          if (!ownVehicle) {
            result.vehicleId = $("manualClockInVehicle").value;
            result.initialKm = Number($("manualClockInInitialKm").value);
            if (!result.vehicleId) throw new Error("Διάλεξε μηχανάκι.");
            if (!Number.isFinite(result.initialKm) || result.initialKm < 0) throw new Error("Γράψε σωστά αρχικά χιλιόμετρα.");
          }
          return result;
        }
      });
      const render = function () {
        const schedule = scheduleById.get(String($("manualClockInSchedule").value));
        if (!schedule) return;
        const ownVehicle = Boolean(schedule.uses_own_vehicle);
        $("manualClockInInfo").innerHTML = '<span><small>Εργαζόμενος</small><strong>' + escapeHtml(schedule.employee_name || "—") + '</strong></span><span><small>Πρόγραμμα</small><strong>' + escapeHtml(formatDateTime(schedule.start_at)) + ' – ' + escapeHtml(formatDateTime(schedule.end_at)) + '</strong></span>';
        $("manualClockInTime").value = datetimeInput(schedule.start_at);
        $("manualClockInOwnHint").classList.toggle("is-hidden", !ownVehicle);
        $("manualClockInOwnHint").textContent = ownVehicle ? "Ιδιόκτητο μηχανάκι — δεν ζητούνται μηχανάκι ή χιλιόμετρα." : "";
        if (ownVehicle) {
          $("manualClockInVehicleFields").innerHTML = "";
          return;
        }
        const preferredId = schedule.vehicle_id || schedule.assigned_vehicle_id || "";
        const choices = state.vehicles.filter(function (item) { return item.available || String(item.id) === String(preferredId); });
        $("manualClockInVehicleFields").innerHTML = '<label class="field"><span>Μηχανάκι</span><select id="manualClockInVehicle">' + choices.map(function (item) { return '<option value="' + escapeHtml(item.id) + '" ' + (String(item.id) === String(preferredId) ? "selected" : "") + '>' + escapeHtml(item.name) + ' • ' + escapeHtml(km(item.odometer)) + '</option>'; }).join("") + '</select></label><label class="field"><span>Αρχικά χιλιόμετρα</span><input id="manualClockInInitialKm" type="number" min="0" inputmode="numeric" value="' + (choices.find(function (item) { return String(item.id) === String(preferredId); })?.odometer || choices[0]?.odometer || 0) + '"></label>';
        const vehicleInput = $("manualClockInVehicle");
        if (vehicleInput) vehicleInput.addEventListener("change", function () {
          const selected = state.vehicles.find(function (item) { return String(item.id) === String(vehicleInput.value); });
          if (selected) $("manualClockInInitialKm").value = Number(selected.odometer || 0);
        });
        if (!choices.length) $("manualClockInVehicleFields").innerHTML = '<p class="form-error">Δεν υπάρχει διαθέσιμο μηχανάκι. Η καταχώρηση θα απορριφθεί μέχρι να ελευθερωθεί ένα.</p>';
      };
      setTimeout(function () {
        $("manualClockInSchedule").addEventListener("change", render);
        render();
      }, 0);
      const data = await editor;
      const confirmation = await requestPin(true);
      await api("/api/admin/shifts/manual-clock-in", { method: "POST", pin: confirmation.pin, body: data });
      toast("Το χειροκίνητο Clock In καταχωρήθηκε και καταγράφηκε στο Audit Log.");
      state.viewLoadedAt.shifts = 0;
      await loadShifts();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function runShiftAction(shiftId, action) {
    const shift = state.shifts.find(function (item) { return String(item.id) === String(shiftId); });
    if (!shift) return;
    let body = {};
    try {
      if (action === "edit") {
        const active = shift.status === "active";
        const ownVehicle = Boolean(shift.ownVehicle);
        const endValue = datetimeInput(shift.actualClockOut || shift.effectiveClockOut);
        body = await simpleEditor({
          overline: "ΔΙΟΡΘΩΣΗ ΒΑΡΔΙΑΣ", title: "Επεξεργασία βάρδιας", submit: "Αποθήκευση αλλαγών",
          html: '<div class="shift-edit-summary"><span><small>Εργαζόμενος</small><strong>' + escapeHtml(shift.employeeName || "—") + '</strong></span><span><small>Μηχανάκι</small><strong>' + escapeHtml(shift.vehicleName || "—") + '</strong></span></div>' +
            '<label class="field"><span>Ώρα έναρξης</span><input id="editShiftIn" type="datetime-local" value="' + escapeHtml(datetimeInput(shift.actualClockIn)) + '" required></label>' +
            (active ? '<p class="editor-hint">' + (ownVehicle ? 'Η βάρδια είναι ενεργή. Δεν καταγράφονται χιλιόμετρα.' : 'Η βάρδια είναι ενεργή. Η ώρα λήξης και τα τελικά χιλιόμετρα καταχωρούνται κατά το κλείσιμο.') + '</p>' : '<label class="field"><span>Ώρα λήξης</span><input id="editShiftOut" type="datetime-local" value="' + escapeHtml(endValue) + '" required></label>') +
            (ownVehicle ? '<p class="editor-hint">Ιδιόκτητο μηχανάκι — χωρίς αρχικά ή τελικά χιλιόμετρα.</p>' : '<label class="field"><span>Αρχικά χιλιόμετρα</span><input id="editShiftInitialKm" type="number" min="0" inputmode="numeric" value="' + Number(shift.initialKm || 0) + '" required></label>' +
            (active ? '' : '<label class="field"><span>Τελικά χιλιόμετρα' + (shift.missingKm ? ' (προαιρετικά)' : '') + '</span><input id="editShiftFinalKm" type="number" min="0" inputmode="numeric" value="' + (shift.finalKm == null ? '' : Number(shift.finalKm)) + '" ' + (shift.finalKm == null ? '' : 'required') + '></label>')) +
            '<label class="field"><span>Σημειώσεις</span><textarea id="editShiftNotes" rows="3" maxlength="500">' + escapeHtml(shift.notes || "") + '</textarea></label>',
          collect: function () {
            const startValue = $("editShiftIn").value;
            const start = new Date(startValue);
            if (!startValue || !Number.isFinite(start.getTime())) throw new Error("Διάλεξε σωστή ώρα έναρξης.");
            if (ownVehicle) {
              if (active) return { actualClockIn: start.toISOString(), actualClockOut: null, finalKm: null, notes: $("editShiftNotes").value.trim() };
              const endValue = $("editShiftOut").value;
              const end = new Date(endValue);
              if (!endValue || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) throw new Error("Η ώρα λήξης πρέπει να είναι μετά την έναρξη.");
              return { actualClockIn: start.toISOString(), actualClockOut: end.toISOString(), finalKm: null, notes: $("editShiftNotes").value.trim() };
            }
            const initialKm = Number($("editShiftInitialKm").value);
            if (!Number.isFinite(initialKm) || initialKm < 0) throw new Error("Γράψε σωστά αρχικά χιλιόμετρα.");
            if (active) return { actualClockIn: start.toISOString(), actualClockOut: null, initialKm: initialKm, finalKm: null, notes: $("editShiftNotes").value.trim() };
            const endValue = $("editShiftOut").value;
            const end = new Date(endValue);
            if (!endValue || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) throw new Error("Η ώρα λήξης πρέπει να είναι μετά την έναρξη.");
            const finalValue = $("editShiftFinalKm").value;
            const finalKm = finalValue === "" ? null : Number(finalValue);
            if (finalKm != null && (!Number.isFinite(finalKm) || finalKm < 0)) throw new Error("Γράψε σωστά τελικά χιλιόμετρα.");
            return { actualClockIn: start.toISOString(), actualClockOut: end.toISOString(), initialKm: initialKm, finalKm: finalKm, notes: $("editShiftNotes").value.trim() };
          }
        });
      }
      if (action === "delete") {
        body = await simpleEditor({
          overline: "ΟΡΙΣΤΙΚΗ ΕΝΕΡΓΕΙΑ", title: "Διαγραφή βάρδιας", submit: "Συνέχεια στη διαγραφή", danger: true,
          html: '<div class="delete-warning"><strong>Θα διαγραφεί ολόκληρη η βάρδια.</strong><p>' + escapeHtml(shift.employeeName || "—") + ' • ' + escapeHtml(shift.vehicleName || "—") + '<br>' + escapeHtml(formatDateTime(shift.actualClockIn)) + '</p><small>Το official odometer της μηχανής δεν μειώνεται αυτόματα, για λόγους ασφάλειας.</small></div>',
          collect: function () { return { confirmDelete: true }; }
        });
      }
      if (action === "kilometers") {
        body = await simpleEditor({
          overline: "OFFICIAL ODOMETER", title: "Καταχώρηση τελικών χιλιομέτρων", submit: "Καταχώρηση",
          html: '<label class="field"><span>Τελικά χιλιόμετρα</span><input id="shiftFinalKm" type="number" min="0" inputmode="numeric" required></label>',
          collect: function () { const finalKm = Number($("shiftFinalKm").value); if (!Number.isFinite(finalKm)) throw new Error("Γράψε τα τελικά χιλιόμετρα."); return { finalKm: finalKm }; }
        });
      }
      if (action === "close") {
        body = await simpleEditor({
          overline: "ΚΡΙΣΙΜΗ ΕΝΕΡΓΕΙΑ", title: "Κλείσιμο ενεργής βάρδιας", submit: "Κλείσιμο βάρδιας",
          html: '<p>Η βάρδια θα κλείσει χωρίς επινόηση χιλιομέτρων και θα εμφανιστεί ως εκκρεμής.</p><label class="field"><span>Payable ώρα λήξης</span><input id="shiftCloseTime" type="datetime-local" required></label>',
          collect: function () { const value = $("shiftCloseTime").value; if (!value) throw new Error("Διάλεξε ώρα λήξης."); return { effectiveClockOut: new Date(value).toISOString() }; }
        });
      }
      if (action === "vehicle") {
        await loadAdminLists();
        const choices = state.vehicles.filter(function (item) { return item.available && String(item.id) !== String(shift.vehicleId); });
        body = await simpleEditor({
          overline: "ACTIVE SHIFT", title: "Αλλαγή μηχανής", submit: "Αλλαγή",
          html: '<label class="field"><span>Τρέχοντα χιλιόμετρα παλιάς μηχανής</span><input id="oldVehicleKm" type="number" inputmode="numeric" required></label><label class="field"><span>Νέο μηχανάκι</span><select id="nextVehicle">' + choices.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + ' • ' + escapeHtml(km(item.odometer)) + '</option>'; }).join("") + '</select></label>',
          collect: function () { if (!choices.length) throw new Error("Δεν υπάρχει άλλο διαθέσιμο μηχανάκι."); const currentKm = Number($("oldVehicleKm").value); if (!Number.isFinite(currentKm)) throw new Error("Γράψε τα χιλιόμετρα."); return { currentKm: currentKm, vehicleId: $("nextVehicle").value }; }
        });
      }
      if (action === "approve-overtime") {
        const scheduledEndMs = new Date(shift.scheduledEnd || "").getTime();
        const actualEndMs = new Date(shift.actualClockOut || Date.now()).getTime();
        const defaultOvertimeMinutes = shift.overtimeMinutesOverride == null
          ? (Number.isFinite(scheduledEndMs) && Number.isFinite(actualEndMs) ? Math.max(0, Math.round((actualEndMs - scheduledEndMs) / 60000)) : 0)
          : Number(shift.overtimeMinutesOverride);
        body = await simpleEditor({
          overline: "ΕΓΚΡΙΣΗ ΥΠΕΡΩΡΙΑΣ", title: "Έγκριση και υπολογισμός", submit: "Έγκριση υπερωρίας", wide: false,
          html: '<div class="overtime-approval-summary"><span><small>Εργαζόμενος</small><strong>' + escapeHtml(shift.employeeName || "—") + '</strong></span><span><small>Προγραμματισμένο τέλος</small><strong>' + escapeHtml(formatDateTime(shift.scheduledEnd)) + '</strong></span><span><small>Πραγματικό Clock Out</small><strong>' + escapeHtml(formatDateTime(shift.actualClockOut)) + '</strong></span></div><p class="editor-hint">Μέχρι την προγραμματισμένη λήξη η μισθοδοσία παραμένει ως έχει. Επίλεξε πόσα λεπτά εγκρίνεις· μόνο αυτά θα υπολογιστούν. Η έγκριση καταγράφει αυτόματα ποιος την έκανε.</p><label class="field"><span>Εγκεκριμένα λεπτά υπερωρίας</span><input id="overtimeMinutesOverride" type="number" min="0" max="720" step="1" value="' + defaultOvertimeMinutes + '" required><small>Π.χ. 30 λεπτά σε €15/ώρα = €7,50 πρόσθετη αμοιβή.</small></label><label class="field"><span>Τιμή υπερωρίας €/ώρα (προαιρετικά)</span><input id="overtimeRateOverride" type="number" min="0" step="0.01" placeholder="Κενό = οι ζώνες του κανόνα, π.χ. €15/ώρα"></label>',
          collect: function () {
            const minutes = Number($("overtimeMinutesOverride").value);
            if (!Number.isInteger(minutes) || minutes < 0 || minutes > 720) throw new Error("Γράψε εγκεκριμένα λεπτά από 0 έως 720.");
            const value = $("overtimeRateOverride").value.trim();
            if (value === "") return { overtimeMinutes: minutes, overtimeRateCents: null };
            const amount = Number(value);
            if (!Number.isFinite(amount) || amount < 0) throw new Error("Γράψε έγκυρη τιμή υπερωρίας.");
            return { overtimeMinutes: minutes, overtimeRateCents: Math.round(amount * 100) };
          }
        });
      }
      const confirmation = await requestPin(true);
      body.reason = confirmation.reason;
      await api("/api/admin/shifts/" + encodeURIComponent(shiftId) + "/" + action, { method: "POST", pin: confirmation.pin, body: body });
      toast(action === "delete" ? "Η βάρδια διαγράφηκε και η ενέργεια καταγράφηκε." : "Η αλλαγή αποθηκεύτηκε και καταγράφηκε στο Audit Log.");
      state.vehicles = [];
      await loadShifts();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  const invoiceStatusLabels = {
    processing: "Σε επεξεργασία",
    delayed: "Καθυστέρηση",
    needs_review: "Προς έλεγχο",
    warning: "Χρειάζεται προσοχή",
    confirmed: "Επιβεβαιωμένο",
    uploaded: "Ανεβασμένο",
    error: "Σφάλμα"
  };

  function invoiceStatusPill(status) {
    const value = String(status || "uploaded");
    const tone = value === "error" ? "critical" : ["processing", "delayed", "needs_review", "warning"].includes(value) ? "warning" : "";
    return '<span class="status-pill invoice-status-pill ' + tone + '">' + escapeHtml(invoiceStatusLabels[value] || value) + '</span>';
  }

  function portalTaskKey(value) {
    return String(value || "").toLocaleLowerCase("el")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9α-ω]+/g, "");
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

  function portalLineText(value, limit) {
    const max = Number(limit) || 500;
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return stripInvoicePartCode(String(value).trim().slice(0, max));
    if (typeof value === "object" && !Array.isArray(value)) {
      const preferred = ["description", "name", "item", "text", "label", "title", "work", "service", "part", "product", "details", "value"];
      for (let i = 0; i < preferred.length; i += 1) {
        const key = preferred[i];
        if (value[key] != null && String(value[key]).trim()) return stripInvoicePartCode(String(value[key]).trim().slice(0, max));
      }
      try { return stripInvoicePartCode(Object.entries(value).filter(function (pair) { return pair[1] != null && String(pair[1]).trim(); }).map(function (pair) { return pair[0] + ": " + pair[1]; }).join(" · ").slice(0, max)); } catch (error) { return ""; }
    }
    return stripInvoicePartCode(String(value).replace(/\[object Object\]/g, "").trim().slice(0, max));
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

  function portalMergeInvoiceTasks(values) {
    const result = [];
    const isOil = function (value) {
      const text = String(value || "");
      if (/^\s*φίλτρ(?:ο|ου|ων|α)?\s+λ[άα]δι(?:ού|ών|ων|α)?/iu.test(text)) return false;
      return /\b(?:ladi|oil|yamalube)\b|λ[άα]δι(?:ού|ών|ων|α)?|λιπαντικ/i.test(text);
    };
    const oilDetail = function (value) {
      return String(value || "")
        .replace(/\b(change|changed|replacement|replace)\s+oil(s)?\b/ig, "")
        .replace(/\b(oil|ladi)\s+change\b/ig, "")
        .replace(/αλλαγ(?:η|ή)\s+λαδι(?:ών|ων|α)/ig, "")
        .replace(/λαδι(?:ών|ων|α)/ig, "")
        .replace(/[–—:;,·]+/g, " ").replace(/\s+/g, " ").trim();
    };
    (Array.isArray(values) ? values : []).forEach(function (raw) {
      const task = cleanInvoiceWorkText(portalLineText(raw, 180));
      if (!task) return;
      const oilIndex = result.findIndex(isOil);
      if (isOil(task) && oilIndex >= 0) {
        const currentDetail = oilDetail(result[oilIndex]);
        const nextDetail = oilDetail(task);
        const detail = currentDetail.length >= nextDetail.length ? currentDetail : nextDetail;
        result[oilIndex] = (detail ? "Αλλαγή λαδιών — " + detail : "Αλλαγή λαδιών").slice(0, 180);
        return;
      }
      const key = portalTaskKey(task);
      if (!key || result.some(function (item) {
        const existingKey = portalTaskKey(item);
        return existingKey === key || existingKey.includes(key) || key.includes(existingKey);
      })) return;
      result.push(task);
    });
    return result.slice(0, 30);
  }

  function portalInvoiceWorkItems(documentRecord) {
    const data = documentRecord && documentRecord.invoiceData && typeof documentRecord.invoiceData === "object" ? documentRecord.invoiceData : {};
    const values = [];
    if (Array.isArray(documentRecord && documentRecord.tasks)) values.push.apply(values, documentRecord.tasks);
    values.push.apply(values, portalLineText(data.workPerformed, 3000).split(/\r?\n|\s*[•;]+\s*/));
    if (Array.isArray(data.lineItems)) values.push.apply(values, data.lineItems);
    if (Array.isArray(data.parts)) values.push.apply(values, data.parts);
    return portalMergeInvoiceTasks(values);
  }

  function invoiceReviewDate(value) {
    const candidate = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
    const match = candidate.match(/(^|\D)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\D|$)/);
    return match ? match[4] + "-" + String(match[3]).padStart(2, "0") + "-" + String(match[2]).padStart(2, "0") : "";
  }

  function invoiceDocumentById(id) {
    return (state.invoiceDocuments || []).find(function (item) { return String(item.id) === String(id); }) || null;
  }

  // The Server stores batch timestamps as ISO strings, while the local
  // optimistic state uses epoch milliseconds.  Number(isoString) is NaN and
  // would make the animated bulk percentage NaN as well.
  function invoiceTimestampMs(value) {
    const raw = String(value == null ? "" : value).trim();
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function invoiceElapsedLabel(seconds) {
    const numeric = Number(seconds);
    if (!Number.isFinite(numeric)) return "Χρόνος: —";
    const safeSeconds = Math.max(0, Math.floor(numeric));
    if (safeSeconds > 600) return "Χρόνος: >10:00";
    const minutes = Math.floor(safeSeconds / 60);
    const rest = String(safeSeconds % 60).padStart(2, "0");
    return minutes ? "Χρόνος: " + minutes + ":" + rest : "Χρόνος: 00:" + rest;
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
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const computed = window.getComputedStyle ? window.getComputedStyle(canvas) : null;
    const cssWidth = Number(rect && rect.width) || Number(canvas.clientWidth) || Number.parseFloat(computed && computed.width) || 48;
    const cssHeight = Number(rect && rect.height) || Number(canvas.clientHeight) || Number.parseFloat(computed && computed.height) || cssWidth;
    const size = Math.max(24, Math.round(Math.min(cssWidth, cssHeight)));
    const deviceScale = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
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
    const phase = (Number(time) || 0) * .0017;
    const steps = 180;
    const pointAt = function (fraction) {
      const angle = -Math.PI / 2 + fraction * Math.PI * 2;
      const wave = Math.sin(angle * 5.4 + phase * 3.2) * size * .026
        + Math.sin(angle * 9.3 - phase * 2.1) * size * .014
        + Math.sin(angle * 15.7 + phase * 1.25) * size * .006;
      const pulse = 1 + Math.sin(phase * 1.35) * .018;
      const distance = (radius + wave) * pulse;
      return { x: center + Math.cos(angle) * distance, y: center + Math.sin(angle) * distance };
    };
    const trace = function (fraction) {
      const count = Math.max(1, Math.round(steps * Math.max(0, Math.min(1, fraction))));
      context.beginPath();
      for (let index = 0; index <= count; index += 1) {
        const point = pointAt(index / steps);
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
      trace(displayedProgress / 100);
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

  function invoiceProgressModel(item) {
    const value = item || {};
    const data = value.invoiceData || {};
    const status = String(value.status || "processing");
    const directProgress = Number(value.progress);
    const storedProgress = Number(data.qrProcessingProgress);
    const reportedValue = Number.isFinite(directProgress) ? directProgress : Number.isFinite(storedProgress) ? storedProgress : 5;
    const reported = Math.max(5, Math.min(100, reportedValue));
    // createdAt may be the original upload date. For a retry, lastAttemptAt
    // or qrProcessingStartedAt is the start of the current attempt.
    const started = invoiceTimestampMs(value.lastAttemptAt || data.qrProcessingStartedAt || value.createdAt);
    const updated = invoiceTimestampMs(value.lastAttemptAt || data.qrProcessingUpdatedAt || data.qrProcessingStartedAt || value.createdAt);
    const now = Date.now();
    const fallbackElapsed = Number(value.elapsedSeconds);
    const elapsedSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : Number.isFinite(fallbackElapsed) ? Math.max(0, Math.floor(fallbackElapsed)) : 0;
    if (status === "confirmed" || status === "completed") return { progress: 100, elapsedSeconds: elapsedSeconds, estimated: false };
    if (status === "error") return { progress: reported, elapsedSeconds: elapsedSeconds, estimated: false };
    const sinceUpdate = Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 1000)) : elapsedSeconds;
    const cap = reported <= 5 ? 55 : reported <= 55 ? 70 : reported <= 70 ? 95 : 98;
    const estimated = reported + Math.min(Math.max(0, cap - reported), Math.floor(sinceUpdate / 3));
    const progress = Math.max(reported, Math.min(cap, estimated));
    return { progress: progress, elapsedSeconds: elapsedSeconds, estimated: progress !== reported };
  }

  function invoiceProgressMarkup(item) {
    const model = invoiceProgressModel(item);
    const progress = model.progress;
    const seconds = model.elapsedSeconds;
    const elapsed = invoiceElapsedLabel(seconds);
    const stage = item && item.progressStage || "Σε επεξεργασία από τον Server";
    const status = String(item && item.status || "processing");
    return '<div class="invoice-progress-panel"><div class="invoice-progress-ring" style="--progress:' + progress + '" aria-label="' + progress + '%"><canvas class="invoice-progress-canvas" data-wiggly-progress data-progress="' + progress + '" data-status="' + escapeHtml(status) + '" width="96" height="96" aria-hidden="true"></canvas><strong>' + progress + '%</strong></div><div><strong>' + escapeHtml(stage) + '</strong><small>' + elapsed + (model.estimated ? " · εκτίμηση" : "") + (item.attempts ? " · προσπάθειες: " + item.attempts : "") + '</small>' + (item.error ? '<p>' + escapeHtml(item.error) + '</p>' : '') + '</div></div>';
  }

  function renderInvoiceBulkProgress() {
    const root = $("invoiceBulkProgress");
    if (!root) return;
    const progress = state.invoiceReprocessProgress;
    if (!progress) {
      root.classList.add("is-hidden");
      root.setAttribute("aria-busy", "false");
      return;
    }
    const rawTotal = Number(progress.total);
    const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.max(1, Math.floor(rawTotal)) : 1;
    const rawCurrent = Number(progress.current);
    const current = Number.isFinite(rawCurrent) ? Math.max(0, Math.min(total, Math.floor(rawCurrent))) : 0;
    const activeTimestamp = invoiceTimestampMs(progress.currentStartedAt || progress.startedAt);
    const activeElapsed = progress.done ? 0 : Number.isFinite(activeTimestamp) ? Math.max(0, Math.floor((Date.now() - activeTimestamp) / 1000)) : 0;
    const estimatedWithinInvoice = !progress.done && current < total ? Math.min(.85, activeElapsed / 30) : 0;
    const displayedCount = progress.done ? current : Math.min(total, current + estimatedWithinInvoice);
    const calculatedPercentage = total > 0 ? Math.round((displayedCount / total) * 100) : 0;
    const percentage = Number.isFinite(calculatedPercentage) ? Math.max(0, Math.min(100, calculatedPercentage)) : 0;
    const ring = root.querySelector(".invoice-bulk-progress-ring");
    if (ring) {
      ring.style.setProperty("--progress", String(percentage));
      ring.setAttribute("aria-label", percentage + "%");
      ring.dataset.status = progress.failed || progress.error ? "error" : progress.done ? "completed" : "processing";
      const canvas = ring.querySelector("[data-wiggly-progress]");
      if (canvas) canvas.dataset.progress = String(percentage);
      const value = ring.querySelector("strong");
      if (value) value.textContent = percentage + "%";
    }
    const title = $("invoiceBulkProgressTitle");
    const detail = $("invoiceBulkProgressDetail");
    const status = $("invoiceBulkProgressStatus");
    if (title) title.textContent = String(progress.title || "Νέα ανάγνωση τιμολογίων");
    if (detail) detail.textContent = String(progress.detail || (current + "/" + total));
    if (status) status.textContent = String(progress.status || "") + (!progress.done && activeElapsed ? " · χρόνος: " + (activeElapsed >= 60 ? Math.floor(activeElapsed / 60) + ":" + String(activeElapsed % 60).padStart(2, "0") : "00:" + String(activeElapsed).padStart(2, "0")) + " · εκτίμηση" : "");
    root.classList.toggle("has-error", Boolean(progress.failed || progress.error));
    root.classList.toggle("has-success", Boolean(progress.done && !progress.failed && !progress.error));
    root.classList.remove("is-hidden");
    root.setAttribute("aria-busy", progress.done ? "false" : "true");
    refreshWigglyProgressRings(root);
  }

  function invoicePlateKey(value) {
    const greek = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ";
    const latin = "ABEZHIKMNOPTYX";
    return String(value || "").normalize("NFKC").toUpperCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, (letter) => latin.charAt(greek.indexOf(letter)))
      .replace(/[^A-Z0-9Α-Ω]/g, "");
  }

  function invoiceDocumentDateKey(item) {
    const raw = String(item && item.invoiceData && item.invoiceData.invoiceDate || "").trim();
    const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|T)/);
    const local = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : null;
    if (!parts) return "";
    const year = Number(parts[0]), month = Number(parts[1]), day = Number(parts[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? parts[0] + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0") : "";
  }

  function invoiceFileGroups(records, selectedPlate, search) {
    const groups = new Map(), seen = new Set();
    const query = String(search || "").trim().toLocaleLowerCase("el");
    const queryPlate = invoicePlateKey(query);
    (records || []).forEach(function (item) {
      if (!item || !item.key || seen.has(String(item.key))) return;
      if (item.contentType !== "application/pdf" && !/\.pdf$/i.test(item.name || "")) return;
      const plate = String(item.bikeName || item.invoiceData && item.invoiceData.plate || "").trim();
      const label = plate || "Χωρίς πινακίδα";
      const key = invoicePlateKey(plate) || "unknown";
      if (selectedPlate && selectedPlate !== key) return;
      if (query && !(label + " " + (item.name || "")).toLocaleLowerCase("el").includes(query)
          && (!queryPlate || !invoicePlateKey(label).includes(queryPlate))) return;
      seen.add(String(item.key));
      if (!groups.has(key)) groups.set(key, { key: key, label: label, items: [] });
      groups.get(key).items.push(item);
    });
    return Array.from(groups.values()).sort(function (a, b) { return a.label.localeCompare(b.label, "el"); }).map(function (group) {
      group.items.sort(function (a, b) {
        // Oldest invoice first. Unknown invoice dates stay at the end; the
        // upload date is only a tie breaker, never presented as an invoice date.
        return (invoiceDocumentDateKey(a) || "9999").localeCompare(invoiceDocumentDateKey(b) || "9999")
          || String(a.uploadedAt || "").localeCompare(String(b.uploadedAt || ""))
          || String(a.name || "").localeCompare(String(b.name || ""), "el")
          || String(a.key).localeCompare(String(b.key));
      });
      return group;
    });
  }

  function invoiceGroupMarkup(key, label, items, meta, content, view) {
    const groupId = view + ":" + key;
    const collapsed = state.invoiceCollapsedGroups.has(groupId);
    const bodyId = "invoice-group-" + view + "-" + encodeURIComponent(key);
    return '<section class="invoice-plate-group' + (collapsed ? ' is-collapsed' : '') + '" data-invoice-group="' + escapeHtml(groupId) + '"><button type="button" class="invoice-plate-toggle" data-invoice-group-toggle="' + escapeHtml(groupId) + '" aria-expanded="' + (!collapsed) + '" aria-controls="' + escapeHtml(bodyId) + '"><span><strong>' + escapeHtml(label) + '</strong><small>' + items.length + (items.length === 1 ? ' τιμολόγιο' : ' τιμολόγια') + '</small></span><small>' + escapeHtml(meta || '') + '</small></button><div id="' + escapeHtml(bodyId) + '" class="invoice-group-body"' + (collapsed ? ' inert' : '') + '><div class="invoice-group-clip"><div class="invoice-plate-items">' + content + '</div></div></div></section>';
  }

  function toggleInvoiceGroup(button) {
    const key = button.dataset.invoiceGroupToggle;
    const group = button.closest("[data-invoice-group]");
    if (!group) return;
    const collapsed = !state.invoiceCollapsedGroups.has(key);
    if (collapsed) state.invoiceCollapsedGroups.add(key); else state.invoiceCollapsedGroups.delete(key);
    group.classList.toggle("is-collapsed", collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    const body = group.querySelector(".invoice-group-body");
    if (body) body.inert = collapsed;
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    state.invoiceGroupAnimationUntil = reduced ? 0 : Date.now() + 380;
  }

  function setInvoiceView(view) {
    state.invoiceView = view === "files" ? "files" : "review";
    document.querySelectorAll("[data-invoice-view]").forEach(function (button) {
      const active = button.dataset.invoiceView === state.invoiceView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderInvoiceQueue();
  }

  function renderInvoiceFileList(records, selectedPlate) {
    const groups = invoiceFileGroups(records, selectedPlate, $("invoiceFileSearch")?.value);
    const root = $("invoiceQueueList");
    if (!root) return;
    root.innerHTML = groups.length ? groups.map(function (group) {
      const rows = group.items.map(function (item) {
        return '<div class="invoice-file-row"><span class="invoice-file-icon" aria-hidden="true">▤</span><strong>' + escapeHtml(item.name || "Τιμολόγιο.pdf") + '</strong><div class="invoice-file-actions"><button type="button" class="secondary-button" data-invoice-open="' + escapeHtml(item.id) + '" aria-label="' + escapeHtml('Άνοιγμα ' + item.name) + '">Άνοιγμα</button><button type="button" class="secondary-button" data-invoice-download="' + escapeHtml(item.id) + '" aria-label="' + escapeHtml('Λήψη ' + item.name) + '">Λήψη</button></div></div>';
      }).join("");
      return invoiceGroupMarkup(group.key, group.label, group.items, "", rows, "files");
    }).join("") : '<div class="invoice-queue-empty"><span>▤</span><strong>Δεν βρέθηκαν αποθηκευμένα PDF.</strong><p>Εδώ εμφανίζονται όλα τα διαθέσιμα αρχεία, ανεξάρτητα από την κατάσταση ελέγχου τους.</p></div>';
  }

  function renderInvoiceQueue() {
    // Polling must not replace an accordion midway through its transition.
    const remaining = state.invoiceGroupAnimationUntil - Date.now();
    if (remaining > 0) {
      if (!state.invoiceGroupRenderTimer) state.invoiceGroupRenderTimer = window.setTimeout(function () {
        state.invoiceGroupRenderTimer = 0;
        renderInvoiceQueue();
      }, remaining + 15);
      return;
    }
    const filesView = state.invoiceView === "files";
    if ($("invoiceStatusFilter")) $("invoiceStatusFilter").hidden = filesView;
    if ($("invoiceQueueSummary")) $("invoiceQueueSummary").hidden = filesView;
    if ($("invoiceFileSearch")) $("invoiceFileSearch").hidden = !filesView;
    const records = Array.isArray(state.invoiceDocuments) ? state.invoiceDocuments : [];
    const filter = String($("invoiceStatusFilter")?.value || "");
    if ($("reprocessInvoices")) {
      $("reprocessInvoices").hidden = !can("fleet.manage");
      $("reprocessInvoices").disabled = Boolean(state.invoiceReprocessBusy || state.invoiceReprocessStarting);
      const progress = state.invoiceReprocessProgress;
      const progressLabel = progress && !progress.done ? " " + Math.min(Number(progress.current || 0) + 1, Number(progress.total || 1)) + "/" + Number(progress.total || 1) : "";
      $("reprocessInvoices").textContent = state.invoiceReprocessBusy ? "↻ Νέα ανάγνωση" + progressLabel + "…" : "↻ Νέα ανάγνωση όλων";
    }
    renderInvoiceBulkProgress();
    const plateSelect = $("invoicePlateFilter");
    const plateKey = function (item) { if (filesView) return invoicePlateKey(item && item.bikeName || item && item.invoiceData && item.invoiceData.plate) || "unknown"; return invoicePlateKey(item && item.invoiceData && item.invoiceData.plateResolution === "kept-current" ? item.bikeName : item && item.invoiceData && item.invoiceData.plate) || invoicePlateKey(item && item.bikeName) || "unknown"; };
    const plateLabel = function (item) { if (filesView) return String(item && item.bikeName || item && item.invoiceData && item.invoiceData.plate || "Χωρίς πινακίδα"); return String(item && item.invoiceData && item.invoiceData.plateResolution === "kept-current" ? item.bikeName : item && item.invoiceData && item.invoiceData.plate || item && item.bikeName || "Χωρίς πινακίδα").trim(); };
    const plateMap = new Map();
    records.forEach(function (item) { const key = plateKey(item); if (!plateMap.has(key)) plateMap.set(key, plateLabel(item)); });
    const selectedPlate = plateSelect ? String(plateSelect.value || "") : "";
    if (plateSelect) {
      plateSelect.innerHTML = '<option value="">Όλες οι πινακίδες</option>' + Array.from(plateMap.entries()).sort(function (a, b) { return a[1].localeCompare(b[1], "el"); }).map(function (pair) { return '<option value="' + escapeHtml(pair[0]) + '">' + escapeHtml(pair[1]) + '</option>'; }).join("");
      plateSelect.value = plateMap.has(selectedPlate) ? selectedPlate : "";
    }
    if (filesView) return void renderInvoiceFileList(records, plateSelect?.value || "");
    const statusMatch = function (item) {
      if (!filter) return true;
      if (filter === "new") return Boolean(item.isNew);
      if (filter === "needs_review") return ["needs_review", "uploaded"].includes(String(item.status));
      if (filter === "processing") return ["processing", "delayed"].includes(String(item.status));
      if (filter === "warning") return String(item.status) === "warning" || (Array.isArray(item.warnings) && item.warnings.length > 0);
      return String(item.status) === filter;
    };
    const filtered = records.filter(function (item) { return statusMatch(item) && (!plateSelect || !plateSelect.value || plateKey(item) === plateSelect.value); });
    const counts = records.reduce(function (result, item) {
      result.total += 1;
      if (["processing", "delayed"].includes(item.status)) result.processing += 1;
      if (item.status === "error") result.error += 1;
      if (item.status === "warning" || (Array.isArray(item.warnings) && item.warnings.length)) result.warning += 1;
      if (["needs_review", "uploaded"].includes(item.status)) result.review += 1;
      if (item.status === "confirmed") result.confirmed += 1;
      if (item.isNew) result.new += 1;
      return result;
    }, { total: 0, processing: 0, error: 0, warning: 0, review: 0, confirmed: 0, new: 0 });
    if ($("invoiceQueueSummary")) {
      $("invoiceQueueSummary").innerHTML = [
        ["Σύνολο", counts.total, "Όλα τα τιμολόγια", "▤", ""],
        ["Σε επεξεργασία", counts.processing, "Αναμονή από Server", "◷", "processing"],
        ["Προς έλεγχο", counts.review, "OCR / διορθώσεις", "✎", "needs_review"],
        ["Νέα", counts.new, "Δεν έχουν ελεγχθεί", "●", "new"],
        ["Προειδοποιήσεις", counts.warning, "Πινακίδα ή χιλιόμετρα", "!", "warning"],
        ["Σφάλματα", counts.error, "Διαθέσιμη επανάληψη", "×", "error"],
        ["Ολοκληρωμένα", counts.confirmed, "Επιβεβαιωμένα", "✓", "confirmed"]
      ].map(function (item) { return '<article><button type="button" class="invoice-summary-card ' + (filter === item[4] ? 'active' : '') + '" data-invoice-summary-filter="' + escapeHtml(item[4]) + '"><span>' + escapeHtml(item[0]) + '<i>' + item[3] + '</i></span><strong>' + item[1] + '</strong><small>' + escapeHtml(item[2]) + '</small></button></article>'; }).join("");
    }
    if (!$("invoiceQueueList")) return;
    if (!filtered.length) {
      $("invoiceQueueList").innerHTML = '<div class="invoice-queue-empty"><span>▤</span><strong>' + (records.length ? "Δεν βρέθηκαν τιμολόγια με αυτό το φίλτρο." : "Δεν υπάρχουν ακόμη τιμολόγια για έλεγχο.") + '</strong><p>Μετά την ολοκλήρωση ενός QR στον Server, το αποτέλεσμα θα εμφανιστεί εδώ αυτόματα.</p></div>';
      return;
    }
    const grouped = new Map();
    filtered.forEach(function (item) {
      const key = plateKey(item);
      if (!grouped.has(key)) grouped.set(key, { label: plateLabel(item), items: [] });
      grouped.get(key).items.push(item);
    });
    const renderCard = function (item) {
      const data = item.invoiceData || {};
      const warnings = Array.isArray(item.warnings) ? item.warnings : [];
      const work = portalInvoiceWorkItems(item);
      const taskHtml = work.length ? '<ul class="invoice-queue-tasks">' + work.map(function (task) { return '<li>' + escapeHtml(task) + '</li>'; }).join("") + '</ul>' : '<span class="invoice-queue-muted">Δεν βρέθηκαν γραμμές εργασιών.</span>';
      const warningHtml = warnings.length ? '<div class="invoice-queue-warnings">' + warnings.map(function (warning) { return '<span>! ' + escapeHtml(warning.message || warning.label || "Χρειάζεται έλεγχος") + '</span>'; }).join("") + '</div>' : '';
      const hasPdf = Boolean(item.key);
      const busy = ["processing", "delayed"].includes(String(item.status));
      const reviewLabel = busy ? "Αναμονή PDF" : "Έλεγχος / διόρθωση";
      const serviceMeta = [item.bikeName || "—", item.serviceDate ? formatDate(item.serviceDate + "T12:00:00Z") : "—", item.serviceKm ? km(item.serviceKm) : "Χωρίς χλμ."].join(" • ");
      const invoiceMeta = [data.supplier || "Προμηθευτής —", data.invoiceNumber || "Αρ. —", data.totalAmount || "Κόστος —"].join(" • ");
      const showProgress = busy || item.status === "error" || (!hasPdf && item.qrUrl);
      const progressHtml = showProgress ? invoiceProgressMarkup(item) : '';
      const correctionBadge = data.correctedByUserAt ? '<span class="invoice-user-correction">✓ Διορθώθηκε από χρήστη</span>' : "";
      const newBadge = item.isNew ? '<span class="invoice-new-badge">ΝΕΟ</span>' : '';
      const retryJobId = item.jobId || data.qrJobId || '';
      const retryHtml = retryJobId && (item.canRetry || ["error", "delayed"].includes(String(item.status))) ? '<button class="secondary-button invoice-retry-button" type="button" data-invoice-retry="' + escapeHtml(retryJobId) + '" data-invoice-retry-record="' + escapeHtml(item.id) + '">Επανάληψη</button>' : '';
      const forceAiHtml = hasPdf && can("fleet.manage") ? '<button class="secondary-button invoice-force-ai-button" type="button" data-invoice-force-ai="' + escapeHtml(item.id) + '" ' + (state.invoiceReprocessBusy ? 'disabled' : '') + '>⚡ Workers AI</button>' : '';
      const deleteHtml = can("fleet.manage") ? '<button class="secondary-button invoice-delete-button" type="button" data-invoice-delete="' + escapeHtml(item.id) + '">Διαγραφή</button>' : '';
      return '<article class="invoice-queue-card ' + (warnings.length ? 'has-warning ' : '') + (item.isNew ? 'is-new ' : '') + escapeHtml(item.status || "uploaded") + '" data-invoice-card="' + escapeHtml(item.id) + '"><div class="invoice-queue-head"><span class="invoice-queue-icon">▤</span><div><span class="overline">' + escapeHtml(invoiceStatusLabels[item.status] || "ΤΙΜΟΛΟΓΙΟ") + ' ' + newBadge + correctionBadge + '</span><h3>' + escapeHtml(item.name || "Τιμολόγιο service") + '</h3><p>' + escapeHtml(serviceMeta) + '</p></div><div>' + invoiceStatusPill(item.status) + '</div></div>' + progressHtml + '<div class="invoice-queue-facts"><span><small>Στοιχεία τιμολογίου</small><strong>' + escapeHtml(invoiceMeta) + '</strong></span><span><small>Πινακίδα / χιλιόμετρα</small><strong>' + escapeHtml((data.plate || "—") + " • " + (data.odometerKm ? km(data.odometerKm) : "—")) + '</strong></span><span><small>QR / PDF</small><strong>' + (item.qrUrl ? 'QR αποθηκευμένο' : '—') + ' • ' + (hasPdf ? 'PDF διαθέσιμο' : 'Σε αναμονή') + '</strong></span></div><div class="invoice-queue-work"><small>Εργασίες / ανταλλακτικά</small>' + taskHtml + '</div>' + warningHtml + '<div class="invoice-queue-actions">' + retryHtml + forceAiHtml + '<button class="primary-button" type="button" data-invoice-review="' + escapeHtml(item.id) + '" ' + (busy || item.status === "error" ? 'disabled' : '') + '>' + reviewLabel + '</button><button class="secondary-button" type="button" data-invoice-open="' + escapeHtml(item.id) + '" ' + (hasPdf ? '' : 'disabled') + '>Άνοιγμα PDF</button><button class="secondary-button" type="button" data-invoice-download="' + escapeHtml(item.id) + '" ' + (hasPdf ? '' : 'disabled') + '>Λήψη PDF</button>' + deleteHtml + '</div></article>';
    };
    $("invoiceQueueList").innerHTML = Array.from(grouped.entries()).map(function (pair) { return Object.assign({ key: pair[0] }, pair[1]); }).sort(function (a, b) { return a.label.localeCompare(b.label, "el"); }).map(function (group) {
      group.items.sort(function (left, right) {
        const newDifference = Number(Boolean(right.isNew)) - Number(Boolean(left.isNew));
        if (newDifference) return newDifference;
        const kmDifference = (Number(right.serviceKm) || 0) - (Number(left.serviceKm) || 0);
        if (kmDifference) return kmDifference;
        return String(right.serviceDate || right.uploadedAt || "").localeCompare(String(left.serviceDate || left.uploadedAt || ""));
      });
      const warningCount = group.items.filter(function (item) { return Array.isArray(item.warnings) && item.warnings.length; }).length;
      return invoiceGroupMarkup(group.key, group.label, group.items, warningCount ? warningCount + " προειδοποιήσεις" : "Χωρίς προειδοποίηση", group.items.map(renderCard).join(""), "review");
    }).join("");
    refreshWigglyProgressRings($("invoiceQueueList"));
  }

  function invoiceBatchClientId() {
    return "invoice-batch-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
  }

  function invoiceBatchProgress(batch) {
    const value = batch || {};
    const status = String(value.status || "processing");
    const rawTotal = Number(value.total);
    const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.max(1, Math.floor(rawTotal)) : 1;
    const rawCompleted = Number(value.completed);
    const completed = Number.isFinite(rawCompleted) ? Math.max(0, Math.min(total, Math.floor(rawCompleted))) : 0;
    const rawFailed = Number(value.failed);
    const failed = Number.isFinite(rawFailed) ? Math.max(0, Math.floor(rawFailed)) : 0;
    const done = status !== "processing";
    const name = String(value.currentName || "Επεξεργασία τιμολογίου");
    const finalStatus = status === "error"
      ? String(value.error || "Η κοινή διαδικασία σταμάτησε.")
      : status === "completed_with_errors"
        ? failed + " τιμολόγιο/α χρειάζονται έλεγχο."
        : done ? "Όλα τα τιμολόγια ολοκληρώθηκαν." : "Η πρόοδος συγχρονίζεται από τον Server σε όλες τις συνδέσεις.";
    return {
      current: completed,
      total: total,
      currentStartedAt: value.currentStartedAt || value.updatedAt || value.startedAt || "",
      title: done ? (status === "error" ? "Η νέα ανάγνωση σταμάτησε" : "Η νέα ανάγνωση ολοκληρώθηκε") : value.mode === "workers-ai" ? "Νέα ανάγνωση · Workers AI" : "Νέα ανάγνωση · Server πρώτα",
      detail: completed + "/" + total + " · " + name,
      status: finalStatus,
      failed: status === "error" || failed > 0,
      error: status === "error",
      done: done
    };
  }

  function markInvoiceDocumentsInBatch(batch) {
    const batchItems = Array.isArray(batch && batch.items) ? batch.items : [];
    const batchKeys = new Set(batchItems.map(function (item) { return String(item && item.key || ""); }).filter(Boolean));
    const batchIds = new Set(batchItems.map(function (item) { return String(item && item.id || ""); }).filter(Boolean));
    const activeIds = new Set((state.invoiceDocuments || []).filter(function (item) {
      return item && item.key && (!batchItems.length || batchKeys.has(String(item.key)) || batchIds.has(String(item.id)));
    }).map(function (item) { return String(item.id); }));
    state.invoiceReprocessActiveIds = Array.from(activeIds);
    state.invoiceDocuments = state.invoiceDocuments.map(function (item) {
      if (!activeIds.has(String(item.id))) return item;
      return Object.assign({}, item, { status: "processing", progress: 5, progressStage: "Σε επεξεργασία όλων των τιμολογίων" });
    });
  }

  function scheduleInvoiceReprocessProgressHide(failed) {
    if (state.invoiceReprocessHideTimer) window.clearTimeout(state.invoiceReprocessHideTimer);
    state.invoiceReprocessHideTimer = window.setTimeout(function () {
      state.invoiceReprocessProgress = null;
      state.invoiceReprocessHideTimer = 0;
      state.invoiceReprocessCompletedBatchId = "";
      state.invoiceReprocessBatchId = "";
      renderInvoiceQueue();
    }, failed ? 8000 : 5000);
  }

  function applyRemoteInvoiceReprocessBatch(batch) {
    if (!batch || !batch.id) return;
    const batchId = String(batch.id);
    if (state.invoiceReprocessCompletedBatchId === batchId) return;
    if (String(batch.status) === "processing") {
      if (!state.invoiceReprocessBusy || state.invoiceReprocessBatchId !== batchId) {
        state.invoiceReprocessPreviousFilter = $("invoiceStatusFilter") ? String($("invoiceStatusFilter").value || "") : "";
        state.invoiceReprocessBatchId = batchId;
        state.invoiceReprocessOwner = false;
        state.invoiceReprocessBusy = true;
        if ($("invoiceStatusFilter")) $("invoiceStatusFilter").value = "processing";
        markInvoiceDocumentsInBatch(batch);
      }
      state.invoiceReprocessProgress = invoiceBatchProgress(batch);
      renderInvoiceQueue();
      return;
    }
    if (state.invoiceReprocessBatchId !== batchId || !state.invoiceReprocessBusy) return;
    state.invoiceReprocessBusy = false;
    state.invoiceReprocessOwner = false;
    state.invoiceReprocessActiveIds = [];
    state.invoiceReprocessCompletedBatchId = batchId;
    const previousFilter = state.invoiceReprocessPreviousFilter;
    state.invoiceReprocessPreviousFilter = "";
    if ($("invoiceStatusFilter")) $("invoiceStatusFilter").value = previousFilter;
    state.invoiceReprocessProgress = invoiceBatchProgress(batch);
    renderInvoiceQueue();
    loadInvoices().catch(function () {});
    toast(batch.status === "error" ? "Η κοινή νέα ανάγνωση σταμάτησε. Δες το σφάλμα στην πρόοδο." : "Η κοινή νέα ανάγνωση ολοκληρώθηκε σε όλες τις συνδέσεις.");
    scheduleInvoiceReprocessProgressHide(Boolean(batch.failed || batch.status === "error"));
  }

  async function refreshInvoiceReprocessBatch() {
    if (state.invoiceReprocessSyncRunning || !state.user || state.view !== "invoices" || document.hidden) return;
    state.invoiceReprocessSyncRunning = true;
    try {
      const result = await api("/api/admin/service-documents/reprocess-batch");
      applyRemoteInvoiceReprocessBatch(result.batch || null);
    } catch (error) {
      // A short network interruption must not erase the last known progress.
    } finally {
      state.invoiceReprocessSyncRunning = false;
    }
  }

  async function publishInvoiceReprocessBatch(action, details) {
    if (!state.invoiceReprocessBatchId) return null;
    try {
      const result = await api("/api/admin/service-documents/reprocess-batch", {
        method: "POST",
        body: Object.assign({ action: action, batchId: state.invoiceReprocessBatchId }, details || {})
      });
      return result.batch || null;
    } catch (error) {
      return null;
    }
  }

  async function loadInvoices() {
    const data = await api("/api/admin/service-documents");
    state.invoiceDocuments = Array.isArray(data.documents) ? data.documents : [];
    renderInvoiceQueue();
  }

  function hasLiveInvoiceJobs() {
    return state.invoiceReprocessBusy || (state.invoiceDocuments || []).some(function (item) {
      return item && ["processing", "delayed"].includes(String(item.status || "")) && (item.jobId || (item.invoiceData && item.invoiceData.qrJobId));
    });
  }

  async function refreshInvoiceProgressLive() {
    if (invoiceLiveRefreshRunning || state.invoiceReprocessBusy || !state.user || state.view !== "invoices" || document.hidden) return;
    invoiceLiveRefreshRunning = true;
    try {
      const data = await api("/api/admin/service-documents");
      state.invoiceDocuments = Array.isArray(data.documents) ? data.documents : state.invoiceDocuments;
      renderInvoiceQueue();
    } catch (error) {
      // The local estimated progress and elapsed timer continue while the
      // next live request waits for the Worker/Server to recover.
    } finally {
      invoiceLiveRefreshRunning = false;
    }
  }

  async function fetchInvoiceDocument(record) {
    if (!record || !record.key) throw new Error("Το PDF δεν είναι ακόμη διαθέσιμο από τον Server.");
    const headers = new Headers();
    if (state.token) headers.set("Authorization", "Bearer " + state.token);
    const response = await fetch(apiBase + "/api/service-documents/" + encodeURIComponent(record.key), { headers: headers, cache: "no-store" });
    if (!response.ok) {
      const payload = await response.json().catch(function () { return {}; });
      throw new Error(payload.error || "Δεν ήταν δυνατή η λήψη του PDF.");
    }
    return { blob: await response.blob(), name: record.name || "τιμολόγιο.pdf" };
  }

  async function openInvoiceDocument(record, download) {
    if (!record || !record.key) return void toast("Το PDF δημιουργείται ακόμη από τον Server.");
    const popup = !download && !(window.AndroidFleet && typeof window.AndroidFleet.openPdf === "function") ? window.open("about:blank", "_blank") : null;
    try {
      const result = await fetchInvoiceDocument(record);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      if (download && window.AndroidFleet && typeof window.AndroidFleet.savePdf === "function") {
        window.AndroidFleet.savePdf(bytesToBase64(bytes), result.name);
      } else if (!download && window.AndroidFleet && typeof window.AndroidFleet.openPdf === "function") {
        window.AndroidFleet.openPdf(bytesToBase64(bytes), result.name);
      } else {
        const href = URL.createObjectURL(result.blob);
        if (download) {
          const link = document.createElement("a");
          link.href = href;
          link.download = result.name;
          document.body.appendChild(link);
          link.click();
          link.remove();
        } else if (popup) {
          popup.location.href = href;
        } else {
          window.open(href, "_blank", "noopener");
        }
        setTimeout(function () { URL.revokeObjectURL(href); }, 5000);
      }
      toast(download ? "Η λήψη του PDF ξεκίνησε." : "Το PDF άνοιξε.");
    } catch (error) {
      if (popup) popup.close();
      toast(error.message);
    }
  }

  function renderInvoiceTransferEntries() {
    const record = state.invoiceReviewDocument;
    const bikeSelect = $("invoiceReviewTargetBike");
    const entrySelect = $("invoiceReviewTargetEntry");
    if (!record || !bikeSelect || !entrySelect) return;
    const options = Array.isArray(record.transferOptions) ? record.transferOptions : [];
    const bikeMap = new Map();
    options.forEach(function (item) {
      const key = String(item.bikeId || "");
      if (key && !bikeMap.has(key)) bikeMap.set(key, String(item.bikeName || key));
    });
    bikeSelect.innerHTML = Array.from(bikeMap.entries()).map(function (pair) { return '<option value="' + escapeHtml(pair[0]) + '">' + escapeHtml(pair[1]) + '</option>'; }).join("");
    const renderEntries = function () {
      const bikeId = String(bikeSelect.value || "");
      const entries = options.filter(function (item) { return String(item.bikeId) === bikeId; });
      entrySelect.innerHTML = entries.map(function (item) {
        const label = (item.serviceDate || "Χωρίς ημερομηνία") + " • " + (item.serviceKm ? km(item.serviceKm) : "χωρίς χιλιόμετρα");
        return '<option value="' + escapeHtml(String(item.entryId || "")) + '">' + escapeHtml(label) + '</option>';
      }).join("");
    };
    bikeSelect.onchange = renderEntries;
    renderEntries();
  }

  async function markInvoiceSeen(record) {
    if (!record || record.isNew === false) return;
    record.isNew = false;
    record.reviewSeenAt = new Date().toISOString();
    renderInvoiceQueue();
    try {
      await api("/api/admin/service-documents/seen", { method: "POST", body: { bikeId: record.bikeId, entryId: record.entryId, key: record.key || undefined } });
    } catch (error) {
      // The visual state can update immediately; the next list refresh will
      // restore the badge if the server was temporarily unavailable.
    }
  }

  async function retryInvoiceDocument(id) {
    const record = invoiceDocumentById(id);
    if (!record) return;
    const jobId = record.jobId || (record.invoiceData && record.invoiceData.qrJobId);
    if (!jobId) return void toast("Δεν βρέθηκε εργασία για επανάληψη.");
    try {
      await api("/api/service-documents/jobs/" + encodeURIComponent(jobId) + "/retry", { method: "POST", body: {} });
      toast("Η επεξεργασία του QR ξεκίνησε ξανά.");
      await loadInvoices();
      for (let attempt = 0; attempt < 42; attempt += 1) {
        await new Promise(function (resolve) { setTimeout(resolve, 3000); });
        const status = await api("/api/service-documents/jobs/" + encodeURIComponent(jobId));
        await loadInvoices();
        if (status.status === "completed") { toast("Το PDF του τιμολογίου είναι έτοιμο."); break; }
        if (status.status === "error") { toast("Η επανάληψη απέτυχε. Δες το σφάλμα στην κάρτα."); break; }
      }
    } catch (error) { toast(error.message); }
  }

  async function forceInvoiceAiDocument(id) {
    const record = invoiceDocumentById(id);
    if (!record || !record.key) return void toast("Το PDF δεν είναι ακόμη διαθέσιμο για ανάγνωση με Workers AI.");
    if (!window.confirm("Να ζητηθεί ανάγνωση του τιμολογίου «" + (record.name || "τιμολόγιο") + "» με Workers AI τώρα; Οι επιβεβαιωμένες διορθώσεις παραμένουν.")) return;
    try {
      const result = await api("/api/admin/service-documents/reprocess", { method: "POST", body: { key: record.key, forceAi: true } });
      if (result.document) {
        const keepInBulkQueue = state.invoiceReprocessBusy && state.invoiceReprocessActiveIds.includes(String(record.id));
        const nextDocument = keepInBulkQueue ? Object.assign({}, result.document, { status: "processing", progress: 5, progressStage: "Σε επεξεργασία όλων των τιμολογίων" }) : result.document;
        state.invoiceDocuments = state.invoiceDocuments.map(function (item) { return String(item.id) === String(record.id) ? nextDocument : item; });
        renderInvoiceQueue();
      }
      toast(result.ocrWarning ? "Το Workers AI δεν ολοκληρώθηκε. Δες την προειδοποίηση στην κάρτα." : "Το τιμολόγιο διαβάστηκε με Workers AI.");
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  }

  function chooseInvoiceReprocessMode() {
    if (state.invoiceReprocessBusy || state.invoiceReprocessStarting) return;
    const records = (state.invoiceDocuments || []).filter(function (item) { return item && item.key; });
    if (!records.length) return void toast("Δεν υπάρχουν αποθηκευμένα PDF για νέα ανάγνωση.");
    $("invoiceReprocessCount").textContent = records.length + " τιμολόγια θα διαβαστούν ξανά. Οι επιβεβαιωμένες διορθώσεις σου διατηρούνται.";
    $("invoiceReprocessDialog").showModal();
  }

  async function reprocessAllInvoiceDocuments(mode) {
    if (!["server-first", "workers-ai"].includes(mode)) return;
    if (state.invoiceReprocessStarting) return;
    if (state.invoiceReprocessBusy) return;
    const records = (state.invoiceDocuments || []).filter(function (item) { return item && item.key; });
    if (!records.length) return void toast("Δεν υπάρχουν αποθηκευμένα PDF για νέα ανάγνωση.");
    state.invoiceReprocessStarting = true;
    $("invoiceReprocessDialog").close();
    renderInvoiceQueue();
    let started;
    try {
      started = await api("/api/admin/service-documents/reprocess-batch", {
        method: "POST",
        body: { action: "start", mode: mode, batchId: invoiceBatchClientId(), total: records.length, items: records.map(function (item) { return { id: String(item.id || ""), key: String(item.key || ""), name: String(item.name || "Τιμολόγιο") }; }) }
      });
    } catch (error) {
      return void toast(error.message);
    } finally {
      state.invoiceReprocessStarting = false;
      renderInvoiceQueue();
    }
    if (!started.started || !started.batch) {
      applyRemoteInvoiceReprocessBatch(started.batch || null);
      return void toast("Υπάρχει ήδη ενεργή νέα ανάγνωση. Παρακολουθείς την κοινή πρόοδο.");
    }
    if (state.invoiceReprocessHideTimer) {
      window.clearTimeout(state.invoiceReprocessHideTimer);
      state.invoiceReprocessHideTimer = 0;
    }
    state.invoiceReprocessBatchId = String(started.batch.id);
    state.invoiceReprocessOwner = true;
    state.invoiceReprocessCompletedBatchId = "";
    state.invoiceReprocessPreviousFilter = $("invoiceStatusFilter") ? String($("invoiceStatusFilter").value || "") : "";
    if ($("invoiceStatusFilter")) $("invoiceStatusFilter").value = "processing";
    state.invoiceReprocessActiveIds = records.map(function (item) { return String(item.id); });
    const activeIds = new Set(state.invoiceReprocessActiveIds);
    state.invoiceDocuments = state.invoiceDocuments.map(function (item) {
      if (!activeIds.has(String(item.id))) return item;
      return Object.assign({}, item, { status: "processing", progress: 5, progressStage: "Σε αναμονή για νέα ανάγνωση" });
    });
    state.invoiceReprocessBusy = true;
    state.invoiceReprocessProgress = { current: 0, total: records.length, startedAt: Date.now(), currentStartedAt: Date.now(), title: mode === "workers-ai" ? "Νέα ανάγνωση · Workers AI" : "Νέα ανάγνωση · Server πρώτα", detail: "Προετοιμασία…", status: "Η πρόοδος συγχρονίζεται από τον Server σε όλες τις συνδέσεις." };
    renderInvoiceQueue();
    // The batch is now an Android Server operation. The portal only starts it
    // and watches the D1 setting, so all open web/APK connections see the same
    // live progress and no browser tab has to remain active as the owner.
    toast("Η νέα ανάγνωση ξεκίνησε στον Server. Η πρόοδος θα ενημερώνεται σε όλες τις συνδέσεις.");
  }

  async function deleteInvoiceDocument(id) {
    const record = invoiceDocumentById(id);
    if (!record) return;
    const label = record.name || "το τιμολόγιο";
    const pendingMessage = record.key ? "" : " Το QR και η εκκρεμής εργασία θα ακυρωθούν επίσης.";
    if (!window.confirm("Να διαγραφεί οριστικά «" + label + "»; Το service και το ιστορικό του μηχανιού δεν διαγράφονται." + pendingMessage)) return;
    try {
      await api("/api/service-documents", { method: "DELETE", body: {
        bikeId: record.bikeId,
        entryId: record.entryId,
        key: record.key || undefined,
        jobId: record.jobId || (record.invoiceData && record.invoiceData.qrJobId) || undefined
      } });
      if (state.invoiceReviewDocument && String(state.invoiceReviewDocument.id) === String(record.id) && $("invoiceReviewDialog")?.open) $("invoiceReviewDialog").close();
      state.invoiceDocuments = state.invoiceDocuments.filter(function (item) { return String(item.id) !== String(record.id) && String(item.key || "") !== String(record.key || ""); });
      renderInvoiceQueue();
      toast("Το τιμολόγιο διαγράφηκε οριστικά. Το service παρέμεινε στο ιστορικό.");
      await loadInvoices();
    } catch (error) { toast(error.message); }
  }

  function openAdminInvoiceReview(id) {
    const record = invoiceDocumentById(id);
    if (!record) return;
    if (record.status === "processing" || record.status === "delayed") return;
    markInvoiceSeen(record);
    state.invoiceReviewDocument = record;
    const data = record.invoiceData || {};
    $("invoiceReviewId").value = record.id || "";
    $("invoiceReviewBikeId").value = record.bikeId || "";
    $("invoiceReviewEntryId").value = record.entryId || "";
    $("invoiceReviewKey").value = record.key || "";
    $("invoiceReviewMeta").innerHTML = '<strong>' + escapeHtml(record.bikeName || "—") + '</strong><span>' + escapeHtml((record.serviceDate || "—") + " • " + (record.serviceKm ? km(record.serviceKm) : "Χωρίς χιλιόμετρα")) + '</span><small>' + escapeHtml(record.name || "Τιμολόγιο service") + '</small>';
    $("invoiceReviewSupplier").value = data.supplier || "";
    $("invoiceReviewPlate").value = data.plate || "";
    $("invoiceReviewOdometer").value = data.odometerKm || "";
    $("invoiceReviewNumber").value = data.invoiceNumber || "";
    $("invoiceReviewDate").value = invoiceReviewDate(data.invoiceDate);
    $("invoiceReviewTotal").value = data.totalAmount || "";
    $("invoiceReviewTasks").value = portalInvoiceWorkItems(record).join("\n");
    $("invoiceReviewComments").value = data.comments || data.notes || "";
    $("invoiceReviewRawText").textContent = data.rawText || "Δεν επιστράφηκε πλήρες κείμενο OCR.";
    $("invoiceReviewRawDetails").classList.toggle("is-hidden", !data.rawText);
    const warnings = Array.isArray(record.warnings) ? record.warnings : [];
    $("invoiceReviewWarnings").innerHTML = warnings.length
      ? warnings.map(function (warning) { return '<div class="invoice-review-warning">! <span><strong>' + escapeHtml(warning.label || "Προειδοποίηση") + '</strong><small>' + escapeHtml(warning.message || "") + '</small></span></div>'; }).join("")
      : '<div class="invoice-review-ok">✓ Δεν βρέθηκε διαφορά πινακίδας ή χιλιομέτρων.</div>';
    const plateMismatch = warnings.some(function (warning) { return warning.type === "plate"; });
    const transferOptions = Array.isArray(record.transferOptions) ? record.transferOptions : [];
    const transferBox = $("invoiceReviewTransfer");
    if (transferBox) {
      // The transfer action is available for every invoice. A normal invoice
      // defaults to “keep here”, while a plate mismatch still asks for an
      // explicit decision when a destination exists.
      transferBox.classList.toggle("is-hidden", !record.key || record.status === "processing");
      renderInvoiceTransferEntries();
      const bikeSelect = $("invoiceReviewTargetBike");
      const entrySelect = $("invoiceReviewTargetEntry");
      const moveButton = $("invoiceReviewMove");
      const hasOptions = transferOptions.length > 0;
      if (!hasOptions) {
        bikeSelect.innerHTML = '<option value="">Δεν βρέθηκε διαθέσιμο service προορισμού</option>';
        entrySelect.innerHTML = '<option value="">Χωρίς διαθέσιμο service</option>';
      }
      bikeSelect.disabled = !hasOptions;
      entrySelect.disabled = !hasOptions;
      moveButton.disabled = !hasOptions;
      state.invoiceReviewTransferChoice = plateMismatch && hasOptions ? null : "keep";
    }
    const available = Boolean(record.key) && record.status !== "processing";
    $("invoiceReviewOpen").disabled = !available;
    $("invoiceReviewDownload").disabled = !available;
    $("invoiceReviewSave").disabled = !available;
    $("invoiceReviewError").textContent = available ? "" : "Το PDF δεν έχει ολοκληρωθεί ακόμη από τον Server.";
    $("invoiceReviewDialog").showModal();
  }

  async function saveAdminInvoiceReview(event) {
    if (event && event.preventDefault) event.preventDefault();
    const record = state.invoiceReviewDocument;
    if (!record || !record.key) return void ($("invoiceReviewError").textContent = "Το PDF δεν είναι ακόμη διαθέσιμο για επιβεβαίωση.");
    if ($("invoiceReviewSave").disabled) return;
    const data = record.invoiceData || {};
    const tasks = String($("invoiceReviewTasks").value || "").split(/\r?\n|\s*[•;]+\s*/).map(function (item) { return item.trim(); }).filter(Boolean).slice(0, 30);
    const invoiceData = Object.assign({}, data, {
      supplier: $("invoiceReviewSupplier").value.trim(),
      plate: $("invoiceReviewPlate").value.trim(),
      odometerKm: $("invoiceReviewOdometer").value.trim(),
      invoiceNumber: $("invoiceReviewNumber").value.trim(),
      invoiceDate: $("invoiceReviewDate").value.trim(),
      totalAmount: $("invoiceReviewTotal").value.trim(),
      workPerformed: tasks.join("\n"),
      lineItems: tasks,
      comments: $("invoiceReviewComments").value.trim()
    });
    const transferBox = $("invoiceReviewTransfer");
    const transferVisible = transferBox && !transferBox.classList.contains("is-hidden");
    if (transferVisible && !state.invoiceReviewTransferChoice) {
      return void ($("invoiceReviewError").textContent = "Επίλεξε μεταφορά στο σωστό μηχανάκι ή κράτηση στο τρέχον.");
    }
    const moveToBikeId = state.invoiceReviewTransferChoice === "move" ? String($("invoiceReviewTargetBike").value || "") : "";
    const moveToEntryId = state.invoiceReviewTransferChoice === "move" ? String($("invoiceReviewTargetEntry").value || "") : "";
    if (state.invoiceReviewTransferChoice === "move" && (!moveToBikeId || !moveToEntryId)) {
      return void ($("invoiceReviewError").textContent = "Επίλεξε μηχανάκι και service προορισμού.");
    }
    const destination = state.invoiceReviewTransferChoice === "move"
      ? (record.transferOptions || []).find(function (item) { return String(item.bikeId) === moveToBikeId && String(item.entryId) === moveToEntryId; }) : record;
    if (!destination) return void ($("invoiceReviewError").textContent = "Το service προορισμού δεν βρέθηκε.");
    const invoiceKm = Number(String(invoiceData.odometerKm || "").replace(/[^0-9]/g, ""));
    if (invoiceKm > 2000000000) return void ($("invoiceReviewError").textContent = "Γράψε σωστά τα χιλιόμετρα.");
    const updateServiceKm = invoiceKm > 0 && invoiceKm !== Number(destination.serviceKm);
    if (updateServiceKm && !window.confirm("Να διορθωθούν τα χιλιόμετρα του service από " + km(destination.serviceKm) + " σε " + km(invoiceKm) + ";")) return;
    const button = $("invoiceReviewSave");
    button.disabled = true;
    $("invoiceReviewError").textContent = "";
    try {
      const result = await api("/api/admin/service-documents/review", { method: "POST", body: {
        bikeId: record.bikeId, entryId: record.entryId, key: record.key, invoiceData: invoiceData, tasks: tasks,
        keepOnCurrent: state.invoiceReviewTransferChoice === "keep",
        updateServiceKm: updateServiceKm,
        expectedServiceKm: updateServiceKm ? Number(destination.serviceKm) : undefined,
        moveToBikeId: moveToBikeId || undefined,
        moveToEntryId: moveToEntryId || undefined
      } });
      state.invoiceDocuments = state.invoiceDocuments.filter(function (item) { return String(item.id) !== String(record.id) && String(item.key) !== String(result.movedFromKey || ""); });
      if (result.document) state.invoiceDocuments.push(result.document);
      // Every invoice on this service uses the corrected manual mileage.
      await loadInvoices().catch(function () { toast("Αποθηκεύτηκε. Ανανέωσε τη λίστα τιμολογίων για τις υπόλοιπες αλλαγές."); });
      $("invoiceReviewDialog").close();
      renderInvoiceQueue();
      toast("Τα στοιχεία του τιμολογίου επιβεβαιώθηκαν και αποθηκεύτηκαν.");
    } catch (error) {
      $("invoiceReviewError").textContent = error.message;
      button.disabled = false;
    }
  }

  async function loadFleetSummary() {
    const data = await api("/api/workforce/vehicles");
    state.vehicles = data.vehicles || [];
    const counts = state.vehicles.reduce(function (result, item) {
      result[item.status] = (result[item.status] || 0) + 1;
      return result;
    }, {});
    $("fleetQuickStats").innerHTML = [
      metric("Σύνολο στόλου", String(state.vehicles.length), "Όλα τα μηχανάκια", "◇"),
      metric("Διαθέσιμα", String(counts.available || 0), "Έτοιμα για βάρδια", "✓"),
      metric("Σε χρήση", String(counts.in_use || 0), "Ενεργές βάρδιες", "●"),
      metric("Service / ανενεργά", String((counts.service || 0) + (counts.inactive || 0)), "Δεν διατίθενται", "!")
    ].join("");
    $("fleetStatusList").innerHTML = state.vehicles.length ? state.vehicles.map(function (item) {
      return '<div class="data-row"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(km(item.odometer)) + '</small></span><span><strong>' + escapeHtml(item.assigned ? "Μόνιμη ανάθεση" : "Χωρίς μόνιμη ανάθεση") + '</strong><small>Official odometer</small></span><div class="table-actions">' + statusPill(item.status) + (can("fleet.manage") && !["in_use", "reserved"].includes(item.status) ? '<button class="secondary-button" type="button" data-vehicle-status="' + escapeHtml(item.id) + '">Αλλαγή</button>' : '') + '</div></div>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχουν μηχανάκια.</p>';
  }

  async function changeVehicleStatus(vehicleId) {
    const vehicle = state.vehicles.find(function (item) { return String(item.id) === String(vehicleId); });
    if (!vehicle) return;
    try {
      const data = await simpleEditor({
        overline: "ΔΙΑΘΕΣΙΜΟΤΗΤΑ", title: vehicle.name, submit: "Αλλαγή κατάστασης",
        html: '<label class="field"><span>Κατάσταση</span><select id="vehicleStatus"><option value="available">Available</option><option value="service">Service</option><option value="inactive">Inactive</option></select></label>',
        collect: function () { return { status: $("vehicleStatus").value }; }
      });
      const confirmation = await requestPin(true);
      data.reason = confirmation.reason;
      await api("/api/admin/vehicles/" + encodeURIComponent(vehicleId) + "/status", { method: "POST", pin: confirmation.pin, body: data });
      toast("Η κατάσταση της μηχανής ενημερώθηκε.");
      await loadFleetSummary();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  function openFleetControl() {
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.openFleet === "function") return window.AndroidFleet.openFleet();
    } catch (error) {}
    window.location.href = "./fleet";
  }

  function scheduleFleetPreload() {
    if (fleetPreloadTimer || !$("fleetModuleFrame") || !can("fleet.view")) return;
    const preload = function () {
      fleetPreloadTimer = null;
      if (state.user && state.user.role !== "employee" && can("fleet.view")) ensureFleetModule();
    };
    if (typeof window.requestIdleCallback === "function") {
      fleetPreloadTimer = window.requestIdleCallback(preload, { timeout: 1800 });
    } else {
      fleetPreloadTimer = window.setTimeout(preload, 1200);
    }
  }

  function setFleetDetailMode(active) {
    const enabled = Boolean(active);
    const portal = $("portal");
    if (portal) portal.classList.toggle("fleet-detail-mode", enabled);
    document.documentElement.classList.toggle("fleet-detail-mode", enabled);
  }

  function ensureFleetModule() {
    const frame = $("fleetModuleFrame");
    const shell = $("fleetModuleShell");
    if (!frame || !shell) return;
    if (!frame.getAttribute("src")) {
      shell.classList.remove("is-loaded");
      shell.setAttribute("aria-busy", "true");
      frame.setAttribute("src", frame.dataset.src || "./index.html?embedded=1");
    }
  }

  function resetFleetModule() {
    const frame = $("fleetModuleFrame");
    const shell = $("fleetModuleShell");
    if (!frame || !shell) return;
    setFleetDetailMode(false);
    frame.removeAttribute("src");
    shell.classList.remove("is-loaded");
    shell.setAttribute("aria-busy", "true");
  }

  function mondayDate() {
    const date = new Date();
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function datePlus(value, days) {
    const date = new Date(String(value) + "T12:00:00");
    date.setDate(date.getDate() + days);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function payrollOvertimeCell(item) {
    const pending = Number(item.pendingOvertime || 0);
    const approvals = Array.isArray(item.overtimeApprovals) ? item.overtimeApprovals : [];
    const parts = [];
    if (pending) parts.push('<span class="payroll-pending">' + pending + ' προς έγκριση</span>');
    approvals.forEach(function (approval) {
      const rate = approval.rateCents == null ? "ζώνες κανόνα" : money(approval.rateCents) + "/ώρα";
      parts.push('<span class="payroll-approval"><strong>' + escapeHtml(hours(Number(approval.overtimeMinutes || 0) / 60)) + '</strong><small>Εγκρίθηκε από ' + escapeHtml(approval.approvedBy || "—") + (approval.approvedAt ? ' • ' + escapeHtml(formatDateTime(approval.approvedAt)) : '') + '<br>' + escapeHtml(rate) + '</small></span>');
    });
    return parts.join("") || '<span class="payroll-muted">—</span>';
  }

  async function loadPayroll() {
    if (!$("payrollStart").value) $("payrollStart").value = mondayDate();
    const start = $("payrollStart").value;
    const end = datePlus(start, 6);
    const data = await api("/api/admin/payroll?start=" + start + "&end=" + end);
    state.payroll = data;
    $("payrollLockButton").classList.toggle("is-hidden", !can("payroll.lock"));
    $("newAdjustmentButton").classList.toggle("is-hidden", !can("payroll.manage"));
    $("payRulesButton").classList.toggle("is-hidden", !can("payroll.manage"));
    $("specialAssignmentsButton").classList.toggle("is-hidden", !can("payroll.manage"));
    $("payrollLockButton").textContent = data.period.status === "locked" ? "Ξεκλείδωμα" : "Κλείδωμα";
    $("payrollSummaryCards").innerHTML = [
      metric("Εργαζόμενοι", String(data.totals.employees || 0), start + " – " + end, "♙"),
      metric("Payable ώρες", String(data.totals.payableHours || 0), "Κανονικές + ειδικές", "◷"),
      metric("Χιλιόμετρα", km(data.totals.kilometers), "Ολοκληρωμένες βάρδιες", "◇"),
      metric("Υπερωρίες", String(data.totals.pendingOvertime || 0), (data.totals.approvedOvertime || 0) + " εγκεκριμένες", "!", null, data.totals.pendingOvertime ? "warning" : ""),
      metric("Τελικό ποσό", money(data.totals.finalCents), data.period.status === "locked" ? "Κλειδωμένο snapshot" : "Ανοιχτή περίοδος", "€")
    ].join("");
    $("payrollTable").innerHTML = data.employees.length ? '<table class="data-table"><thead><tr><th>Εργαζόμενος</th><th>Βάρδιες</th><th>Κανονικές ώρες</th><th>Ειδικές ώρες</th><th>Payable</th><th>Χλμ.</th><th>Βάση</th><th>Ειδική αμοιβή</th><th>Υπερωρίες / έγκριση</th><th>Bonus</th><th>Κρατήσεις</th><th>Προκαταβολές</th><th>Τελικό</th></tr></thead><tbody>' + data.employees.map(function (item) {
      return '<tr><td><strong>' + escapeHtml(item.employeeName) + '</strong></td><td>' + Number(item.shifts || 0) + '</td><td>' + escapeHtml(hours(item.normalHours)) + '</td><td>' + escapeHtml(hours(item.specialHours)) + '</td><td>' + escapeHtml(hours(item.payableHours)) + '</td><td>' + escapeHtml(km(item.kilometers)) + '</td><td>' + escapeHtml(money(item.basePayCents)) + '</td><td>' + escapeHtml(money(item.specialPayCents)) + '</td><td>' + payrollOvertimeCell(item) + '</td><td>' + escapeHtml(money(item.bonusCents)) + '</td><td>' + escapeHtml(money(item.deductionCents)) + '</td><td>' + escapeHtml(money(item.advanceCents)) + '</td><td><strong>' + escapeHtml(money(item.finalCents)) + '</strong></td></tr>';
    }).join("") + '</tbody></table>' : '<p class="empty-copy">Δεν υπάρχουν ολοκληρωμένες βάρδιες σε αυτή την περίοδο.</p>';
  }

  async function togglePayrollLock() {
    if (!state.payroll) await loadPayroll();
    const locked = state.payroll.period.status === "locked";
    try {
      const confirmation = await requestPin(true);
      await api(locked ? "/api/admin/payroll/unlock" : "/api/admin/payroll/lock", {
        method: "POST", pin: confirmation.pin,
        body: { startDate: $("payrollStart").value, endDate: datePlus($("payrollStart").value, 6), reason: confirmation.reason }
      });
      toast(locked ? "Η περίοδος ξεκλειδώθηκε." : "Η μισθοδοσία κλειδώθηκε σε snapshot.");
      await loadPayroll();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function addAdjustment() {
    try {
      await loadAdminLists();
      const data = await simpleEditor({
        overline: "ΜΙΣΘΟΔΟΣΙΑ", title: "Bonus / κράτηση / προκαταβολή", submit: "Καταχώρηση",
        html: '<label class="field"><span>Εργαζόμενος</span><select id="adjustEmployee">' + state.employees.filter(function (item) { return item.active; }).map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.fullName) + '</option>'; }).join("") + '</select></label><label class="field"><span>Τύπος</span><select id="adjustKind"><option value="bonus">Bonus</option><option value="deduction">Κράτηση</option><option value="advance">Προκαταβολή</option><option value="hours">Διόρθωση ωρών</option></select></label><label class="field"><span>Ποσό (€ — για bonus/κράτηση/προκαταβολή)</span><input id="adjustAmount" type="number" step="0.01" value="0"></label><label class="field"><span>Ώρες (για διόρθωση ωρών)</span><input id="adjustHours" type="number" step="0.01" value="0"></label><label class="field"><span>Ημερομηνία</span><input id="adjustDate" type="date" value="' + inputDate(0) + '"></label><label class="field"><span>Αιτιολογία</span><textarea id="adjustReason" rows="3" required></textarea></label>',
        collect: function () { const reason = $("adjustReason").value.trim(); if (!reason) throw new Error("Γράψε αιτιολογία."); return { employeeId: $("adjustEmployee").value, kind: $("adjustKind").value, amountCents: Math.round(Number($("adjustAmount").value || 0) * 100), hours: Number($("adjustHours").value || 0), date: $("adjustDate").value, reason: reason }; }
      });
      const confirmation = await requestPin(false);
      data.startDate = $("payrollStart").value || mondayDate();
      data.endDate = datePlus(data.startDate, 6);
      await api("/api/admin/payroll/adjustment", { method: "POST", pin: confirmation.pin, body: data });
      toast("Η προσαρμογή μισθοδοσίας καταχωρήθηκε.");
      await loadPayroll();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function simulateRule() {
    try {
      const rules = (await api("/api/admin/pay-rules")).rules || [];
      const today = inputDate(0);
      const data = await simpleEditor({
        overline: "PAY RULE LAB", title: "Προσομοιωτής κανόνα", submit: "Υπολογισμός",
        html: '<label class="field"><span>Κανόνας</span><select id="simRule">' + rules.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + ' • v' + item.version + '</option>'; }).join("") + '</select></label><label class="field"><span>Προγραμματισμένη έναρξη (προαιρετικά)</span><input id="simScheduled" type="datetime-local" value="' + today + 'T17:00"></label><p class="editor-hint">Αν συμπληρώσεις προγραμματισμένη έναρξη, εφαρμόζεται και η ανοχή καθυστερημένου Clock In.</p><label class="field"><span>Actual Clock In</span><input id="simIn" type="datetime-local" value="' + today + 'T17:20" required></label><label class="field"><span>Actual Clock Out</span><input id="simOut" type="datetime-local" value="' + datePlus(today, 1) + 'T02:00" required></label>',
        collect: function () {
          const scheduledValue = $("simScheduled").value;
          const inValue = $("simIn").value;
          const outValue = $("simOut").value;
          const actualStart = new Date(inValue);
          const actualEnd = new Date(outValue);
          const scheduledStart = scheduledValue ? new Date(scheduledValue) : null;
          if (!Number.isFinite(actualStart.getTime()) || !Number.isFinite(actualEnd.getTime()) || (scheduledValue && !Number.isFinite(scheduledStart.getTime()))) throw new Error("Συμπλήρωσε έγκυρες ώρες.");
          return { ruleId: $("simRule").value, scheduledStart: scheduledStart ? scheduledStart.toISOString() : null, actualClockIn: actualStart.toISOString(), actualClockOut: actualEnd.toISOString() };
        }
      });
      const result = await api("/api/admin/payroll/simulate", { method: "POST", body: data });
      await simpleEditor({
        overline: "ΑΠΟΤΕΛΕΣΜΑ", title: result.rule.name + " • v" + result.rule.version, submit: "Κλείσιμο",
        html: '<div class="completion-metrics"><span><small>Payable</small><strong>' + escapeHtml(hours(result.result.payableHours)) + '</strong></span><span><small>Βάση</small><strong>' + escapeHtml(money(result.result.basePayCents)) + '</strong></span><span><small>Ειδικό</small><strong>' + escapeHtml(money(result.result.specialPayCents)) + '</strong></span><span><small>Σύνολο</small><strong>' + escapeHtml(money(result.result.totalPayCents)) + '</strong></span></div>',
        collect: function () { return {}; }
      });
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  function payRateRow(item) {
    const rate = item || {};
    const startTime = rate.startTime || rate.start_time || "";
    const endTime = rate.endTime || rate.end_time || "";
    const rateCents = rate.rateCents == null ? rate.rate_cents : rate.rateCents;
    const qualificationLabels = { first_eligible: "Πρώτος διαθέσιμος", scheduled: "Με πρόγραμμα", automatic: "Αυτόματο", manual: "Χειροκίνητη ανάθεση" };
    const qualification = ["first_eligible", "scheduled", "automatic", "manual"].includes(rate.qualification) ? rate.qualification : "automatic";
    const options = Object.keys(qualificationLabels).map(function (key) {
      return '<option value="' + key + '" ' + (key === qualification ? "selected" : "") + '>' + qualificationLabels[key] + '</option>';
    }).join("");
    const active = rate.active !== false;
    return '<div class="pay-rate-row" data-pay-rate-row><input type="hidden" data-pay-rate-id value="' + escapeHtml(rate.id || "") + '"><label class="field"><span>Περιγραφή</span><input data-pay-rate-label value="' + escapeHtml(rate.label || "Ειδική ώρα") + '" placeholder="π.χ. Νυχτερινή ώρα" required></label><label class="field"><span>Έναρξη</span><input data-pay-rate-start type="time" value="' + escapeHtml(startTime) + '" required></label><label class="field"><span>Λήξη</span><input data-pay-rate-end type="time" value="' + escapeHtml(endTime) + '" required></label><label class="field"><span>Αμοιβή €/ώρα</span><input data-pay-rate-euro type="number" min="0" step="0.01" value="' + (Number(rateCents || 0) / 100) + '" required></label><label class="field"><span>Χωρητικότητα</span><input data-pay-rate-capacity type="number" min="1" step="1" value="' + (rate.capacity == null ? "" : Number(rate.capacity)) + '" placeholder="Χωρίς όριο"></label><label class="field"><span>Προτεραιότητα</span><input data-pay-rate-priority type="number" step="1" value="' + Number(rate.priority || 0) + '"></label><label class="field"><span>Εφαρμογή</span><select data-pay-rate-qualification>' + options + '</select></label><label class="remember-row pay-rate-active"><input data-pay-rate-active type="checkbox" ' + (active ? "checked" : "") + '><span><strong>Ενεργή ζώνη</strong></span></label><button class="ghost-button pay-rate-remove" type="button" data-remove-pay-rate>Αφαίρεση</button></div>';
  }

  function collectPayRates() {
    return Array.from(document.querySelectorAll("[data-pay-rate-row]")).map(function (row, index) {
      const value = function (selector) { const input = row.querySelector(selector); return input ? input.value.trim() : ""; };
      const label = value("[data-pay-rate-label]");
      const startTime = value("[data-pay-rate-start]");
      const endTime = value("[data-pay-rate-end]");
      const rateText = value("[data-pay-rate-euro]");
      const rateEuros = Number(rateText);
      const capacityValue = value("[data-pay-rate-capacity]");
      const priority = Number(value("[data-pay-rate-priority]") || 0);
      const id = value("[data-pay-rate-id]");
      if (!id && !startTime && !endTime && !rateText && (!label || label === "Ειδική ώρα")) return null;
      if (!label) throw new Error("Η ζώνη " + (index + 1) + " χρειάζεται περιγραφή.");
      if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(startTime) || !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(endTime)) throw new Error("Η ζώνη " + (index + 1) + " χρειάζεται έγκυρη ώρα έναρξης και λήξης.");
      if (!Number.isFinite(rateEuros) || rateEuros < 0) throw new Error("Η αμοιβή της ζώνης " + (index + 1) + " δεν είναι έγκυρη.");
      let capacity = null;
      if (capacityValue !== "") {
        capacity = Number(capacityValue);
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Η χωρητικότητα της ζώνης " + (index + 1) + " δεν είναι έγκυρη.");
      }
      if (!Number.isInteger(priority)) throw new Error("Η προτεραιότητα της ζώνης " + (index + 1) + " δεν είναι έγκυρη.");
      return {
        id: id || undefined,
        label, startTime, endTime, rateCents: Math.round(rateEuros * 100), capacity,
        qualification: value("[data-pay-rate-qualification]") || "automatic",
        priority, active: Boolean(row.querySelector("[data-pay-rate-active]")?.checked)
      };
    }).filter(Boolean);
  }

  function payRuleForm(rule, rules) {
    const selected = rule || { id: "", name: "Νέος κανόνας", scopeType: "general", scopeId: "", priority: 0, normalRateCents: 600, startRoundMode: "up", startRoundMinutes: 30, lateGraceMinutes: 0, lateClockOutGraceMinutes: 30, endRoundMode: "none", endRoundMinutes: 1, durationRoundMode: "none", payableIncrementMinutes: 1, minimumMinutes: 0, maximumMinutes: 720, active: true, specialRates: [] };
    const options = '<option value="">+ Νέος κανόνας</option>' + rules.map(function (item) { return '<option value="' + escapeHtml(item.id) + '" ' + (item.id === selected.id ? "selected" : "") + '>' + escapeHtml(item.name) + ' • v' + item.version + '</option>'; }).join("");
    const scopeOptions = ["general", "group", "employee", "shift"].map(function (scope) {
      const labels = { general: "Γενικός", group: "Ομάδα", employee: "Εργαζόμενος ID", shift: "Βάρδια ID" };
      return '<option value="' + scope + '" ' + (scope === (selected.scopeType || "general") ? "selected" : "") + '>' + labels[scope] + '</option>';
    }).join("");
    const modeLabels = { none: "Ακριβώς όπως καταγράφηκε", down: "Στην προηγούμενη χρονική βαθμίδα", up: "Στην επόμενη χρονική βαθμίδα", nearest: "Στην κοντινότερη χρονική βαθμίδα" };
    const modeOptions = function (value) { return Object.keys(modeLabels).map(function (mode) { return '<option value="' + mode + '" ' + (mode === value ? "selected" : "") + '>' + modeLabels[mode] + '</option>'; }).join(""); };
    const specialRates = Array.isArray(selected.specialRates) ? selected.specialRates : [];
    return '<label class="field"><span>Επεξεργασία υπάρχοντος</span><select id="rulePicker">' + options + '</select></label><input id="ruleEditId" type="hidden" value="' + escapeHtml(selected.id) + '"><div class="form-grid"><label class="field"><span>Όνομα</span><input id="ruleName" value="' + escapeHtml(selected.name) + '" required></label><label class="field"><span>Scope</span><select id="ruleScope">' + scopeOptions + '</select></label><label class="field"><span>Scope ID</span><input id="ruleScopeId" value="' + escapeHtml(selected.scopeId || "") + '"></label><label class="field"><span>Προτεραιότητα</span><input id="rulePriority" type="number" step="1" value="' + Number(selected.priority || 0) + '"></label><label class="field"><span>Ισχύει από</span><input id="ruleValidFrom" type="date" value="' + escapeHtml(selected.validFrom || "") + '"></label><label class="field"><span>Ισχύει έως</span><input id="ruleValidUntil" type="date" value="' + escapeHtml(selected.validUntil || "") + '"></label><label class="field"><span>Κανονική αμοιβή €/ώρα</span><input id="ruleRate" type="number" min="0" step="0.01" value="' + (Number(selected.normalRateCents || 0) / 100) + '" required></label><label class="field"><span>Ανοχή καθυστερημένου Clock In (λεπτά)</span><input id="ruleLateGrace" type="number" min="0" max="720" step="1" value="' + Number(selected.lateGraceMinutes || 0) + '"><small>Μέχρι αυτά τα λεπτά πληρώνεται από την προγραμματισμένη έναρξη.</small></label><label class="field"><span>Ανοχή καθυστερημένου Clock Out (λεπτά)</span><input id="ruleLateClockOutGrace" type="number" min="0" max="720" step="1" value="' + Number(selected.lateClockOutGraceMinutes == null ? 30 : selected.lateClockOutGraceMinutes) + '"><small>Προεπιλογή 30. Η καθυστέρηση δεν πληρώνεται χωρίς έγκριση υπερωρίας.</small></label><label class="field"><span>Υπολογισμός έναρξης Clock In</span><select id="ruleStartMode">' + modeOptions(selected.startRoundMode || "none") + '</select><small>Π.χ. «επόμενη» με βήμα 30: 15:20 υπολογίζεται ως 15:30.</small></label><label class="field"><span>Βήμα έναρξης (λεπτά)</span><input id="ruleStartMinutes" type="number" min="1" max="60" step="1" value="' + Number(selected.startRoundMinutes || 1) + '"></label><label class="field"><span>Υπολογισμός λήξης Clock Out</span><select id="ruleEndMode">' + modeOptions(selected.endRoundMode || "none") + '</select><small>Εφαρμόζεται μόνο μέσα στον πληρωτέο χρόνο και δεν περνά την εγκεκριμένη λήξη.</small></label><label class="field"><span>Βήμα λήξης (λεπτά)</span><input id="ruleEndMinutes" type="number" min="1" max="60" step="1" value="' + Number(selected.endRoundMinutes || 1) + '"></label><label class="field"><span>Ελάχιστα πληρωτέα λεπτά</span><input id="ruleMinimum" type="number" min="0" max="1440" step="1" value="' + Number(selected.minimumMinutes || 0) + '"><small>0 = χωρίς ελάχιστο. Η διάρκεια δεν στρογγυλοποιείται.</small></label><label class="field"><span>Μέγιστα πληρωτέα λεπτά</span><input id="ruleMaximum" type="number" min="1" max="1440" step="1" value="' + Number(selected.maximumMinutes || 720) + '"></label></div><div class="pay-rate-editor"><div class="pay-rate-editor-head"><span><strong>Ωριαίες ζώνες</strong><small>Πρόσθεσε όσες ζώνες χρειάζεσαι. Για το παράδειγμά σου: 00:00–01:00 με €10 και 01:00–02:00 με €15.</small></span><button class="secondary-button" type="button" data-add-pay-rate>+ Προσθήκη ζώνης</button></div><div id="payRateRows" class="pay-rate-rows">' + specialRates.map(payRateRow).join("") + '</div></div><label class="remember-row"><input id="ruleActive" type="checkbox" ' + (selected.active ? "checked" : "") + '><span><strong>Ενεργός κανόνας</strong></span></label>';
  }

  async function managePayRules() {
    try {
      const rules = (await api("/api/admin/pay-rules")).rules || [];
      state.payRules = rules;
      const promise = simpleEditor({
        overline: "VERSIONED PAY RULES", title: "Κανόνες πληρωμής", submit: "Αποθήκευση νέας έκδοσης", wide: true,
        html: payRuleForm(rules[0] || null, rules),
        collect: function () {
          const name = $("ruleName").value.trim();
          const normalRate = Number($("ruleRate").value);
          const priority = Number($("rulePriority").value || 0);
          const lateGraceMinutes = Number($("ruleLateGrace").value || 0);
          const lateClockOutGraceMinutes = Number($("ruleLateClockOutGrace").value || 0);
          const startRoundMinutes = Number($("ruleStartMinutes").value);
          const endRoundMinutes = Number($("ruleEndMinutes").value);
          const minimumMinutes = Number($("ruleMinimum").value);
          const maximumMinutes = Number($("ruleMaximum").value);
          if (!name) throw new Error("Γράψε όνομα κανόνα.");
          if (!Number.isFinite(normalRate) || normalRate < 0) throw new Error("Η κανονική αμοιβή δεν είναι έγκυρη.");
          if (!Number.isInteger(priority) || !Number.isInteger(lateGraceMinutes) || lateGraceMinutes < 0 || lateGraceMinutes > 720 || !Number.isInteger(lateClockOutGraceMinutes) || lateClockOutGraceMinutes < 0 || lateClockOutGraceMinutes > 720) throw new Error("Έλεγξε προτεραιότητα και τις ανοχές Clock In / Clock Out.");
          if (!Number.isInteger(startRoundMinutes) || startRoundMinutes < 1 || startRoundMinutes > 60 || !Number.isInteger(endRoundMinutes) || endRoundMinutes < 1 || endRoundMinutes > 60) throw new Error("Τα βήματα στρογγυλοποίησης πρέπει να είναι από 1 έως 60 λεπτά.");
          if (!Number.isInteger(minimumMinutes) || minimumMinutes < 0 || !Number.isInteger(maximumMinutes) || maximumMinutes < 1 || maximumMinutes < minimumMinutes) throw new Error("Έλεγξε τα ελάχιστα και μέγιστα πληρωτέα λεπτά.");
          return { id: $("ruleEditId").value || undefined, name, scopeType: $("ruleScope").value, scopeId: $("ruleScopeId").value.trim(), priority, validFrom: $("ruleValidFrom").value || null, validUntil: $("ruleValidUntil").value || null, normalRateCents: Math.round(normalRate * 100), lateGraceMinutes, lateClockOutGraceMinutes, startRoundMode: $("ruleStartMode").value, startRoundMinutes, endRoundMode: $("ruleEndMode").value, endRoundMinutes, durationRoundMode: "none", payableIncrementMinutes: 1, minimumMinutes, maximumMinutes, active: $("ruleActive").checked, specialRates: collectPayRates() };
        }
      });
      const data = await promise;
      const confirmation = await requestPin(true);
      data.reason = confirmation.reason;
      const result = await api("/api/admin/pay-rules", { method: "POST", pin: confirmation.pin, body: data });
      toast("Ο κανόνας αποθηκεύτηκε ως έκδοση " + result.version + ".");
      await loadPayroll();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function manageSpecialAssignments() {
    try {
      await loadAdminLists();
      const rules = (await api("/api/admin/pay-rules")).rules || [];
      const manualRates = [];
      rules.forEach(function (rule) {
        (rule.specialRates || []).forEach(function (rate) {
          if (rate.active !== false && rate.qualification === "manual") {
            manualRates.push({
              id: rate.id, label: rate.label, ruleName: rule.name,
              capacity: rate.capacity == null ? null : Number(rate.capacity)
            });
          }
        });
      });
      if (!manualRates.length) throw new Error("Δεν υπάρχει ενεργή ειδική ζώνη με qualification \"manual\". Δημιούργησέ την πρώτα στους κανόνες πληρωμής.");

      const renderEmployees = function (selectedIds) {
        const selected = new Set(selectedIds || []);
        const rate = manualRates.find(function (item) { return item.id === $("specialAssignmentRate").value; }) || manualRates[0];
        $("specialAssignmentInfo").textContent = rate.capacity == null
          ? "Χωρίς όριο εργαζομένων."
          : "Μέγιστη χωρητικότητα: " + rate.capacity + " εργαζόμενοι.";
        $("specialAssignmentEmployees").innerHTML = state.employees.filter(function (item) { return item.active; }).map(function (item) {
          return '<label><input type="checkbox" data-special-employee="' + escapeHtml(item.id) + '" ' + (selected.has(item.id) ? "checked" : "") + '> <span>' + escapeHtml(item.fullName) + '</span></label>';
        }).join("") || '<p class="empty-copy">Δεν υπάρχουν ενεργοί εργαζόμενοι.</p>';
      };
      const refreshSelections = async function () {
        const date = $("specialAssignmentDate").value;
        const rateId = $("specialAssignmentRate").value;
        if (!date || !rateId) return renderEmployees([]);
        try {
          const payload = await api("/api/admin/special-rate-assignments?date=" + encodeURIComponent(date));
          renderEmployees((payload.assignments || []).filter(function (item) { return item.special_rate_id === rateId; }).map(function (item) { return item.employee_id; }));
        } catch (error) {
          $("simpleError").textContent = error.message;
        }
      };
      const dataPromise = simpleEditor({
        overline: "PAYROLL CAPACITY", title: "Χειροκίνητες ειδικές ζώνες", submit: "Αποθήκευση αναθέσεων",
        html: '<div class="form-grid"><label class="field"><span>Ημερομηνία</span><input id="specialAssignmentDate" type="date" value="' + inputDate(0) + '" required></label><label class="field"><span>Ειδική ζώνη</span><select id="specialAssignmentRate">' + manualRates.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.ruleName + " • " + item.label) + '</option>'; }).join("") + '</select></label></div><p id="specialAssignmentInfo" class="helper-copy"></p><div id="specialAssignmentEmployees" class="check-grid special-assignment-grid"></div>',
        collect: function () {
          const rate = manualRates.find(function (item) { return item.id === $("specialAssignmentRate").value; });
          const employeeIds = Array.from(document.querySelectorAll("[data-special-employee]:checked")).map(function (input) { return input.dataset.specialEmployee; });
          if (rate && rate.capacity != null && employeeIds.length > rate.capacity) throw new Error("Η ζώνη δέχεται έως " + rate.capacity + " εργαζόμενους.");
          return { specialRateId: $("specialAssignmentRate").value, date: $("specialAssignmentDate").value, employeeIds: employeeIds };
        }
      });
      setTimeout(function () {
        $("specialAssignmentDate").addEventListener("change", refreshSelections);
        $("specialAssignmentRate").addEventListener("change", refreshSelections);
        refreshSelections();
      }, 0);
      const data = await dataPromise;
      const confirmation = await requestPin(true);
      data.reason = confirmation.reason;
      const saved = await api("/api/admin/special-rate-assignments", { method: "POST", pin: confirmation.pin, body: data });
      toast("Αποθηκεύτηκαν " + saved.assigned + " αναθέσεις ειδικής ζώνης.");
      await loadPayroll();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function prepareReports() {
    if (!$("reportFrom").value) $("reportFrom").value = inputDate(-30);
    if (!$("reportTo").value) $("reportTo").value = inputDate(0);
    await loadAdminLists();
    const employeeValue = $("reportEmployee").value;
    const vehicleValue = $("reportVehicle").value;
    $("reportEmployee").innerHTML = '<option value="">Όλοι</option>' + state.employees.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.fullName) + '</option>'; }).join("");
    $("reportVehicle").innerHTML = '<option value="">Όλα</option>' + state.vehicles.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>'; }).join("");
    $("reportEmployee").value = employeeValue;
    $("reportVehicle").value = vehicleValue;
    const service = state.selectedReport === "service";
    const payroll = state.selectedReport === "payroll";
    $("reportEmployee").closest("label").classList.toggle("is-hidden", service || payroll);
    $("reportVehicle").closest("label").classList.toggle("is-hidden", payroll);
    $("reportServiceTask").closest("label").classList.toggle("is-hidden", !service);
    $("reportWorkshop").closest("label").classList.toggle("is-hidden", !service);
  }

  const reportLabels = {
    employee: "Εργαζόμενος", employeeName: "Εργαζόμενος", actual_clock_in: "Actual Clock In",
    actual_clock_out: "Actual Clock Out", payable_hours: "Payable ώρες", vehicle: "Μηχανάκι",
    initial_km: "Αρχικά χλμ.", final_km: "Τελικά χλμ.", shift_km: "Χλμ. βάρδιας",
    status: "Κατάσταση", final_pay_cents: "Τελική αμοιβή", started_at: "Έναρξη",
    ended_at: "Λήξη", distance: "Απόσταση", reason: "Αιτιολογία", date: "Ημερομηνία",
    record_id: "Κωδικός εγγραφής", km: "Χιλιόμετρα", tasks: "Εργασίες", workshop: "Συνεργείο", oil_changed: "Αλλαγή λαδιών", notes: "Σημειώσεις",
    payableHours: "Payable ώρες", normalHours: "Κανονικές ώρες", specialHours: "Ειδικές ώρες",
    kilometers: "Χιλιόμετρα", basePayCents: "Βασική αμοιβή", specialPayCents: "Ειδική αμοιβή",
    bonusCents: "Bonus", deductionCents: "Κρατήσεις", advanceCents: "Προκαταβολές", finalCents: "Τελικό"
  };

  function reportValue(key, value) {
    if (value == null || value === "") return "—";
    if (/_at$/.test(key)) return formatDateTime(value);
    if (/Cents$|_cents$/.test(key)) return money(value);
    if (["initial_km", "final_km", "shift_km", "distance", "km", "kilometers"].includes(key)) return km(value);
    if (["payableHours", "normalHours", "specialHours", "payable_hours"].includes(key)) return hours(value);
    return String(value);
  }

  function reportTable(data) {
    return data.rows.length ? '<table class="data-table"><thead><tr>' + data.columns.map(function (key) { return '<th>' + escapeHtml(reportLabels[key] || key) + '</th>'; }).join("") + '</tr></thead><tbody>' + data.rows.map(function (row) { return '<tr>' + data.columns.map(function (key) { return '<td class="' + (["tasks", "notes", "reason"].includes(key) ? "wrap" : "") + '">' + escapeHtml(reportValue(key, row[key])) + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table>' : '<p class="empty-copy">Δεν βρέθηκαν αποτελέσματα για αυτή την περίοδο.</p>';
  }

  async function runReport() {
    await prepareReports();
    try {
      const query = new URLSearchParams({
        type: state.selectedReport, from: $("reportFrom").value, to: $("reportTo").value,
        employeeId: $("reportEmployee").value, vehicleId: $("reportVehicle").value,
        serviceTask: $("reportServiceTask").value.trim(), workshop: $("reportWorkshop").value.trim()
      });
      state.report = await api("/api/admin/reports?" + query.toString());
      $("reportResult").innerHTML = reportTable(state.report);
      $("reportResultPanel").classList.remove("is-hidden");
    } catch (error) { toast(error.message); }
  }

  function csvCell(value) {
    let textValue = String(value == null ? "" : value);
    if (/^[=+\-@]/.test(textValue)) textValue = "'" + textValue;
    return '"' + textValue.replace(/"/g, '""') + '"';
  }

  function downloadReportCsv() {
    if (!state.report) return void toast("Δημιούργησε πρώτα την αναφορά.");
    const lines = [state.report.columns.map(function (key) { return csvCell(reportLabels[key] || key); }).join(";")];
    state.report.rows.forEach(function (row) { lines.push(state.report.columns.map(function (key) { return csvCell(row[key]); }).join(";")); });
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "Fleet_Control_" + state.report.type + "_" + state.report.from + "_" + state.report.to + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  async function loadAlerts() {
    const data = await api("/api/admin/alerts");
    state.alerts = data.alerts || [];
    $("alertRulesButton").classList.toggle("is-hidden", !can("alerts.manage"));
    $("notificationCount").textContent = state.alerts.length;
    $("notificationCount").classList.toggle("is-hidden", !state.alerts.length);
    $("alertList").innerHTML = state.alerts.length ? state.alerts.map(function (item) {
      const canResolve = can("alerts.manage");
      const canApproveOvertime = can("shifts.manage") || can("payroll.manage");
      const action = item.type === "correction_request" && canResolve
        ? '<button class="secondary-button" type="button" data-handle-correction="' + escapeHtml(item.object_id) + '">Έλεγχος</button>'
        : item.object_type === "shift" && ["overtime", "forgotten_clock_out"].includes(item.type) && canApproveOvertime
          ? '<button class="secondary-button" type="button" data-open-shift-alert="' + escapeHtml(item.object_id) + '">Άνοιγμα βάρδιας</button>'
          : canResolve
            ? '<button class="secondary-button" type="button" data-resolve-alert="' + escapeHtml(item.id) + '">Ολοκληρώθηκε</button>'
            : '';
      const channel = item.channel === "both" ? "In-app + Push" : item.channel === "push" ? "Push" : "In-app";
      return '<article class="alert-item ' + escapeHtml(item.severity) + '"><span class="alert-icon">' + (item.severity === "critical" ? "!" : item.severity === "info" ? "i" : "◷") + '</span><span><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.message) + '</p><time>' + escapeHtml(formatDateTime(item.created_at) + " • " + channel) + '</time></span>' + action + '</article>';
    }).join("") : '<div class="action-card ok"><i>✓</i><span><strong>Καμία εκκρεμότητα</strong><small>Δεν υπάρχουν ενεργές ειδοποιήσεις.</small></span></div>';
    updateNotificationControls();
    updateBulkAlertControl();
    deliverLocalAlerts(state.alerts);
  }

  const alertsRequiringAction = new Set(["correction_request", "overtime", "forgotten_clock_out"]);

  function bulkResolvableAlerts() {
    return (state.alerts || []).filter(function (item) {
      return can("alerts.manage") && !alertsRequiringAction.has(String(item.type || ""));
    });
  }

  function updateBulkAlertControl() {
    const button = $("resolveAllAlerts");
    if (!button) return;
    const count = bulkResolvableAlerts().length;
    button.classList.toggle("is-hidden", !count);
    button.textContent = count > 1 ? "Ολοκλήρωση όλων (" + count + ")" : "Ολοκλήρωση όλων";
    button.disabled = !count;
  }

  async function resolveAllAlerts() {
    const resolvable = bulkResolvableAlerts();
    if (!resolvable.length) return;
    const protectedCount = (state.alerts || []).length - resolvable.length;
    const suffix = protectedCount
      ? "\n\nΟι " + protectedCount + " ειδοποιήσεις που απαιτούν έγκριση ή έλεγχο θα παραμείνουν ανοικτές."
      : "";
    if (!window.confirm("Να ολοκληρωθούν όλες οι διαθέσιμες ειδοποιήσεις (" + resolvable.length + ");" + suffix)) return;
    const results = await Promise.allSettled(resolvable.map(function (item) {
      return api("/api/admin/alerts/" + encodeURIComponent(item.id) + "/resolve", { method: "POST", body: {} });
    }));
    const failed = results.filter(function (result) { return result.status === "rejected"; }).length;
    await loadAlerts();
    toast(failed ? "Ολοκληρώθηκαν όσα ήταν διαθέσιμα. Απέτυχαν " + failed + "." : "Οι διαθέσιμες ειδοποιήσεις ολοκληρώθηκαν.");
  }

  function androidNotificationStatus() {
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.getAlertNotificationStatus === "function") {
        return JSON.parse(String(window.AndroidFleet.getAlertNotificationStatus() || "{}"));
      }
    } catch (error) {}
    return null;
  }

  function browserNotificationsEnabled() {
    try { return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem(BROWSER_NOTIFICATIONS) === "1"; }
    catch (error) { return false; }
  }

  function updateNotificationControls() {
    const android = androidNotificationStatus();
    const enabled = android ? Boolean(android.enabled) : browserNotificationsEnabled();
    $("mobileNotificationsButton").textContent = enabled ? "Ειδοποιήσεις ενεργές ✓" : "Ενεργοποίηση στο κινητό";
    $("mobileNotificationsButton").classList.toggle("notifications-active", enabled);
    $("mobileNotificationsStatus").textContent = android
      ? (enabled ? "Άμεση ειδοποίηση όταν η εφαρμογή είναι ανοικτή και ασφαλής περιοδικός έλεγχος στο παρασκήνιο περίπου ανά 15 λεπτά." : "Ενεργοποίησέ τες και επίλεξε «Να θυμάσαι αυτή τη συσκευή» στη σύνδεση για ειδοποιήσεις στο παρασκήνιο.")
      : (enabled ? "Οι ειδοποιήσεις εμφανίζονται όσο το Web App παραμένει ενεργό." : "Οι ειδοποιήσεις της συγκεκριμένης συσκευής δεν έχουν ενεργοποιηθεί.");
  }

  async function enableMobileNotifications() {
    try {
      if (window.AndroidFleet && typeof window.AndroidFleet.enableAlertNotifications === "function") {
        const result = JSON.parse(String(window.AndroidFleet.enableAlertNotifications(true) || "{}"));
        if (!result.enabled) throw new Error(result.message || "Δεν δόθηκε άδεια ειδοποιήσεων από το Android.");
        toast("Οι ειδοποιήσεις Fleet Control ενεργοποιήθηκαν στο κινητό.");
      } else {
        if (typeof Notification === "undefined") throw new Error("Ο browser δεν υποστηρίζει ειδοποιήσεις.");
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Η άδεια ειδοποιήσεων δεν δόθηκε.");
        localStorage.setItem(BROWSER_NOTIFICATIONS, "1");
        toast("Οι ειδοποιήσεις ενεργοποιήθηκαν σε αυτή τη συσκευή.");
      }
      updateNotificationControls();
      deliverLocalAlerts(state.alerts || []);
    } catch (error) { toast(error.message); }
  }

  function deliverLocalAlerts(alerts) {
    const android = androidNotificationStatus();
    if (!(android ? android.enabled : browserNotificationsEnabled())) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(ALERT_NOTIFICATION_IDS) || "[]"); } catch (error) {}
    const known = new Set(Array.isArray(seen) ? seen.map(String) : []);
    const pending = (alerts || []).filter(function (item) {
      return (item.channel === "push" || item.channel === "both") && !known.has(String(item.id));
    }).slice(0, 3);
    pending.slice().reverse().forEach(function (item) {
      try {
        if (android && window.AndroidFleet && typeof window.AndroidFleet.notifyAlert === "function") {
          window.AndroidFleet.notifyAlert(String(item.id), String(item.title), String(item.message), String(item.severity));
        } else {
          const notification = new Notification("Fleet Control • " + item.title, { body: item.message, icon: "./icons/icon-192.png", tag: "fleet-alert-" + item.id });
          notification.onclick = function () { window.focus(); goTo("alerts"); notification.close(); };
        }
      } catch (error) {}
      known.add(String(item.id));
    });
    try { localStorage.setItem(ALERT_NOTIFICATION_IDS, JSON.stringify([...known].slice(-200))); } catch (error) {}
  }

  async function manageAlertRules() {
    try {
      const rules = (await api("/api/admin/alert-rules")).rules || [];
      const html = '<p class="helper-copy">Οι επιλογές εφαρμόζονται στον server. Το κανάλι Push προετοιμάζει τη δρομολόγηση· οι ειδοποιήσεις μέσα στην εφαρμογή παραμένουν διαθέσιμες.</p><div class="alert-rules-editor">' + rules.map(function (rule) {
        return '<div class="alert-rule-row" data-alert-rule="' + escapeHtml(rule.type) + '"><label class="alert-rule-toggle"><input type="checkbox" data-alert-enabled ' + (rule.enabled ? "checked" : "") + '><span><strong>' + escapeHtml(alertTypeLabels[rule.type] || rule.type) + '</strong><small>' + escapeHtml(rule.type) + '</small></span></label><select data-alert-severity aria-label="Σοβαρότητα"><option value="info" ' + (rule.severity === "info" ? "selected" : "") + '>Info</option><option value="warning" ' + (rule.severity === "warning" ? "selected" : "") + '>Warning</option><option value="critical" ' + (rule.severity === "critical" ? "selected" : "") + '>Critical</option></select><select data-alert-channel aria-label="Κανάλι"><option value="in_app" ' + (rule.channel === "in_app" ? "selected" : "") + '>In-app</option><option value="push" ' + (rule.channel === "push" ? "selected" : "") + '>Push</option><option value="both" ' + (rule.channel === "both" ? "selected" : "") + '>Both</option></select></div>';
      }).join("") + '</div>';
      const data = await simpleEditor({
        overline: "ALERT ROUTING", title: "Ρυθμίσεις ειδοποιήσεων", submit: "Αποθήκευση ρυθμίσεων", html: html,
        collect: function () {
          return { rules: Array.from(document.querySelectorAll("[data-alert-rule]")).map(function (row) {
            return { type: row.dataset.alertRule, enabled: row.querySelector("[data-alert-enabled]").checked, severity: row.querySelector("[data-alert-severity]").value, channel: row.querySelector("[data-alert-channel]").value };
          }) };
        }
      });
      const confirmation = await requestPin(true);
      data.reason = confirmation.reason;
      await api("/api/admin/alert-rules", { method: "PUT", pin: confirmation.pin, body: data });
      toast("Οι ρυθμίσεις ειδοποιήσεων αποθηκεύτηκαν.");
      await loadAlerts();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function handleCorrection(id) {
    try {
      const data = await api("/api/admin/corrections");
      const request = (data.corrections || []).find(function (item) { return String(item.id) === String(id); });
      if (!request) throw new Error("Το αίτημα διόρθωσης δεν βρέθηκε.");
      const decision = await simpleEditor({
        overline: "ΑΙΤΗΜΑ ΔΙΟΡΘΩΣΗΣ", title: request.employee_name || "Εργαζόμενος", submit: "Αποθήκευση απόφασης",
        html: '<div class="action-card"><i>i</i><span><strong>' + escapeHtml(request.type) + '</strong><small>' + escapeHtml(request.message) + '</small></span></div><label class="field"><span>Απόφαση</span><select id="correctionDecision"><option value="approved">Έγκριση</option><option value="rejected">Απόρριψη</option></select></label><label class="field"><span>Τρόπος επίλυσης / αιτιολογία</span><textarea id="correctionResolution" rows="4" required></textarea></label>',
        collect: function () { const resolution = $("correctionResolution").value.trim(); if (!resolution) throw new Error("Γράψε τον τρόπο επίλυσης ή την αιτιολογία."); return { status: $("correctionDecision").value, resolution: resolution }; }
      });
      const confirmation = await requestPin(true);
      decision.reason = confirmation.reason;
      await api("/api/admin/corrections/" + encodeURIComponent(id) + "/resolve", { method: "POST", pin: confirmation.pin, body: decision });
      toast(decision.status === "approved" ? "Το αίτημα εγκρίθηκε." : "Το αίτημα απορρίφθηκε.");
      await loadAlerts();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function resolveAlert(id) {
    try {
      await api("/api/admin/alerts/" + encodeURIComponent(id) + "/resolve", { method: "POST", body: {} });
      toast("Η ειδοποίηση επιλύθηκε.");
      await loadAlerts();
    } catch (error) { toast(error.message); }
  }

  async function loadAudit() {
    const data = await api("/api/admin/audit");
    const entries = data.entries || [];
    $("auditTable").innerHTML = entries.length ? '<table class="data-table"><thead><tr><th>Χρόνος</th><th>Χρήστης</th><th>Ρόλος</th><th>Ενέργεια</th><th>Αντικείμενο</th><th>Αιτιολογία</th><th>IP / Device</th><th>PIN</th></tr></thead><tbody>' + entries.map(function (item) {
      return '<tr><td>' + escapeHtml(formatDateTime(item.timestamp)) + '</td><td><strong>' + escapeHtml(item.user_name || "System") + '</strong></td><td>' + escapeHtml(roleLabel(item.role)) + '</td><td>' + escapeHtml(item.action) + '</td><td>' + escapeHtml(item.object_type + (item.object_id ? " • " + item.object_id : "")) + '</td><td class="wrap">' + escapeHtml(item.reason || "—") + '</td><td>' + escapeHtml((item.ip_address || "—") + (item.device_id ? " • " + item.device_id : "")) + '</td><td>' + (Number(item.admin_pin_used) ? "Ναι" : "Όχι") + '</td></tr>';
    }).join("") + '</tbody></table>' : '<p class="empty-copy">Το Audit Log είναι κενό.</p>';
  }

  function recycleTypeLabel(type) {
    return type === "fleet_history" ? "Service / χιλιόμετρα" : type === "shift" ? "Πραγματική βάρδια" : type === "schedule_assignment" ? "Πρόγραμμα" : type;
  }

  async function loadRecycle() {
    const query = new URLSearchParams();
    if ($("recycleType").value) query.set("type", $("recycleType").value);
    if ($("recycleShowRestored").checked) query.set("restored", "1");
    const data = await api("/api/admin/recycle-bin?" + query.toString());
    state.recycle = data.records || [];
    $("recycleSummary").innerHTML = '<span><strong>' + Number(data.counts?.active || 0) + '</strong><small>διαθέσιμα για ανάκτηση</small></span><span><strong>' + Number(data.counts?.restored || 0) + '</strong><small>ήδη ανακτημένα</small></span><p>Οι εγγραφές διατηρούνται μέχρι να αποφασίσεις εσύ. Κάθε ανάκτηση γράφεται και στο Audit Log.</p>';
    $("recycleList").innerHTML = state.recycle.length ? state.recycle.map(function (item) {
      return '<article class="recycle-card ' + (item.restoredAt ? "restored" : "") + '"><span class="recycle-icon">↶</span><div class="recycle-copy"><span><b>' + escapeHtml(recycleTypeLabel(item.recordType)) + '</b>' + (item.restoredAt ? '<em>Ανακτήθηκε</em>' : '<em>Στον κάδο</em>') + '</span><h3>' + escapeHtml(item.label) + '</h3><p>' + escapeHtml(item.details || "—") + '</p><small>Διαγραφή: ' + escapeHtml(formatDateTime(item.deletedAt)) + ' • ' + escapeHtml(item.deletedBy || "System") + (item.reason ? '<br>Αιτία: ' + escapeHtml(item.reason) : '') + (item.restoredAt ? '<br>Ανάκτηση: ' + escapeHtml(formatDateTime(item.restoredAt)) : '') + '</small></div>' + (item.canRestore ? '<button class="secondary-button" type="button" data-recycle-restore="' + escapeHtml(item.id) + '">Ανάκτηση</button>' : '') + '</article>';
    }).join("") : '<div class="recycle-empty"><span>✓</span><strong>Ο κάδος είναι άδειος</strong><p>Δεν υπάρχουν διαγραμμένες εγγραφές για τα επιλεγμένα φίλτρα.</p></div>';
  }

  async function restoreRecycleRecord(id) {
    const item = state.recycle.find(function (record) { return String(record.id) === String(id); });
    if (!item) return;
    try {
      const data = await simpleEditor({
        overline: "ΑΣΦΑΛΗΣ ΑΝΑΚΤΗΣΗ", title: "Ανάκτηση εγγραφής", submit: "Ανάκτηση τώρα",
        html: '<div class="restore-preview"><small>' + escapeHtml(recycleTypeLabel(item.recordType)) + '</small><strong>' + escapeHtml(item.label) + '</strong><p>' + escapeHtml(item.details || "") + '</p></div><label class="field"><span>Αιτιολογία ανάκτησης</span><textarea id="recycleRestoreReason" rows="3" maxlength="500">Ανάκτηση εγγραφής που διαγράφηκε κατά λάθος</textarea></label>',
        collect: function () { const reason = $("recycleRestoreReason").value.trim(); if (!reason) throw new Error("Γράψε αιτιολογία ανάκτησης."); return { reason: reason }; }
      });
      await api("/api/admin/recycle-bin/" + encodeURIComponent(id) + "/restore", { method: "POST", body: data });
      toast(item.recordType === "shift" ? "Η βάρδια ανακτήθηκε. Αν ήταν ενεργή, έλεγξε ώρα λήξης και χιλιόμετρα." : "Η εγγραφή ανακτήθηκε με επιτυχία.");
      state.viewLoadedAt.recycle = 0;
      await loadRecycle();
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function requestBackupNow() {
    const button = $("requestBackup");
    button.disabled = true;
    button.textContent = "Αποστολή αιτήματος…";
    try {
      await api("/api/backup/request", { method: "POST", body: {} });
      toast("Το αίτημα backup στάλθηκε στην εφαρμογή Server.");
      setTimeout(function () { loadStatus(true); }, 2500);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = "Δημιουργία backup τώρα"; }
  }

  async function loadSettings() {
    const results = await Promise.all([api("/api/admin/settings"), loadDevices()]);
    const data = results[0];
    $("noSchedulePolicy").value = data.settings.no_schedule_policy || "allow_warning";
    $("adminSessionDuration").value = data.settings.admin_session_duration || "4h";
    $("fallbackHour").value = data.settings.safety_fallback_hour || "5";
    $("unusualDistanceKm").value = data.settings.unusual_distance_km || "300";
    $("changeAdminPin").classList.toggle("is-hidden", !can("security.manage"));
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      const confirmation = await requestPin(true);
      await api("/api/admin/settings", { method: "PUT", pin: confirmation.pin, body: {
        no_schedule_policy: $("noSchedulePolicy").value,
        admin_session_duration: $("adminSessionDuration").value,
        safety_fallback_hour: $("fallbackHour").value,
        unusual_distance_km: Number($("unusualDistanceKm").value || 300),
        reason: confirmation.reason
      } });
      toast("Οι ρυθμίσεις αποθηκεύτηκαν.");
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  async function loadDevices() {
    const data = await api("/api/auth/devices");
    const devices = data.devices || [];
    $("deviceList").innerHTML = devices.length ? devices.map(function (item) {
      return '<div class="data-row"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.platform) + '</small></span><span><strong>' + escapeHtml(formatDateTime(item.last_seen_at)) + '</strong><small>Τελευταία σύνδεση</small></span>' + statusPill(Number(item.active) ? "available" : "inactive") + '</div>';
    }).join("") : '<p class="empty-copy">Δεν υπάρχουν καταγεγραμμένες συσκευές.</p>';
  }

  async function changeAdminPin() {
    try {
      const current = await requestPin(false);
      const data = await simpleEditor({
        overline: "ΔΕΥΤΕΡΗ ΕΠΙΒΕΒΑΙΩΣΗ", title: "Αλλαγή Admin PIN", submit: "Αλλαγή PIN",
        html: '<label class="field"><span>Νέο PIN (4–6 αριθμοί)</span><input id="newAdminPin" class="pin-field" type="password" inputmode="numeric" maxlength="6" required></label><label class="field"><span>Επανάληψη νέου PIN</span><input id="confirmAdminPin" class="pin-field" type="password" inputmode="numeric" maxlength="6" required></label>',
        collect: function () { const pin = $("newAdminPin").value.trim(); if (!/^\d{4,6}$/.test(pin)) throw new Error("Το PIN πρέπει να έχει 4 έως 6 αριθμούς."); if (pin !== $("confirmAdminPin").value.trim()) throw new Error("Τα δύο PIN δεν ταιριάζουν."); return { pin: pin }; }
      });
      await api("/api/admin/pin", { method: "POST", pin: current.pin, body: data });
      toast("Το Admin PIN άλλαξε.");
    } catch (error) { if (!/ακυρώθηκε/.test(error.message)) toast(error.message); }
  }

  function bindEvents() {
    $("loginForm").addEventListener("submit", handleLogin);
    $("bootstrapForm").addEventListener("submit", handleBootstrap);
    $("showBootstrap").addEventListener("click", function () { $("loginForm").classList.add("is-hidden"); $("bootstrapForm").classList.remove("is-hidden"); });
    $("backToLogin").addEventListener("click", showAuth);
    $("logoutButton").addEventListener("click", logout);
    $("menuButton").addEventListener("click", function () { $("portal").classList.toggle("sidebar-open"); });
    $("sidebarBackdrop").addEventListener("click", function () { $("portal").classList.remove("sidebar-open"); });
    $("notificationButton").addEventListener("click", function () { if (can("alerts.view")) goTo("alerts"); });
    $("profileButton").addEventListener("click", function () { if (can("settings.manage")) goTo("settings"); });
    $("dashboardDetailOpen").addEventListener("click", function () {
      const target = state.dashboardDetailTarget;
      if (!target) return;
      $("dashboardDetailDialog").close();
      goTo(target);
    });
    $("employeeForm").addEventListener("submit", saveEmployee);
    $("scheduleForm").addEventListener("submit", saveSchedule);
    $("scheduleEditForm").addEventListener("submit", saveScheduleEdit);
    $("pinForm").addEventListener("submit", submitPin);
    $("simpleForm").addEventListener("submit", submitSimple);
    $("newEmployeeButton").addEventListener("click", function () { openEmployeeDialog(); });
    $("newScheduleButton").addEventListener("click", function () { openScheduleDialog("shift").catch(function (error) { toast(error.message); }); });
    $("scheduleTemplatesButton").addEventListener("click", function () { openTemplateManager().catch(function (error) { toast(error.message); }); });
    $("scheduleCopyButton").addEventListener("click", copyPreviousScheduleWeek);
    $("scheduleImportButton").addEventListener("click", openScheduleImportDialog);
    $("schedulePublishButton").addEventListener("click", publishCurrentScheduleWeek);
    $("scheduleImportFile").addEventListener("change", function (event) { handleScheduleImportFile(event).catch(function (error) { $("scheduleImportError").textContent = error.message; }); });
    $("scheduleImportForm").addEventListener("submit", commitScheduleImport);
    $("schedulePdfButton").addEventListener("click", downloadSchedulePdf);
    $("previousScheduleWeek").addEventListener("click", function () { moveScheduleWeek(-7); });
    $("nextScheduleWeek").addEventListener("click", function () { moveScheduleWeek(7); });
    $("currentScheduleWeek").addEventListener("click", function () { $("scheduleWeekDate").value = mondayIso(inputDate(0)); loadSchedules(true).catch(function (error) { toast(error.message); }); });
    $("scheduleWeekDate").addEventListener("change", function () { loadSchedules(true).catch(function (error) { toast(error.message); }); });
    $("bulkVehicleMode").addEventListener("change", renderBulkVehicleAssignments);
    $("bulkScheduleDays").addEventListener("change", renderBulkVehicleAssignments);
    $("bulkScheduleEmployees").addEventListener("change", renderBulkVehicleAssignments);
    $("weekScheduleEmployee").addEventListener("change", renderEmployeeWeekRows);
    $("sameVehicleAllWeek").addEventListener("change", applySameWeekVehicleState);
    $("sameWeekVehicle").addEventListener("change", applySameWeekVehicleState);
    $("scheduleEditEmployee").addEventListener("change", function () { refreshScheduleEditVehicle(true); });
    $("scheduleEditDelete").addEventListener("click", removeScheduleAssignment);
    $("templateForm").addEventListener("submit", saveTemplate);
    $("newTemplateButton").addEventListener("click", function () { editTemplate(null); });
    $("addTemplateSegment").addEventListener("click", addTemplateSegment);
    $("deleteTemplateButton").addEventListener("click", disableTemplate);
    $("refreshShifts").addEventListener("click", loadShifts);
    $("refreshInvoices").addEventListener("click", loadInvoices);
    $("invoiceFileSearch").addEventListener("input", renderInvoiceQueue);
    $("invoiceStatusFilter").addEventListener("change", renderInvoiceQueue);
    if ($("invoicePlateFilter")) $("invoicePlateFilter").addEventListener("change", renderInvoiceQueue);
    $("invoiceReviewForm").addEventListener("submit", saveAdminInvoiceReview);
    $("invoiceReviewOpen").addEventListener("click", function () { openInvoiceDocument(state.invoiceReviewDocument, false); });
    $("invoiceReviewDownload").addEventListener("click", function () { openInvoiceDocument(state.invoiceReviewDocument, true); });
    if ($("reprocessInvoices")) $("reprocessInvoices").addEventListener("click", chooseInvoiceReprocessMode);
    if ($("invoiceReviewMove")) $("invoiceReviewMove").addEventListener("click", function () { state.invoiceReviewTransferChoice = "move"; saveAdminInvoiceReview(); });
    if ($("invoiceReviewKeep")) $("invoiceReviewKeep").addEventListener("click", function () { state.invoiceReviewTransferChoice = "keep"; saveAdminInvoiceReview(); });
    $("manualClockInButton").addEventListener("click", manualClockIn);
    $("loadPayroll").addEventListener("click", loadPayroll);
    $("payrollLockButton").addEventListener("click", togglePayrollLock);
    $("newAdjustmentButton").addEventListener("click", addAdjustment);
    $("ruleSimulatorButton").addEventListener("click", simulateRule);
    $("payRulesButton").addEventListener("click", managePayRules);
    $("specialAssignmentsButton").addEventListener("click", manageSpecialAssignments);
    if ($("openFleetButton")) $("openFleetButton").addEventListener("click", openFleetControl);
    if ($("fleetModuleFrame")) $("fleetModuleFrame").addEventListener("load", function () {
      setFleetDetailMode(false);
      $("fleetModuleShell").classList.add("is-loaded");
      $("fleetModuleShell").setAttribute("aria-busy", "false");
    });
    window.addEventListener("message", function (event) {
      const frame = $("fleetModuleFrame");
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || message.type !== "fleet-control:embedded-view") return;
      const immersiveFleetView = message.view === "detail" || message.view === "quick-check";
      setFleetDetailMode(state.view === "fleet" && immersiveFleetView);
    });
    $("runReport").addEventListener("click", runReport);
    $("reportPdf").addEventListener("click", function () { if (state.report) window.print(); else toast("Δημιούργησε πρώτα την αναφορά."); });
    $("reportExcel").addEventListener("click", downloadReportCsv);
    $("refreshAlerts").addEventListener("click", loadAlerts);
    $("resolveAllAlerts").addEventListener("click", resolveAllAlerts);
    $("mobileNotificationsButton").addEventListener("click", enableMobileNotifications);
    $("alertRulesButton").addEventListener("click", manageAlertRules);
    $("refreshAudit").addEventListener("click", loadAudit);
    $("refreshRecycle").addEventListener("click", loadRecycle);
    $("recycleType").addEventListener("change", loadRecycle);
    $("recycleShowRestored").addEventListener("change", loadRecycle);
    $("refreshCoverage").addEventListener("click", loadCoverage);
    $("coverageWeek").addEventListener("change", loadCoverage);
    $("requestBackup").addEventListener("click", requestBackupNow);
    if ($("loginAndroidDownload")) $("loginAndroidDownload").addEventListener("click", downloadClientApk);
    if ($("loginIosGuide")) $("loginIosGuide").addEventListener("click", showIosInstallGuide);
    if ($("portalDownloadApk")) $("portalDownloadApk").addEventListener("click", downloadClientApk);
    if ($("portalIosGuide")) $("portalIosGuide").addEventListener("click", showIosInstallGuide);
    if ($("installGuideClose")) $("installGuideClose").addEventListener("click", function () { $("installGuideDialog").close(); });
    if ($("iosShareButton")) $("iosShareButton").addEventListener("click", openIosShareMenu);
    if ($("iosCopyLink")) $("iosCopyLink").addEventListener("click", copyIosInstallLink);
    $("systemSettingsForm").addEventListener("submit", saveSettings);
    $("changeAdminPin").addEventListener("click", changeAdminPin);
    $("refreshDevices").addEventListener("click", loadDevices);
    $("employeeRole").addEventListener("change", function () { renderEmployeePermissions(null, $("employeeRole").value); });
    $("usesOwnVehicle").addEventListener("change", applyOwnVehicleEmployeeState);
    document.querySelectorAll("[data-pin-cancel]").forEach(function (button) { button.addEventListener("click", cancelPin); });
    document.addEventListener("click", function (event) {
      const go = event.target.closest("[data-go]");
      if (go) { event.preventDefault(); return void goTo(go.dataset.go); }
      const dashboardDetail = event.target.closest("[data-dashboard-detail]");
      if (dashboardDetail) return void openDashboardDetail(dashboardDetail.dataset.dashboardDetail);
      const coverageDay = event.target.closest("[data-coverage-day]");
      if (coverageDay) {
        state.coverageDay = Number(coverageDay.dataset.coverageDay) || 0;
        return void renderCoverage();
      }
      const dashboardEmployeeDetail = event.target.closest("[data-dashboard-employee-detail]");
      if (dashboardEmployeeDetail) {
        $("dashboardDetailDialog").close();
        const employeeId = dashboardEmployeeDetail.dataset.dashboardEmployeeDetail;
        return void loadAdminLists().then(function () { return openEmployeeDetail(employeeId); }).catch(function (error) { toast(error.message); });
      }
      const dashboardEmployeeEdit = event.target.closest("[data-dashboard-employee-edit]");
      if (dashboardEmployeeEdit) {
        $("dashboardDetailDialog").close();
        return void openEmployeeDialog(dashboardEmployeeEdit.dataset.dashboardEmployeeEdit);
      }
      const close = event.target.closest("[data-close]");
      if (close) {
        event.preventDefault();
        if (close.dataset.close === "simpleDialog") return void cancelSimple();
        const dialog = $(close.dataset.close);
        if (dialog && dialog.open) dialog.close();
        return;
      }
      const edit = event.target.closest("[data-employee-edit]");
      if (edit) return void openEmployeeDialog(edit.dataset.employeeEdit);
      const employeeDetail = event.target.closest("[data-employee-detail]");
      if (employeeDetail) return void openEmployeeDetail(employeeDetail.dataset.employeeDetail);
      const employeeTab = event.target.closest("[data-employee-detail-tab]");
      if (employeeTab) {
        $("employeeDetailTabs").querySelectorAll("button").forEach(function (button) { button.classList.toggle("active", button === employeeTab); });
        return void loadEmployeeDetail(employeeTab.dataset.employeeDetailTab);
      }
      const reset = event.target.closest("[data-password-reset]");
      if (reset) return void resetPassword(reset.dataset.passwordReset);
      const forced = event.target.closest("[data-force-logout]");
      if (forced) return void forceLogout(forced.dataset.forceLogout);
      const shiftAction = event.target.closest("[data-shift-action]");
      if (shiftAction) return void runShiftAction(shiftAction.dataset.shiftId, shiftAction.dataset.shiftAction);
      const builderMode = event.target.closest("[data-builder-mode]");
      if (builderMode) return void setScheduleBuilderMode(builderMode.dataset.builderMode);
      const scheduleEdit = event.target.closest("[data-schedule-edit]");
      if (scheduleEdit) return void openScheduleEditDialog(scheduleEdit.dataset.scheduleEdit);
      const suggestedVehicle = event.target.closest("[data-suggested-vehicle]");
      if (suggestedVehicle) return void useSuggestedVehicle(suggestedVehicle.dataset.suggestedVehicle);
      const editSuggestedVehicle = event.target.closest("[data-edit-suggested-vehicle]");
      if (editSuggestedVehicle) {
        $("scheduleEditVehicle").value = editSuggestedVehicle.dataset.editSuggestedVehicle;
        $("scheduleEditSuggestionBox").classList.add("is-hidden");
        $("scheduleEditError").textContent = "Το προτεινόμενο μηχανάκι επιλέχθηκε. Πάτησε Αποθήκευση αλλαγών.";
        return;
      }
      const templateEdit = event.target.closest("[data-template-edit]");
      if (templateEdit) return void editTemplate(templateEdit.dataset.templateEdit);
      const addPayRate = event.target.closest("[data-add-pay-rate]");
      if (addPayRate) {
        const rows = $("payRateRows");
        if (!rows) return;
        if (rows.querySelectorAll("[data-pay-rate-row]").length >= 30) return void ($("simpleError").textContent = "Μπορείς να έχεις έως 30 ωριαίες ζώνες ανά κανόνα.");
        rows.insertAdjacentHTML("beforeend", payRateRow(null));
        $("simpleError").textContent = "";
        return;
      }
      const removePayRate = event.target.closest("[data-remove-pay-rate]");
      if (removePayRate) {
        const row = removePayRate.closest("[data-pay-rate-row]");
        if (row) row.remove();
        return;
      }
      const removeSegment = event.target.closest("[data-remove-template-segment]");
      if (removeSegment) {
        const rows = Array.from(document.querySelectorAll(".template-segment-row"));
        if (rows.length > 1) rows[Number(removeSegment.dataset.removeTemplateSegment)].remove();
        document.querySelectorAll('[data-remove-template-segment]').forEach(function (button) { button.disabled = document.querySelectorAll('.template-segment-row').length === 1; });
        return;
      }
      const openShiftAlert = event.target.closest("[data-open-shift-alert]");
      if (openShiftAlert) {
        state.viewLoadedAt.shifts = 0;
        return void goTo("shifts");
      }
      const alert = event.target.closest("[data-resolve-alert]");
      if (alert) return void resolveAlert(alert.dataset.resolveAlert);
      const recycleRestore = event.target.closest("[data-recycle-restore]");
      if (recycleRestore) return void restoreRecycleRecord(recycleRestore.dataset.recycleRestore);
      const invoiceSummary = event.target.closest("[data-invoice-summary-filter]");
      if (invoiceSummary) {
        $("invoiceStatusFilter").value = invoiceSummary.dataset.invoiceSummaryFilter || "";
        if ($("invoicePlateFilter")) $("invoicePlateFilter").value = "";
        return void renderInvoiceQueue();
      }
      const invoiceReview = event.target.closest("[data-invoice-review]");
      if (invoiceReview) return void openAdminInvoiceReview(invoiceReview.dataset.invoiceReview);
      const invoiceRetry = event.target.closest("[data-invoice-retry]");
      if (invoiceRetry) return void retryInvoiceDocument(invoiceRetry.dataset.invoiceRetryRecord || invoiceRetry.dataset.invoiceRetry);
      const invoiceForceAi = event.target.closest("[data-invoice-force-ai]");
      if (invoiceForceAi) return void forceInvoiceAiDocument(invoiceForceAi.dataset.invoiceForceAi);
      const invoiceDelete = event.target.closest("[data-invoice-delete]");
      if (invoiceDelete) return void deleteInvoiceDocument(invoiceDelete.dataset.invoiceDelete);
      const invoiceGroup = event.target.closest("[data-invoice-group-toggle]");
      if (invoiceGroup) return void toggleInvoiceGroup(invoiceGroup);
      const invoiceView = event.target.closest("[data-invoice-view]");
      if (invoiceView) return void setInvoiceView(invoiceView.dataset.invoiceView);
      const invoiceMode = event.target.closest("[data-invoice-reprocess-mode]");
      if (invoiceMode) return void reprocessAllInvoiceDocuments(invoiceMode.dataset.invoiceReprocessMode);
      const invoiceOpen = event.target.closest("[data-invoice-open]");
      if (invoiceOpen) return void openInvoiceDocument(invoiceDocumentById(invoiceOpen.dataset.invoiceOpen), false);
      const invoiceDownload = event.target.closest("[data-invoice-download]");
      if (invoiceDownload) return void openInvoiceDocument(invoiceDocumentById(invoiceDownload.dataset.invoiceDownload), true);
      const invoiceCard = event.target.closest("[data-invoice-card]");
      if (invoiceCard && !event.target.closest("button")) return void openAdminInvoiceReview(invoiceCard.dataset.invoiceCard);
      const correction = event.target.closest("[data-handle-correction]");
      if (correction) return void handleCorrection(correction.dataset.handleCorrection);
      const vehicleStatus = event.target.closest("[data-vehicle-status]");
      if (vehicleStatus) return void changeVehicleStatus(vehicleStatus.dataset.vehicleStatus);
      const password = event.target.closest("[data-toggle-password]");
      if (password) { const input = $(password.dataset.togglePassword); input.type = input.type === "password" ? "text" : "password"; }
    });
    $("reportTypes").addEventListener("click", function (event) {
      const button = event.target.closest("[data-report]");
      if (!button) return;
      state.selectedReport = button.dataset.report;
      $("reportTypes").querySelectorAll("button").forEach(function (item) { item.classList.toggle("active", item === button); });
      prepareReports().catch(function (error) { toast(error.message); });
    });
    document.addEventListener("change", function (event) {
      if (event.target.id !== "rulePicker") return;
      const selected = (state.payRules || []).find(function (item) { return item.id === event.target.value; }) || null;
      $("simpleFields").innerHTML = payRuleForm(selected, state.payRules || []);
      $("ruleScope").value = selected ? selected.scopeType : "general";
    });
    window.addEventListener("online", function () { if (state.user) goTo(state.view); });
  }

  if (window.__FLEET_PDF_TEST_ONLY__) {
    window.__FLEET_PDF_TEST_API__ = {
      renderSvg: function (data) {
        const previous = state.weekData;
        state.weekData = data;
        const result = schedulePdfSvg();
        state.weekData = previous;
        return result;
      },
      imagePdf: imagePdf
    };
    return;
  }

  bindEvents();
  initialize();
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    if ($("installGuideDialog") && $("installGuideDialog").open) $("installGuideDialog").close();
    toast("Το Fleet Control εγκαταστάθηκε ως Web App.");
  });
  setInterval(function () {
    if (state.user && state.user.role !== "employee" && !document.hidden) loadStatus(state.view === "server");
  }, 30000);
  setInterval(function () {
    if (!state.user || state.view !== "invoices" || document.hidden || !hasLiveInvoiceJobs()) return;
    renderInvoiceQueue();
  }, 1000);
  setInterval(refreshInvoiceReprocessBatch, 1000);
  setInterval(refreshInvoiceProgressLive, 2500);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("./service-worker.js").catch(function () {});
})();
