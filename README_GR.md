# Fleet Control — πλήρες έργο και OTA

Client/Web 5.37.0 · Server 2.1.0 · Worker 5.1.0

Περιλαμβάνει πλήρη πηγαίο κώδικα Android Client, Android Server, Web, Portal και Cloudflare Worker, κοινό installer, ιστορικό Git, φορητά εργαλεία build και GitHub Actions.

Ξεκίνησε από [αρχική σύνδεση GitHub/OTA](docs/GITHUB_OTA_SETUP_GR.md). Για ανεξάρτητη ανάπτυξη και build διάβασε [οδηγίες κατασκευής](docs/BUILD_AND_HANDOFF_GR.md). Οι [σημειώσεις έκδοσης](docs/RELEASE_NOTES_CURRENT.md) περιγράφουν αλλαγές και πραγματικούς ελέγχους.

Τα ιδιωτικά στοιχεία υπογραφής και το αρχικό κλειδί Server παραδίδονται ξεχωριστά. Δεν περιλαμβάνονται στο Git ούτε στο source ZIP. Τα νέα APK έχουν υπογραφεί με το αρχικό πιστοποιητικό· το δημόσιο fingerprint βρίσκεται στο signing-certificate.sha256.

Το έργο είναι έτοιμο για αρχική σύνδεση λογαριασμών και δοκιμή στη συσκευή. Δεν έχει αποθηκευτεί σε απομακρυσμένο GitHub ούτε δημοσιευτεί στο Cloudflare. Για ολοκλήρωση απαιτούνται οι συγκεκριμένες ρυθμίσεις των οδηγιών.
