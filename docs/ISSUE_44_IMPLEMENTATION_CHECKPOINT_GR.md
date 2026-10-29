# #44 — Σημείο συνέχειας υλοποίησης, 29/10/2026

## Ανακτήθηκε και αποθηκεύτηκε ο κώδικας

Η διακοπή παρακάτω είναι ιστορική. Το περιβάλλον επανήλθε και όλος ο τότε τοπικός source αποθηκεύτηκε στο689dd702878d95bded6da159683b5bd1a43487c2/PR48. Συνεχίζονται πρόσθετες διορθώσεις/έλεγχοι· δες το νεότερο κοινό handoff. Δεν έχει γίνει ακόμη δημοσίευση.

## Περιβάλλον διαθέσιμο ξανά

Το περιβάλλον επανήλθε στην ίδια συνέχεια· επιβεβαιώθηκαν ο τοπικός φάκελος και όλες οι νεότερες αλλαγές. Οι δοκιμές Worker/SQLite API και shipped UI/JSDOM επαναλήφθηκαν επιτυχώς. Συνεχίζονται WIP source push και οι εκκρεμείς συνολικοί έλεγχοι. Η προηγούμενη διακοπή παρακάτω είναι ιστορική και δεν αποτελεί πλέον ενεργό blocker.

## Κατάσταση και πραγματικό εμπόδιο

**Δεν είναι ολοκληρωμένη ή δημοσιευμένη έκδοση.** Το περιβάλλον εκτέλεσης δηλώθηκε unavailable πριν αποθηκευτεί το νεότερο τοπικό implementation. Η προσπάθεια exec_command απέτυχε με «No usable execution environment is available». Υπάρχει σύνδεση GitHub, αλλά δεν υπάρχει πρόσβαση τώρα στον τοπικό κώδικα/αρχεία ή δυνατότητα εκτέλεσης των συνολικών ελέγχων. Δεν χαρακτηρίζουμε χαμένα τα αρχεία χωρίς έλεγχο, ούτε ισχυριζόμαστε ότι όλος ο νεότερος κώδικας βρίσκεται στο GitHub.

Επαληθευμένο remote runtime checkpoint: **413e2d0a66a983dd90916008972131146acb4dbc**, tree **17de2a5c0e9338fdb2cc422cee367f1542aa4e94**, PR #48, branch `codex/issue-44-ordexa-stores`. Περιέχει τη βάση engine/protocol/store/Worker και native test, όχι το πλήρες παρακάτω implementation. Η παρούσα καταγραφή σώζει τεχνική συνέχεια· δεν υποκαθιστά τα μη προσβάσιμα source files.

Τελευταίο ελεγμένο main **09ae41972ca71b8956799b9b2fff971ce64a2b8a**. Ενεργή παραγωγή **5.56.1 / Server2.5.3 / Worker5.15.3**, δημοσιευμένη πηγήdf870b6ea472e3b0a153d340ff2f49c94234e9a1. Δεν ενεργοποιήθηκε υποψήφια5.57.0. Δεν έγινε παραγωγικό import, backup/restore ή εγκατάσταση APK ως δοκιμή.

## Οριστικοί κανόνες χρήστη

