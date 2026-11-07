## Επιβεβαιωμένη δημοσίευση 07/11/2026

Το PR #73 συγχωνεύτηκε και η [Fleet 5.61.0](https://github.com/pavlos-argyris/fleet-control/releases/tag/fleet-v5.61.0)
ενεργοποιήθηκε ως κανονική ενημέρωση στις 07/11/2026, 22:13:59 ώρα Ελλάδας,
μετά το πλήρες συμφωνημένο scope, τους ελέγχους και την υπάρχουσα έγκριση.
Η πραγματική λήψη Client/Server επαληθεύτηκε με SHA-256.
Δεν εκτελέστηκε παραγωγική μεταφορά κύριας βάσης ή restore.
Ο τρέχων οδηγός είναι [Αυτόματο Ταμείο](ORDEXA_AUTO_CASH_20261107_GR.md).

# Fleet Control 5.61 — κοινή τελική ενοποίηση

Ενημέρωση 07/11/2026. PR #73 συγχωνευμένο στο `main` ως `527287a4a0b80685d1dd041792b36706f7c4e824`.
Εγκεκριμένο πεδίο: `docs/APPROVED_ROADMAP_UI_20261105_GR.md` και τα δύο UI proposals.

## Πραγματική σημερινή υλοποίηση

| Issue | Υλοποίηση στον κώδικα | Απόδειξη και πρακτικό όριο |
|---|---|---|
| #59 | Typed frozen SQLite μεταφορά, πλήρης επαλήθευση πηγής/ιδιωτικών αρχείων, atomic promotion, native auth/business/receipts/audit, ECDH/AES-GCM relay, lease και ανάκληση, αποκλεισμός δεύτερου D1 writer | Πραγματικό Workerd/D1 και Java/Rhino/SQLite, χαμένη τελική απάντηση, concurrent admins, quota/offline/restart, ανάκληση και recovery. Η μεταφορά ενεργοποιείται από τον ιδιοκτήτη στη συσκευή μετά τις πύλες· δεν εκτελέστηκε παραγωγική μεταφορά από agent. |
| #60 | SQLite cash ledger, επιλεγμένα καταστήματα, χρονικοί κανόνες 2,50€/3€, καταχωρίσεις, παραλαβές/αντιλογισμοί/CAS/audit, αυτόματο Ordexa, οθόνες και PDF/XLSX | Ανεξάρτητο από μισθοδοσία. Πραγματικό identity report/owner semantics, local automatic applier/immutable reversals/pinned τιμές και ρητή manual συμφιλίωση. Πλήρες CI επιτυχές. Η τελική κάλυψη απαιτεί ενεργή κύρια βάση, πλήρη source και financial completion. |
| #61 | Streaming κρυπτογραφημένο φορητό FCB3, πλήρης native βάση/ιδιωτικά αρχεία, πραγματικό isolated restore, ασφαλής cold recovery και journal, retention, OTA fencing | Συμβατό FCB2, μεγάλα αντίγραφα με περιορισμένο heap, process-death core. Η αργή ανά-byte εγγραφή διορθώθηκε. Δεν υπάρχει φυσική δοκιμή Note10+/Drive/Keystore/fsync/helper lifecycle ή backup παραγωγής από agent. |
| #62 | Οικονομικά/Ανά ημέρα/Χρεώσεις, ημέρα/εβδομάδα/μήνας/διάστημα, ίδιος backend UI/PDF/XLSX, ιστορικοί όροι, alias CAS/tombstones, κάλυψη | 0 επιβεβαιωμένες παραγγελίες→0 χρέωση, άγνωστο δεν γίνεται μηδέν. Διατηρούνται οι δύο weekly PDF μορφές και audit της δημοσιευμένης 5.60.1 (#76/#77). |
| #63 | Versioned ουρά ελέγχου, αιτίες/source fingerprint, διατήρηση/επανεξέταση με audit, πραγματικά blockers χωριστά από υπομνήσεις | Ο άμεσος editor βάρδιας λειτουργεί με παλιό aggregate. Παραμένουν 6/10/15€, 02:00, Ordexa, συμφωνημένη στρογγυλοποίηση και κλειδωμένα ποσά. |
| #64 | Υγεία Server/Ordexa/stores/outbox/χώρου/backup-file/restore-proof, συνενωμένα περιστατικά, CAS acknowledgement, ασφαλής διάγνωση | Γνώση δεν σημαίνει επίλυση. D1 Άγνωστο χωρίς πραγματική μέτρηση. Δεν προστίθεται βαρύ polling ή υποτιθέμενο telemetry. |
| #8 | BootReceiver μη εξαγόμενος/action allowlist, manifest/OTA checks, σύγκριση πραγματικών signed ιστορικών APK και νέων compiled artifacts στο CI | Πέρασαν οι έλεγχοι compiled manifest, ιστορικών APK και αρχικών υπογραφών της δημοσιευμένης πηγής. Το harmful-app μήνυμα υπάρχει ως αναφορά στο issue#8· φυσική αναπαραγωγή και απόφαση Google δεν έχουν παρατηρηθεί· το #8 δεν κλείνει ως Google clearance. |

