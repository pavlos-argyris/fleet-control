# Issue #8 — ασφάλεια APK και Play Protect, έναρξη 04/11/2026

Απομονωμένος κλάδος `codex/roadmap-8-play-protect-audit`, βάση main `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd`. Δεν τροποποιούνται APK manifest permissions, υπογραφές, OTA ή Installer· πρώτα τεκμηρίωση και διαγνωστική απογραφή.

Το Server και Client manifest ορίζουν `android:allowBackup="false"`, `android:usesCleartextTraffic="false"`, `targetSdkVersion=34` και ζητούν `REQUEST_INSTALL_PACKAGES` + `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. Η παρουσία αυτών των permissions **δεν αποδεικνύει** αιτία Play Protect, ούτε ότι υπάρχει malware/false positive. Θα συγκριθούν παλαιές/νέες signed εκδόσεις, installer paths, δυναμικά permissions και η επίσημη διαδικασία ανασκόπησης της Google πριν γίνει οποιαδήποτε αλλαγή συμπεριφοράς.

Χρειάζεται πραγματική συσκευή με το ακριβές Play Protect alert για αποδοχή, όχι απλώς συντακτικός έλεγχος. Χωρίς bypass, χωρίς απενεργοποίηση ελέγχων ασφαλείας και χωρίς νέα χρέωση.