- Νέα καρτέλα Καταστήματα, πλήθη/χρεώσεις και όροι ανά κατάστημα, ατομική/μαζική επεξεργασία, άμεση αποθηκευμένη προβολή και ανανέωση στο παρασκήνιο.
- Ημέρα **[05:00, επόμενη05:00), Europe/Athens**. Δεν αλλάζει το08:00–02:00 μισθοδοσίας.
- **«Διατήρηση παραγγελιών στο Fleet»: default κλειστή σε κάθε κατάστημα.** Όταν λείπει επιβεβαιωμένα παραγγελία από πλήρη επιτυχημένη συνεπή ανάγνωση Ordexa, αφαιρείται από ενεργή καταμέτρηση/χρέωση Fleet, εκτός αν ο χρήστης άνοιξε την εξαίρεση του καταστήματος. Partial/error/unchecked range δεν διαγράφει. Audit παραμένει.
- Ενεργοποίηση διατήρησης αργότερα δεν ανασταίνει ήδη εφαρμοσμένες διαγραφές. Πραγματική επανεμφάνιση της ίδιας πηγής μπορεί να επανενεργοποιεί την ίδια παραγγελία.
- Αρχική εισαγωγή όρων Ordexa, μετά ανεξάρτητοι Fleet όροι με ημερομηνία ισχύος. Νέα καταστήματα μετά το bootstrap απαιτούν ρύθμιση· άγνωστη τιμή δεν είναι0€.
- Ημερήσια χρέωση = count×price + αναγκαίο συμπλήρωμα μέχρι το ημερήσιο ελάχιστο. Το ελάχιστο είναι ανεξάρτητο ποσό. Πολιτική μηδενικών ημερών διατηρείται.
- Άντληση/διαπιστευτήρια/υπολογισμός στο Server APK, Ordexa αποκλειστικά ανάγνωση. Ωριαίο stores sync και χειροκίνητο· ξεχωριστό5λεπτο shifts sync.
- Πλήρης source στο GitHub, ενημέρωση handoff, πλήρεις έλεγχοι, αρχικές APK υπογραφές, κανονική αυτόματη δημοσίευση μετά επιτυχημένο exact-main CI. Χωρίς δεύτερη επιβεβαίωση.

## Τοπικό implementation που πρέπει πρώτα να ανακτηθεί

Τοπικός φάκελος όταν επανέλθει το περιβάλλον:
`/workspace/scratch/d6ba238fe61c/fleet-issue44`.

Το native Git history είναι **synthetic imported source**, όχι το πραγματικό remote history. Μην κάνεις native force-push. Χρησιμοποιήθηκαν GitHub blobs/tree/commit/ref με expected-SHA lease. Η αρχική ακριβής imported tree ήταν5c461ef57b9406feb96a497b02f70b0694fd1a7a. Μην συμπεριλάβεις symlinks .android-toolchain/node_modules, private/signing, BuildSecrets ή test APKs.

Νεότερα αρχεία/αλλαγές που αναφέρονται από την προηγούμενη ενεργή εκτέλεση και **δεν έχουν επαληθευτεί στο remote**:

