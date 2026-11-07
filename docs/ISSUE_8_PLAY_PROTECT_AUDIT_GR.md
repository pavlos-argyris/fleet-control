# Issue #8 — ασφάλεια APK και Play Protect

Ενεργή εργασία στο κοινό draft PR #73 μετά τη ρητή έναρξη υλοποίησης του χρήστη στις 05/11/2026. Διατηρούνται οι αρχικές υπογραφές, τα υπάρχοντα permissions και ο ελεγμένος μηχανισμός εγκατάστασης.

Το Server και Client manifest ορίζουν `android:allowBackup="false"`, `android:usesCleartextTraffic="false"`, `targetSdkVersion=34` και ζητούν `REQUEST_INSTALL_PACKAGES` + `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Η παρουσία αυτών των permissions **δεν αποδεικνύει** αιτία Play Protect, ούτε ότι υπάρχει malware/false positive. Θα συγκριθούν παλαιές/νέες signed εκδόσεις, installer paths, δυναμικά permissions και η επίσημη διαδικασία ανασκόπησης της Google πριν γίνει οποιαδήποτε αλλαγή συμπεριφοράς.

Το issue #8 καταγράφει «Εντοπίστηκε επιβλαβής εφαρμογή» και στα δύο APK· χρειάζεται πραγματική συσκευή/πλήρης διάγνωση του alert για αποδοχή, όχι απλώς συντακτικός έλεγχος. Χωρίς bypass, χωρίς απενεργοποίηση ελέγχων ασφαλείας και χωρίς νέα χρέωση.

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

## Πραγματική σύγκριση διαθέσιμων APK — 06/11/2026

Το `android-build-support/apk-audit-references.json` κλειδώνει δημόσια release
asset IDs, μήκη και SHA-256 για Client/Server της αρχικής5.37.0/2.1.0 και της
πρόσφατης5.60.1/2.9.1. Δεν χαρακτηρίζονται «γνωστά ασφαλή» ή Google-approved.
Το `scripts/audit-apk-history.mjs` κατεβάζει τα ακριβή bytes και εκτελεί:

- Υπογραφή με πραγματικό apksigner, certificate SHA-256 και verified schemes.
- Compiled AndroidManifest από aapt: package/version/code, SDK, πραγματικά permissions, ρητά allowBackup/cleartext/exported και component actions/processes. Απόντα flags μένουν null αντί κατασκευασμένων defaults.
- Τυπικό APK/ZIP header, CRC/διπλά ονόματα, bounded αποσυμπίεση, SHA-256 κάθε DEX/native library/OCR model και ABI inventory.
- Πραγματική σύγκριση permissions/components/SDK/υπογραφών. Η υποψήφια έκδοση διατηρεί το permission set της5.60.1 και εξάγει μόνο τον launcher· όλα τα άλλα components απαιτούν ρητό false.

Το υποχρεωτικό source CI χρησιμοποιεί μόνο disposable test signature και το
δηλώνει. Το κανονικό release εκτελεί `--production` μετά το υπάρχον
`verify-apks` και απαιτεί ακριβώς το αρχικό δημόσιο certificate fingerprint
του repository. Κανένα ιδιωτικό κλειδί δεν προστίθεται σε source CI ή report.
Το μικρό artifact `apk-security-comparison` περιέχει JSON/Markdown/compiled
manifests· τα παλιά APK δεν επανεξάγονται ως νέα release αρχεία.
Η πρώτη ακριβής εκτέλεση του νέου audit εκκρεμεί στο commit που το εισάγει.

Αυτή είναι σύγκριση ακεραιότητας και επιφάνειας πρόσβασης, **όχι** verdict
malware ή απόδειξη συμπεριφοράς σε πραγματική συσκευή. Ο interpreter του
native business runtime και οι νέες βιβλιοθήκες εμφανίζονται στο πραγματικό
inventory· ο αριθμός DEX ή το μέγεθος δεν αποδεικνύει αιτία Google alert.

## Επίσημη διάγνωση και επανεξέταση Google

Ελέγχθηκαν στις06/11/2026 οι επίσημες οδηγίες:
- [Developer guidance for Play Protect warnings](https://developers.google.com/android/play-protect/warning-dev-guidance).
- [App verification / classification appeal](https://support.google.com/googleplay/android-developer/answer/2992033?hl=en).

Η Google ξεχωρίζει προειδοποίηση άγνωστης εφαρμογής/προτεινόμενο scan,
συγκεκριμένο harmful-app block, ευαίσθητα δικαιώματα και παλιό target API.
Χρειάζονται το ακριβές μήνυμα, έκδοση Android και συγκεκριμένο APK SHA-256
για να επιλεγεί η σωστή αντιμετώπιση. Η απλή παρουσία installer permissions
δεν ταυτοποιεί κατηγορία ή αιτία.

Αν πρόκειται για χαρακτηρισμό που εξακολουθεί να θεωρείται λανθασμένος μετά
τον έλεγχο, η επίσημη διαδικασία είναι Play Protect classification appeal.
Η προτροπή αποστολής άγνωστης εφαρμογής για security check έχει χωριστή ροή·
η ίδια η οδηγία αναφέρει ότι appeal δεν αφαιρεί αυτό το μήνυμα.
Δεν υποβλήθηκε appeal ούτε στάλθηκαν APK/στοιχεία λογαριασμού στη Google.
Δεν απενεργοποιείται Play Protect και δεν αλλάζει package/signing identity.

Το issue #8 παραμένει ανοικτό για πλήρη διάγνωση του αναφερόμενου harmful-app alert και πραγματική εγκατάσταση/
επανεκκίνηση/σάρωση της αρχικά υπογεγραμμένης έκδοσης στη συσκευή. Η παράδοση
του τεχνικού ελέγχου δεν παρουσιάζεται ως Google clearance.

## Ήδη καταγεγραμμένο περιστατικό και διάκριση από τη δοκιμή

Το αρχικό issue #8 αναφέρει **«Εντοπίστηκε επιβλαβής εφαρμογή» και στα δύο
APK**, με άγνωστη πρώτη προβληματική έκδοση. Αυτό είναι αναφορά του χρήστη,
όχι νέα αναπαραγωγή από agent. Δεν πρέπει να υποβαθμιστεί αυθαίρετα σε απλό
unknown-app scan ή να ειπωθεί ότι δεν έχει δοθεί καθόλου μήνυμα.
Παραμένουν άγνωστα το ακριβές πλήρες panel/κατηγορία, το SHA του APK που
σαρώθηκε και η συμπεριφορά της νέας signed έκδοσης στη συσκευή.

## Εναλλακτική διανομή Google Play — αξιολόγηση χωρίς αλλαγή λογαριασμών

Ελέγχθηκαν οι επίσημες οδηγίες [Internal testing](https://google.play/business/internal-testing/),
[Internal app sharing](https://support.google.com/googleplay/android-developer/answer/9844679?hl=en)
και [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en).
Το internal testing επιτρέπει περιορισμένη ομάδα δοκιμαστών, αλλά απαιτεί
πρόσβαση Play Console και κατάλληλη προετοιμασία Play release/AAB.
Το υπάρχον build παράγει signed APK· δεν αποτελεί αυτομάτως έτοιμο Play track.

Για συμβατή ενημέρωση των σημερινών εγκαταστάσεων πρέπει να επιβεβαιωθεί το
ίδιο package και πραγματικό app-signing certificate στα διανεμόμενα APK.
Δεν αρκεί το upload certificate. Το Internal app sharing χρησιμοποιεί δικό
του test signing certificate σύμφωνα με τη σχετική τεκμηρίωση και δεν
επιλέγεται ως απευθείας αντικατάσταση της ήδη εγκατεστημένης έκδοσης.
Δεν ανοίχτηκε νέος λογαριασμός, δεν αναλήφθηκε κόστος, δεν μεταφέρθηκε
ιδιωτικό signing key και δεν έγινε enrollment/αλλαγή Play signing.
Η διανομή μέσω Google Play δεν αποτελεί τεκμήριο επίλυσης της συγκεκριμένης
ανίχνευσης χωρίς πραγματικό αποτέλεσμα ελέγχου.

Έτοιμα απαιτούμενα πεδία/τεχνικό κείμενο και ασφαλής δημιουργία αρχικά υπογεγραμμένης υποψήφιας έκδοσης: `docs/PLAY_PROTECT_REVIEW_PACKET_GR.md`. Η επίσημη φόρμα απαιτεί SHA-256 του APK που έχει ανέβει στο VirusTotal· κανένα τέτοιο upload/appeal δεν πραγματοποιήθηκε από agent.
