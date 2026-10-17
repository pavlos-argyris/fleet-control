import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "cloudflare-worker", "public");
const previewRoot = path.join(projectRoot, "verification", "ui");

const releaseConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "release-config.json"), "utf8"));
const now = new Date().toISOString();
const user = {
  id: "ui-owner",
  fullName: "Δοκιμαστικός Owner",
  username: "ui-owner",
  role: "owner",
  permissions: ["*"]
};
const employeeUser = {
  id: "ui-employee",
  fullName: "Δοκιμαστικός Υπάλληλος",
  username: "ui-employee",
  role: "employee",
  permissions: ["clock_in_out", "select_vehicle", "view_own_history", "request_correction"],
  showSchedule: true,
  canChangeVehicle: false
};
const bikes = [
  { id: "bike-ok", name: "ΜΗΧ-01", intervalKm: 3000, lastServiceKm: 10000, currentKm: 11650, nextServiceKm: 13000, lastCheckedAt: "2026-09-08", createdAt: now, updatedAt: now, history: [] },
  { id: "bike-soon", name: "ΜΗΧ-07", intervalKm: 2500, lastServiceKm: 15000, currentKm: 17220, nextServiceKm: 17500, lastCheckedAt: "2026-09-08", createdAt: now, updatedAt: now, history: [{ id: "service-1", type: "service", km: 15000, date: "2026-08-12", tasks: ["Αλλαγή λαδιών", "Γενικός έλεγχος"], notes: "Αλλαγή λαδιών\nΓενικός έλεγχος", workshop: "Δοκιμαστικό συνεργείο", cost: "9", attachments: [
    { id: "invoice-one", key: "service-documents/bike-soon/service-1/one.pdf", name: "invoice-one.pdf", ocr: { totalAmount: "9,00", invoiceDate: "2026-08-13", workPerformed: "Αλλαγή λαδιών\nΌροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς" } },
    { id: "invoice-two", key: "service-documents/bike-soon/service-1/two.pdf", name: "invoice-two.pdf", ocr: { totalAmount: "50,00", invoiceDate: "2026-08-14", workPerformed: "Γενικός έλεγχος" } }
  ], oilChanged: true, createdAt: now, updatedAt: now }] },
  { id: "bike-urgent", name: "ΜΗΧ-12", intervalKm: 3000, lastServiceKm: 20000, currentKm: 22920, nextServiceKm: 23000, lastCheckedAt: "2026-09-07", createdAt: now, updatedAt: now, history: [] },
  { id: "bike-overdue", name: "ΜΗΧ-18", intervalKm: 2000, lastServiceKm: 30000, currentKm: 32240, nextServiceKm: 32000, lastCheckedAt: "2026-09-06", createdAt: now, updatedAt: now, history: [] }
];

