# Server 2.2.16 — CursorWindow και φόρτωση ρυθμίσεων (#19)

Κοινό release 5.51.11. Αλλάζει ο Server σε 2.2.16 / versionCode 42. Client/Web παραμένουν 5.51.10 / code 82 και Worker 5.12.10. Διατηρείται η ήδη δημοσιευμένη διόρθωση προγράμματος #17. Δεν αλλάζουν API, σχήμα βάσης, φορμά backup, κλειδιά ή δεδομένα παραγωγής.

## Αιτία και αναπαραγωγή

Τα full_export/canonical_snapshot/local_invoice_queue και bikes.data περιέχουν JSON ολόκληρων αντιγράφων/ιστορικών. Οι προηγούμενες αναγνώσεις επέλεγαν όλο το TEXT cell μέσω Cursor. Αναπαράχθηκε το ακριβές `Row too big to fit into CursorWindow requiredPos=0,totalRows=1` στο πραγματικό FleetDataStore.getSystemExport με πραγματική SQLite, πραγματικό JSON parser και προσομοιωμένο όριο CursorWindow 2 MiB, με Unicode δεδομένα άνω των 4 MiB. Δεν μετρήθηκε το συγκεκριμένο όριο/row της συσκευής του χρήστη.

Το MainActivity.dashboard ζητούσε getStats/getFleet/getSystemExport πριν φορτώσει SharedPreferences. Η αποτυχία επέστρεφε `{}`. Η οθόνη ερμήνευε την κενή απάντηση ως αρχικές τιμές και έδειχνε χωρίς διεύθυνση, backup «δεν έχει οριστεί», αυτόματο backup κλειστό και άλλες ανενεργές ενδείξεις. Η αποθήκευση προτιμήσεων γινόταν πριν από το επόμενο dashboard read, άρα μπορούσε να αναφερθεί αποτυχία μετά από ήδη ολοκληρωμένη εγγραφή. Η κενή ένδειξη δεν αποδείκνυε διαγραφή· δεν έχουμε πρόσβαση στις πραγματικές προτιμήσεις/βάση της συσκευής.

## Διόρθωση

