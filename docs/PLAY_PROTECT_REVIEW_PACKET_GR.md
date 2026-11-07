# Play Protect — φάκελος τεχνικής επανεξέτασης

Το issue #8 αναφέρει «Εντοπίστηκε επιβλαβής εφαρμογή» σε Server και Client.
Η πρώτη επηρεαζόμενη έκδοση είναι άγνωστη. Δεν έχει αναπαραχθεί η ανίχνευση
στη φυσική συσκευή από agent και δεν υπάρχει απόφαση false positive.

## Επίσημη φόρμα και απαιτούμενα στοιχεία

[Play Protect Appeals Submission Form](https://support.google.com/googleplay/android-developer/contact/protectappeals),
ελεγμένη06/11/2026: υποχρεωτικά email επικοινωνίας, package name, SHA-256 του
APK που έχει ανέβει στο VirusTotal και πρόσθετα τεχνικά στοιχεία. Προαιρετικό
developer name. Η σελίδα αναφέρει ότι οι αποφάσεις είναι τελικές και δεν
υπόσχεται απάντηση. Δεν έχει υποβληθεί αίτημα και δεν έχει γίνει εξωτερική
αποστολή APK ή στοιχείων λογαριασμού.

Χρειάζεται χωριστή καταχώριση ανά package και ακριβές πραγματικό APK. Δεν
χρησιμοποιείται hash CI test-signature ή διαφορετικής έκδοσης από αυτή που
εμφανίζει το πρόβλημα. Δεν θεωρούμε ότι κάποια έκδοση έχει ήδη καταχωριστεί
στο VirusTotal χωρίς πραγματική απόδειξη.

| Εφαρμογή | Package | Δημόσιο certificate SHA-256 |
|---|---|---|
| Client | gr.argyrismitsos.fleetcontrol | 36666ef31643e2c76c885d4636ac44b6288369dca947880c841a42e2d4cb5687 |
| Server | gr.argyrismitsos.fleetserver | 36666ef31643e2c76c885d4636ac44b6288369dca947880c841a42e2d4cb5687 |

Τα ακριβή μήκη/SHA/permissions/components της υποψήφιας έκδοσης προκύπτουν
από το **original-signed** `apk-security-comparison/report.json`, όχι από
πρόχειρη ανακατασκευή. Ο πλήρης κώδικας βρίσκεται στο PR#73 και στο source ZIP
του ίδιου commit. Τα ιδιωτικά κλειδιά δεν περιλαμβάνονται.

## Κείμενο προς έλεγχο πριν από υποβολή

Παρακάτω είναι φάκελος προετοιμασίας, όχι ήδη αποσταλείσα δήλωση ή ισχυρισμός
ότι ολοκληρώθηκε ο έλεγχος Google. Συμπληρώνονται μόνο από πραγματικές αποδείξεις
το συγκεκριμένο package, APK SHA, παρατηρημένη έκδοση Android και πλήρες alert.

> Please review the Play Protect classification of the identified Fleet Control APK. The application owner reports the Greek warning “Εντοπίστηκε επιβλαβής εφαρμογή” during updates; the first affected release is unknown. Fleet Control is a delivery fleet management application. The Client provides the staff/admin interface; the separate Server application runs local business processing, backups and authenticated read-only Ordexa imports.
>
> The update mechanism checks exact package/version, file length and SHA-256, and matches the installed application's signing certificate before using Android PackageInstaller. The original signing identity is preserved. Android installation confirmation and Play Protect remain authoritative; protection is not disabled or bypassed.
>
> The accompanying artifact report verifies the specific APK bytes and signature and compares compiled manifests, permissions, exported components, DEX/native libraries and OCR model hashes against pinned historical releases. We corrected an exported Server boot receiver and restrict its accepted actions. We do not claim that this was the cause of the Google classification or that a static audit establishes absence of harmful behavior. Please assess the exact supplied artifact and supporting evidence.

Client: ρόλος WebView διεπαφής, συνδέσεις Fleet, κάμερα/ειδοποιήσεις όπου
χρησιμοποιούνται, self-update του ίδιου package. Server: υπηρεσία dataSync,
τοπική SQLite, backup/restore, OCR και self-update του ίδιου package.
Οι δύο περιπτώσεις τεκμηριώνονται χωριστά από τα αντίστοιχα artifacts.

## Προετοιμασία αρχικά υπογεγραμμένων APK χωρίς καθολική ενημέρωση

Η ελεγχόμενη εντολή `node scripts/request-publish.mjs --candidate --reason "..."`
παράγει request-only commit αμέσως μετά από καθαρό main source. Χρειάζεται το
τελευταίο επιτυχές exact-main CI, όπως και η κανονική δημοσίευση.
Η υφιστάμενη trusted release διαδρομή κατασκευάζει με τα αρχικά κλειδιά,
εκτελεί verify-apks και production artifact audit και αποθηκεύει το
`fleet-original-signed-candidate` artifact με APK, πλήρες source ZIP,
manifest και SHA256SUMS. Δεν δημιουργεί GitHub release, δεν κάνει Worker
configure/deploy, upload ή activation και δεν εκτελεί παραγωγικό probe.
Τα private build αρχεία καθαρίζονται πάντα. Η κανονική `--publish` διαδρομή
διατηρείται χωριστή και παραμένει εξουσιοδοτημένη μετά την ολοκλήρωση των πυλών.

Η πραγματική δοκιμή στην υπάρχουσα εγκατάσταση γίνεται χωρίς απεγκατάσταση ή
παράκαμψη Play Protect, με ήδη ελεγμένο backup. Δεν εκτελείται παραγωγική
μεταφορά βάσης/restore μόνο και μόνο για τη σάρωση. Η μεταφορά authority είναι
χωριστή ενέργεια ιδιοκτήτη με τις ενσωματωμένες πύλες.

Πραγματικός έλεγχος updater πηγής: `OtaInstaller.validate` απαιτεί package/νεότερο code/έκδοση, μήκος έως50MiB, SHA-256 και ίδια υπογραφή με την εγκατεστημένη εφαρμογή πριν από PackageInstaller. Το artifact audit απορρίπτει candidate πάνω από αυτό το υφιστάμενο όριο. Οι προϋπάρχουσες χειροκίνητες uploads δεν ταυτίζονται με αυτόματη εγκατάσταση.
