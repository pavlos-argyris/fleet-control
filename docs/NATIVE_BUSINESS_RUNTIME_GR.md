# Τοπικές λειτουργίες και μεταφορά κύριας βάσης

Η κοινή έκδοση 5.61.0 παραμένει υπό ανάπτυξη στο draft PR #73. Αυτό το έγγραφο
περιγράφει τον πραγματικό νέο κώδικα και τα όρια των ελέγχων του. Δεν δηλώνει
ενεργοποίηση παραγωγικής μεταφοράς ή δοκιμή σε φυσικό τηλέφωνο.

## Ίδιοι κανόνες στη SQLite

Το `server-runtime/` συνδυάζει τους υπάρχοντες Worker business handlers με
native adapters. Ο ενσωματωμένος interpreted Rhino δεν έχει Java/Packages,
reflection, shell ή γενική πρόσβαση αρχείων. Οι εκδόσεις, SHA-256 και άδειες
παραδίδονται με τον πηγαίο κώδικα και το APK. Μόνο bundled κώδικας εκτελείται.
Κάθε αίτημα εκτελείται σε πραγματική συναλλαγή Android SQLite. Απόκριση 500,
αστοχία receipt ή εξάντληση instruction budget αναιρεί τις αλλαγές.

Οι μεταβολές απαιτούν operation UUID. Το receipt, το business αποτέλεσμα και
το audit δεσμεύονται στην ίδια συναλλαγή. Επανάληψη επιστρέφει το αποθηκευμένο
αποτέλεσμα. Διαφορετικό περιεχόμενο με ίδιο ID ή αλλαγή λογαριασμού/δικαιωμάτων
απορρίπτονται. Login/ανάκληση χρησιμοποιούν την ίδια ελεγμένη υλοποίηση auth
και τους υπάρχοντες salted PBKDF2 κωδικούς στη νέα τοπική βάση.

## Φραγή D1 και ασφαλής πύλη

Το `primary-authority.js` χρησιμοποιεί το υπάρχον FleetEvents Durable Object,
χωρίς νέα υπηρεσία ή binding. Μικρή κατάσταση ελέγχου, P-256 ταυτότητα Server
και opaque κρυπτογραφημένα packets διατηρούνται στην πύλη. Επιχειρησιακά
δεδομένα, receipts και καθαρά αιτήματα δεν μεταφέρονται στη D1 της πύλης.

Η προετοιμασία απαιτεί Server credential **και επιβεβαίωση πραγματικού owner**.
Ατομικό D1 batch εγκαθιστά write-denial triggers και επανελέγχει τον owner πριν
αλλάξει το writer fence. Έτσι αποκλείονται και παλιά αιτήματα που είχαν ήδη
ξεκινήσει πριν τη μεταφορά. Το τελικό export γίνεται σε σταθερές σελίδες με
rowids/metadata. Παλιές συνεδρίες cloud δεν εισάγονται ως ενεργές τοπικές.

Η ακύρωση δεσμεύει πρώτα την κατάσταση `aborting`, ώστε να μην μπορεί να
συμπέσει με activation. Καθυστερημένη παλιά προσπάθεια fence δεν μπορεί να
αναιρέσει ακύρωση με το ίδιο ticket. Μια ενεργή κύρια βάση δεν επιστρέφει από
αυτό το κουμπί στην παλιά cloud βάση. Απώλεια activation ACK είναι idempotent.
Η σύνδεση Server απαιτεί υπογραφή P-256 σε nonce μίας χρήσης. Η παλιά read-only
σύζευξη αποκλείεται μετά τη μετάβαση, ώστε να μην υποκαθιστά την τρέχουσα ανάκληση.

Το API απαιτεί proof πλήρους σύγκρισης/απομονωμένης ανάκτησης πριν ενεργοποίηση.
Η ολοκληρωμένη native διαδικασία migration, lease, αρχεία και οι τελικές οθόνες
είναι το επόμενο βήμα του ίδιου PR. Οι μεμονωμένοι έλεγχοι backend δεν αρκούν
για να ενεργοποιηθεί πραγματική authority.