- Τα μεγάλα TEXT cells διαβάζονται με δεσμευμένες scalar SQLiteStatement/simpleQueryForString κλήσεις. Μόνο μικρά IDs/χρόνοι/αριθμοί μπαίνουν σε Cursor. Δεν αυξάνεται CursorWindow, δεν κόβεται JSON, δεν μεταφέρεται/διαγράφεται βάση. Οι ελλείπουσες προαιρετικές εγγραφές διακρίνονται από SQL/JSON αποτυχίες· ένα πρόβλημα ανάγνωσης δεν μετατρέπεται σιωπηλά σε άδειο snapshot/ουρά ή χαμένο μηχανάκι.
- Η SQLiteStatement API είναι διαθέσιμη από API 1. Η επίσημη υλοποίηση ακολουθεί executeForString/nativeExecuteForString αντί executeForCursorWindow: [Android API](https://developer.android.com/reference/android/database/sqlite/SQLiteStatement#simpleQueryForString()) και [AOSP](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/database/sqlite/SQLiteConnection.java).
- Η αποτυχία στατιστικών εμφανίζεται χωριστά, με διαθέσιμες πραγματικές προτιμήσεις/backup. Γενική αποτυχία dashboard αναφέρεται ρητά, κρατά τελευταία γνωστή κατάσταση και κλειδώνει τη φόρμα. Δεν εμφανίζονται τα άγνωστα δεδομένα ως μηδέν/κλειστά.
- Φόρμα και native bridge ελέγχουν ότι έχουν φορτωθεί ρυθμίσεις πριν εγγράψουν. Η προτίμηση επιβεβαιώνεται με commit και το αποτέλεσμα αποθήκευσης διαχωρίζεται από το μεταγενέστερο refresh. Διατηρούνται οι αλλαγές του χρήστη στο υπάρχον 1-second polling.
- Το σταθερό διαγνωστικό ServerConfig.SERVER_VERSION ευθυγραμμίζεται με το manifest 2.2.16. Δεν προστίθεται runtime εξάρτηση JSON: ο μικρός vendor JSON-java jar χρησιμοποιείται μόνο στις offline δοκιμές και δεν εντάσσεται στα APK.

## Έλεγχοι

Πριν την αλλαγή απέτυχαν οι νέες δοκιμές στο CursorWindow read και στη μη κλειδωμένη αρχική φόρμα. Μετά πέρασαν:

- test-server-large-storage-native: πραγματικό FleetDataStore/HistoryMergePolicy/NextServiceNotes, SQLite μέσω τοπικής Python και upstream πραγματικό JSON-java. Μεγάλα Unicode/emoji cells, πλήρη mirror/canonical/queue/settings/bikes, getStats/fullBackupPayload/merge, απόντα rows, δεσμευμένα keys, SQL failures, μη έγκυρο JSON, διατήρηση αποθηκευμένων τιμών και κλείσιμο handles. CursorWindow προσομοιώνεται· δεν δηλώνεται πραγματικό Android instrumentation.
- test-server-settings-recovery: πραγματικό JS/DOM, αρχική αποτυχία χωρίς ψευδώς κλειστό backup, αποτροπή submit πριν φόρτωση, τελευταία γνωστή κατάσταση, χωριστή αποτυχία στατιστικών, recovery και επιτυχές save με αποτυχημένο refresh.
- test-server-update-ui: διατήρηση υπαρχόντων settings/OTA/backup συμπεριφορών. Το πλήρες check-all και τα τελικά CI αποτελέσματα καταγράφονται στο PR και στο CHATGPT_HANDOFF_GR.md.
- test-server-backup-browser: desktop/κινητό, αρχική αποτυχία, διατήρηση true προτιμήσεων μετά επόμενη αποτυχία και recovery, μαζί με υπάρχοντα backup/OTA layouts. Ο έλεγχος native γίνεται και στο production workflow πριν από το build.

## Εγκατάσταση και δεδομένα

Η τελική διαθεσιμότητα καθορίζεται από την επιτυχή δημοσίευση/ενεργοποίηση, όχι από αυτό το source έγγραφο. Τα APK, ο πλήρης κώδικας όλων των τμημάτων, build inputs, manifest, οδηγίες και SHA-256 διατίθενται στο GitHub release 5.51.11 μετά επιβεβαιωμένο publish.

Εάν το υπάρχον OTA κολλά στο backup εξαιτίας του ίδιου παλιού CursorWindow reader, λαμβάνεται το νέο αρχικά υπογεγραμμένο Server 2.2.16 APK και εγκαθίσταται ως ενημέρωση πάνω από το υπάρχον πακέτο. Δεν απαιτείται απεγκατάσταση, εκκαθάριση δεδομένων ή restore. Μετά το άνοιγμα ελέγχονται URL, επιλεγμένος φάκελος, πραγματικό automatic backup και στατιστικά. Μόλις λειτουργήσει η ανάγνωση, μπορεί να δημιουργηθεί νέο κανονικό backup στη συσκευή.

Η ενημέρωση δεν επαναγράφει αυτόματα προτιμήσεις. Αν αποθηκεύτηκαν ήδη αρχικές τιμές σε προηγούμενη συνεδρία, δεν υπόσχεται ανάκτηση παλαιών επιλογών που δεν διαθέτουμε· ελέγχονται οι πραγματικές τιμές μετά το update. Η επιλογή φακέλου και το περιεχόμενό του δεν διαγράφονται από αυτή τη διόρθωση. Δεν λήφθηκε παραγωγικό backup/restore, πρόσβαση στη συσκευή ή εγκατάσταση από τον βοηθό. Το #19 μένει ανοιχτό μέχρι την επιβεβαίωση χρήστη.
