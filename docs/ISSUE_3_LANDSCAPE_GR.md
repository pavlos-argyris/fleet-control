# Issue #3 — Client APK σε landscape

Σχετίζεται με #3. Παράδοση προς τον συντονιστή του #1 μέσω PR #15, χωρίς merge,
κλείσιμο issue, publication request, release ή deploy από τον βοηθό #3.

## Αιτία και διόρθωση

Το `client-android/AndroidManifest.xml` κλείδωνε το `MainActivity` σε
`android:screenOrientation="portrait"`. Έτσι το Android δεν επέτρεπε κανονική
περιστροφή στο κινητό και μπορούσε να παρουσιάζει στενό portrait compatibility
window/letterboxing σε οριζόντιο tablet. Η συγκεκριμένη εκδήλωση σε φυσικό tablet
δεν αναπαράχθηκε εδώ: δεν υπάρχει Android emulator ή φυσική συσκευή.

Το WebView είναι ήδη το κύριο περιεχόμενο της Activity, με wide viewport και
`width=device-width` στο Portal και Fleet. Οι υπάρχουσες responsive οθόνες
αξιοποιούν το διαθέσιμο πλάτος όταν το Android το παραχωρεί. Δεν βρέθηκε ανάγκη
για ειδική εξαίρεση CSS ή αλλαγή του zoom.

- Αφαιρείται το αναγκαστικό portrait. Ακολουθείται η κανονική πολιτική
  προσανατολισμού της συσκευής/του χρήστη, όχι εξαναγκασμένη περιστροφή sensor.
- Δηλώνονται `orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden`.
  Το ίδιο WebView διατηρείται στις συγκεκριμένες αλλαγές configuration.
- Το `onConfigurationChanged` καλεί το framework και ζητά νέο layout του WebView.
  Δεν δημιουργεί νέο WebView, δεν ξαναφορτώνει τη σελίδα και δεν χάνει σκόπιμα
  τις φόρμες/καρτέλες/κύλιση κατά την περιστροφή.
- Δεν αλλάζουν CSS, viewport, portal.js, backend ή Web/Client assets. Τα παλιά
  versioned assets παραμένουν αμετάβλητα. Το Server APK δεν επηρεάζεται.
- Το target SDK παραμένει 34, με την προϋπάρχουσα προεπιλεγμένη υποστήριξη
  resizable Activity. Δεν προστίθεται όριο aspect ratio ή σταθερό native πλάτος.

Η διατήρηση της Activity αφορά τις δηλωμένες αλλαγές configuration. Δεν είναι
νέος μηχανισμός ανάκτησης πρόχειρης φόρμας μετά από τερματισμό της διεργασίας
από το λειτουργικό σύστημα.

## Έλεγχοι

- `node scripts/test-client-landscape.mjs`: έλεγχος του πραγματικού manifest,
  viewport και callback. Απορρίπτει το αρχικό manifest με το portrait lock και
  περνά με τη διόρθωση.
- `bash scripts/check-all.sh`: επιτυχής πλήρης υπάρχουσα σουίτα, μαζί με τον νέο
  έλεγχο, API/SQLite/πραγματικό Workers D1, migration/backup/payroll/schedule.
- `node scripts/test-client-landscape-browser.mjs`: πραγματικό Chromium με
  συνθετικά API, HTTP Web και τοπικά file Client assets, χωρίς παραγωγικά δεδομένα.
  Δεν είναι Android WebView ή native rotation test.
- Μεγέθη CSS viewport: κινητό 390×844 ↔ 844×390, μικρό κινητό 320×667 ↔ 667×320,
  tablet 800×1280 ↔ 1280×800. Έξι ανεξάρτητα περιβάλλοντα Client/Web.
- Αρχική, βάρδιες, πρόγραμμα, εργαζόμενοι, τιμολόγια, Fleet/list bottom, καρτέλα
  μηχανής και νέο service. Έλεγχος οριζόντιας υπερχείλισης, πλάτους workspace,
  διαλόγων και προσβασιμότητας κάτω κουμπιών χωρίς υποβολή.
