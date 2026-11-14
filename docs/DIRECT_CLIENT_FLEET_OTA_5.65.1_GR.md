# Υποψήφια διόρθωση 5.65.1 / Server 2.14.1

- Πρώτη σύνδεση Direct: υιοθέτηση επιβεβαιωμένου revision πριν από το πρώτο business request, χωρίς halt/ανακατεύθυνση ολόκληρου Android WebView. Πραγματική μεταγενέστερη αλλαγή εξακολουθεί να ακυρώνει τα προηγούμενα requests, χωρίς επανάληψη εγγραφών.
- Client: το normal Direct πακέτο κρατά το κανονικό παράθυρο OTA, αντί του stub της ανεξάρτητης δοκιμής. Ο native updater ελέγχει πρώτα τη δημόσια υπογεγραμμένη έκδοση ώστε παλιό τοπικό catalogue/μη διαθέσιμος Server να μην την κρύβει. Διατηρούνται hash, μέγεθος και αρχική υπογραφή.
- Server: τα χειροκίνητα check/install/force/postpone και automatic on/off περνούν από τον ιδιωτικό same-UID provider και τη μία scoped κατάσταση Direct. Δεν παρακάμπτονται προηγούμενο πλήρες backup, installer permission, ασφαλές pause ή έλεγχος APK. Η παλιά generated Direct Activity ήδη διέθετε scoped OtaManager· η συγκεκριμένη αιτία αποτυχίας ενημέρωσης στη φυσική συσκευή δεν έχει ακόμη αποδειχθεί.
- Νέα fixtures: fresh Web/Android bootstrap με Server revision7, 29 μηχανές και 57 τιμολόγια, πραγματικό Client OTA UI, πραγματικό Android bridge/provider automatic on/off. Δεν δηλώνονται εκτελεσμένα τα fixtures Chromium/Android στο τελικό source.

## Σταθερή λίστα κανόνων Ταμείου

Νεότερο αίτημα: οι καταχωρισμένοι κανόνες καταστημάτων αδειάζουν στιγμιαία και επανέρχονται στα refresh. Αναπαράχθηκε με πραγματικό DOM και καθυστερημένο rules response: δύο κανόνες γίνονταν μηδέν. Τα live/manual refresh και οι αποθηκεύσεις πλέον ακυρώνουν μόνο τη φρεσκάδα του καταλόγου, κρατώντας την τελευταία επιτυχή λίστα μέχρι έγκυρη αντικατάσταση. Αποτυχία/μη έγκυρο response εμφανίζει σφάλμα και διατηρεί τη λίστα. Ίδιο HTML δεν αντικαθιστά τις κάρτες, ώστε να παραμένουν σταθερά τα DOM nodes, η εστίαση και η κύλιση. Τα πραγματικά νέα δεδομένα εξακολουθούν να ενημερώνονται, ενώ logout/clear αφαιρεί κανονικά την προβολή. Δεν αλλάζουν κανόνες υπολογισμού, τιμές, οικονομικές εγγραφές ή συχνότητα συγχρονισμού.

Actual DOM regression PASS: διατήρηση δύο κανόνων όσο καθυστερεί το αίτημα, διατήρηση ίδιων DOM nodes σε αμετάβλητη απάντηση, διατήρηση μετά από αποτυχία και εμφάνιση πραγματικής αλλαγής2,50→2,75→2,50. Πέρασε ολόκληρη η υφιστάμενη native-management DOM suite μαζί με draft/CAS/mapping/receipt και logout tests.

Η λίστα δείχνει μία μόνο κάρτα ανά κατάστημα/κατηγορία, επιλέγοντας τελευταία ημερομηνία ισχύος και κατόπιν τελευταία revision, ανεξάρτητα από τη σειρά της απάντησης. Η ενέργεια εμφανίζεται ως «Επεξεργασία» και η ενημέρωση αντικαθιστά την ίδια συνοπτική κάρτα. Το πλήρες catalogue διατηρείται εσωτερικά για ιστορικούς υπολογισμούς και CAS στην αποθήκευση. Πρόσθετος DOM έλεγχος καλύπτει παλιότερη ημερομηνία με μεγαλύτερο revision και νέο κανόνα2,75 στην ίδια ημέρα: παραμένουν δύο κάρτες για δύο καταστήματα, με edit ID της τελευταίας έκδοσης.

## Πραγματικοί έλεγχοι

PASS: regression πρώτου request (ο παλιός κώδικας απέτυχε με το ακριβές μήνυμα αλλαγής λειτουργίας), μεταγενέστερο in-flight mutation fence, native backend policy/file-lock/Client storage, Client OTA UI, Server update UI, Java OTA policy, Direct Web functions, independent transport, release activation/rollback/hash, code map, source safety, fast source gate. Κατασκευάστηκαν Client και Server με προσωρινό δοκιμαστικό κλειδί και πέρασαν compiled payload/security checks. Δεν παραδίδονται αυτά ως συμβατή παραγωγική ενημέρωση.

Το πλήρες check-all σταμάτησε μετά τις πρώτες επιτυχείς Workerd/SQLite σουίτες λόγω ακύρωσης network approval. Το τοπικό Chromium δεν μπόρεσε να ξεκινήσει λόγω απαγορευμένου Unix socket. Εκκρεμούν full exact-source GitHub CI, πραγματική Android εκτέλεση, browser screenshots, αρχικά παραγωγικά κλειδιά και κανονική δημοσίευση.

Δημόσια read-only probes: Direct health200, mode revision1/directApproved=true, Direct Client feed5.65.0 και GitHub manifest5.65.0 προσβάσιμα. Δεν διαβάστηκε η ιδιωτική λίστα29 μηχανών και δεν επιβεβαιώνεται ακόμη το αποτέλεσμα στη φυσική συσκευή. Δεν μεταβλήθηκαν παραγωγικά δεδομένα, backup, πιστοποιητικά, router ή ιδιωτικά κλειδιά.

Η αποστολή στο δημόσιο pavlos-argyris/fleet-control απορρίφθηκε από automatic approval review, παρά την επαλήθευση repository1412318293/admin και του ίδιου origin. Δεν επιχειρήθηκε παράκαμψη μέσω connector. Χρειάζεται νέα ρητή άδεια του χρήστη για την αποστολή του συγκεκριμένου source branch πριν από remote CI/merge/publish.
