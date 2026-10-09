# Fleet Control — πλήρες έργο και OTA

Client/Web 5.37.0 · Server 2.1.0 · Worker 5.1.0

Ιδιωτικό αποθετήριο: [pavlos-argyris/fleet-control](https://github.com/pavlos-argyris/fleet-control).

Περιλαμβάνει πλήρη πηγαίο κώδικα Android Client, Android Server, Web, Portal και Cloudflare Worker, κοινό installer, ιστορικό αλλαγών, φορητά εργαλεία build και GitHub Actions. Το ακριβές αρχικό ιστορικό με τα αρχικά commits και tags διατηρείται επιπλέον στο [Git bundle ανάκτησης](archive/README_GR.md).

Ξεκίνησε από [αρχική σύνδεση GitHub/OTA](docs/GITHUB_OTA_SETUP_GR.md). Για ανεξάρτητη ανάπτυξη και build διάβασε [οδηγίες κατασκευής](docs/BUILD_AND_HANDOFF_GR.md). Οι [σημειώσεις έκδοσης](docs/RELEASE_NOTES_CURRENT.md) περιγράφουν αλλαγές και πραγματικούς ελέγχους.

Για το επόμενο βήμα στα Windows, το [Setup OTA](docs/OTA_NEXT_STEP_WINDOWS_GR.md) καταχωρίζει τα ιδιωτικά secrets και διαβάζει τα υπάρχοντα Cloudflare bindings χωρίς δημοσίευση update.

Τα ιδιωτικά στοιχεία υπογραφής και το αρχικό κλειδί Server παραδίδονται ξεχωριστά. Δεν περιλαμβάνονται στο Git ούτε στο source ZIP. Τα νέα APK έχουν υπογραφεί με το αρχικό πιστοποιητικό· το δημόσιο fingerprint βρίσκεται στο signing-certificate.sha256.

Ο κώδικας έχει αποθηκευτεί στο ιδιωτικό GitHub. Η παραγωγική δημοσίευση στο Cloudflare, οι ιδιωτικές ρυθμίσεις GitHub Actions και η δοκιμή OTA στη συσκευή παραμένουν εκκρεμείς. Για ολοκλήρωση ακολούθησε τις συγκεκριμένες ρυθμίσεις των οδηγιών.