## Ταμείο διανομέων

Οι αρχικές αυτόματες αντιστοιχίσεις order→courier δεν έχουν επαληθευτεί σε
πραγματική πηγή. Χρησιμοποιούνται ρητές χειροκίνητες καταχωρίσεις με σταθερό
Fleet employee/store ID. Τα `cash.view` / `cash.manage` δίνονται στους
διαχειριστικούς ρόλους manager/payroll_manager· ο employee δεν τα αποκτά με
γενικό override. Η πηγή/χειροκίνητη καταχώριση δηλώνονται στην προβολή.

Versioned κανόνες ανά κατάστημα/κατηγορία/ημέρα, αμετάβλητες κινήσεις οφειλής,
παραλαβής και αντιλογισμού, ιστορική τιμή ανά κίνηση και χωριστό audit. Δεν
τροποποιούνται μισθοδοσία, χρεώσεις καταστημάτων ή Ordexa. Ημέρα 05:00–05:00
Αθήνας. Οι αρχειοθετημένοι εργαζόμενοι διατηρούν το οικονομικό τους ιστορικό.

## Αναφορές καταστημάτων και εξαγωγές

Αναφορές από τα υπάρχοντα `local_day` snapshots και την πραγματική κάλυψη,
στην ενεργή πηγή μόνο. Ημέρα, εβδομάδα Δευτέρα–Κυριακή, μήνας και διάστημα.
Άγνωστες/ελλιπείς ημέρες κρατούν άγνωστα τελικά σύνολα και ξεχωριστό γνωστό
μερικό ποσό. Explicit aliases απαιτούν CAS και audit· δεν επιτρέπονται κύκλοι.

Η νεότερη απαίτηση 0 παραγγελίες → 0 πάγιο εφαρμόζεται στον native engine v2,
ακόμη και όταν παλιοί Ordexa όροι περιέχουν chargeOnZero=true. Οι πηγαίοι όροι
διατηρούνται. Παλιό ασύμβατο snapshot επισημαίνεται για επανυπολογισμό· δεν
παρουσιάζεται διαφορετικό σιωπηρό σύνολο μόνο στην αναφορά. Δεν δημιουργείται
μηδενική χρέωση όταν λείπει η ίδια η ανάγνωση της ημέρας.

Excel/PDF λαμβάνουν τον ίδιο prepared πίνακα. Ακριβή cents σε πραγματικά
αριθμητικά Excel κελιά, κείμενα ως inline strings για αποφυγή formulas,
ενσωματωμένη ελληνική γραμματοσειρά PDF, αναδίπλωση και επαναλαμβανόμενες
κεφαλίδες. Τα ελλιπή ποσά γράφονται «Άγνωστο». Δεν αποστέλλονται σε τρίτη υπηρεσία.

## Έλεγχος μισθοδοσίας και υγεία

Η ουρά ελέγχου βασίζεται στις πραγματικές Server προβολές, με fingerprint
πηγής/κανόνα/πληρωτέου/απόφασης, CAS και append-only ιστορικό. Advisory εκτός
προγράμματος δεν αλλάζει έγκυρες ώρες και δεν γίνεται νέος blocker. Πραγματικό
payment blocker παραμένει μέχρι ελεγμένη απόφαση στο υπάρχον shift editor.
Κλειδωμένα ποσά και πραγματικές ώρες πηγής δεν ξαναγράφονται από την ουρά.

Η υγεία χρησιμοποιεί allowlisted πραγματικά metrics. Άγνωστη μέτρηση δεν
επιλύει παλιό πρόβλημα. Ειδοποιήσεις συνενώνονται ανά code/generation, ack και
resolution αποθηκεύονται χωριστά, επανεμφάνιση απαιτεί νέο ack. Η διαγνωστική
εξαγωγή αποκλείει credentials, ονόματα, notes και raw errors. D1 quota χωρίς
πραγματική εγκεκριμένη μέτρηση παραμένει Άγνωστο.

