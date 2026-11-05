# Issue #8 — ασφάλεια APK και Play Protect

Ενεργή εργασία στο κοινό draft PR #73 μετά τη ρητή έναρξη υλοποίησης του χρήστη στις 05/11/2026. Διατηρούνται οι αρχικές υπογραφές, τα υπάρχοντα permissions και ο ελεγμένος μηχανισμός εγκατάστασης.

Το Server και Client manifest ορίζουν `android:allowBackup="false"`, `android:usesCleartextTraffic="false"`, `targetSdkVersion=34` και ζητούν `REQUEST_INSTALL_PACKAGES` + `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Η παρουσία αυτών των permissions **δεν αποδεικνύει** αιτία Play Protect, ούτε ότι υπάρχει malware/false positive. Θα συγκριθούν παλαιές/νέες signed εκδόσεις, installer paths, δυναμικά permissions και η επίσημη διαδικασία ανασκόπησης της Google πριν γίνει οποιαδήποτε αλλαγή συμπεριφοράς.

Χρειάζεται πραγματική συσκευή με το ακριβές Play Protect alert για αποδοχή, όχι απλώς συντακτικός έλεγχος. Χωρίς bypass, χωρίς απενεργοποίηση ελέγχων ασφαλείας και χωρίς νέα χρέωση.

## Επαληθευμένη διόρθωση έκθεσης receiver, 05/11/2026

Ο Server BootReceiver ήταν εξαγόμενος προς άλλες εφαρμογές και εκκινούσε την
υπηρεσία χωρίς να ελέγχει το action του εισερχόμενου intent. Το νέο native test
απέτυχε στον αρχικό κώδικα για null/άγνωστο broadcast, πριν από οποιαδήποτε αλλαγή.

Ο receiver γίνεται `exported=false` και επιτρέπει μόνο BOOT_COMPLETED και
MY_PACKAGE_REPLACED. Η επιλογή automatic_start και οι υπάρχουσες διαδρομές
εκκίνησης υπηρεσίας SDK23/34 διατηρούνται. Η επίσημη
[τεκμηρίωση Android](https://developer.android.com/guide/topics/manifest/receiver-element#exported)
διευκρινίζει ότι ένας μη εξαγόμενος receiver εξακολουθεί να λαμβάνει μηνύματα
του συστήματος και της ίδιας εφαρμογής.

Το πραγματικό BootReceiver εκτελείται στο native regression με ελεγχόμενα
Android adapters: άγνωστα/null actions δεν διαβάζουν προτιμήσεις ούτε εκκινούν
υπηρεσία, ενώ οι δύο επιτρεπόμενες ενέργειες και το automatic_start OFF
συμπεριφέρονται σωστά. Το manifest regression επιτρέπει εξωτερική έκθεση μόνο
του launcher και στα δύο APK. Δεν προστέθηκε/αφαιρέθηκε permission.

Αυτό διορθώνει πραγματικό πρόβλημα επιφάνειας πρόσβασης. **Δεν αποτελεί απόδειξη
ότι ήταν η αιτία του Play Protect**, ούτε επιβεβαιώνει απόφαση της Google.
Παραμένουν συγκρίσεις αρχικών υπογεγραμμένων artifacts/πιστοποιητικών και
πραγματική δοκιμή εγκατάστασης/επανεκκίνησης στη συσκευή πριν κλείσει το #8.