Πλοήγηση: μόνο νέο κύριο μενού **Ταμείο διανομέων**, ίδιο compact bottom nav.
Ταμείο/καταστήματα 05:00–05:00 Europe/Athens, εβδομάδα Δευτέρα–Κυριακή.

## Επιβεβαιωμένη πηγή και έλεγχοι

- Τελικό PR source `8f892c0dc9398c72651675c5bc0589ad41137785`: Fast [42405801159](https://github.com/pavlos-argyris/fleet-control/actions/runs/42405801159) και full [42405801256](https://github.com/pavlos-argyris/fleet-control/actions/runs/42405801256) **SUCCESS**.
- Δημοσιευμένο source `527287a4a0b80685d1dd041792b36706f7c4e824`: exact main [42406792334](https://github.com/pavlos-argyris/fleet-control/actions/runs/42406792334) **SUCCESS**. Ίδιο tree `a7a3c650b419dd9fd21965401b2ec012b9e8d1ff`, όλα τα native/Workerd/Chromium suites, δύο APK και εννέα οπτικά jobs.
- Η [δημοσίευση 42407760150](https://github.com/pavlos-argyris/fleet-control/actions/runs/42407760150), δεύτερη προσπάθεια, **SUCCESS**: αρχικές υπογραφές, upload/activation και πραγματικά ληφθέντα Client/Server bytes. Ανεξάρτητη δημόσια ανάγνωση `/api/client-update` επιβεβαίωσε Client 5.61.0/104 και την ίδια πηγή.
- Το πλήρες source ZIP, Web/Worker, build inputs, manifest και SHA-256 διατίθενται στη [δημοσιευμένη έκδοση](https://github.com/pavlos-argyris/fleet-control/releases/tag/fleet-v5.61.0). Η ανεξάρτητη επαλήθευση του τελικού PR source κάλυψε και τα 2.857 αρχεία/εκτελέσιμα modes του ίδιου tree.

Δημοσιευμένες εκδόσεις: Client/Web 5.61.0, Client 104, Server 2.10.18 (72), Worker 5.18.8.
Ακριβή hashes, χρόνοι και περιστατικό πρώτης προσπάθειας: `docs/CHATGPT_HANDOFF_GR.md`.

## Παράδοση και αποδοχή

1. Ολοκληρώθηκαν artifact audit, οπτική επιθεώρηση των πραγματικά παραχθέντων συνθετικών Chromium screenshots και οι διορθώσεις 320 px. Πέρασε και η πραγματική παύση CashSync κατά OTA.
2. Ολοκληρώθηκαν ακριβές PR/main CI, build με αρχικές υπογραφές και μία κοινή ενεργοποίηση Server/Client/Web. Η πρώτη αποτυχημένη αποστολή δεν είχε ενεργοποιήσει νέα metadata· η επανάληψη ενεργοποίησε την ίδια ελεγμένη έκδοση.
3. Παραδόθηκαν πλήρες source ZIP/versions/checksums/οδηγίες. Εκκρεμεί παρατήρηση της πραγματικής εγκατάστασης στη συσκευή. Η κύρια βάση ενεργοποιείται μόνο μέσα από τη ρητή ροή Server, με backup/σύγκριση/απομονωμένη ανάκτηση. Η δημόσια περιγραφή μετά τη δημοσίευση παραμένει `mode=cloud`, όχι αυτόματη παραγωγική μεταφορά.
4. Η φυσική δοκιμή Note10+/Drive/Keystore/backup και τυχόν διαδικασία Google καταγράφονται χωριστά· δεν κλείνουν issues μόνο επειδή πέρασε συνθετικό CI.

Δεν εξουσιοδοτούνται παραγωγικό restore/διαγραφή, Ordexa writes, αλλαγή ιδιωτικών κλειδιών ή νέα έξοδα.
Η διόρθωση του νέου APK δεν παρακάμπτει τον ήδη εγκατεστημένο παλιό OTA backup gate.

## Ιστορική αφετηρία

Στις05/11/2026 από main `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd` ενοποιήθηκαν οι αρχικοί καθαροί πυρήνες των draft PR#66–#72.
Η τότε καταγραφή «λείπουν UI/DB/exports/auth/restore» περιέγραφε εκείνο το αρχικό checkpoint και **δεν αποτελεί τη σημερινή κατάσταση**.
Το επόμενο source ενσωματώνει και το atomic tariff fence του PR#79, με προστασία στο πραγματικό SQLite INSERT και διατήρηση προσχεδίου σε409.
Τα πραγματικά επόμενα checkpoints και τα παλιά αποτελέσματα διατηρούνται στο `docs/CHATGPT_HANDOFF_GR.md` και στο git history· μην ξαναξεκινήσεις ολοκληρωμένες ροές.