- Περιστροφή ανοικτού invoice dialog με σχόλιο και ανοικτού νέου service με
  χιλιόμετρα/σημείωση: παραμένουν τα δεδομένα και τα ίδια live documents, χωρίς
  page errors. Επιστροφή portrait μετά από landscape.
- Σύγκριση πραγματικών μετρήσεων Client/Web: ίδιο πλάτος κύριου χώρου και Fleet.
  Το desktop sidebar κρατά το συμφωνημένο πλάτος του· το υπόλοιπο workspace
  αξιοποιείται. Δεν απαιτείται να τεντώνονται οι διάλογοι σε όλο το tablet.
- Τοπικό Client APK build με αποκλειστικά προσωρινό δοκιμαστικό κλειδί.
  `node scripts/test-client-landscape-apk.mjs`: επιβεβαιώνεται το πραγματικό
  packaged manifest, χωρίς screenOrientation, με configChanges `0xda0`.
- Το GitHub CI εκτελεί επιπλέον όλους τους υπάρχοντες browser/native ελέγχους,
  κατασκευή και των δύο APK, Worker dry-run και πλήρες source ZIP. Τα ακριβή
  run/head/αποτελέσματα καταγράφονται στο PR και στο κοινό αρχείο μετά το τέλος.

## Εικόνες και όρια

Τα αποτελέσματα/εικόνες βρίσκονται στο CI artifact `navigation-motion-verification`,
υποφάκελο `client-landscape/after`, και ο έλεγχος compiled APK στο
`client-landscape-apk-verification`. Αντιπροσωπευτικές συγκρίσεις browser
baseline/after περιλαμβάνονται στο `docs/issue-3-landscape/`.

Οι εικόνες **browser baseline πριν** δείχνουν την ήδη σωστή responsive Web/Client
σελίδα όταν της δίνεται ολόκληρο το viewport. Δεν είναι εικόνες Android πριν από
τη διόρθωση και δεν προσομοιώνουν το native portrait letterbox. Η ουσιαστική
πριν/μετά αλλαγή είναι στο Android window configuration, την οποία τεκμηριώνουν
το αρχικό manifest, η αρνητική δοκιμή και το κατασκευασμένο APK. Οι browser
εικόνες τεκμηριώνουν ότι η υπάρχουσα responsive εμφάνιση διατηρείται.

Παραμένει χειροκίνητη αποδοχή σε πραγματικό Android κινητό/tablet: εγκατάσταση
**του τελικού, κανονικά υπογεγραμμένου APK του συντονιστή**, αυτόματη περιστροφή
ενεργή, portrait/landscape, ανοικτές φόρμες/καρτέλες, πληκτρολόγιο και
multi-window. Να ελεγχθούν και τυχόν ρυθμίσεις Samsung Labs/αναλογίας εφαρμογής
που ο χρήστης έχει επιβάλει. Καμία δοκιμή εγκατάστασης, production backup ή
restore δεν πραγματοποιήθηκε εδώ.

## Ενσωμάτωση

Runtime αρχεία: `client-android/AndroidManifest.xml` και
`client-android/src/gr/argyrismitsos/fleetcontrol/MainActivity.java`.
Δεν υπάρχει κοινό runtime diff με το backend/portal.js του #1.
Κοινά σημεία συντονισμού: CI workflow, check-all και κοινό αρχείο συνέχειας·
κατά την ενσωμάτωση διατηρούνται οι προσθήκες και των δύο PR.

Δεν αυξάνονται σε αυτό το PR οι εκδόσεις/versionCodes και δεν παράγονται νέα
Web snapshots, βάσει της ειδικής οδηγίας συντονιστή στο #3. Τοπικά/CI test APK
φέρει την υπάρχουσα υποψήφια metadata και **δεν είναι παραγωγική ενημέρωση**.
Ο συντονιστής οριστικοποιεί Client versionCode/εκδόσεις/cache keys/snapshots,
επανελέγχει το τελικό main και αναλαμβάνει αποκλειστικά δημοσίευση/επαλήθευση.