## Πραγματικοί έλεγχοι

- `test-primary-authority.mjs`: actual Workerd/D1/Durable Objects, owner TOCTOU,
  παλιός writer, export, abort/activate, lost ACK, registration/replay,
  legacy revocation, encrypted relay, lease messages, D1-unavailable/static path.
- `test-business-runtime-native.mjs`: πραγματική Java/SQLite, auth/permissions,
  revoked sessions, atomic receipt, injected SQL failure/rollback, >5 MiB
  Unicode/CursorWindow, cash/report/review/health API σενάρια, budget/integrity.
- `test-financial-export-native.mjs`: πραγματική PDFBox/OOXML δημιουργία από
  τα κοινά export specs, ανεξάρτητο openpyxl/pypdf και rendered PNG. Ελληνικά,
  αριθμητικά ποσά, άγνωστα πεδία, formula injection, πολλαπλές σελίδες.

Οι συνθετικοί έλεγχοι δεν αποτελούν παραγωγικό backup, εγκατάσταση σε φυσική
συσκευή, Play Protect απόφαση ή επιβεβαιωμένη ενεργοποίηση της μεταφοράς.


## Ατομική εισαγωγή canonical δεδομένων — 06/11/2026

Ο υπάρχων `NativeFrozenImportV3` παραμένει απομονωμένος staging importer. Πλέον αποθηκεύει επιπλέον SHA-256 **όλου του τυποποιημένου περιεχομένου**, με table/column order, stable rowids, NULL, 64bit INTEGER, binary64 REAL, ακριβές UTF-8 και BLOB. `NativeFrozenDigest` το επαληθεύει ξανά απευθείας στη SQLite με τμήματα32KiB, ακόμη για μεγάλο cell που δεν χωρά σε CursorWindow.

Ο νέος `NativePrimaryPromotion` αντιγράφει το ελεγμένο candidate στην ήδη δημιουργημένη **pinned native business schema**, σε μία πραγματική συναλλαγή. Απαιτεί τα tables του υπογεγραμμένου runtime manifest, συμβατά columns/constraints, ίδιο realm/generation/επιβεβαιωμένο owner και αποθηκευμένο content hash. Άγνωστο/ασύμβατο schema απορρίπτεται. Τοπικά bikes/settings/queues/order ledgers δεν αποτελούν στόχο εισαγωγής. Δεν εκτελείται SQL από το cloud.

Προσωρινά αναστέλλονται μόνο τα ήδη εγκατεστημένα bundled triggers μέσα στην ίδια συναλλαγή, και επανεγκαθίστανται πριν από commit. Έλεγχος όλων των τελικών values/types/hash, canonical constraints, foreign keys/integrity και ενεργού owner προηγείται της αποθήκευσης phase`prepared`. Οι παλιές συνεδρίες αφαιρούνται, το παράγωγο mirror epoch αλλάζει και κλειδωμένα ποσά/audit αντιγράφονται ακριβώς. Οποιαδήποτε αστοχία/ακύρωση αναιρεί και αντιγραφές και triggers και phase. Replay μετά από χαμένο ACK συγκρίνει ξανά τον πραγματικό προορισμό· ενεργό primary δεν επιτρέπεται να αντικατασταθεί.

Το `prepared` **δεν ενεργοποιεί business writes**. Ο native controller εξακολουθεί να χρειάζεται authenticated Worker fence, διακοπή τοπικών pipelines σε ασφαλές σημείο, πλήρη αντιγραφή ιδιωτικών αρχείων, προστατευμένο backup και πραγματική δοκιμή ανάκτησης, activation και τρέχον lease. Αυτή η διασύνδεση/transport/UI είναι ακόμη σε ανάπτυξη, δεν έγινε παραγωγική μεταφορά. Τα παράγωγα frozen staging tables αφαιρούνται από το φυσικό αντίγραφο backup ώστε να μη διπλασιάζουν το πλήρες canonical ιστορικό.

