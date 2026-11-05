# Issue #59 — απογραφή εξαρτήσεων D1 πριν από απομακρυσμένες εγγραφές

## Κοινός business runtime στη SQLite

Οι υπάρχοντες business handlers γίνονται bundled ES5 asset του υπογεγραμμένου
Server APK και εκτελούνται interpreted με pinned Rhino 1.9.1. Δεν κατεβαίνει
κώδικας κατά την εκτέλεση. Το ασφαλές JS περιβάλλον αποκλείει Java/Packages,
reflection, shell και γενική πρόσβαση αρχείων. Ρητές primitive capabilities
μεταφέρουν JSON σε typed Android SQLite και native crypto. Κάθε συναλλαγή
διατηρεί rollback, μεγάλα ιστορικά κελιά διαβάζονται σε bounded slices και ο
interpreter έχει instruction/time budget. Τα SQL strings προέρχονται μόνο από
τον bundled κώδικα, ποτέ απευθείας από αίτημα χρήστη.

Το native regression εκτελεί τους πραγματικούς κοινούς handlers σε πραγματική
SQLite: schema, PBKDF2 login, δημιουργία εργαζομένου, δικαιώματα, άμεση ανάκληση,
typed binds/injection isolation, atomic rollback, >5 MiB Unicode ιστορικό,
κλείσιμο cursors, bundle integrity και deadline. Το πραγματικό APK 2.10.2/56
κατασκευάστηκε με προσωρινή δοκιμαστική υπογραφή. Ο runtime δεν εκτίθεται ακόμη
στο παραγωγικό API και δεν ενεργοποιεί authority χωρίς πλήρη migration fence.

Server Android 8/API26+ απαιτείται από τον επίσημο Android interpreter. Το
Client παραμένει συμβατό με την υπάρχουσα ελάχιστη έκδοση. Πριν την ενεργή
μεταφορά απαιτείται επιπλέον έλεγχος των τοπικών SQLite δυνατοτήτων. Οι πηγές,
άδειες και ακριβές dependency hash παραδίδονται με το πλήρες source archive.

Πρώτη P0 φάση και πραγματική τοπική προετοιμασία migration. Καμία μεταβολή
παραγωγικής D1, ενεργοποίηση νέας authority ή αλλαγή λογαριασμών.

## Matrix υπηρεσιών από τον τρέχοντα κώδικα

Η παρακάτω αντιστοίχιση αφορά τις πραγματικές διαδρομές/αποθηκεύσεις της πηγής,
όχι μέτρηση παραγωγικής D1 ή ολοκληρωμένη μεταφορά. Τα endpoints είναι ομάδες
σχετικών διαδρομών· το lexical εργαλείο δεν αρκεί για πλήρες query profiling.