1. **StoreBillingEngine.java:**05day/DST/Monday, integer cents/BigDecimal, fixed/dailyMin bootstrap, unsupported terms explicit, effective versions με ισοβαθμία μεγαλύτερου version, max/minimum/zero policy/unknowns.
2. **StoreBillingProtocol.java:** αυστηρό setup/orders schema, σταθερά IDs, πλήρη timestamps με offset, page/pages/total, max500rows, ordered pages. Όταν city-wide rows δεν έχουν shopId, explicit shopId-filtered fallback. Ποτέ name-based joining.
3. **StoreBillingStore.java:** SQLite μικρών εγγραφών32KiB, accepted order/original evidence, observation/audit, terms/store/coverage και transient stage/seen. Dirty delta uploads, transaction page replay, duplicate detection, two-pass digest, input staging/hydration, paged32removals, backup canonical kinds μόνο.
4. **StoreBillingSync.java (νέο):** persisted step machine,2sec tick χωρίς idle network, shared Ordexa guard, scope/generation/restore epoch, input revision fence, setup/catalogue hash, archive hydration, expanded source dates και exact05filter, fixed run cutoff, δύο ίδιες πλήρεις αναγνώσεις, bounded50local/32network. Πρόσφατες ημέρες + μία παλιότερη covered ημέρα ανά hourly cycle· manual έως31ημέρες. Wake record χωριστό ώστε να μη χάνεται concurrent request. Future-effective terms δεν τιμολογούν μελλοντικές ημέρες.
5. **Κρίσιμη ατομικότητα διαγραφής:** local pendingDeleteRun δεν αφαιρεί ενεργή πηγή πριν publish. Worker staged removals + daily rows, atomic CAS ελέγχου όλων των store revisions/retain policy, source archive deactivation και ενεργοποίησης αποτελέσματος. Μετά επιβεβαιωμένο durable receipt local commit. Network lost ACK κρατά job και επαναλαμβάνει ίδιο publish receipt· δεν διπλοεφαρμόζει.
6. **OrdexaClient/OrdexaSync:** μόνο συγκεκριμένα GET setup/orders στη read-only allowlist, έλεγχος origin/query πριν network, κοινό guard, ασφαλές storesContext χωρίς token, protected session generation_at.
7. **SyncService/MainActivity:** separate stores executor και wake operation, status/manual request JS bridge.
8. **FleetDataStore/BackupManager:** native store archive στο fullBackupPayload, validation πριν restore, χωρίς transient leases/credentials, dirty restore και wake. Η ισχύς validation/συμβατότητα παλιών fixtures θέλει επανέλεγχο.
9. **Worker store-billing.js (~30Kchars):** store_billing_records/guards, control lease15min, paged inputs50, catalogue25/60K, archive/stage32, atomic publish/removals/receipt, progress/request. Admin view/days/terms/selection/operations/sync/bulk με stores.view/manage. Exact idempotency + all-or-none CAS ≤50stores, partial-field updates, audit, durable reprice queue. Source/network errors δεν καταστρέφουν παλιά αποτελέσματα.
10. **Worker integration:** workforce schema/routes/backup columns, mirror table34, runtime schema store-billing-v1, permissions/manager defaults, stores-only live-change scope. Intermediate staging δεν στέλνει άσκοπα live refresh.
11. **Web store-billing.js/CSS:** εβδομάδα/προσαρμοσμένο εύρος,50rows/σελίδα, selection/editor, defaultOFF retention, explicit bulk partialfields, cents/effective date, same-idempotency retry/draft preservation, detailBack, token/range memory15sec/inflight coalescing/logout fence, lightweight active ops30sec, source stale background queue μέχρι σήμερα. Escaped source names, unknown amounts/counts ως—.
12. **Portal/client:** new view/navigation/title/help/permissions, server ordexa status/manual dates και ακριβές5min/1hour κείμενο, rootClient mirrors + immutable v5.57assets.
13. **Μόνο τοπικές υποψήφιες εκδόσεις:**5.57.0/Client92/Server2.6.0(code50)/Worker5.16.0, retained assets5.56.1/5.56.0/5.55.0. Επανέλεγχος διαθεσιμότητας version πριν παράδοση. Rerun prepare-static-assets μετά τελευταίες αλλαγές· όχι overwrite παλιών snapshots.

## Αναφερθέντες τοπικοί έλεγχοι — όχι νέο verified CI

Η προηγούμενη εκτέλεση ανέφερε επιτυχία των παρακάτω πριν το περιβάλλον γίνει μη διαθέσιμο. Τα νεότερα test αρχεία, outputs και ο πλήρης ακριβής candidate κώδικας δεν είναι τώρα προσβάσιμα. **Δεν ισοδυναμούν με επιτυχημένο CI του remote413e2d ή έγκριση δημοσίευσης.**

- test-store-billing-native.mjs:41actual Java engine/protocol assertions και SDK23 compile. Το foundation test υπάρχει ήδη στο remote.
- test-store-billing-api.mjs: actual Worker/SQLite57stores, pagination/bootstrap/defaultOFF/partialbulk/replay/CAS/archive/staging/stale reads.
- fixtures/native-store-sqlite.mjs + test-store-billing-pipeline.mjs: πραγματικά native Store/Sync/Engine/Protocol και SQLite μέσω synthetic provider/Worker bridge,60orders/>50pages, filtered fallback, source503 κρατά προηγούμενα60/12000c, επόμενη διαγραφή defaultstore→0 ενώ protectedstore διατηρεί1/200c, OFF→0, μετέπειταON δεν ανασταίνει. Native backup export excludes meta.
- test-store-billing-ui.mjs: JSDOM source escaping/05day/defaultOFF/explicit retention/save failure+retry/back/hidden/session/cache.
- Root syntax checks. Αρχικό safety check δεν είχε όλα τα νέα αρχεία staged, άρα όχι authoritative full check.
- **Δεν έγιναν ακόμη:** πλήρες check-all σε συνδυασμένο source, final APK builds, νέος actual Workerd/D1 και πραγματικό Chromium visual QA, exact-head CI, publication.
- Η τελευταία τοπική εντολή έκανε patch future-day clamp/unknown UI/effective-term pendingDays/nativefuture και έτρεχε syntax/UI/API. Το τελικό αποτέλεσμα δεν διασώθηκε στη σύνοψη· να επαναληφθεί, χωρίς υπόθεση επιτυχίας.

