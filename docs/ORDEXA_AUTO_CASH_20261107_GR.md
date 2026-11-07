# Αυτόματο Ταμείο Ordexa — εγκεκριμένη επέκταση07/11/2026

Η απαίτηση είναι το [εγκεκριμένο σχόλιο του PR#73](https://github.com/pavlos-argyris/fleet-control/pull/73#issuecomment-6698903220). Νεότερη άδεια: merge/deploy όταν ολοκληρωθούν το συμφωνημένο scope και οι πύλες ελέγχου, χωρίς δεύτερη ίδια επιβεβαίωση. Το PR παραμένει υπό έλεγχο· δεν έγινε production merge/deploy/restore.

## Πραγματικά δεδομένα και επιβεβαίωση ιδιοκτήτη

Ο χρήστης έδωσε report πραγματικής εκτέλεσης diagnostic0.1.0 στις07/11, SHA-256 `4857c6e9342383de2537ce05bd5552cce0373f182420e9199021dcae927c8e73`. HTTP200 JSON page1/repeat1/page2,50rows/page,138/3pages, envelope options/page/pages/rows/sums/total. Επιβεβαιώθηκαν numeric id/riderId/shopId, ISO at με timezone και nickname rider, με ίδιες sampled identities στην επανάληψη. Δεν ήταν πλήρες snapshot· δεν διαβάστηκε η τελευταία σελίδα. Το αρχικό report/προσωπικά δεδομένα/HMAC tags δεν καταχωρίζονται.

Στη συνέχεια απάντησε ρητά «Εξαφανίζονται» για ακυρωμένες παραγγελίες και «Παράδοση» για τον χρόνο. Το contract `ordexa-delivered-orders-20261107-v1` επομένως ορίζει at=παράδοση, ημέρα[05:00,επόμενη05:00) Europe/Athens και αντιλογισμό απουσίας μόνο μετά από δύο πλήρεις συνεπείς λήψεις. Δεν υποτίθεται status πεδίο. zeroCharge/straight/tooFar/income/charge/riderCost δεν γίνονται κανόνες απόδοσης ή ακύρωσης. Τα schema-only διαγνωστικά εξακολουθούν να δηλώνουν false financial approval: μόνο runtime source/configuration/ledger gates επιτρέπουν χρήματα.

## Υλοποίηση στον Server

- Ο ίδιος `StoreBillingSync` διαβάζει κάθε σελίδα και για Καταστήματα και για Ταμείο. Δύο πλήρεις pass, stable scoped IDs/streamed digest, rider-change guard, atomic snapshot/alias history. Κανένας δεύτερος provider fetcher ή raw order/rider outbox προς D1.
- Το `CashSync` ζητά τρέχουσα και προηγούμενη05-day ανά120sec μόνο για ενεργή κύρια βάση/lease με συμμετέχοντα καταστήματα ή ενεργές χρεώσεις. Συμπτύσσει pending αιτήματα και δεν τρέχει interpreter όταν είναι idle. Το τοπικό internal port εφαρμόζει έως200 IDs/transaction. Η persisted provider αναμονή μετά από αποτυχία τηρείται ακόμη μετά restart ή νέο manual αίτημα. Attendance παραμένει5min·60sec δεν εγκρίθηκε από μικρά sample timings.
- Τοπικό global(scope,orderId) state και immutable events/history: νέα παράδοση→χρέωση, ακύρωση→ακριβής αντιλογισμός, αλλαγή rider/shop/day→αντιλογισμός και νέα χρέωση. Αν παλιό/νέο day snapshot διαφωνούν, διατηρείται η παλιά οικονομική κατάσταση και ζητείται πλήρης επανέλεγχος. Τα processed IDs είναι σταθερά και η επανάληψη δεν διπλοχρεώνει.
- Επιλέγονται μόνο καταστήματα με δικούς μας χρονικούς κανόνες απόδοσης. Υπάρχουσες επιβεβαιωμένες χρεώσεις κρατούν τη δική τους ιστορική τιμή· οι νέες παίρνουν τον ισχύοντα κανόνα. Αλλαγή κανόνα σε μερική αρχική παρτίδα δεν αφήνει τυχαίες διαφορετικές τιμές. Πολλαπλές ενεργές κατηγορίες ή μη αντιστοιχισμένο rider μπλοκάρουν το τελικό αυτόματο σύνολο.
- Αντιστοιχίσεις scoped Ordexa rider ID→υπάρχων εργαζόμενος, ημερομηνία ισχύος/immutable CAS και ιστορικό παρατσουκλιών. Καμία fuzzy σύνδεση, νέος εργαζόμενος ή αλλαγή μισθοδοσίας.

## Μετάβαση και οθόνες

Οι παλιές χειροκίνητες ποσότητες δεν συνυπολογίζονται σιωπηρά με τις αυτόματες. Η ημέρα μένει «Συμφιλίωση παλιών ποσοτήτων». Η καρτέλα **Αυτόματο** δείχνει τις ημέρες, εκκρεμότητες και πραγματική τελευταία ολοκληρωμένη λήψη. «Έλεγχος συμφιλίωσης» δείχνει παλιά ποσά και παραδόσεις Ordexa. Μόνο ρητή checked απόφαση με ίδιο source/config/manual proof αντιλογίζει τις παλιές ποσότητες και δρομολογεί τις αυτόματες. Οι αρχικές κινήσεις και όλες οι παραλαβές χρημάτων διατηρούνται. Αλλαγή proof απαιτεί νέα προεπισκόπηση·409 κρατά το προσχέδιο.

Ρητός αντιλογισμός αυτόματης χρέωσης δημιουργεί versioned εξαίρεση, που δεν αναιρείται στο επόμενο refresh. Η επαναφορά απαιτεί ξεχωριστή αιτιολογημένη CAS ενέργεια. Η συνήθης κύρια ενέργεια είναι «Παραλαβή χρημάτων». Ιστορικές χειροκίνητες ποσότητες διατηρούνται για έλεγχο· νέα ποσότητα δεν προστίθεται πάνω σε ενεργή αυτόματη ημέρα/κατάστημα.

Η λίστα δείχνει τελική «Οφειλή διανομέα προς την επιχείρηση» μόνο με πλήρη source **και** ολοκληρωμένη financial coverage. Pending/partial/unmapped/manual-review/backoff/error κρατούν τα καταγεγραμμένα ποσά χωριστά. Inline ανάπτυξη περιλαμβάνει κατάστημα, παραγγελίες×ιστορική τιμή, χρεώσεις, παραλαβές και υπόλοιπο. Στο άνοιγμα εμφανίζεται πρώτα η cache και μετά μπαίνει async αίτημα στον κοινό reader· τα περιοδικά UI/live refresh δεν παράγουν νέα provider εργασία. Read-only χρήστης δεν κάνει χρηματικές εγγραφές ή αιτήματα πηγής.

## Backup, έλεγχοι και όρια

Το πλήρες physical SQLite/FCB3 περιέχει auto day/order state, immutable history, εξαιρέσεις/συμφιλιώσεις, source aliases/mappings/queue και το αρχικό ledger/receipts. Η ανάκτηση δεν επανενεργοποιεί παλιά primary identity. Το legacy selective store restore κρατά το cash history και επιβάλλει νέα source λήψη.

Πέρασαν στοχευμένα actual Node SQLite1055/201 batch tests, πραγματικό Java/Rhino/SQLite native financial API με injection rollback/χαμένη απάντηση, πλήρες snapshot/FCB3/isolated/cold recovery και πραγματικοί Java reader/pilot tests. Νέες DOM assertions καλύπτουν reconciliation, explicit preview/CAS, exclusions, honest totals και open-only refresh. Το exact-head πλήρες CI, Chromium screenshots και δύο APK χρειάζονται επιβεβαίωση στο νέο checkpoint.

Client/Web5.61.0(code103), Server2.10.16(code70), Worker5.18.8. Diagnostic παραμένει0.1.0/code1 χωρίς επανεγκατάσταση. Δεν έχει τρέξει το πλήρες Fleet source/financial pipeline στην παραγωγική συσκευή· Note10+/Drive/Keystore/Google/πραγματικό backup και πλήρες provider performance δεν δηλώνονται ως ελεγμένα. Οι272/149/117ms του sample δεν είναι πλήρες benchmark. Διατηρούνται οι κανόνες release/backup/primary activation· κανένα source artifact δεν είναι backup παραγωγικών δεδομένων.

## Ιστορικό checkpoint και αρχική πύλη

Το source4ca81c7 πέρασε Fast42286421655/full42286421033. Περιέχει λειτουργικά
native business/auth/backup/recovery, cash ledger, reports, payroll review και
health. Η παρούσα επέκταση δεν ξανακατασκευάζει αυτά τα τμήματα.

Στις07/11 επιβεβαιώθηκε ενεργή εξουσιοδοτημένη σύνδεση Ordexa και η προβολή
«Ανά παραγγελία»: 50 γραμμές και22 σελίδες στην επιλεγμένη ημέρα. Τα IDs των
γραμμών δεν υπάρχουν στα ορατά DOM attributes. Δεν καταγράφηκε HTTP response
παραγγελιών. Ο Cloud Browser δεν παρέχει Network API/WebMCP και το εγγενές
Chromium εμφάνισε οργανωτικό αποκλεισμό DevTools. Δεν παρακάμφθηκε αυτός ο
περιορισμός. Μία άμεση ανάγνωση της ήδη γνωστής GET διαδρομής μέσω browser
επέστρεψε JSON σφάλματος, χωρίς rows· δεν τεκμηριώνεται η αιτία ως συγκεκριμένο
auth/status error. Δεν εξήχθησαν cookies, token ή credentials από τον browser.

Πριν ενεργοποιηθεί αυτόματη οικονομική εφαρμογή απαιτούνται:

1. Πραγματικά σταθερά order ID, rider ID και shop ID στο συγκεκριμένο scope.
2. Πραγματικό envelope/pagination, ίδιο order ID σε επανάληψη και όρια ίδιων timestamps.
3. Επιβεβαιωμένη σημασία χρόνου, timezone και ημερολογιακού παραθύρου.
4. Πραγματικό λεξιλόγιο status, cancellation/reassignment/deletion semantics.
5. Χρονικά/HTTP στοιχεία από native συσκευή και ασφαλής συχνότητα παρόχου.

Δεν επιλέγεται υποθετικό rider JSON key. Η αυτόματη χρέωση και το120s polling
είναι **ανενεργά**. Τα60s παραμένουν στόχος μόνο μετά από πραγματικές μετρήσεις.
Ο πεντάλεπτος συγχρονισμός παρουσιών και η υπάρχουσα ροή καταστημάτων διατηρούνται.

## Τι υλοποιείται τώρα χωρίς υπέρβαση της πύλης

- Συνοπτική λίστα διανομέων αντί μεγάλων καρτών. Πατώντας τη γραμμή, αναπτύσσεται
  ακριβώς από κάτω η ανάλυση· χωρίς modal και με κανονικό κουμπί/πληκτρολόγιο.
- Ανάλυση ανά κατάστημα/κατηγορία/**ιστορική τιμή**, π.χ.10×2,50€ και10×3€.
  Διαφορετικές πραγματικές τιμές παραμένουν χωριστές, χωρίς μέση τιμή ως δήθεν tariff.
- Ενεργοί εργαζόμενοι χωρίς κινήσεις παραμένουν στη λίστα. Μηδενικές
  καταγεγραμμένες κινήσεις δεν παρουσιάζονται ως επιβεβαιωμένο αυτόματο μηδέν.
- Κεντρική ένδειξη «Οφειλή διανομέα προς την επιχείρηση» γίνεται «Προς
  επιβεβαίωση» χωρίς verified coverage. Το γνωστό υπόλοιπο του παλιού ledger
  φαίνεται χωριστά. Τα ιστορικά χρήματα/παραλαβές/αντιλογισμοί διατηρούνται.
- Το lastCompleteAt δεν παράγεται από ώρα ανοίγματος/GET/αποτυχίας. Pending,
  partial, unmapped, stale και error αποκλείουν παρουσίαση νέου οριστικού ποσού.
- Ανοικτή ανάλυση και focus διατηρούνται κατά την ενημέρωση του ledger.
  Ανοικτό προσχέδιο φόρμας συνεχίζει να προστατεύεται.
- Η αρχική πύλη επέστρεφε409 πριν από τα πραγματικά IDs. Η νέα ασφαλής λήψη επιστρέφει202 για αναμονή στην κοινή ουρά, χωρίς να ισχυρίζεται ολοκλήρωση ή οικονομική εφαρμογή.

## Αποπροσωποποιημένο τεχνικό δείγμα από τον κοινό reader

Το υπάρχον OrdexaClient κρατά για τις ήδη επιτρεπόμενες GET orders αναγνώσεις
μόνο HTTP status, media type, bytes και monotonic διάρκεια. Δεν γράφει
Authorization, cookies, πλήρες URL, credentials ή body σε logs.

Ο StoreBillingSync παρατηρεί τις πρώτες σελίδες των υπαρχόντων passes.
Δεν προστίθεται κανένα provider request. Ο StoreBillingProtocol εξάγει envelope
και row field types, pagination και έως δύο sampled rows με έως24 πεδία.
Όλες οι scalar τιμές γίνονται HMAC proof tags με process-local τυχαίο κλειδί,
το οποίο δεν αποθηκεύεται ούτε εξάγεται. Τα tags συσχετίζονται μόνο εντός του
ίδιου process/source scope. Όνομα, πραγματικό ID, status value, ακριβής ώρα
παραγγελίας και στοιχεία πελατών δεν εξάγονται. Ευαίσθητα keys παραλείπονται.

Η παρατήρηση αποθηκεύεται σε μία bounded local SQLite cell ανά scope, έως δύο
frames, dirty=false. Δεν τροφοδοτεί order/cloud outbox. Η αποτυχία diagnostic
δεν ακυρώνει τον αρχικό συγχρονισμό. Αποθηκεύεται πριν από την υπάρχουσα
κανονική validation, επομένως **δεν** αποδεικνύει αποδεκτή/πλήρη λήψη.

Μετά από ανάγνωση/restore ανακατασκευάζεται allowlist. Το semanticsVerified και
το automaticWritesEnabled παραμένουν false, ακόμη αν το αρχείο τα ισχυρίζεται true.
Το artifact δείχνει δομή και συσχετίσεις, όχι ερμηνεία rider/time/status ή
υπογραφή του παρόχου. Περιορισμένο sample δεν αποδεικνύει απουσία κάποιου πεδίου.

Πρόσβαση στο Server: Ρυθμίσεις → Διαγνωστικά → «Έλεγχος σύνδεσης παραγγελιών
Ordexa» → Αντιγραφή ελέγχου. Είναι τοπική ανάγνωση, λειτουργεί και πριν από
primary migration και δεν εκτελεί νέο HTTP αίτημα. Στο native Web/Client υπάρχει
αντίστοιχη ασφαλής εξαγωγή διάγνωσης με δικαίωμα cash.manage.
Η απουσία δείγματος εμφανίζεται ρητά και δεν προσφέρει κουμπί παράκαμψης.

Το πλήρες typed native backup περιλαμβάνει την τοπική SQLite cell. Το legacy
selective store archive δεν μετατρέπει diagnostic παρατήρηση σε επιχειρησιακό
proof· μπορεί να ξανασυλλεχθεί. Η νεότερη φάση προσθέτει τις source αντιστοιχίσεις και cells που περιγράφονται παραπάνω, με πραγματική κάλυψη πλήρους backup. Δεν υπάρχει ακόμη νέος οικονομικός applier/outbox.

## Επόμενη λειτουργική φάση μετά την πραγματική επαλήθευση

Επαλήθευση source contract και επαναχρησιμοποίηση της scoped ρητής αντιστοίχισης
rider ID→Fleet employee με nickname history, ποτέ fuzzy names. Κοινό persisted
staging/coverage και bounded συμφιλίωση μεταβαλλόμενων totals, idempotent outbox/
inbox προς το υπάρχον immutable ledger, reversals σε αλλαγές rider/shop/status,
και ρητή συμφιλίωση παλιών χειροκίνητων ποσοτήτων πριν από auto activation.
Οι ανεξάρτητοι κανόνες250/300cents,05:00–05:00 Europe/Athens, πραγματικές παραλαβές
και η αμετάβλητη μισθοδοσία διατηρούνται. Ακολουθούν οι δοκιμές του εγκεκριμένου
σχολίου0/1/50/51/1055 orders, live additions, same-time paging, cancellations,
identity changes, crash/restore, offline/errors και responsive UI.

Αυτή η φάση **δεν σημειώνεται ολοκληρωμένη** από τη συλλογή metadata ή από
συνθετικά fixtures. Η πλήρης αυτόματη τροφοδότηση παραμένει εκκρεμής στην πύλη.

## Έλεγχοι αυτού του checkpoint

PASS οι πραγματικές Java/SQLite διαδρομές αποθήκευσης: μία diagnostic cell,
έως δύο frames, scope isolation, dirty/outbox κενά και επαναπροβολή allowlist.
Το synthetic HTTPS fixture ελέγχει metadata/privacy/error status και bounded
sampling0/1/50/51/1055 rows· **δεν** αποτελεί πραγματικό HTTP contract ή έλεγχο
πλήρους νέας pagination. Το πραγματικό κοινό business runtime/FCB3 recovery
και οι DOM έλεγχοι παραμένουν green. Και τα δύο APK κατασκευάστηκαν τοπικά με
προσωρινή test υπογραφή, όχι για εγκατάσταση πάνω από τα παραγωγικά APK.
Το local Chromium δεν ξεκίνησε λόγω socket policy· τα πραγματικά browser
αποτελέσματα και το πλήρες source ZIP παρέχονται από το exact-head CI του PR#73.
