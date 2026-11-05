# Issue #59 — απογραφή εξαρτήσεων D1 πριν από απομακρυσμένες εγγραφές

Εργασία μόνο της πρώτης P0 φάσης, χωρίς runtime migration, DB writes ή αλλαγή λογαριασμών.

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

Κατάσταση: **P0 αποτύπωση ξεκίνησε, όχι ολοκληρωμένη πλήρης καταγραφή.**
