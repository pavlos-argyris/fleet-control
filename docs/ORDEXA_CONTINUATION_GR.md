# Ordexa — παράδοση ημιτελούς υλοποίησης σε άλλη συνομιλία

**Ιστορική παράδοση 29/10/2026. Ο χρήστης έδωσε νεότερη εντολή στη νέα συνομιλία να συνδυάσει τις εργασίες και να συνεχίσει την υλοποίηση στο ίδιο branch/PR.**

Το αρχικό checkpoint παραμένει `f42ef3646508dad7c2c99dcc06f864be578833a4`. Η τρέχουσα ευθύνη/κατάσταση καταγράφεται στην πρώτη ενότητα του CHATGPT_HANDOFF_GR.md. Οι παρακάτω εκκρεμότητες παραμένουν προς έλεγχο μέχρι να καταγραφεί επαληθευμένη επίλυση.
Η νέα συνομιλία συνεχίζει τα #28/#29/#30 μαζί από τον κλάδο
`codex/ordexa-integration`, όχι από το παλιό main. Το draft PR είναι το σημείο
ελέγχου του ακριβούς αποθηκευμένου head. Η βάση είναι
`09ee4bb5def6e735db06dd24c4f9ee3aecbcc37c` (merged claim PR#34).

## Απαιτήσεις που πρέπει να διατηρηθούν

- Διαβάστε **AGENTS.md**, **CHATGPT_HANDOFF_GR.md**, το παρόν και
  **ORDEXA_INTEGRATION_5.52.0_GR.md**, μαζί με τα πραγματικά issues/PR/Actions.
- Login/ανάγνωση/προετοιμασία Ordexa στο **Server APK**, όχι στον Worker.
  Κωδικός δεν αποθηκεύεται· provider token μόνο κρυπτογραφημένο στη συσκευή,
  εκτός backup/Worker/Client/Web/logs. Στέλνονται μόνο αναγκαίες αλλαγές.
- **Μόνο ανάγνωση Ordexa.** Επιτρέπεται αναγκαίο login και συγκεκριμένα GET.
  Καμία αλλαγή παρόχου, clock, εργαζομένων, βαρδιών, οικονομικών ή δικαιωμάτων.
  Δεν δοκιμάζουμε απαγορευμένες ενέργειες στην πραγματική υπηρεσία.
- **Ρητή χειροκίνητη αντιστοίχιση** cityId/riderId → υπάρχον Fleet employee ID.
  Ονόματα μπορεί να διαφέρουν εντελώς. Δεν δημιουργείται αυτόματα εργαζόμενος,
  δεν αποθηκεύεται name-match. Rename δεν χάνει σύνδεση.
- Fleet clock παραμένει ενεργό μέχρι επιβεβαίωση χρήστη. Διακριτές πηγές,
  χωρίς διπλή πληρωμή, διατήρηση raw ιστορικού/αποφάσεων/locked snapshots.
- Ο χρήστης ορίζει ρητά όριο κενού και αν προσμετράται. Καμία επιχειρησιακή
  προεπιλογή και καμία αδιάκριτη ένωση πρωινής/βραδινής βάρδιας.
- Η αυτόματη δημοσίευση ακολουθεί τους μόνιμους κανόνες μόνο αφού η επόμενη
  συνομιλία ολοκληρώσει και ελέγξει την εργασία. Η παρούσα παράδοση δεν είναι
  επιτυχές τελικό CI, ούτε άδεια παράκαμψης ελέγχων.

## Αποθηκευμένος κώδικας

Υποψήφιες εκδόσεις: Release/Client/Web **5.52.0**, Client code86,
Server **2.3.0** code44, Worker **5.13.0**. Αυξήθηκαν manifests/config/cache
και δημιουργήθηκαν νέα snapshots v5.52.0. Τα δημοσιευμένα assets διατηρούνται.

- `cloudflare-worker/src/ordexa-core.js`: strict normalized schema, stable IDs,
  3 πίνακες, πολιτική κενού, grouping χωρίς απώλεια raw/DST evidence.
- `src/ordexa.js`: authenticated daily imports/receipts, nonce/replay/stale
  guards, manual mapping, policy, review, audit/CAS, coverage/revision blockers.
- `src/workforce.js` / `workforce-core.js`: αποκλειστική πηγή Ordexa μέσω του
  υπάρχοντος payroll engine, αφαίρεση κενού χωρίς δεύτερη στρογγυλοποίηση,
  διατήρηση κλειδωμένων περιόδων και atomic revision guards στο lock.
- `worker.js`, `mirror-delta.js`, `change-events.js`: schema/restore/mirror,
  31 πίνακες/93 triggers και one-time epoch reset για παλιούς mirrors.
- `server-android/.../OrdexaClient.java`: fixed API origin, transport fence,
  μόνο login/me/cities/report, no redirects, bound sizes/timeouts, απαραίτητα
  πεδία μόνο. `OrdexaSync.java`: AndroidKeyStore token, preview/sequential daily
  sync, local digest skip, optional hourly last7days, stages/errors, OTA yield.
- MainActivity/SyncService bridge και `server-android/assets/www/ordexa-server.js`:
  τοπικές ρυθμίσεις, login/city/preview/sync/status, χωριστός executor.
- `public/ordexa-ui.js/css`, Portal integration και Client mirrors: themed
  explicit mapping/policy/review, session fences, pagination. Δεν έχει γίνει
  ακόμη πλήρης browser/Server UI επαλήθευση.
- Νέα tests core/UI/native/D1/browser· προσθήκες σε check-all και **και τα δύο**
  check/release workflows. Διατηρούνται οι προηγούμενες invoice suites.

## Τι ελέγχθηκε πραγματικά

- Νέα pure core και actual shipped UI/JSDOM tests πέρασαν.
- Actual Java OrdexaClient με συνθετικό transport: read-only allowlist και
  αποκλεισμός μεθόδων/paths/origins πριν network, numeric IDs, timezone,
  απομάκρυνση financial aggregates/tokens. Πέρασε, **όχι live Server login**.
- Actual Workerd/D1 Ordexa suite πέρασε με synthetic data: auth, διαφορετικά
  ονόματα/rename, CAS, 8 concurrent replay submissions, stale import fence,
  audit rollback, coverage/payroll, μη διπλή πληρωμή με παράλληλο Fleet clock,
  missing/current corrections και locked cross-period protection.
- Full `scripts/check-all.sh` πέρασε σε **προγενέστερο τοπικό checkpoint** μετά
  διόρθωση diagnostic version/expected mirror counts. Μετά προστέθηκαν guards
  και tests· **απαιτείται νέα πλήρης εκτέλεση στο τελικό head**.
- Server2.3.0 compile πέρασε με προσωρινό test key. Αυτό το APK δεν είναι
  παραγωγικά υπογεγραμμένο, δεν ανεβαίνει ως release και δεν εγκαθίσταται.
- Chromium **δεν είναι διαθέσιμο τοπικά**. Επίσημο download απέτυχε ως
  truncated ZIP, το browser test δεν ξεκίνησε. Το νέο browser test έχει μπει
  στο GitHub CI αλλά δεν έχει ακόμη αποδειχθεί ότι περνά. Μην το αναφέρετε ως
  επιτυχία και μην παρακάμψετε/αποδυναμώσετε τον έλεγχο.
- Πραγματική σύνδεση browser/προβολή Ordexa έγινε μόνο με ανάγνωση και secure
  credential entry, χωρίς εξαγωγή token. Δημόσιος client επιθεωρήθηκε. Η API
  είναι εσωτερική διεπαφή του web client· δεν επιβεβαιώθηκαν υποστηριζόμενο
  δημόσιο API, read-only role, rate limits ή live native JSON στη συσκευή.
- Δεν έγιναν παραγωγικές δοκιμαστικές εγγραφές, lock, backup/restore ή install.

## Ανοιχτά ευρήματα προς έλεγχο — όχι ολοκληρωμένες διορθώσεις

1. **Πιθανό blocker UI:** κανονική αλλά μη αντιστοιχισμένη παρουσία μπορεί να
   εμποδίζει payroll, ενώ τα review buttons εμφανίζονται μόνο για
   review/missing/ignored. Ελέγξτε ασφαλή ρητή μη προσμέτρηση με αιτιολογία για
   πρώην/άσχετο rider, χωρίς υποχρεωτική δημιουργία ή λανθασμένη αντιστοίχιση.
2. GET `/api/admin/ordexa` invalid date/page: πιθανό plain Error →500 αντί400,
   και fractional page. Ελέγξτε strict validation/κατάλληλο μήνυμα.
3. Native digest: provider array ordering δεν κανονικοποιείται ακόμη. Ελέγξτε
   σταθερή ταξινόμηση ώστε ίδιο περιεχόμενο σε άλλη σειρά να μη στέλνεται ξανά.
4. Native preview/schema validation και πραγματικοί τύποι flag/date/IDs:
   επιβεβαίωση χωρίς guessing. Worker strict booleans μπορεί να απορρίπτει
   διαφορετικό πραγματικό σχήμα· μη χαλαρώσετε τον έλεγχο χωρίς αποδεικτικά.
5. Native login/configure ενώ τρέχει sync, αλλαγή λογαριασμού/πόλης και
   credential expiry: χρειάζονται έλεγχοι racing state και stale results.
6. Συγκεκριμένος race ανάμεσα σε payroll computation και atomic lock,
   import batch rollback, ignored decision preservation μετά νέα ανάγνωση,
   Ordexa backup/restore roundtrip, παλιός28-table mirror →31-table migration
   και δεύτερη εκκίνηση χωρίς νέο epoch reset χρειάζονται focused δοκιμές.
7. Μεγάλη αναφορά/2000 sessions, bounded D1 SQL και Worker CPU: μετρήστε πριν
   παράδοση. Η αρχιτεκτονική μεταφέρει provider I/O στο Server, αλλά δεν έχει
   αποδειχθεί ακόμη production CPU υπό μεγάλο φόρτο. Δεν υπόσχεται μηδενικό CPU.
8. Νέο `test-ordexa-browser.mjs`: πλήρες Portal/Client desktop/mobile/file
   landscape, explicit mapping/Escape/layout. Χρειάζεται πραγματική εκτέλεση,
   επιθεώρηση εικόνων και Server UI mock/preview/config stage tests. Μην
   ισχυριστείτε ότι υπάρχουν ήδη Server screenshots ή φυσικό device test.

## Πρακτικά επόμενα βήματα

1. Επαληθεύστε draft PR/head και τυχόν CI από το checkpoint push. Αναλάβετε
   ρητά στο handoff και συνεχίστε **στο ίδιο branch** διατηρώντας όλη την πηγή.
2. Διερευνήστε τα παραπάνω, διορθώστε/δοκιμάστε με synthetic fixtures.
3. Συνήθεις εντολές από repo root μετά τα documented dependency/toolchain setup:
   `node scripts/test-ordexa-core.mjs`, `node scripts/test-ordexa-ui.mjs`,
   `node scripts/test-ordexa-d1.mjs`, `node scripts/test-ordexa-native.mjs`,
   `node scripts/test-ordexa-browser.mjs`, `bash scripts/check-all.sh`.
   Το native test χρειάζεται το pinned vendor JSON jar/Android Java toolchain,
   το browser χρειάζεται Playwright Chromium. Τα workflows δείχνουν τη σειρά.
4. Συγχρονίστε root public/Client mirrors και νέα v5.52.0 snapshots με τα
   υπάρχοντα scripts μετά τυχόν διορθώσεις. Μην αλλάξετε published snapshots.
5. Τελικό full check-all, browser/screenshots, native Client+Server builds,
   Worker dry run και exact PR CI. Έλεγχος latest main/άλλων publish πριν merge.
6. Exact main CI πριν το κανονικό request-only publish μέσω generator,
   παρακολούθηση activation και αρχικών signing certificates/live hashes.
   Πλήρης πηγή/build inputs/οδηγίες/checksums GitHub μόνο, καμία παράδοση test APK.
7. Κρατήστε #28/#29/#30 ανοιχτά για πραγματική εγκατάσταση/επαλήθευση. Κανένα
   πραγματικό Ordexa import/payroll mutation ως δοκιμή από τον βοηθό.

Το workspace της παλιάς συνομιλίας είχε μόνο αναπαραγώγιμα caches/toolchain,
test-signed APK και συνθετικά logs. Δεν χρειάζονται ως build inputs και δεν
μεταφέρονται ιδιωτικά κλειδιά στο Git. Η ασφαλής browser συνεδρία δεν αποτελεί
παραγωγική σύνδεση του Server ούτε μεταφέρεται στη νέα συνομιλία.