| Υπηρεσία / routes | Σημερινή κύρια αποθήκευση / εξάρτηση | Τοπικό δεδομένο Server | Επόμενη απαραίτητη πύλη |
|---|---|---|---|
| Login, ανάκληση, συσκευές `/api/auth/user-*`, `/me`, `/force-logout` | `workforce.js`: `app_users`, `auth_sessions`, `auth_login_attempts`, `registered_devices`, audit στην D1 | `full_export.workforce` με χρήστες/συσκευές· χωριστό `direct_auth_v1` μόνο για read-only πρόσβαση | Μοναδική κύρια πηγή credentials/roles/revocation, διατήρηση lockout, νέα sessions και explicit session epoch. Το mirror δεν αρκεί. |
| Προσωπικό `/api/admin/employees*` | `app_users`, αναθέσεις/ιστορικά και `audit_log` στην D1 | Πλήρες mirror, τώρα και ελεγχόμενο υποψήφιο αντίγραφο με αρχικά row IDs | Typed schema/constraints, native business validation και Writer fence πριν ενεργοποίηση |
| Πρόγραμμα `/api/admin/schedule-*`, `/shift-templates*` | `shift_templates`, `schedule_assignments`, drafts/publications/acknowledgements/waivers, `schedules` | Mirror και τοπική προβολή | Ατομικές εβδομάδες/δημοσιεύσεις, έλεγχος επικαλύψεων, CAS και audit |
| Μηχανάκια `/api/sync/bike`, `/api/operations`, `/api/admin/vehicles*` | `fleet_snapshot`, `fleet_operations`, `vehicle_registry`, `vehicle_archives`· native εφαρμογή operations | `bikes`, `applied_operations`, canonical snapshot | Ενοποίηση canonical version, idempotent remote operations και registry/archive fence |
| Service `/api/admin/service-trash`, `/service-impact`, `/service-appointments`, `/api/admin/fleet/*/history/*` | Μεταβολές JSON ιστορικού μέσα στο `fleet_snapshot`, σχετικές ουρές/audit | Native ιστορικό μηχανών και αρχεία παραστατικών | Διατήρηση CAS service entry, αρχικών μετρήσεων, confirmations και ιστορικού |
| Τιμολόγια `/api/service-documents*`, `/api/admin/service-documents*` | Metadata στο snapshot, `fleet_operations`, `invoice_import_drafts` και αποθήκευση αντικειμένων· heavy OCR στον Server | Τοπική ουρά ανάλυσης, πρωτότυπα/αποτελέσματα PDF, mirror drafts | Native receipts/retries/reviews και ασφαλής διανομή αρχείων χωρίς απώλεια προηγούμενης επιβεβαίωσης |
| Ordexa παρουσίες `/api/server/ordexa*`, `/api/admin/ordexa*` | Πηγή Ordexa μόνο ανάγνωσης· `ordexa_riders`, `ordexa_imports`, `ordexa_sessions` στην D1 | Native άντληση/ανάλυση, mirror παρουσιών | Authority mapping/source revisions, χωρίς δεύτερη πηγή clock ή Ordexa writes |
| Βάρδιες/μισθοδοσία `/api/admin/ordexa-server/*`, `/api/admin/payroll*` | Native υπολογισμός· D1 `ordexa_shift_adjustments`, `ordexa_pay_decisions`, `ordexa_server_views`, `payroll_periods`, `payroll_snapshots`, rules/adjustments | Τοπικό αποτέλεσμα μισθοδοσίας και mirror αρχικών/κλειδωμένων εγγραφών | Ατομικές αποφάσεις/κλείδωμα με ίδια source version, διατήρηση κλειδωμένων ποσών και audit |
| Καταστήματα `/api/admin/store-billing*`, `/api/server/store-billing/*` | Ήδη Server-primary orders/daily results· D1 `store_billing_records` για όρους, έλεγχο και aggregate publication | `store_billing_local`: orders, coverage, local results, outbox και authority markers | Διατήρηση protocol2· μεταφορά υπόλοιπων controls/terms, όχι επιστροφή raw orders στην D1 |
| Ταμείο διανομέων #60 | Ακόμη δεν υπάρχει παραγωγικό ledger· μόνο αρχικός calculation core | Κανένα ενεργό cash ledger | Νέα native schema + identity/order IDs + audit/backup πριν ενεργοποίηση |
| Ρυθμίσεις/ειδοποιήσεις/κάδος | D1 `system_settings`, `system_alerts`, `alert_rules`, `audit_log`, `deleted_records` | Mirror· native ρυθμίσεις εφαρμογής/διαγνωστικά | Ρητό ownership ανά ρύθμιση, ανάκληση/acknowledgement ξεχωριστά από επίλυση |
| OTA / διανομή | D1-backed release metadata και activation, αντικείμενα APK/Web· εξαίρεση relay πριν `ensureSchema` | Native download/validation/installer, αρχικές υπογραφές | D1-independent read distribution/activation contract με διατήρηση exact-source publication gate |
| Backup/restore | Native encrypted snapshots/sidecars, επιλογή φακέλου και local jobs | Fleet/workforce/store ledger/settings, πραγματικό isolated restore | Κάλυψη κάθε νέου ενεργού ledger, portable recovery και ελεγμένη αλλαγή συσκευής |

Το `SystemMirror` αποθηκεύει όλο το workforce στο `system_state.full_export`.
Αυτό **δεν** δημιουργεί native relational tables με δικαιώματα εγγραφής.
Το direct relay παραμένει read-only και το όριο24 ωρών του `DirectAccess`
δεν εξουσιοδοτεί νέες οικονομικές καταχωρίσεις με παλιά privileges.

## Πραγματικό staging στην SQLite

Η νέα `ServerAuthorityStage` τροφοδοτείται από το υπάρχον ολοκληρωμένο mirror,
χωρίς κανένα δικτυακό αίτημα. Η επιλογή βρίσκεται στον Server στις **Ρυθμίσεις →
Μεταφορά βάσης στον Server**. Δεν εκτελείται αυτόματα ούτε προσθέτει polling.

