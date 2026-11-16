# #107 — Κοινός υπολογισμός καταστημάτων, ανεξάρτητη εξουσιοδότηση

Η ίδια canonical οικονομική αναφορά καταστημάτων επαναχρησιμοποιείται ανά scope/ημερομηνίες/περίοδο/κατάστημα και committed stores/all revisions. Οι σελίδες pagination και PDF/Excel χρησιμοποιούν τον ίδιο ακριβώς πλήρη υπολογισμό. Η βελτίωση ενεργοποιείται μόνο στο standalone Direct runtime.

Κάθε route συνεχίζει να καλεί πρώτα τον πραγματικό `actor(...,stores.view)` και τον έλεγχο τρέχουσας πηγής. Μοιράζεται μόνο το role-independent report object· ποτέ principal, response headers, session, file token ή export. Κάθε hit αποδίδει ανεξάρτητο JSON αντίγραφο. Τα πραγματικά snapshots/κανόνες/coverage παραμένουν SQLite authority.

Η RAM περιορίζεται σε8 υπολογισμούς/4MiB/5min, με έως2MiB ανά αποτέλεσμα. Το νέο signed-native transaction hook ξεκινά νέο epoch, κρατά νέα αποτελέσματα προσωρινά και τα δημοσιεύει μόνο αφού ολοκληρωθεί το πραγματικό SQLite commit. Αποτυχία beforeCommit, rollback, deadline ή εγκαταλειμμένα microtasks δεν επιτρέπουν δημοσίευση με counter που μπορεί να επαναχρησιμοποιηθεί από επόμενο commit. Αποτυχία optional cache δεν μεταβάλλει ήδη committed API αποτέλεσμα. Νέος request epoch απορρίπτει πάντα προηγούμενο staging.

## Αποδείξεις

- `test-shared-reads.mjs`: immutable copies, rollback με ίδιο μελλοντικό counter, abandoned request, delayed previous-epoch computation και αδρανής cloud path.
- `test-independent-business.mjs` / `IndependentStoreReadModelChecks.java.txt`: πραγματικοί shared Java/Rhino handlers/SQLite,40 καταστήματα ×31 ημέρες. Διαφορετικός manager λαμβάνει ακριβώς το ίδιο οικονομικό report με δικό του x-fleet-actor. Η ανάκληση stores.view επιστρέφει403 πριν χρησιμοποιηθεί hot report. Cold/warm SQL reads10/5. Native beforeCommit failure υπολογίζει μη committed ποσό200c και αποτυγχάνει· επόμενο πραγματικό commit στην ίδια revision θέση300c αποδίδει μόνο το σωστό300c. Μετέπειτα alias commit μεταβάλλει40→39 groups και διατηρεί ακριβώς τα χρήματα.
- Το υπάρχον range index store_billing_local_scope καλύπτει scope/kind/day και επιβεβαιώνεται με EXPLAIN· δεν προστίθεται διπλό index. Native read-model cache παραμένει ξεχωριστή ανά session για την τελική authorized προβολή.

Οι δοκιμές είναι συνθετικές. Δεν αποτελούν φυσική παραλαβή Note10+, ιδιωτικής βάσης ή πρωτοκόλλου/χρεώσεων Ordexa. Καμία παραγωγική αλλαγή δεδομένων, cloud restore/delete ή νέα χρέωση.
