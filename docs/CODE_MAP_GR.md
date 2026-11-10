# Fleet Control — χάρτης κώδικα και γρήγορη αναγνώριση αλλαγών

**Σκοπός:** να μη χρειάζεται κάθε νέος agent να αναλύει ξανά ολόκληρο το repository. Ο βασικός διαχωρισμός επιχειρησιακών ενοτήτων, των κεντρικών αρχείων, των εξαρτήσεων και των συσχετισμένων δοκιμών βρίσκεται στον αναθεωρούμενο **[CODE_MAP.json](CODE_MAP.json)**.

Ο χάρτης είναι συνειδητά ένας **οδηγός για διάβασμα και προαιρετικούς στοχευμένους ελέγχους** — όχι απόδειξη ότι γνωρίζουμε όλες τις έμμεσες εξαρτήσεις. Οι ενότητες μοιράζονται backend, UI, δεδομένα/δικαιώματα και migrations. Κάθε σοβαρή διόρθωση διαβάζει τον πραγματικό σχετικό κώδικα και τις εγγύς εξαρτήσεις του· προτού συγχωνευθεί ή δημοσιευθεί, περνά το **πλήρες υποχρεωτικό CI στο ακριβές commit**.

## Πού βρίσκεται τι

| Ενότητα | Κεντρικά σημεία | Αντιπροσωπευτικές δοκιμές |
|---|---|---|
| Server και τοπική SQLite | `server-android/src/.../fleetserver/SyncService.java`, `FleetDataStore.java`, `FleetHttp.java`, `SystemMirror.java` | `test-server-snapshot-sync.mjs`, `test-server-system-mirror.mjs` |
| Worker, D1, δικαιώματα και events | `cloudflare-worker/src/worker.js`, `workforce-core.js`, `snapshot-store.js`, `mirror-delta.js` | `test-worker-model.mjs`, `test-mirror-compound-limit.mjs` |
| Ordexa και clock in/out | `OrdexaClient.java`, `OrdexaSync.java`, `cloudflare-worker/src/ordexa*.js` | `test-ordexa-native.mjs`, `test-ordexa-browser.mjs` |
| Βάρδιες/μισθοδοσία | `OrdexaPayrollEngine.java`, `OrdexaPayrollSync.java`, `ordexa-pay.js`, `ordexa-server-ui.js` | `test-ordexa-pay.mjs`, `test-payroll-regressions.mjs` |
| Καταστήματα/παραγγελίες | `StoreBilling*.java`, `cloudflare-worker/src/store-billing.js` | `test-store-billing-*.mjs` |
| Πρόγραμμα και προσωπικό | `workforce.js`, `workforce-core.js`, `schedule-workbook.js` | `test-schedule-*.mjs`, `test-staff-schedule-payroll.mjs` |
| Τιμολόγια/PDF/QR | `InvoicePipeline.java`, `LocalInvoiceReader.java`, `invoice-*.js` | `test-invoice-*.mjs` |
| Μηχανάκια και service | `service-operations.js`, `fleet-operations*.js`, `NextServiceNotes.java` | `test-fleet-operations-*.mjs`, `test-service-*.mjs` |
| Backup/restore | `Backup*.java`, `HistoryMergePolicy.java` | `test-backup-*.mjs` |
| Direct encrypted access | `Direct*.java`, `direct-relay.js`, `direct-*.js` | `test-direct-*.mjs` |
| #87 απομονωμένο Android Tunnel PoC | `tunnel-poc-android/`, `build-tunnel-poc-connector.py`, `probe-tunnel-poc.mjs` | `test-tunnel-poc.mjs`, `test-tunnel-poc-dns.py` |
| Client APK / mobile web | `client-android/src/.../MainActivity.java`, `portal.html`, `fleet-navigation.js` | `test-client-landscape*.mjs`, `test-ui-system*.mjs` |
| Server UI και reconnect | `server-android/assets/www/server-*.js`, `MainActivity.java` | `test-server-reconnect-*.mjs`, `test-server-settings-recovery.mjs` |
| Build, OTA, GitHub CI | `.github/workflows/`, `scripts/build-android.sh`, `release-config.json` | `test-publish-request.mjs`, `test-ota-releases.mjs` |

Οι ακριβείς και επικυρώσιμες διαδρομές βρίσκονται στο JSON· οι παραπάνω συντομογραφίες δεν αποτελούν literal paths.

## Χρήση από ChatGPT / Cursor / προγραμματιστή

1. Διάβασε `AGENTS.md`, **την κορυφή** του `docs/CHATGPT_HANDOFF_GR.md`, το τελευταίο main/PR/Actions και τον σχετικό τομέα στο `CODE_MAP.json`. Πριν αλλάξεις αποθηκευμένα επιχειρησιακά δεδομένα, διάβασε και το αντίστοιχο domain guide. Δεν χρειάζεται ξανά ανάγνωση όλων των ιστορικών release notes.
2. Μετά από αλλαγή σε γνωστές διαδρομές, για προτάσεις στοχευμένων tests:

   ```bash
   node scripts/code-map.mjs --paths server-android/src/gr/argyrismitsos/fleetserver/OrdexaSync.java
   ```

   Για ολόκληρο το branch (εφόσον υπάρχει το remote ref):

   ```bash
   git fetch origin main
   node scripts/code-map.mjs --base origin/main
   ```