- Ελέγχει σύνδεση Fleet, schema wrapper 3–5, epoch/cursor, ακριβή λίστα και των 34
  πινάκων, arrays και πλήρη αντιστοίχιση με τα σταθερά row IDs του mirror.
- Υπολογίζει πραγματικό SHA-256 των UTF-8 bytes του snapshot σε μικρά BLOB slices,
  χωρίς μεγάλο CursorWindow cell ή ολόκληρο Java String. Διατηρεί ακόμη και μία
  μεμονωμένη εγγραφή άνω των4 MiB.
- Αντιγράφει σε ξεχωριστό `server_authority_stage_rows` και συγκρίνει αμφίδρομα
  ολόκληρο το περιεχόμενο/row IDs με SQL `EXCEPT`, μέσα στην ίδια συναλλαγή.
  Ελέγχει SQLite `quick_check`. Δεν πιστοποιεί ακόμη domain constraints ή σχέσεις
  native business tables: αυτά παραμένουν απαραίτητη επόμενη πύλη.
- Αντικαθιστά το προηγούμενο υποψήφιο αντίγραφο μόνο όταν περάσουν όλοι οι
  έλεγχοι. Διπλές ταυτότητες, σφάλμα SQL, διακοπή/OTA, λάθος σύνδεση ή μη επαρκής
  χώρος κάνουν rollback. Το CAS token απορρίπτει παλιά ή ταυτόχρονη προετοιμασία.
- Οι stable IDs περνούν από χωριστό indexed lookup μέσα στην ίδια συναλλαγή,
  αντί για join δύο JSON arrays με επανάληψη ολόκληρης της λίστας ανά εγγραφή.
  Τα lookup rows καθαρίζονται πριν από επιτυχές commit. Σε ανεξάρτητο συνθετικό
  SQLite in-memory query 2.000 εγγραφών μετρήθηκαν 0,429 s → 0,001 s με ακριβώς ίδια
  αποτελέσματα. Πρόκειται μόνο για το συγκεκριμένο join, όχι χρόνο μεταφοράς
  ολόκληρου Fleet ή μέτρηση συσκευής.
- Η κατάσταση εμφανίζει χρόνο πηγής/προετοιμασίας και πλήθη. Αλλαγή source stamp,
  epoch/cursor ή σύνδεσης εμφανίζει απαίτηση νέας προετοιμασίας. Η απλή ανάγνωση
  της κατάστασης δεν επανυπολογίζει SHA σε όλο το ιστορικό· η σύγκριση αφορά το
  συγκεκριμένο snapshot/χρόνο, όχι συνεχή έλεγχο με το Ordexa ή την D1.
- Αν η OTA ενημέρωση έχει ζητήσει ασφαλές σημείο, η έναρξη απορρίπτεται με
  συσχετισμένο native αποτέλεσμα. Τα κουμπιά ελευθερώνονται και εμφανίζεται η
  αιτία, αντί να μένει η οθόνη σε αναμονή. Η εργασία που δεν ξεκίνησε δεν
  αφαιρεί blocker άλλης εργασίας.
- Η ένδειξη `businessWritesEnabled` παραμένει **false** σε κάθε διαδρομή.
  Καμία αλλαγή στο ενεργό auth, στις επιχειρησιακές εγγραφές ή στην κύρια πηγή.

Το staging είναι αναγεννήσιμο παράγωγο του ήδη αρχειοθετούμενου `full_export`.
Δεν εξάγεται ως νέο ενεργό ledger στα backup. Η πραγματική επαναφορά ακυρώνει
το proof πριν εφαρμόσει δεδομένα και απαιτεί νέα προετοιμασία. Τα disposable
rows αντικαθίστανται στην επόμενη επιτυχή προετοιμασία. Όταν προστεθεί **ενεργό**
native ledger, πρέπει πρώτα να αποκτήσει export/restore/probe contract.

Οι μετρήσεις χώρου είναι πραγματικό `getUsableSpace` της συσκευής με συντηρητικό
περιθώριο για αντίγραφο/journal. Δεν εγγυώνται ότι ο δίσκος δεν θα γεμίσει κατά
την εργασία. Οι progress callbacks επιτρέπουν ασφαλές rollback στην επόμενη
ελεγμένη φάση, χωρίς εγκατάλειψη ενεργών εγγραφών.

## Έλεγχοι του staging

