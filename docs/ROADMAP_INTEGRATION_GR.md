## Νεότερη ρητή οδηγία07/11/2026

Νεότερη έγκριση ιδιοκτήτη: merge/deploy όταν είναι όλα έτοιμα. Η προηγούμενη παύση αντικαταστάθηκε από αυτή την προϋπόθεση, χωρίς δεύτερη ίδια άδεια. Πραγματικό HTTP identity report και ρητή επιβεβαίωση παράδοσης/εξαφάνισης ακυρωμένων παραλήφθηκαν. Το αυτόματο Ταμείο πλέον υλοποιείται με πλήρη runtime gates, bounded local ledger, συμφιλίωση και κοινό120sec pilot. Απαιτείται επιβεβαίωση νέου exact-source CI/οπτικής αποδοχής και των υπόλοιπων release gates. Δεν έγινε merge/deploy/παραγωγική migration ή restore. Ο τρέχων οδηγός είναι [Νέο αυτόματο Ταμείο](ORDEXA_AUTO_CASH_20261107_GR.md).

# Fleet Control 5.61 — κοινή τελική ενοποίηση

Ενημέρωση 06/11/2026. Branch `codex/roadmap-integration-fleet-561`, PR #73.
Εγκεκριμένο πεδίο: `docs/APPROVED_ROADMAP_UI_20261105_GR.md` και τα δύο UI proposals.

## Πραγματική σημερινή υλοποίηση

| Issue | Υλοποίηση στον κώδικα | Απόδειξη και πρακτικό όριο |
|---|---|---|
| #59 | Typed frozen SQLite μεταφορά, πλήρης επαλήθευση πηγής/ιδιωτικών αρχείων, atomic promotion, native auth/business/receipts/audit, ECDH/AES-GCM relay, lease και ανάκληση, αποκλεισμός δεύτερου D1 writer | Πραγματικό Workerd/D1 και Java/Rhino/SQLite, χαμένη τελική απάντηση, concurrent admins, quota/offline/restart, ανάκληση και recovery. Η μεταφορά ενεργοποιείται από τον ιδιοκτήτη στη συσκευή μετά τις πύλες· δεν εκτελέστηκε παραγωγική μεταφορά από agent. |
| #60 | SQLite cash ledger, επιλεγμένα καταστήματα, χρονικοί κανόνες 2,50€/3€, καταχωρίσεις, παραλαβές/αντιλογισμοί/CAS/audit, οθόνες και PDF/XLSX | Ανεξάρτητο από μισθοδοσία. Πραγματικό identity report/owner semantics, local automatic applier/immutable reversals/pinned τιμές και ρητή manual συμφιλίωση. Η τελική κάλυψη απαιτεί πλήρη source και financial completion· νέο CI εκκρεμεί. |
| #61 | Streaming κρυπτογραφημένο φορητό FCB3, πλήρης native βάση/ιδιωτικά αρχεία, πραγματικό isolated restore, ασφαλής cold recovery και journal, retention, OTA fencing | Συμβατό FCB2, μεγάλα αντίγραφα με περιορισμένο heap, process-death core. Η αργή ανά-byte εγγραφή διορθώθηκε. Δεν υπάρχει φυσική δοκιμή Note10+/Drive/Keystore/fsync/helper lifecycle ή backup παραγωγής από agent. |
| #62 | Οικονομικά/Ανά ημέρα/Χρεώσεις, ημέρα/εβδομάδα/μήνας/διάστημα, ίδιος backend UI/PDF/XLSX, ιστορικοί όροι, alias CAS/tombstones, κάλυψη | 0 επιβεβαιωμένες παραγγελίες→0 χρέωση, άγνωστο δεν γίνεται μηδέν. Διατηρούνται οι δύο weekly PDF μορφές και audit της δημοσιευμένης 5.60.1 (#76/#77). |
| #63 | Versioned ουρά ελέγχου, αιτίες/source fingerprint, διατήρηση/επανεξέταση με audit, πραγματικά blockers χωριστά από υπομνήσεις | Ο άμεσος editor βάρδιας λειτουργεί με παλιό aggregate. Παραμένουν 6/10/15€, 02:00, Ordexa, συμφωνημένη στρογγυλοποίηση και κλειδωμένα ποσά. |
| #64 | Υγεία Server/Ordexa/stores/outbox/χώρου/backup-file/restore-proof, συνενωμένα περιστατικά, CAS acknowledgement, ασφαλής διάγνωση | Γνώση δεν σημαίνει επίλυση. D1 Άγνωστο χωρίς πραγματική μέτρηση. Δεν προστίθεται βαρύ polling ή υποτιθέμενο telemetry. |
| #8 | BootReceiver μη εξαγόμενος/action allowlist, manifest/OTA checks, σύγκριση πραγματικών signed ιστορικών APK και νέων compiled artifacts στο CI | Η νέα artifact σύγκριση απαιτεί την ακριβή εκτέλεση CI αυτού του commit. Το harmful-app μήνυμα υπάρχει ως αναφορά στο issue#8· φυσική αναπαραγωγή και απόφαση Google δεν έχουν παρατηρηθεί· το #8 δεν κλείνει ως Google clearance. |

