# #37 — Μαζική επανάληψη και σταθερός έλεγχος τιμολογίων

Δημοσιευμένη και ενεργοποιημένη **5.55.0**, 29/10/2026, PR#39.
Client/Web5.55.0(code89), Server2.5.1(code47), Worker5.15.1.
Συνδυάστηκε ολόκληρη η ήδη ενεργοποιημένη Ordexa5.54.0 και το νεότερο main.
[Release, πλήρης πηγή και αρχεία](https://github.com/pavlos-argyris/fleet-control/releases/tag/fleet-v5.55.0).
Πηγή/tag: `326819f7689125512aea785c51cfeede5cb501fe`.

## Αλλαγές

- Η συγκεντρωτική προειδοποίηση στο Fleet ανοίγει τη σχετική επιλογή μαζικής
  επανάληψης, αντί να μεταφέρει μόνο στο πρώτο service. Θεματική επιλογή
  Server-first ή εξαναγκασμένου Workers AI, με Πίσω/Escape χωρίς υποβολή.
- Αποθήκευση της επιλεγμένης λίστας στην υφιστάμενη durable ουρά Server.
  Κλείσιμο Client/Web δεν χάνει την εργασία. Το recovery window περιορίζεται
  σε δύο τοπικές αναγνώσεις, με αποθήκευση ενός αποτελέσματος ανά αίτημα.
- PDF και QR χωρίς PDF στην ίδια λίστα. Η αποδοχή QR στην ουρά αναφέρεται
  χωριστά από ολοκλήρωση ανάλυσης. Κάθε αποτέλεσμα/αποτυχία παραμένει στην
  κατάσταση batch. Δεν επιβεβαιώνεται αυτόματα ανεπίλυτη διαφορά.
- Native αποτυχίες επικοινωνίας της μαζικής εργασίας: αναμονή 1 και 2 λεπτών,
  παύση μετά την τρίτη συνεχόμενη αποτυχία, διατήρηση θέσης/μετρητή μετά restart
  και reconcile. Το pulse δεν μηδενίζει την αναμονή. Συνέχιση δημιουργεί νέα
  ελεγχόμενη εργασία. OTA παύση δεν μετρά ως αποτυχία.
- Σελιδοποιημένη προβολή ανά τέσσερα service, με έως12 γραμμές προεπισκόπησης
  και χωρίς rawText/evidence στη λίστα. Τα πλήρη στοιχεία διατηρούνται στη
  βάση και διαβάζονται όταν ανοίγει ο έλεγχος. Αλλαγή snapshot ανάμεσα σε
  σελίδες προκαλεί μία νέα πλήρη ανάγνωση, χωρίς ανάμειξη εκδόσεων.
- Τα live σήματα στο Fleet συγκεντρώνονται ανά έως5δευτ. αντί να ξαναζητούν
  ολόκληρο snapshot για κάθε αποτέλεσμα. Χειροκίνητες αποθηκεύσεις/ανανεώσεις
  δεν καθυστερούν, και παλιό session ή κρυφή καρτέλα δεν στέλνει pending read.
- Οι εκκρεμότητες τιμολογίων δεν ξαναζητούν ολόκληρο snapshot. Κατά ενεργό
  μαζικό reprocess τα live σήματα ανανεώνουν την πρόοδο, όχι ολόκληρη λίστα
  για κάθε αποτέλεσμα. Τα υπόλοιπα φίλτρα ιστορικού συνεχίζουν να έχουν τα
  δεδομένα που χρειάζονται.
- Κανονικοποιημένα αποτυπώματα ανά πεδίο και πολυσύνολο γραμμών: αλλαγή
  σειράς/κενών/τόνων ή μορφής ποσού δεν μηδενίζει προηγούμενη επιβεβαίωση.
  Αποδεκτές διαφορές διατηρούνται ακόμη και αν αλλάξει άλλο πεδίο. Πραγματικά
  νέα διαφορετικά ποσά παραμένουν προς έλεγχο σε επόμενες αναγνώσεις.
  Για legacy επιβεβαιώσεις χρησιμοποιείται ανεξάρτητο πλήρες προηγούμενο
  κείμενο μόνο όταν υπάρχει επαρκές labelled evidence, αλλιώς συντηρητικός
  έλεγχος. Δεν γίνεται μαζική αυτόματη έγκριση παλιών εκκρεμοτήτων.
- Φίλτρο λαδιού αναγνωρίζεται ως ξεχωριστή εργασία/ανταλλακτικό, χωρίς να
  συγχωνεύεται με αλλαγή λαδιών ή να επανεκκινεί τον κύκλο λαδιών. Καλύπτονται
  κεφαλαία/πεζά/τόνοι, κενά και αλλαγή γραμμής, Greek/English oil filter.

## Πραγματικά αποτελέσματα ελέγχων

- Worker/SQLite: 59 εγγραφές, 57 PDF και2 QR, concurrent starts/μία batch,
  pause/resume, ξεχωριστή queued ένδειξη, αποτυχία διαγραμμένου service χωρίς
  διακοπή των άλλων, διατήρηση manual χιλιομέτρων και επίμονης νέας διαφοράς.
- Actual Workerd/D1: 57 τιμολόγια ×512 γραμμές, πηγή1.889.920bytes,
  15 σελίδες, έως περίπου5.2KB ανά απόκριση στο fixture, οκτώ ταυτόχρονα starts
  και μία durable operation, pause/resume, αναλλοίωτη αρχική πηγή. Μετρήσεις
  `Server-Timing: invoice-list-js` είναι τοπικός χρόνος σύγχρονης επεξεργασίας,
  **όχι παραγωγική μέτρηση Cloudflare CPU ούτε εγγύηση CPU budget**.
- Shipped UI/JSDOM: 57 επιλογές, themed mode/Back, ένα POST, progress,
  escaped labels, failed-save και stale-session fence, χωρίς full snapshot.
- Πραγματικός Java queue: persistent 1/2λεπτη αναμονή, count μετά restart και
  reconcile, παύση μετά τρεις αποτυχίες, προηγούμενα OCR/ack/cancel tests.
- Πραγματικός Java PDF reader: πολυσέλιδο συνθετικό120γραμμών PDF με φίλτρο
  λαδιού/πεζά/σπαστή περιγραφή → native JSON → Worker normalizeFleet. Το φίλτρο
  παραμένει χωριστό από την αλλαγή λαδιών. Προηγούμενο πλήρες reader test μένει.
- Προηγούμενα invoice-auto/retry/followup στοχευμένα tests πέρασαν.

## Επιβεβαιωμένη παράδοση και οδηγίες εγκατάστασης

**Επιβεβαιωμένη δημοσίευση**, μετά την ολοκλήρωση της άλλης συνομιλίας για Ordexa #28/#29/#30. Οι παλαιότερες ενδείξεις «υποψήφια / εκκρεμεί» παρακάτω είναι ιστορικά ορόσημα, όχι η τρέχουσα κατάσταση.

- Release/Client/Web **5.55.0 (code89)**, Server **2.5.1 (code47)**, Worker **5.15.1**. [Όλα τα αρχεία και πλήρης πηγαίος κώδικας](https://github.com/pavlos-argyris/fleet-control/releases/tag/fleet-v5.55.0).
- [PR39](https://github.com/pavlos-argyris/fleet-control/pull/39), τελικό head `29306e1a4073c20c9ee1a61f82a2951029a85f75`, tree `6fef91aa589e8de500a85b7d6afff7c4167aee4b`. Συγχωνευμένη πηγή/tag `326819f7689125512aea785c51cfeede5cb501fe`, με ακριβώς το ίδιο tree. Περιλαμβάνει ολόκληρη την ενεργοποιημένη Ordexa5.54.0/source18f40ba και νεότερο main9c1d4e7/καταγραφές.
- [Exact PR CI40910560529](https://github.com/pavlos-argyris/fleet-control/actions/runs/40910560529) και [exact main CI40912682133](https://github.com/pavlos-argyris/fleet-control/actions/runs/40912682133): success. Πλήρης συνδυασμένη σουίτα, διατήρηση παλιών Ordexa/μισθοδοσίας/backup/sync/mirror tests, Worker dry-run και δύο APK builds.
- Όταν έγινε μη διαθέσιμο το τοπικό runtime, χρησιμοποιήθηκε το υπάρχον readonly/artifact-only fallback, προσαρμοσμένο στη5.55.0. Το [prepare40912682043](https://github.com/pavlos-argyris/fleet-control/actions/runs/40912682043), job123584555805, περίμενε το επιτυχές exact-main CI και εκτέλεσε τον κανονικό `scripts/request-publish.mjs` σε καθαρό exact source. Δεν έκανε commit/deploy. Το παραγόμενο JSON ανακτήθηκε από το log και επαληθεύτηκε με το καταγεγραμμένο Git blob SHA `6fca7ad04e27002025f0aeee95ec8bb34409fb5b`.
- Request `fleet-5ced525a-faee-47aa-824b-463092906adc`, requestedAt `2026-10-29T16:42:14.153Z`. Request-only commit `97f511eed17ea9cfcec2496fac5447ad677dea26`, μοναδικός γονέας η πηγή326819f7, μοναδική αλλαγή `.github/fleet-publish-request.json`, ενημέρωση main με expected-SHA lease.
- [Publish40914348221](https://github.com/pavlos-argyris/fleet-control/actions/runs/40914348221): **success**, validation job123590472258 / publish job123590591090. Αρχικά πιστοποιητικά Client και Server επιβεβαιώθηκαν. Activation `activated:true`, releaseId `v5.55.0-326819f76891`, sourceCommit326819f7. Live έλεγχος `complete:true`, `failedRequests:[]`, `downloadsVerified:true`, deliverySource και serverSource ακριβώς326819f7. Τα δύο πραγματικά downloads HTTP200 συμφωνούν με μεγέθη/hashes των GitHub assets.
- [Release-verification artifact12916815217](https://github.com/pavlos-argyris/fleet-control/actions/runs/40914348221/artifacts/12916815217), SHA256 `2c991c79230f5e994501b81a0ec38f6cd73e295a2bcd5e09d63c07d296a06c09`. Τα πλήρη checksums υπάρχουν στα release-manifest.json / SHA256SUMS.txt.
- Source `Fleet_Control_Source_v5.55.0.zip`: 66,852,980 bytes, SHA256 `ac0c707fca1cbff1aa096b54156b599b755cd796863509a4fc87016c5f227afd`.
- Client APK: 37,153,603 bytes, SHA256 `303a6884b541342536366d28b269e2397fa1c837f23408a74971b7936a031b85`.
- Server APK: 30,685,111 bytes, SHA256 `92c368a029de8065478740c70ff114c0a8db002d51b51c79211eca4fe7285976`.

**Συμπεριφορά και έλεγχοι:** μαζική επιλογή όλων των αναφερόμενων εκκρεμοτήτων από τη γενική προειδοποίηση Fleet, με καθαρισμό παλιών φίλτρων μόνο σε αυτή την ενέργεια. Server-first ή ρητό Workers AI, durable PDF+QR batch με παράθυρο2, ξεχωριστή ένδειξη QR queued έναντι πραγματικής ολοκλήρωσης, pause/resume/ανά εγγραφή αποτελέσματα, native persistent backoff1/2λεπτά και παύση στην τρίτη αποτυχία. Μικρές SQL-projected σελίδες/12 γραμμές preview, coalescing live Fleet ανά5δευτ., polling μόνο με ορατό διάλογο. Canonical/ανά πεδίο αποδεκτή βάση διατηρεί χειροκίνητες αποφάσεις· νέα πραγματική διαφορά μένει προς έλεγχο, document binding και stale-editor409. Κοινή διάκριση φίλτρου λαδιού από αλλαγή λαδιών χωρίς επανεκκίνηση κύκλου.

Worker/SQLite59items (57PDF+2QR), concurrent starts, pause/resume, διαγραφή service/μεμονωμένη αποτυχία, διατήρηση manual7000km έναντι νέας8000km/παλιού αποδεκτού evidence, επίμονη νέα διαφορά ποσού. Πραγματικό Workerd/D1 fixture57×512γραμμές,1,889,920bytes,15σελίδες/~5.2KB μέγιστη απόκριση,8ταυτόχρονες εκκινήσεις→μία operation. Πραγματικός Java queue/restart/reconcile/backoff και Java120-line πολυσέλιδο PDF→Worker normalization φίλτρου. Shipped JSDOM/session/visibility/global-filter regressions και πραγματικός Chromium desktop1440×1000/mobile390×844/Client file-landscape1024×768 πέρασαν. Πέντε εικόνες του CI40907021256 επιθεωρήθηκαν οπτικά (desktop progress, mobile επιλογή/failed-save/progress, Client landscape): συνεπές πράσινο θέμα, ευανάγνωστα κουμπιά, σαφές σφάλμα και διαθέσιμη επανάληψη, χωρίς οριζόντια υπερχείλιση. Το τελικό exact CI επανέλαβε τις browser assertions μετά το τελευταίο filter regression.

**Ενημέρωση και φυσική δοκιμή:** πρώτα OTA Server2.5.1, έπειτα Client5.55.0 και ανανέωση Web. Ρυθμίσεις→ενημερώσεις→Έλεγχος τώρα. Συμβατή ενημέρωση πάνω από την εγκατάσταση, χωρίς απεγκατάσταση/καθαρισμό δεδομένων. Web/Worker έχουν ήδη δημοσιευτεί. Η νέα PDF+QR recovery χρειάζεται τον νέο Server· ο2.5.0 δεν έχει το no-key QR batch native μονοπάτι. Ο χρήστης μετά επιλέγει τη γενική προειδοποίηση Fleet→Server (ή ρητά Workers AI). Μετά την αποδοχή στην ουρά μπορεί να κλείσει το UI· παυμένη εργασία έχει Συνέχιση, αποτυχία μένει ορατή. Οδηγός: [ISSUE_37_INVOICE_RECOVERY_GR.md](ISSUE_37_INVOICE_RECOVERY_GR.md).

**Όρια επαλήθευσης:** το #37 μένει ΑΝΟΙΚΤΟ για φυσική επιβεβαίωση. Δεν εκτελέστηκε παραγωγική μαζική επανεπεξεργασία, μεταβολή μισθοδοσίας/Ordexa, παραγωγικό backup/restore ή εγκατάσταση φυσικής συσκευής. Το source ZIP δεν είναι backup δεδομένων· δεν ελήφθη/ελέγχθηκε backup συσκευής ούτε downgrade. Δεν δόθηκε endpoint/Ray/log του συγκεκριμένου νέου CPU συμβάντος. Τα συνθετικά tests και synchronous wall-time/Server-Timing δεν αποτελούν μέτρηση παραγωγικού CPU, ούτε εγγύηση μηδενικών503.

**Παράλληλη άλλη συνομιλία:** μετά την ολοκλήρωση28/29/30 ανέλαβε το #40 / draft[PR41](https://github.com/pavlos-argyris/fleet-control/pull/41), `codex/ordexa-payable-day-fixes`, τελευταίο παρατηρημένο head `bb31a581ee13a5cf310cdb2eddba4382bcd1cc24`, υποψήφια5.56.0/Server2.5.2. Δεν έγινε επέμβαση στον δικό της κλάδο. Για τη συνέχεια διατηρεί ΟΛΟ το #37/πηγή326819f7 και την παρούσα τελική καταγραφή, συγχωνεύει το νεότερο main, ελέγχει εκ νέου και χρησιμοποιεί νεότερη έκδοση. Η5.55.0 είναι ήδη ενεργή· δεν ξαναδημοσιεύεται. Η παρούσα προσθήκη είναι μόνο τεκμηρίωση και δεν δημιουργεί νέο request/deploy.