const indexSource = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(publicRoot, "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(publicRoot, "styles.css"), "utf8");
const portalSource = fs.readFileSync(path.join(publicRoot, "portal.html"), "utf8");
const portalScriptSource = fs.readFileSync(path.join(publicRoot, "portal.js"), "utf8");
const portalStylesSource = fs.readFileSync(path.join(publicRoot, "portal.css"), "utf8");
const serviceWorkerSource = fs.readFileSync(path.join(publicRoot, "service-worker.js"), "utf8");
const workforceSource = fs.readFileSync(path.join(projectRoot, "cloudflare-worker", "src", "workforce.js"), "utf8");
const workerSource = fs.readFileSync(path.join(projectRoot, "cloudflare-worker", "src", "worker.js"), "utf8");
const androidManifestSource = fs.readFileSync(path.join(projectRoot, "client-android", "AndroidManifest.xml"), "utf8");
const androidAlertJobSource = fs.readFileSync(path.join(projectRoot, "client-android", "src", "gr", "argyrismitsos", "fleetcontrol", "AlertJobService.java"), "utf8");
const clientActivitySource = fs.readFileSync(path.join(projectRoot, "client-android", "src", "gr", "argyrismitsos", "fleetcontrol", "MainActivity.java"), "utf8");
const serverActivitySource = fs.readFileSync(path.join(projectRoot, "server-android", "src", "gr", "argyrismitsos", "fleetserver", "MainActivity.java"), "utf8");
const serverSyncSource = fs.readFileSync(path.join(projectRoot, "server-android", "src", "gr", "argyrismitsos", "fleetserver", "SyncService.java"), "utf8");
const serverIndexSource = fs.readFileSync(path.join(projectRoot, "server-android", "assets", "www", "index.html"), "utf8");
const serverAppSource = fs.readFileSync(path.join(projectRoot, "server-android", "assets", "www", "app.js"), "utf8");
const serverStylesSource = fs.readFileSync(path.join(projectRoot, "server-android", "assets", "www", "styles.css"), "utf8");
const localInvoiceReaderSource = fs.readFileSync(path.join(projectRoot, "server-android", "src", "gr", "argyrismitsos", "fleetserver", "LocalInvoiceReader.java"), "utf8");
const documentRendererSource = fs.readFileSync(path.join(projectRoot, "server-android", "src", "gr", "argyrismitsos", "fleetserver", "ServiceDocumentRenderer.java"), "utf8");
assert.equal((indexSource.match(/data-overview-filter=/g) || []).length, 4, "Πρέπει να υπάρχουν τέσσερα διαδραστικά πλαίσια σύνοψης.");
assert.ok(indexSource.includes('id="overviewDialog"') && appSource.includes("openOverviewDialog"), "Λείπει η αναλυτική προβολή των στατιστικών.");
assert.ok(stylesSource.includes(".picker-dialog") && stylesSource.includes("margin: max(.75rem, env(safe-area-inset-top)) auto auto"), "Ο επιλογέας δεν έχει τοποθετηθεί ψηλά.");
assert.ok(portalSource.indexOf('id="fleetModuleShell"') < portalSource.indexOf("fleet-availability-bottom"), "Η διαθεσιμότητα πρέπει να βρίσκεται μετά το Fleet module.");
assert.ok(appSource.includes("fleet-control:embedded-view") && portalScriptSource.includes("fleet-control:embedded-view"), "Λείπει η επικοινωνία πλήρους οθόνης.");
assert.ok(portalStylesSource.includes(".portal.fleet-detail-mode .app-header") && portalStylesSource.includes("height: 100dvh"), "Λείπουν οι κανόνες πλήρους οθόνης.");
assert.ok(portalScriptSource.includes("fleet-focus-mode") && portalStylesSource.includes(".portal.fleet-focus-mode .fleet-module-shell"), "Λείπει η seamless προβολή Fleet χωρίς εξωτερικό περίγραμμα.");
assert.ok(!portalStylesSource.includes(".portal.fleet-focus-mode .sidebar,\n.portal.fleet-focus-mode .app-header"), "Το Fleet view δεν πρέπει να απομονώνει την πλαϊνή πλοήγηση και την επάνω μπάρα.");
assert.ok(portalStylesSource.includes(".portal.fleet-focus-mode .fleet-module-shell") && portalStylesSource.includes("border: 0; border-radius: 0"), "Λείπει η αφαίρεση του περιττού εξωτερικού πλαισίου Fleet.");
assert.ok(stylesSource.includes("--ink: #172033") && stylesSource.includes("--teal-dark: #07917f") && stylesSource.includes("--blue: #5576f6"), "Η αρχική παλέτα του Fleet Control δεν έχει επανέλθει.");
assert.ok(portalStylesSource.includes("--ink: #172033") && portalStylesSource.includes("--teal-dark: #07917f") && portalStylesSource.includes("--blue: #5576f6"), "Η αρχική παλέτα δεν εφαρμόζεται στο Operations Suite.");
assert.ok(indexSource.includes('id="archivedBikesSection"') && appSource.includes("restoreBike") && appSource.includes("/archive"), "Λείπει η ανάκτηση αρχειοθετημένων μηχανών.");
assert.ok(portalSource.includes('id="notificationButton" class="icon-button notification-button is-hidden"') && portalScriptSource.includes("applyRoleChrome"), "Οι ειδοποιήσεις πρέπει να ξεκινούν κρυφές και να εμφανίζονται μόνο σε επιτρεπόμενο ρόλο.");
assert.ok(portalScriptSource.includes("employeeAllowedPermissions") && portalScriptSource.includes("permissionsForRole"), "Το UI δικαιωμάτων Employee δεν έχει περιοριστεί στις προσωπικές λειτουργίες.");
assert.ok(portalSource.includes('id="dashboardDetailDialog"') && portalScriptSource.includes('data-dashboard-detail="') && portalStylesSource.includes(".metric-card-action"), "Οι κάρτες του Admin Dashboard πρέπει να είναι διαδραστικές.");
assert.ok(indexSource.includes('id="serviceMajorService"') && indexSource.includes('id="detailMajorService"'), "Λείπει η καταχώρηση και η προβολή μεγάλου service.");
assert.ok(appSource.includes("MAJOR_SERVICE_INTERVAL_KM = 10000") && appSource.includes("hasMajorService") && appSource.includes("actualKm + MAJOR_SERVICE_INTERVAL_KM"), "Λείπει ο ανεξάρτητος υπολογισμός μεγάλου service.");
assert.ok(indexSource.includes('id="quickCheckView"') && indexSource.includes('id="openQuickCheckButton"') && appSource.includes("openQuickCheck"), "Ο έλεγχος χιλιομέτρων πρέπει να ανοίγει σε πλήρη οθόνη.");
assert.ok(stylesSource.includes(".quick-check-full-panel") && stylesSource.includes("min-height: 100dvh"), "Λείπει η διάταξη πλήρους οθόνης για τον έλεγχο χιλιομέτρων.");
assert.ok(portalSource.includes('id="coverageTimeline"') && portalScriptSource.includes("loadCoverage"), "Λείπει ο πίνακας κάλυψης προσωπικού.");
assert.ok(portalSource.includes('id="viewRecycle"') && portalScriptSource.includes("restoreRecycleRecord"), "Λείπει ο κάδος ανάκτησης.");
assert.ok(portalSource.includes('id="mobileNotificationsButton"') && portalScriptSource.includes("enableMobileNotifications"), "Λείπει η ενεργοποίηση ειδοποιήσεων κινητού.");
assert.ok(portalSource.includes('id="serverWarnings"') && portalScriptSource.includes("/api/admin/server-health"), "Λείπει η παρακολούθηση υγείας του Server APK.");
assert.ok(portalSource.indexOf('id="loginButton"') < portalSource.indexOf('id="loginAndroidDownload"'), "Οι λήψεις πρέπει να εμφανίζονται κάτω από τη σύνδεση.");
assert.ok(portalSource.includes('apple-mobile-web-app-capable') && portalSource.includes('rel="apple-touch-icon"'), "Λείπουν τα στοιχεία εγκατάστασης iPhone Web App.");
assert.ok(portalSource.includes('id="iosShareButton"') && portalScriptSource.includes("openIosShareMenu"), "Λείπει η συντόμευση προς το μενού εγκατάστασης iPhone.");
assert.ok(portalScriptSource.includes("confirmedExpiry") && portalScriptSource.includes("Η συνεδρία σου διατηρήθηκε"), "Ένα προσωρινό πρόβλημα δικτύου δεν πρέπει να διαγράφει τη συνεδρία.");
assert.ok(portalScriptSource.includes("employee-identity") && portalStylesSource.includes(".employee-card-actions { position: static"), "Οι κάρτες διαχείρισης εργαζομένων πρέπει να έχουν ανεξάρτητες περιοχές ονόματος και ενεργειών.");
assert.ok(portalStylesSource.includes("@media (max-width: 480px)") && portalStylesSource.includes(".clock-preview-row"), "Λείπει η ασφαλής mobile διάταξη της προεπισκόπησης Clock In.");
assert.ok(portalSource.includes("portal.css?v=" + releaseConfig.web.version) && portalSource.includes("portal.js?v=" + releaseConfig.web.version), "Η τρέχουσα έκδοση πρέπει να παρακάμπτει την παλιά web cache.");
assert.ok(workforceSource.includes("function resolveEmployeeAssignedVehicleId") && workforceSource.includes("body?.assignedVehicleId !== undefined ? body.assignedVehicleId : existing?.assigned_vehicle_id"), "Η ρητή αφαίρεση μόνιμης μηχανής πρέπει να αποθηκεύεται ως κενή ανάθεση.");
assert.ok(workforceSource.includes("function effectiveScheduleVehicleId") && workforceSource.includes("const vehicleId = effectiveScheduleVehicleId(raw, employee)"), "Το πρόγραμμα πρέπει να εφαρμόζει τη μόνιμη ανάθεση μηχανής πριν τον έλεγχο σύγκρουσης.");
assert.ok(workforceSource.includes("uses_own_vehicle") && workforceSource.includes("ownVehicleShiftId") && workforceSource.includes("initial_km, out_of_schedule"), "Ο Worker πρέπει να υποστηρίζει εργαζόμενο με ιδιόκτητο μηχανάκι χωρίς registry μηχανής.");
assert.ok(portalSource.includes('id="usesOwnVehicle"') && portalScriptSource.includes("usesOwnVehicle") && portalScriptSource.includes("Χωρίς χιλιόμετρα"), "Το Portal πρέπει να έχει επιλογή ιδιόκτητου μηχανιού χωρίς χιλιόμετρα.");
assert.ok(workforceSource.includes("conflict: { kind: \"vehicle\""), "Η σύγκρουση ίδιας μηχανής πρέπει να επιστρέφει στοιχεία για προειδοποίηση.");
assert.ok(portalScriptSource.includes("error.validationErrors") && portalScriptSource.includes("validationIssue.message"), "Το UI πρέπει να εμφανίζει το συγκεκριμένο σφάλμα σύγκρουσης.");
assert.ok(portalScriptSource.includes('message.view === "quick-check"'), "Το Portal πρέπει να κρύβει το chrome στην πλήρη οθόνη ελέγχου.");
assert.ok(portalScriptSource.includes("scheduleFleetPreload") && portalScriptSource.includes("renderEmployeeActiveShift"), "Το Portal πρέπει να προφορτώνει το Fleet και να εμφανίζει άμεσα το αποτέλεσμα του Clock In.");
assert.ok(portalScriptSource.includes('button.textContent = "Καταχώρηση…"') && portalScriptSource.includes('button.setAttribute("aria-busy", "true")'), "Η ροή εργαζομένου πρέπει να προστατεύεται από διπλό πάτημα.");
assert.ok(portalScriptSource.includes("apiTimings") && portalScriptSource.includes("Server-Timing"), "Το Portal πρέπει να κρατά προσωρινές μετρήσεις απόκρισης.");
assert.ok(portalScriptSource.includes("upcomingSlots") && portalScriptSource.includes('bucket.status === "planned"') && portalStylesSource.includes(".coverage-row.planned"), "Η κάλυψη δεν πρέπει να εμφανίζει τα μελλοντικά μισάωρα ως κενά.");
assert.ok(portalScriptSource.includes("lateGraceMinutes") && portalScriptSource.includes("data-pay-rate-row") && portalScriptSource.includes("overtimeRateOverride"), "Το Portal πρέπει να έχει ρυθμιζόμενη ανοχή, ωριαίες ζώνες και τιμή υπερωρίας.");
assert.ok(workforceSource.includes("overtime_approved_by_name") && workforceSource.includes("specialRates") && workforceSource.includes("overtimeRateCents"), "Ο Worker πρέπει να αποθηκεύει έγκριση υπερωρίας, ζώνες και προσαρμοσμένη τιμή.");
assert.ok(workforceSource.includes('hasPermission(actor.permissions, "payroll.manage")') && portalScriptSource.includes('can("payroll.manage")'), "Ο Payroll Manager πρέπει να μπορεί να εγκρίνει υπερωρία χωρίς πρόσβαση σε όλες τις ενέργειες βάρδιας.");
assert.ok(portalScriptSource.includes('"missed-clock-ins"') && portalScriptSource.includes("activeClockInPreview") && portalScriptSource.includes("missedClockInPreview"), "Το Dashboard πρέπει να εμφανίζει χωριστά ενεργά και καθυστερημένα Clock In.");
assert.ok(workforceSource.includes("loadScheduleConflictRows") && workforceSource.includes("const existingRows = await loadScheduleConflictRows"), "Το πρόγραμμα πρέπει να προφορτώνει τα σχετικά rows πριν ελέγξει συγκρούσεις.");
assert.ok(/RUNTIME_SCHEMA_VERSION = "[0-9]+\.[0-9]+\.[0-9]+"/.test(workerSource) && workerSource.includes("withServerTiming") && workerSource.includes("STATUS_RESPONSE_CACHE_MS") && workerSource.includes("/api/admin/service-documents/reprocess") && workerSource.includes("/api/admin/service-documents/reprocess-batch") && workerSource.includes("/api/server/service-documents/reprocess-batch") && workerSource.includes("/api/service-documents"), "Ο Worker πρέπει να έχει versioned index, κοινή server batch πρόοδο τιμολογίων, διαγραφή/επανεπεξεργασία, status cache και Server-Timing.");
assert.ok(appSource.includes("function qrTimestampMs") && appSource.includes("Χρόνος: >10:00") && portalScriptSource.includes("function invoiceElapsedLabel") && portalScriptSource.includes("lastAttemptAt || data.qrProcessingStartedAt"), "Ο χρόνος τιμολογίου πρέπει να ξεκινά από την τελευταία προσπάθεια και να μην εμφανίζει τεράστιους αριθμούς.");
assert.ok(workerSource.includes("payload.requestedAt = now") && workerSource.includes("payload.retryRequestedAt = now"), "Η επανάληψη τιμολογίου πρέπει να μη χρησιμοποιεί την αρχική ημερομηνία ως χρόνο έναρξης.");
assert.ok(workforceSource.includes("missedClockIns: missedRows") && workforceSource.includes("missedEmployees.size"), "Το Dashboard API πρέπει να επιστρέφει τις πραγματικές καθυστερήσεις Clock In.");
assert.ok(indexSource.indexOf('class="fleet-overview"') < indexSource.indexOf('id="fleetAlert"'), "Η προειδοποίηση service πρέπει να εμφανίζεται κάτω από τα κουτάκια Fleet.");
assert.ok(!indexSource.includes('class="sync-dot"') && !appSource.includes("intro.appendChild(actions)"), "Το ενσωματωμένο Fleet δεν πρέπει να εμφανίζει πράσινη τελεία ή κλειδαριά.");
assert.ok(!portalScriptSource.includes('>Καρτέλα</button>'), "Η ασαφής ενέργεια Καρτέλα πρέπει να έχει αντικατασταθεί από Προβολή.");
assert.ok(androidManifestSource.includes('android:versionCode="' + releaseConfig.client.versionCode + '"') && androidManifestSource.includes('android:versionName="' + releaseConfig.client.version + '"') && androidManifestSource.includes('android.permission.ACCESS_NETWORK_STATE') && androidManifestSource.includes('android:allowBackup="false"'), "Το Android hotfix πρέπει να περιλαμβάνει την άδεια δικτύου, την τρέχουσα έκδοση και απενεργοποιημένο Android backup.");
assert.ok(androidManifestSource.includes('android.permission.CAMERA') && clientActivitySource.includes("onPermissionRequest") && clientActivitySource.includes("RESOURCE_VIDEO_CAPTURE"), "Το Android Client πρέπει να μπορεί να δώσει άδεια κάμερας στο QR scanner.");
assert.ok(androidAlertJobSource.includes("setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)") && androidAlertJobSource.includes("catch (RuntimeException ignored)"), "Ο JobScheduler των ειδοποιήσεων πρέπει να μην τερματίζει την εφαρμογή.");
assert.ok(clientActivitySource.includes("periodicUpdateCheck") && clientActivitySource.includes("postDelayed(periodicUpdateCheck, UPDATE_CHECK_INTERVAL_MS)"), "Το Client πρέπει να ελέγχει περιοδικά για ενημερώσεις όσο είναι ανοιχτό.");
assert.ok(clientActivitySource.includes("localWebViewClient()") && clientActivitySource.includes("isLocalAppUrl"), "Το Client WebView πρέπει να κρατά το native bridge σε τοπικές σελίδες.");
assert.ok(serverActivitySource.includes("localWebViewClient()") && serverActivitySource.includes("isLocalAppUrl"), "Το Server WebView πρέπει να κρατά το native bridge σε τοπικές σελίδες.");
assert.ok(serverSyncSource.includes("LocalInvoiceReader.readBest") && serverSyncSource.includes("X-Fleet-Local-Ocr") && serverSyncSource.includes("processInvoiceReprocessBatch"), "Ο Server πρέπει να διαβάζει πρώτα τοπικά και να υποστηρίζει batch επανεπεξεργασία.");
assert.ok(serverSyncSource.includes("localReadStatus") && serverSyncSource.includes("ocrFallbackReason"), "Ο Server πρέπει να στέλνει και αποτυχία local OCR για αυτόματο fallback.");
assert.ok(serverSyncSource.includes("refreshInvoiceReprocessStatus") && serverSyncSource.includes("invoice_reprocess_state") && serverSyncSource.includes("markInvoiceReprocessError"), "Ο Server πρέπει να συγχρονίζει και να αποθηκεύει real-time κατάσταση batch τιμολογίων.");
assert.ok(serverSyncSource.includes("batchStep < 5000") && serverSyncSource.includes("previousCursor"), "Η μαζική ανάγνωση πρέπει να συνεχίζει διαδοχικά στον ίδιο κύκλο συγχρονισμού.");
assert.ok(serverSyncSource.includes("invoice_parallelism") && serverSyncSource.includes("newFixedThreadPool") && serverSyncSource.includes("saveInvoiceReprocessParallelState"), "Ο Server πρέπει να υποστηρίζει ελεγχόμενη παράλληλη τοπική ανάγνωση τιμολογίων.");
assert.ok(serverActivitySource.includes("invoiceParallelism") && serverIndexSource.includes('id="invoiceParallelism"') && serverAppSource.includes("invoiceParallelism"), "Η παράλληλη επεξεργασία πρέπει να ρυθμίζεται από την οθόνη ρυθμίσεων του Server.");
assert.ok(workerSource.includes('searchParams.get("window")') && workerSource.includes("windowItems"), "Ο Worker πρέπει να δίνει ασφαλές παράθυρο τιμολογίων στον Server.");
assert.ok(serverActivitySource.includes("invoiceReprocess") && serverIndexSource.includes('id="invoiceProcessingCard"') && serverAppSource.includes("renderInvoiceProcessing") && serverStylesSource.includes("invoice-processing-bar"), "Η οθόνη Server πρέπει να εμφανίζει ζωντανό ποσοστό και στάδιο επεξεργασίας τιμολογίων.");
assert.ok(localInvoiceReaderSource.includes("ToUnicode") && localInvoiceReaderSource.includes("findWorkAccurate") && localInvoiceReaderSource.includes("startsDescriptionItem") && localInvoiceReaderSource.includes("removeLeadingInvoiceCodes") && localInvoiceReaderSource.includes("normalizePlate"), "Ο τοπικός αναγνώστης πρέπει να υποστηρίζει Unicode PDF text, περιγραφές χωρίς κωδικό, καθαρές γραμμές εργασιών και πινακίδες.");
assert.ok(documentRendererSource.includes("renderToPdfWithText") && documentRendererSource.includes("capturePageTextAndPrint") && documentRendererSource.includes("document.body&&document.body.innerText"), "Ο Server πρέπει να παίρνει και το ζωντανό κείμενο της δυναμικής σελίδας πριν το PDF.");
assert.ok(clientActivitySource.includes('android_asset/www/') || serverActivitySource.includes('android_asset/www/'), "Το Android WebView πρέπει να φορτώνει τοπικά assets.");
assert.ok(indexSource.includes('vendor/jsQR.js') && indexSource.includes('vendor/qrcode-generator.js') && appSource.includes("readQrFromFile") && appSource.includes("reportQrSvg"), "Λείπει η ανάγνωση ή η αναδημιουργία QR.");
assert.ok(indexSource.includes('id="qrScannerDialog"') && indexSource.includes('id="serviceQrScanButton"') && appSource.includes("getUserMedia") && appSource.includes("attachInvoiceToEntry"), "Λείπει η παράλληλη ζωντανή σάρωση QR με χειροκίνητη εναλλακτική.");
assert.ok(workerSource.includes("resolve-qr") && workerSource.includes("import-qr") && workerSource.includes("qrValue") && workerSource.includes("invoiceData"), "Ο Worker πρέπει να αποθηκεύει QR και επιβεβαιωμένα στοιχεία τιμολογίου.");
assert.ok(portalSource.includes('id="viewInvoices"') && portalSource.includes('id="invoiceReviewDialog"') && portalScriptSource.includes("loadInvoices") && portalScriptSource.includes("/api/admin/service-documents"), "Λείπει η καρτέλα ελέγχου και διόρθωσης τιμολογίων.");
assert.ok(workerSource.includes("serviceDocumentWarnings") && workerSource.includes("buildInvoiceDisplayName") && workerSource.includes("mergeInvoiceTasks") && workerSource.includes("reviewAdminServiceDocument"), "Λείπουν οι έλεγχοι και η επιβεβαίωση δεδομένων τιμολογίου στον Worker.");
assert.ok(portalScriptSource.includes("Το QR στάλθηκε στον Server") || appSource.includes("Ο Server συνεχίζει στο παρασκήνιο") || appSource.includes("Ο Server δημιουργεί το PDF στο παρασκήνιο"), "Η ροή QR πρέπει να συνεχίζει στο παρασκήνιο.");
assert.ok(appSource.includes("reportHeaderMarkup") && stylesSource.includes(".history-report-header") && stylesSource.includes("@page { size: A4 landscape"), "Η εκτύπωση ιστορικού πρέπει να έχει επαγγελματική διάταξη.");
assert.ok(workerSource.includes('type: "image_url"') && workerSource.includes("attachServiceDocumentMetadata"), "Η εικόνα πρέπει να στέλνεται σωστά στο Workers AI και να συνδέεται με το service.");
assert.ok(appSource.includes("downloadServiceDocument") && appSource.includes("Αναλυτικά αποτελέσματα OCR"), "Λείπουν η λήψη τιμολογίου και η πλήρης προβολή OCR.");
assert.ok(appSource.includes("ensureAttachmentQr") && workerSource.includes("service-document-qr") && workerSource.includes("mergeServiceQrMetadata"), "Το QR πρέπει να αποθηκεύεται πριν ολοκληρωθεί το server-side PDF.");
assert.ok(clientActivitySource.includes("openPdf") && clientActivitySource.includes("printCurrentPage") && androidManifestSource.includes("FleetPdfProvider"), "Το Android Client πρέπει να ανοίγει και να εκτυπώνει PDF μέσω native provider.");
assert.ok(appSource.includes("AndroidFleet.openPdf") && appSource.includes("AndroidFleet.savePdf"), "Τα κουμπιά PDF πρέπει να χρησιμοποιούν το native Android bridge.");
assert.ok(appSource.includes("return remainingA - remainingB") && appSource.includes("MILEAGE_CHECK_STALE_DAYS = 7"), "Ο στόλος πρέπει να ταξινομείται με βάση τα χιλιόμετρα και να ελέγχει παλιές μετρήσεις.");
assert.ok(workforceSource.includes("mileage_check_stale") && workforceSource.includes("alerts-v4"), "Ο Worker πρέπει να δημιουργεί και να επαναφέρει ειδοποιήσεις παλιού ελέγχου χιλιομέτρων.");
assert.ok(indexSource.includes('class="fleet-alert alert-button') && appSource.includes("openMileageCheckOverview") && appSource.includes("elements.fleetAlert.addEventListener") && appSource.includes("data-mileage-check=\"stale\"") && stylesSource.includes(".mileage-check-badge"), "Οι ειδοποιήσεις service/χιλιομέτρων πρέπει να είναι διαδραστικές και οι καθυστερημένοι έλεγχοι να έχουν εικονίδιο στη λίστα.");
assert.ok(portalSource.includes('id="resolveAllAlerts"') && portalScriptSource.includes("resolveAllAlerts") && portalScriptSource.includes("alertsRequiringAction") && portalScriptSource.includes('"/api/admin/alerts/"'), "Οι ειδοποιήσεις πρέπει να έχουν ασφαλή μαζική ολοκλήρωση, αφήνοντας ανοικτές όσες απαιτούν έγκριση ή έλεγχο.");
assert.ok(serviceWorkerSource.includes('CACHE_NAME = "fleet-control-v' + releaseConfig.web.version.replaceAll(".", "-") + '"'), "Το Service Worker πρέπει να αλλάξει cache για να φορτώσει την τρέχουσα διόρθωση.");
assert.ok(appSource.includes("qr-progress-ring") && appSource.includes("retryQrDocumentJob") && appSource.includes("invoiceLineText"), "Το Client πρέπει να δείχνει ομαλή πρόοδο QR, επανάληψη και ασφαλή ανάγνωση γραμμών OCR.");
assert.ok(appSource.includes("refreshVisibleQrProgress") && appSource.includes("setInterval(refreshVisibleQrProgress, 5000)"), "Το Client πρέπει να ενημερώνει ζωντανά την πρόοδο QR χωρίς refresh.");
assert.ok(portalScriptSource.includes("invoiceProgressMarkup") && portalScriptSource.includes("markInvoiceSeen") && portalScriptSource.includes("retryInvoiceDocument") && portalSource.includes('value="new"'), "Το Admin Panel πρέπει να έχει ένδειξη νέου τιμολογίου, πρόοδο και επανάληψη.");
assert.ok(portalScriptSource.includes("refreshInvoiceProgressLive") && portalScriptSource.includes("setInterval(refreshInvoiceProgressLive, 2500") && portalScriptSource.includes("drawWigglyProgressRing") && portalScriptSource.includes("refreshWigglyProgressRings") && appSource.includes("drawWigglyProgressRing") && portalStylesSource.includes(".invoice-progress-ring canvas"), "Το Admin Panel και το Client πρέπει να ενημερώνουν ζωντανά και να εμφανίζουν Canvas wiggly πρόοδο για κάθε μεμονωμένο QR χωρίς refresh.");
assert.ok(portalScriptSource.includes("Number.isFinite(directProgress)") && appSource.includes("Number.isFinite(rawProgress)") && workerSource.includes("cleanInteger(safePayload.progress, 5, 95, 5)"), "Η πρόοδος QR πρέπει να προστατεύεται από μη έγκυρες τιμές όπως NaN.");
assert.ok(portalScriptSource.includes("refreshInvoiceReprocessBatch") && portalScriptSource.includes("publishInvoiceReprocessBatch") && portalScriptSource.includes("data-wiggly-progress") && portalSource.includes('data-wiggly-progress'), "Η κοινή batch πρόοδος πρέπει να συγχρονίζεται από τον Worker και ο κύκλος να έχει κινούμενη Canvas φωτεινή διαδρομή.");
assert.ok(portalScriptSource.includes("function invoiceTimestampMs") && portalScriptSource.includes("Number.isFinite(calculatedPercentage)"), "Η κοινή πρόοδος πρέπει να χειρίζεται ISO timestamps και να μην εμφανίζει NaN.");
assert.ok(portalSource.includes('id="invoiceBulkProgress"') && portalScriptSource.includes("renderInvoiceBulkProgress") && portalScriptSource.includes("invoiceReprocessActiveIds") && portalStylesSource.includes(".invoice-bulk-progress-ring"), "Η μαζική νέα ανάγνωση πρέπει να δείχνει ζωντανό συνολικό κύκλο και να εμφανίζει τα τιμολόγια στο Σε επεξεργασία.");
assert.ok(workerSource.includes("stripInvoicePartCode") && workerSource.includes("normalizeInvoiceWorkPerformed") && workerSource.includes("ocrWarning"), "Ο Worker πρέπει να καθαρίζει αναδρομικά κωδικούς και παλιές OCR εγγραφές.");
assert.ok(workerSource.includes("serverOperationProgress") && workerSource.includes("serverOperationError") && workerSource.includes("retryServiceDocumentJob") && workerSource.includes("SERVICE_RENDER_MAX_ATTEMPTS"), "Ο Worker πρέπει να καταγράφει πρόοδο, σφάλματα και ασφαλή επανάληψη QR.");
assert.ok(workerSource.includes("forceAi") && workerSource.includes("Ζητήθηκε χειροκίνητα από τον διαχειριστή") && portalScriptSource.includes("forceInvoiceAiDocument") && portalScriptSource.includes("data-invoice-force-ai") && portalStylesSource.includes(".invoice-force-ai-button"), "Η καρτέλα Τιμολόγια πρέπει να επιτρέπει χειροκίνητη ανάγνωση συγκεκριμένου PDF από Workers AI.");
const renderHomeStart = appSource.indexOf("function renderHome()");
const attentionDeclaration = appSource.indexOf("const attention =", renderHomeStart);
const totalAttentionDeclaration = appSource.indexOf("const totalAttention =", renderHomeStart);
assert.ok(renderHomeStart >= 0 && attentionDeclaration >= 0 && attentionDeclaration < totalAttentionDeclaration, "Η renderHome πρέπει να δημιουργεί την attention πριν από τον υπολογισμό του totalAttention.");
console.log("OK Fleet UI static checks");

const chromiumExecutable = chromium.executablePath();
if (!fs.existsSync(chromiumExecutable)) {
  console.log("SKIP Fleet UI browser screenshots: δεν υπάρχει εγκατεστημένο Chromium στο περιβάλλον ελέγχου.");
  process.exit(0);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function mimeType(file) {
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" })[path.extname(file)] || "application/octet-stream";
}

let employeeStatusRequests = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const employeeRequest = request.headers.authorization === "Bearer employee-ui-token";
  if (url.pathname === "/api/auth/bootstrap-status") return sendJson(response, { configured: true });
  if (url.pathname === "/api/auth/me") return sendJson(response, employeeRequest
    ? { user: employeeUser, allPermissions: employeeUser.permissions, employeeAllowedPermissions: employeeUser.permissions, rolePermissions: { employee: employeeUser.permissions } }
    : { user, allPermissions: ["*"], rolePermissions: { owner: ["*"] } });
  if (url.pathname === "/api/employee/home") return sendJson(response, { user: employeeUser, activeShift: null, schedule: null, scheduleWeek: null, vehicles: [] });
  if (url.pathname === "/api/admin/employees") return sendJson(response, { employees: [{ ...employeeUser, active: true }] });
  if (url.pathname === "/api/sync") return sendJson(response, { bikes, version: 1, serverTime: now });
  if (url.pathname === "/api/workforce/vehicles") {
    return sendJson(response, { vehicles: bikes.map((bike, index) => ({
      id: bike.id, name: bike.name, odometer: bike.currentKm,
      status: index === 1 ? "in_use" : index === 3 ? "service" : "available",
      assigned: index === 0, available: index !== 1 && index !== 3
    })) });
  }
  if (url.pathname === "/api/workforce/dashboard") {
    return sendJson(response, { actionCount: 0, today: { employees: 4, workingNow: 1, missedClockIns: 1, vehicles: { in_use: 1, available: 2 } }, currentWeek: { payableHours: 0, payrollCents: 0, kilometers: 0, startDate: "08/09", endDate: "14/09" }, realtime: [{ id: "active-test", employee_id: "employee-active", employee_name: "Ενεργός Δοκιμής", actual_clock_in: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: "active" }], missedClockIns: [{ id: "missed-test", employee_id: "employee-missed", employee_name: "Καθυστέρησε Δοκιμής", start_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), status: "planned" }], dailySchedule: [] });
  }
  if (url.pathname === "/api/status") {
    if (employeeRequest) employeeStatusRequests += 1;
    return sendJson(response, { serverOnline: true, databaseOk: true, storageOk: true, fleetControlOk: true, bikes: bikes.length, pendingAlerts: 0 });
  }
  if (url.pathname.startsWith("/api/")) return sendJson(response, {});

  const requested = url.pathname === "/" ? "/portal.html" : url.pathname;
  const file = path.resolve(publicRoot, "." + requested);
  if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    return response.end("Not found");
  }
  response.writeHead(200, { "Content-Type": mimeType(file), "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
fs.mkdirSync(previewRoot, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
  await page.addInitScript(({ token, userData, fleet }) => {
    localStorage.setItem("fleet-control-auth-token", token);
    localStorage.setItem("fleet-control-user-cache", JSON.stringify(userData));
    localStorage.setItem("moto-service-tracker-v1", JSON.stringify(fleet));
  }, { token: "ui-test-token", userData: user, fleet: bikes });

  await page.goto(origin + "/portal.html", { waitUntil: "networkidle" });
  await page.locator('[data-dashboard-detail="employees"]').click();
  await page.locator("#dashboardDetailDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#dashboardDetailDialog .clock-preview-row").count(), 1,
    "Η κάρτα εργαζομένων πρέπει να δείχνει μόνο το ενεργό Clock In.");
  assert.equal(await page.locator("#dashboardDetailDialog [data-dashboard-employee-edit]").count(), 0,
    "Η προεπισκόπηση δεν πρέπει να περιέχει επεξεργασία.");
  assert.equal(await page.locator("#dashboardDetailOpen").isVisible(), false,
    "Η προεπισκόπηση δεν πρέπει να οδηγεί στη διαχείριση.");
  await page.locator('[data-close="dashboardDetailDialog"]').first().click();
  await page.locator('[data-dashboard-detail="missed-clock-ins"]').click();
  assert.equal(await page.locator("#dashboardDetailDialog .clock-preview-row").count(), 1,
    "Η ξεχωριστή κάρτα πρέπει να δείχνει όσους δεν έκαναν Clock In.");
  assert.equal(await page.locator("#dashboardDetailOpen").isVisible(), false,
    "Η προειδοποίηση δεν πρέπει να εμφανίζει διαχείριση.");
  await page.locator('[data-close="dashboardDetailDialog"]').first().click();
  await page.locator('#sideNav [data-go="fleet"]').click();
  const frame = page.frameLocator("#fleetModuleFrame");
  await frame.locator("#homeView").waitFor({ state: "visible" });
  assert.equal(await frame.locator("#webAccessButton").isVisible(), false,
    "Η κλειδαριά δεν πρέπει να εμφανίζεται μέσα στο ενσωματωμένο Fleet.");

  const placement = await page.evaluate(() => {
    const shell = document.getElementById("fleetModuleShell");
    const availability = document.querySelector(".fleet-availability-panel");
    return Boolean(shell && availability && shell.compareDocumentPosition(availability) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(placement, true, "Η διαθεσιμότητα πρέπει να βρίσκεται κάτω από το Fleet Control.");
  await page.screenshot({ path: path.join(previewRoot, "fleet-ui-home-v5.17.png"), fullPage: false });

  await frame.locator("#openQuickCheckButton").click();
  await frame.locator("#quickCheckView").waitFor({ state: "visible" });
  await page.locator("#portal.fleet-detail-mode").waitFor({ state: "attached" });
  const quickFullScreen = await page.evaluate(() => {
    const header = document.querySelector(".app-header");
    const availability = document.querySelector(".fleet-availability-panel");
    const frameElement = document.getElementById("fleetModuleFrame");
    const rect = frameElement.getBoundingClientRect();
    return {
      headerHidden: getComputedStyle(header).display === "none",
      availabilityHidden: getComputedStyle(availability).display === "none",
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      viewport: window.innerHeight
    };
  });
  assert.equal(quickFullScreen.headerHidden, true, "Η εξωτερική κεφαλίδα πρέπει να κρύβεται στον έλεγχο χιλιομέτρων.");
  assert.equal(quickFullScreen.availabilityHidden, true, "Η διαθεσιμότητα πρέπει να κρύβεται στον έλεγχο χιλιομέτρων.");
  assert.ok(quickFullScreen.top <= 1 && quickFullScreen.height >= quickFullScreen.viewport - 1, "Ο έλεγχος χιλιομέτρων πρέπει να καλύπτει όλη την οθόνη.");
  await page.screenshot({ path: path.join(previewRoot, "fleet-ui-mileage-full-v5.17.png"), fullPage: false });
  await frame.locator("#quickCheckBackButton").click();
  await page.waitForFunction(() => !document.getElementById("portal").classList.contains("fleet-detail-mode"));

  await frame.locator("#openQuickCheckButton").click();
  await frame.locator("#quickBikePicker").click();
  await frame.locator("#bikePickerDialog").waitFor({ state: "visible" });
  const pickerBox = await frame.locator("#bikePickerDialog").boundingBox();
  assert.ok(pickerBox && pickerBox.y < 230, "Ο επιλογέας μηχανής πρέπει να ανοίγει κοντά στο πάνω μέρος.");
  await page.screenshot({ path: path.join(previewRoot, "fleet-ui-picker-v5.17.png"), fullPage: false });
  await frame.locator('[data-close-dialog="bikePickerDialog"]').click();
  await frame.locator("#quickCheckBackButton").click();
  await page.waitForFunction(() => !document.getElementById("portal").classList.contains("fleet-detail-mode"));

  await frame.locator('[data-overview-filter="attention"]').click();
  await frame.locator("#overviewDialog").waitFor({ state: "visible" });
  assert.equal(await frame.locator("[data-overview-bike]").count(), 2, "Η κατηγορία service πρέπει να εμφανίζει δύο δοκιμαστικά μηχανάκια.");
  await page.screenshot({ path: path.join(previewRoot, "fleet-ui-summary-v5.17.png"), fullPage: false });
  await frame.locator('[data-overview-bike="bike-soon"]').click();

  await page.locator("#portal.fleet-detail-mode").waitFor({ state: "attached" });
  await frame.locator("#detailView").waitFor({ state: "visible" });
  const fullScreen = await page.evaluate(() => {
    const header = document.querySelector(".app-header");
    const availability = document.querySelector(".fleet-availability-panel");
    const frameElement = document.getElementById("fleetModuleFrame");
    const rect = frameElement.getBoundingClientRect();
    return {
      headerHidden: getComputedStyle(header).display === "none",
      availabilityHidden: getComputedStyle(availability).display === "none",
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      viewport: window.innerHeight
    };
  });
  assert.equal(fullScreen.headerHidden, true, "Η εξωτερική κεφαλίδα πρέπει να κρύβεται στην καρτέλα μηχανής.");
  assert.equal(fullScreen.availabilityHidden, true, "Η διαθεσιμότητα πρέπει να κρύβεται στην καρτέλα μηχανής.");
  assert.ok(fullScreen.top <= 1 && fullScreen.height >= fullScreen.viewport - 1, "Η καρτέλα μηχανής πρέπει να καλύπτει όλη την οθόνη.");
  await page.screenshot({ path: path.join(previewRoot, "fleet-ui-detail-v5.17.png"), fullPage: false });
  assert.match(await frame.locator("#detailHistory .history-cost").innerText(), /59,00/);
  assert.doesNotMatch(await frame.locator("#detailHistory .service-task-list").innerText(), /Πληρωμής/);
  await frame.locator("#detailExportButton").click();
  await frame.locator("#historyReportDialog").waitFor({ state: "visible" });
  const dateCell = frame.locator("#historyReportBody tbody tr td").first();
  const dateText = await dateCell.innerText();
  assert.ok(dateText.indexOf("12/08/2026") < dateText.indexOf("13/08/2026"));
  assert.match(dateText, /Τιμολόγιο: 13\/08\/2026/);
  assert.match(dateText, /Τιμολόγιο: 14\/08\/2026/);
  assert.equal(await dateCell.locator(".report-invoice-date").count(), 2);
  assert.match(await frame.locator("#historyReportBody tbody tr td").nth(4).innerText(), /59,00/);
  await page.screenshot({ path: path.join(previewRoot, "invoice-dates-and-cost.png"), fullPage: false });
  await frame.locator('[data-close-dialog="historyReportDialog"]').click();


  await frame.locator("#detailCheckButton").click();
  await frame.locator("#quickCheckView").waitFor({ state: "visible" });
  await page.locator("#portal.fleet-detail-mode").waitFor({ state: "attached" });
  await frame.locator("#quickCheckBackButton").click();
  await frame.locator("#detailView").waitFor({ state: "visible" });

  await frame.locator("#detailBackButton").click();
  await page.waitForFunction(() => !document.getElementById("portal").classList.contains("fleet-detail-mode"));

  const employeePage = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
  await employeePage.addInitScript(({ token, userData }) => {
    localStorage.setItem("fleet-control-auth-token", token);
    localStorage.setItem("fleet-control-user-cache", JSON.stringify(userData));
  }, { token: "employee-ui-token", userData: employeeUser });
  await employeePage.goto(origin + "/portal.html", { waitUntil: "networkidle" });
  await employeePage.locator("#viewEmployeeHome").waitFor({ state: "visible" });
  assert.equal(await employeePage.locator("#notificationButton").isVisible(), false, "Ο Employee δεν πρέπει να βλέπει το πλαίσιο ειδοποιήσεων.");
  assert.equal(await employeePage.locator("#serverMini").isVisible(), false, "Ο Employee δεν πρέπει να βλέπει στοιχεία Server.");
  assert.deepEqual(await employeePage.locator("#sideNav [data-go]").evaluateAll((items) => items.map((item) => item.dataset.go)), ["employee-home"],
    "Ο Employee πρέπει να βλέπει μόνο τη δική του βάρδια στην πλοήγηση.");
  assert.equal(employeeStatusRequests, 0, "Το Employee περιβάλλον δεν πρέπει να ζητά στοιχεία status/ειδοποιήσεων στο παρασκήνιο.");
  await employeePage.close();
  console.log("OK Fleet UI: Admin dashboard actions, strict Employee chrome, Fleet summaries and full bike detail.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