Πλοήγηση: μόνο νέο κύριο μενού **Ταμείο διανομέων**, ίδιο compact bottom nav.
Ταμείο/καταστήματα 05:00–05:00 Europe/Athens, εβδομάδα Δευτέρα–Κυριακή.

## Επιβεβαιωμένο checkpoint

Source `dc5bf27f411800c6c5fc21973e5ec844d2277217`:
- Fast [42281646860](https://github.com/pavlos-argyris/fleet-control/actions/runs/42281646860) **SUCCESS**.
- Full [42281646837](https://github.com/pavlos-argyris/fleet-control/actions/runs/42281646837) **SUCCESS**: πραγματικό Chromium, file-origin Client, native/runtime/backup tests, δύο test-signed APK, Worker dry-run και πλήρες source handoff.
- Source artifact [13536870747](https://github.com/pavlos-argyris/fleet-control/actions/runs/42281646837/artifacts/13536870747), artifact ZIP SHA-256 `b1a2dc7007ad2c90d2b6b00f3bc5507a05e5845c6b404d908818a4096369c3c2`.

Τρέχουσα υποψήφια έκδοση: Fleet/Web/Client5.61.0, Client104, Server2.10.17(71), Worker5.18.8.
Οι επόμενες αλλαγές audit/visual-review απαιτούν νέο exact-source CI πριν από συγχώνευση.

## Παράδοση και αποδοχή

1. Ολοκλήρωση νέου artifact audit, πραγματική οπτική επιθεώρηση των συνθετικών Chromium screenshots και τυχόν διορθώσεις.
2. Επαλήθευση νεότερου main και exact PR/main CI. Προετοιμασία original-signed candidate για τελική φυσική/Play Protect επαλήθευση πριν από τη μία κοινή εξουσιοδοτημένη δημοσίευση. Η candidate διαδρομή δεν κάνει παραγωγικό deploy ή activation.
3. Πλήρες source ZIP/versions/checksums/οδηγίες και επιβεβαίωση ενεργοποίησης. Δημοσίευση δεν ισοδυναμεί με φυσική εγκατάσταση ή ενεργοποίηση primary στη συσκευή.
4. Η φυσική δοκιμή και τυχόν διαδικασία Google καταγράφονται χωριστά· δεν κλείνουν issues μόνο επειδή πέρασε συνθετικό CI.

Δεν εξουσιοδοτούνται παραγωγικό restore/διαγραφή, Ordexa writes, αλλαγή ιδιωτικών κλειδιών ή νέα έξοδα.
Η διόρθωση του νέου APK δεν παρακάμπτει τον ήδη εγκατεστημένο παλιό OTA backup gate.

## Ιστορική αφετηρία

Στις05/11/2026 από main `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd` ενοποιήθηκαν οι αρχικοί καθαροί πυρήνες των draft PR#66–#72.
Η τότε καταγραφή «λείπουν UI/DB/exports/auth/restore» περιέγραφε εκείνο το αρχικό checkpoint και **δεν αποτελεί τη σημερινή κατάσταση**.
Το επόμενο source ενσωματώνει και το atomic tariff fence του PR#79, με προστασία στο πραγματικό SQLite INSERT και διατήρηση προσχεδίου σε409.
Τα πραγματικά επόμενα checkpoints και τα παλιά αποτελέσματα διατηρούνται στο `docs/CHATGPT_HANDOFF_GR.md` και στο git history· μην ξαναξεκινήσεις ολοκληρωμένες ροές.