## Εκκρεμείς έλεγχοι/κίνδυνοι πριν merge

- Ανάκτηση τοπικών αρχείων και άμεσο WIP push. Αν δεν ανακτηθούν, ανακατασκευή από remote foundation και παρούσα αρχιτεκτονική. Μην ισχυριστείς ότι το checkpoint περιέχει ολοκληρωμένο feature.
- Fresh main/PRs/Actions και διατήρηση τελευταίου handoff άλλου agent. Ενσωμάτωση09ae419 και τυχόν νεότερου main· όχι overwrite παλιού full tree πάνω σε νεότερο.
- Regression same-day terms version tie και future-effective pricing: παλιά ημέρα δεν pending από μελλοντική τιμή· τρέχων applicable όρος/retention μεταβολή προκαλεί σωστό reprice.
- Actual Workerd/D1 transaction/guards/rollback,32batch/parameter limits, retention race, concurrent bulk/publish, lostACK/expiredlease exactreceipt. Ενίσχυση receipt binding finalPass και stage validation/safeinteger sums.
- Native pipeline crash/restart/pagination inconsistency/source-change/rehydration/restore tests. Αδύναμο restore validation χρειάζεται βελτίωση. Source timestamp representations πρέπει να αποφεύγουν ψευδή conflict.
- UI σύγκριση πριν/μετά/editor current terms, pagination cache, desktop/mobile/Client landscape screenshots, nooverflow/back/defaultOFF/failure/retry. Τοπικό Chromium executable έλειπε· CI το εγκαθιστά.
- Wiring tests σε check-all/check.yml/release.yml: native μετά unpack-toolchain, browser μετά εγκατάσταση. Διατήρηση παλιών suite assertions· legitimate fixtures update για νέες native references/mirror34/scopes5.
- Πλήρες check-all, native storage/backup regressions, bothAPKs temporary test signing μόνο για CI, static asset/safety checks.
- Οδηγός ISSUE_44_STORES_GR.md, ενημέρωση sharedhandoff/issues, readyPR μετά ακριβέςCI.
- Μετά merge/exactmainCI το κανονικό request-publish.mjs δημιουργεί ξεχωριστό request-only commit. Όχι χειροποίητο/fake publish JSON. Το προηγούμενο prepare-current-publication workflow είναι pinned5.55 και χρειάζεται σωστή προσαρμογή εάν χρησιμοποιηθεί. Παρακολούθηση αρχικών υπογραφών/activated/download hashes/sourceZIP.
- #44 ανοιχτό για πραγματική επιβεβαίωση χρήστη. Καμία live business-data write/test στο Ordexa ή παραγωγικό restore.

## P0 τεκμήρια και όρια

Ordexa user-visible Ανά κατάστημα/Πληρωμές καταστημάτων/Ανά παραγγελία είχαν επιθεωρηθεί read-only μετά ασφαλές login. Δημόσιος client index-C14BgXZX.js SHA256 dabe6bc38dd3b332dd0c6489a5c832f9a6444816f7cde14cef736ab9faaa85b5.

GET origin https://api.ordexa.gr, /api/cities/{city}/setup με shops/settings/city, shopid/name/blocked/versions{from,terms}; terms.method fixed/dailyMin/monthlyMin/km/area/riderCharge, perOrder/minOrders/zeroDays, settings.chargeFixedOnZeroDays. Orders GET /api/cities/{city}/orders?from&to&page&sort=at&dir=asc[&shopId], rootrows/total/page/pages. **Δεν είχε επαληθευτεί ανεξάρτητο live native JSON**. Η runtime gate πρέπει να απορρίπτει ασυμβατό schema/IDs/timestamps/pagination πριν αποδοχή και πριν διαγραφές. Δεν υπάρχει δημόσιο SLA ή εγγύηση ανάκτησης παραγγελίας που διαγράφτηκε πριν την πρώτη άντληση.