Το `test-server-authority-stage-native.mjs` εκτελεί την πραγματική Java πάνω σε
πραγματική επίμονη SQLite μέσω των ίδιων native adapters με τα υπάρχοντα tests.
Καλύπτει 5.003 εγγραφές και >4 MiB Unicode cell, exact SHA/πλήρες περιεχόμενο, restart, έλλειψη χώρου,
διαφορετικό realm, διπλά IDs, injected SQL failure, mid-copy cancellation,
παλιό CAS/δύο ταυτόχρονους admins, future schema/ελλιπείς πίνακες, συμβατό backup
wrapper 3 και ακύρωση proof μετά από restore. Ανεξάρτητη Python συγκρίνει bytes
πηγής και κλειδωμένο ιστορικό ποσό. Δεν χρησιμοποιείται ζωντανή D1/Ordexa.
Το DOM regression καλύπτει ακριβές CAS token, καθυστερημένα native replies,
ασφαλές rendering, αλλαγή πηγής και παλιό native bridge, χωρίς polling.

## Τι είναι ήδη επιβεβαιωμένο στον πηγαίο κώδικα

- `cloudflare-worker/src/worker.js`: η πλειονότητα του κανονικού request path καλεί `ensureSchema(env)` μετά το ειδικό `/direct.html` και το routeDirectRelay. Αυτό είναι **υπαρκτό όριο** πλήρους λειτουργίας χωρίς D1· μην ισχυριστείς D1-independence από την ύπαρξη ενός read-only relay.
- `cloudflare-worker/src/mirror-delta.js`: change journal με D1 triggers, `mirrorDelta`, `trimMirrorJournal`· έχει πραγματική εγγραφή/ανάγνωση D1 και πρέπει να αποτιμηθούν οι write multipliers ανά batch.
- `cloudflare-worker/src/store-billing.js`: ήδη υπάρχει Server-primary protocol2 για ημέρες/παραγγελίες και aggregate-only μεταφορά· διατήρησε αυτό το έργο, μην ξανακάνεις import στο Cloudflare.
- `server-android/src/gr/argyrismitsos/fleetserver/FleetDataStore.java`, `FleetSnapshotSync.java`, `Direct*.java`: σημεία για έλεγχο τοπικής authority, ισχύος permissions, CAS και remote writes. Η ύπαρξη αρχείων δεν επιβεβαιώνει πλήρη ροή απομακρυσμένων εγγραφών.

## Εργαλείο

`node scripts/d1-source-inventory.mjs` παράγει **offline lexical** κατάλογο JavaScript αρχείων με αναφορές `DB.prepare/batch/exec`. Τα `readSqlHints/writeSqlHints` δεν είναι εκτελέσεις queries και δεν μετρούν πραγματικά D1 rows. Για πλήρη audit απαιτείται χειροκίνητη αντιστοίχιση endpoint → D1 table/query → Server source, καθώς και πραγματικό Workerd profiling και live απογραφή με εξουσιοδότηση χωρίς γράψιμο/σβήσιμο δεδομένων.

## Υποχρεωτικές πύλες πριν προχωρήσει το #59

1. Matrix ανά υπηρεσία (login, προσωπικό, πρόγραμμα, μηχανάκια, service, τιμολόγια, βάρδιες, ταμείο, καταστήματα): current authority / D1 dependency / Server-local data / migration checkpoint.
2. Ακριβής νέα επαλήθευση backup & δοκιμαστική αποκατάσταση (#61).
3. Security design: authenticated encrypted remote mutation relay, ανάκληση, idempotency key, CAS, audit και μη επαναχρησιμοποίηση παρωχημένων privileges.
4. Workerd/Android synthetic tests: D1 quota exceeded, Server restart, offline, multi-admin race, no false success, rollback.
5. Μόνο μετά από αυτά γίνεται σταδιακή μεταφορά ανά υποσύστημα. Δεν αλλάζει σήμερα `release.yml`, production D1 ή signing.

Κατάσταση: **Source matrix και πραγματική τοπική προετοιμασία υλοποιήθηκαν.
Δεν έχει ενεργοποιηθεί native business authority ή πλήρης ανεξαρτησία D1.**
Επόμενο: typed native schemas/constraints και authenticated per-module writer
fence με τελική πηγή/receipt πριν από auth/revocation και remote mutations.
Παραμένουν ανοικτά πλήρες endpoint/query profiling, πραγματικές Workerd
μετρήσεις, συσκευή, τελική επαλήθευση και το συνολικό release gate.
