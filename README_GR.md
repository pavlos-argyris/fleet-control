# Fleet Control — Πηγαίος κώδικας πακέτου 5.36.6

Αυτό το ZIP περιέχει τα πραγματικά αρχεία πηγής που εντοπίστηκαν στον υπάρχοντα φάκελο εργασίας του Fleet Control. Τα αρχεία Java δεν προέρχονται από JADX. Η αντιστοιχία τους με τα διαθέσιμα APK επιβεβαιώθηκε με νέα τοπική μεταγλώττιση.

| Τμήμα | Έκδοση | Φάκελος |
|---|---|---|
| Android Client | 5.36.5, versionCode 46 | `client-android/` |
| Android Server | 2.0.12, versionCode 15 | `server-android/` |
| Cloudflare Worker | 5.0.41 | `cloudflare-worker/src/` |
| Web και Portal | Αρχεία του πακέτου 5.36.6· frontend 5.36.5 | `cloudflare-worker/public/` |

Το πακέτο 5.36.6 διατηρεί τον Client 5.36.5. Δεν βρέθηκε ούτε δημιουργήθηκε Client APK με ετικέτα 5.36.6. Στον Server 2.0.12 υπάρχει η ρύθμιση παράλληλης επεξεργασίας τιμολογίων 1–10, με προεπιλογή 4.

## Τι περιλαμβάνεται

- Όλα τα 125 αρχεία πηγής, πόρων, ρυθμίσεων, τεκμηρίωσης και scripts του εντοπισμένου έργου, χωρίς αλλαγές στο περιεχόμενό τους.
- 4 αρχεία Java για τον Client και 14 για τον Server, μαζί με manifests, Android resources και ενσωματωμένα web assets.
- Κώδικας Worker και Web, `package.json`, `package-lock.json`, `wrangler.jsonc` και τα υπάρχοντα scripts ελέγχων/build.
- Το αρχικό πακέτο διανομής 5.36.6 και τα αντίστοιχα APK στον φάκελο `reference-releases/`.
- Στοιχεία αντιστοίχισης, αποτελέσματα ελέγχων και hashes στους φακέλους `verification/`, `SOURCE_INDEX.json` και `SHA256SUMS.txt`.

## Τι επιβεβαιώθηκε στις 2026-10-09

1. Ο αρχικός κώδικας Java και των δύο εφαρμογών μεταγλωττίστηκε επιτυχώς.
2. Τα νέα `classes.dex` είναι απολύτως ίδια ανά byte με εκείνα των αντίστοιχων APK.
3. Τα manifests, τα compiled resources και όλα τα assets που παρήγαγε το build ταυτίζονται με εκείνα των APK.
4. Ολοκληρώθηκε ολόκληρο το `scripts/build-android.sh all`, μαζί με υπογραφή και έλεγχο υπογραφής και των δύο APK.
5. Και τα 23 αρχεία του Web/Worker ταυτίζονται με το αρχικό `Fleet_Control_Web_Worker_Update_v5.36.6.zip`.
6. Τα 16 αρχεία JavaScript πέρασαν τον έλεγχο σύνταξης `node --check`.

Ολόκληρα τα ZIP/APK που ξαναχτίστηκαν έχουν διαφορετικό SHA-256 από τα παλαιά APK, παρότι το περιεχόμενο της εφαρμογής μέσα τους ταυτίζεται. Τα APK στον φάκελο `reference-releases/` είναι τα υπάρχοντα αρχικά αρχεία. Δεν έγινε εγκατάσταση σε συσκευή, έλεγχος λειτουργίας σε Android ή deploy του Worker. Οι δοκιμές λειτουργίας δεν υποκαθίστανται από τη μεταγλώττιση.

Το AAPT εξέδωσε προειδοποιήσεις για το πρόσθετο framework των foreground services. Το build ολοκληρώθηκε και τα binary manifests/resources ταυτίζονται με τα αρχικά. Το σχετικό log διατηρείται στο `verification/full-build.log`.

## Τοπικό Android build

Το έργο χρησιμοποιεί το υπάρχον script `scripts/build-android.sh`. Δεν είναι εξαγωγή Gradle/Android Studio από JADX.

Η επαλήθευση έγινε σε Linux, με Java 17 και την υπάρχουσα εργαλειοθήκη του έργου: Android 23 framework JAR, AAPT, Eclipse Java Compiler 3.32.0, DX 10.0.0, zipalign και apksigner 31.0.2. Στο παρόν πακέτο ανάπτυξης η εργαλειοθήκη Android περιλαμβάνεται στον διπλανό φάκελο `../toolchain/`. Η Java, το Node/npm, οι npm εξαρτήσεις και τα βασικά Linux πακέτα εγκαθίστανται χωριστά. Δες το `../DEVELOPER_HANDOFF_GR.md` για το πλήρες στήσιμο. Διατηρείται το `android-build-support/fgs-extension/` που χρειάζεται το αρχικό script.

Από τον φάκελο του έργου, με την ίδια διάταξη εργαλειοθήκης:

```bash
FLEET_ANDROID_TOOLCHAIN_ROOT=/absolute/path/to/toolchain bash scripts/build-android.sh all
```

Το script δέχεται επίσης `client` ή `server`, και επιμέρους διαδρομές μέσω των μεταβλητών `FLEET_ANDROID_JAR`, `FLEET_AAPT_BIN`, `FLEET_ECJ_JAR`, `FLEET_DX_JAR`, `FLEET_ZIPALIGN_BIN`, `FLEET_APKSIGNER_JAR`, `FLEET_KEYSTORE` και `FLEET_PRIVATE_KEYS`. Τα APK εξόδου γράφονται στο `dist/`.

## Ανάκτηση στοιχείων υπογραφής

Ο φάκελος εργασίας δεν περιείχε το keystore και το αρχείο ρυθμίσεων υπογραφής. Το υπάρχον `fleet-control-release.p12` ανακτήθηκε αυτούσιο από το παλαιότερο `Fleet_Control_PRIVATE_SOURCE_v5.6.zip`. Το πιστοποιητικό του επιβεβαιώθηκε ότι ταιριάζει και στα δύο νεότερα APK. Στο `docs/PRIVATE_SETUP_KEYS.txt` αντιγράφηκαν μόνο τα πεδία υπογραφής που απαιτεί το build· δεν αντικαταστάθηκαν ρυθμίσεις ή κλειδιά εφαρμογής/backend.

Το ZIP περιέχει ιδιωτικό κλειδί και κωδικούς υπογραφής, καθώς και τις υπάρχουσες ρυθμίσεις του έργου. Είναι προσωπικό αντίγραφο ανάπτυξης και δεν προορίζεται για δημόσια ανάρτηση.

## Web/Worker

Ο κώδικας βρίσκεται στο `cloudflare-worker/`. Το `package-lock.json` διατηρείται αυτούσιο. Για ανάπτυξη χρειάζονται οι npm εξαρτήσεις του έργου και οι σωστές ρυθμίσεις Cloudflare/D1 για τον λογαριασμό σου. Οι αρχικές οδηγίες είναι στο `cloudflare-worker/ΟΔΗΓΙΕΣ.txt` και στο `docs/UPDATE_5.36.6_INSTALL_GR.txt`.

Το ZIP περιέχει τον πηγαίο κώδικα και τα αρχεία διανομής. Δεν περιέχει αντίγραφο της ενεργής βάσης δεδομένων ή των δεδομένων χρηστών.