`test-native-primary-promotion.mjs`: actual SQLite >5MiB Unicode, ακριβές64bit/REAL/BLOB/NULL, αλλοίωση candidate, SQL fault, διακοπή μετά την πραγματική αντιγραφή, canonical unique constraint, audit trigger rollback, τοπικές εκκρεμότητες, sessions, lostACK, ενεργή generation. Ανεξάρτητος Python SHA-256 oracle ανοίγει την τελική SQLite και επιβεβαιώνει όλο το hash, όχι μόνο έναν counter. Νέο exact saved-source CI απαιτείται πριν από αποδοχή έκδοσης.


## Primary transport και επαναφορά identity — 06/11/2026

Ο νέος cipher έχει domain`fleet-primary-v1`, διαφορετικό από το παλιό read-only pairing. Κάθε packet δένεται με realm, generation, ephemeral key, nonce και direction. Η P-256 υπογραφή εγγραφής είναι P1363/WebCrypto compatible. Το TLS WebSocket εφαρμόζει κανονική επαλήθευση CA/hostname και bounded RFC6455 frames. Java/WebCrypto και actual TLS tests ελέγχουν και τις δύο κατευθύνσεις.

Η άδεια30s υπολογίζεται από τη **μονοτονική ώρα αποστολής**, όχι από την ώρα λήψης του ACK. Η παραγωγική πηγή χρόνου είναι `SystemClock.elapsedRealtime` για λήξη και μέσα σε deep sleep. Έλεγχος χρειάζεται πριν την έναρξη και πριν το commit, σε υπηρεσία με χωριστό reader/heartbeat από την ουρά SQL. Το31s handover gap υπερβαίνει κάθε προηγούμενη άδεια. Η αλλαγή DO state φράζει events έως την πραγματική ολοκλήρωση durabletransaction· commitfailure δεν δημοσιεύει in-memory authority.

Η ακύρωση αφήνει μόνιμο D1 tombstone ανά migrationticket, ώστε καθυστερημένο fence να μην αναστηθεί μετά από διαφορετικές μεταφορές. R2 inventory/seed προσφέρονται μόνο με ιδιωτικό ticket και ολοκληρωμένο fence. Το seed διατηρεί το υπάρχον PIN/session namespace χωρίς μεταφορά του στους clients. Τα κανονικά νέα business αιτήματα παραμένουν κρυπτογραφημένα. Το κεντρικό HTTP transport απορρίπτει αποκρυπτογραφημένο NativeRoot πριν από networkopen, αντί να το στείλει σε legacy importendpoint.

Η recovery reservation χρειάζεται root capability του FCB3 και τοπικά verifiedrestore/documents/accountsreview. Σταματά την παλιά σύνδεση και τα παλιά signedchallenges, περιμένει31s, απαιτεί νέο verifiedbackup και ενεργοποιεί νέο publickey/generation με περιστροφή capability. Χαμένα ACK είναι idempotent. Αν αποτύχει δεύτερη συσκευή πριν το τέλος, το capability του ήδη καταχωρισμένου candidatebackup μπορεί να δεσμεύσει τρίτη identity· η παλιά reservation παύει να ισχύει. Η authorizingcapability παραμένει έγκυρη έως τη νέα επιτυχή ολοκλήρωση, μετά αποσύρεται. Δεν ανακτώνται private devicekeys από backup.

Οι παραπάνω είναι πραγματικοί helpers/controls με actual Java/Workerd tests, **όχι ακόμη πλήρης λειτουργική recovery/primary υπηρεσία**. Native controller, protected responsechunk transport, atomic coldstart restore και UI ακολουθούν πριν τη δημοσίευση. Καμία παραγωγική μεταφορά/επαναφορά δεν εκτελέστηκε.