3. Εκτέλεσε πρώτα μόνο τα επιλεγμένα tests **σε ήδη προετοιμασμένο περιβάλλον**. Αυτά μπορεί να εξαρτώνται από `npm ci`, native toolchain ή Playwright· το εργαλείο δεν εγκαθιστά εξαρτήσεις.
4. Έλεγξε το JSON με `node scripts/code-map.mjs --check`. Το command τρέχει και στο **fast** και στο **full** CI. Αν διαγράφηκε/μετονομάστηκε κεντρικό αρχείο ή test/guide, το validation αποτυγχάνει και ενημερώνεται ο χάρτης **στην ίδια αλλαγή**.
5. Για νέα λειτουργία/σημαντική νέα διαδρομή, ενημέρωσε **πριν από merge**: `modules[].paths`, `tests`, `related`, `docs` και την παρούσα περιγραφή. Αν το εργαλείο δείξει `UNMAPPED`, μην υποθέτεις ότι η αλλαγή είναι ασφαλής ή ότι τα επιλεγμένα tests αρκούν. Ελέγξτε τη νέα εξάρτηση και προσθέστε mapping.
6. Επιβεβαίωσε τελικά ολόκληρο `Check saved source` στο συγκεκριμένο PR/main SHA και την ξεχωριστή διαδικασία υπογραφής/ενεργοποίησης μόνο αν υπάρχει εξουσιοδοτημένη παραγωγική αλλαγή.

## Σημαντικά όρια

- Ο χάρτης προσδιορίζει **κύριες** αρμοδιότητες: shared `app.js`, `portal.js`, `worker.js`, SQL migrations, δικαιώματα και login επηρεάζουν πιθανώς πολλές ενότητες. Τα `related` υποδεικνύουν σημεία που χρειάζονται εξέταση. Δεν χρησιμοποιούνται οι προτάσεις για να παραλείπεται το full check.
- Το `--check` εγγυάται ότι οι δηλωμένες διαδρομές, τα scripts δοκιμών και τα docs **υπάρχουν στο Git** και τα references έχουν έγκυρη μορφή. Δεν αποδεικνύει την πληρότητα όλων των εξαρτήσεων και δεν καλύπτει αυτόματα νέα άγνωστα αρχεία· απαιτείται review.
- Αν αλλαγή αφορά μόνο κείμενα/docs, μπορεί να χρειάζεται μόνο γρήγορος τοπικός έλεγχος για ανατροφοδότηση, αλλά **το full CI παραμένει αναγκαίο για merge** όπως συμφωνήθηκε.
- Δεν περιέχει credentials, μυστικά, signing keys ή production records. Δεν χρειάζεται νέα έκδοση Android μόνο για να διορθωθεί η τεκμηρίωση.

## Συντήρηση

Σε κάθε PR με αλλαγές αρχιτεκτονικής, οι reviewers επικαιροποιούν `CODE_MAP.json` και τη συνοπτική λίστα παραπάνω **μαζί με** τον κώδικα. Κάθε agent δηλώνει τις ενότητες που επηρεάζει στο κοινό handoff, ώστε άλλος agent να μην κάνει συγχρόνως τις ίδιες αλλαγές. Η λειτουργία παραμένει συντηρήσιμη από GitHub, χωρίς εξωτερικό index server ή επιπλέον συνδρομή.

## Ταυτοποίηση παραγγελιών Ordexa — 07/11/2026

Ο `OrdexaCashOrderProtocol` κρατά μόνο τα πραγματικά παρατηρημένα αριθμητικά `id/riderId/shopId`, `at` και `rider`. Ο `OrdexaCashSourceStore` συμμετέχει στο υπάρχον `StoreBillingSync`: τοπικό staging, δύο πλήρεις ίδιες αναγνώσεις, ατομικός δείκτης snapshot, παρατηρήσεις αλλαγών/απουσίας και ιστορικό ονομάτων, χωρίς οικονομική εφαρμογή. Το `server-runtime/cash-source.js` προσφέρει ιστορικές scoped αντιστοιχίσεις και coalesced durable αιτήματα προς τον ίδιο reader. Πρώτοι έλεγχοι: `test-ordexa-cash-source-native.mjs`, `test-store-billing-pipeline.mjs`, `test-business-runtime-native.mjs`, `test-native-management-ui.mjs` και `test-native-management-browser.mjs`.

Το `cash-contract.js` ορίζει το επιβεβαιωμένο contract παράδοσης/απουσίας (ιδιοκτήτης07/11). Ο `cash-auto.js` εφαρμόζει πηγή μόνο με πλήρες επαναληπτικό snapshot σε τοπικές παρτίδες200, immutable ledger/history, pinned τιμές, manual cutover και εξαιρέσεις. Το `CashSync` ζητά current/previous05-day στον ίδιο reader ανά120sec και καλεί αποκλειστικά το εσωτερικό native financial port· δεν κάνει HTTP. Πρόσθετοι πραγματικοί έλεγχοι: `test-cash-auto-sqlite.mjs`, `test-cash-pilot-native.mjs`, `BusinessAutomaticCashChecks` και οι νέες automatic DOM/Chromium οθόνες.
