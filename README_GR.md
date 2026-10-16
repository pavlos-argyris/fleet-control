# Fleet Control 5.46.0

Client/Web 5.46.0 · Server 2.2.2 · Worker 5.8.0.
[Εργαλεία στόλου, ZIP και διάγνωση](docs/OPERATIONS_UPDATE_5.46.0_GR.md).

# Fleet Control 5.45.0

Client/Web 5.45.0 · Server 2.2.1 · Worker 5.7.1.
[Κουμπιά, εξηγήσεις και επιστροφή](docs/UI_NAVIGATION_UPDATE_5.45.0_GR.md).

# Fleet Control 5.44.0

Client/Web 5.44.0, Server 2.2.1, Worker 5.7.0.
Οδηγίες νέων επιλογών: [FOLLOWUP_UPDATE_5.44.0_GR.md](docs/FOLLOWUP_UPDATE_5.44.0_GR.md).

# Τρέχον update 5.43.0

[Οδηγίες service / backup / ιστορικού](docs/SERVICE_UPDATE_5.43.0_GR.md). Πλήρης παράδοση μέσω ιδιωτικού GitHub.

# Fleet Control — πλήρες έργο και OTA

Έκδοση πακέτου 5.42.1 · Client/Web 5.42.1 · Server 2.1.9 · Worker 5.5.1

Ιδιωτικό αποθετήριο: [pavlos-argyris/fleet-control](https://github.com/pavlos-argyris/fleet-control).

Περιλαμβάνει πλήρη πηγαίο κώδικα Android Client, Android Server, Web, Portal και Cloudflare Worker, κοινό installer, ιστορικό αλλαγών, φορητά εργαλεία build και GitHub Actions. Το ακριβές αρχικό ιστορικό με τα αρχικά commits και tags διατηρείται επιπλέον στο [Git bundle ανάκτησης](archive/README_GR.md).

Ξεκίνησε από [αρχική σύνδεση GitHub/OTA](docs/GITHUB_OTA_SETUP_GR.md). Για ανεξάρτητη ανάπτυξη και build διάβασε [οδηγίες κατασκευής](docs/BUILD_AND_HANDOFF_GR.md). Οι [σημειώσεις έκδοσης](docs/RELEASE_NOTES_CURRENT.md) περιγράφουν αλλαγές και πραγματικούς ελέγχους.

Για τις επόμενες εκδόσεις διάβασε [αυτόματη δημοσίευση από ChatGPT ή Cursor](docs/AUTOMATIC_PUBLISH_GR.md). Μια ξεχωριστή εντολή στο GitHub ξεκινά το workflow αυτόματα και δημοσιεύει το συγκεκριμένο commit που πέρασε τους ελέγχους. Τα συνηθισμένα push κώδικα ενεργοποιούν ελέγχους.

Η ενημέρωση 5.42.1 προσθέτει τοπικό ελληνικό OCR, μαζικά προσχέδια QR, ελέγχους διπλοτύπων/επίδρασης service, πηγές πεδίων, κανόνες προμηθευτών, cache και OTA ανά ώρα. Διάβασε τις [οδηγίες εγκατάστασης και ελέγχων](docs/INVOICE_LOCAL_UPDATE_5.42.1_GR.md). Χρειάζονται Server, Client, Web και Worker της νέας έκδοσης.

Για το επόμενο βήμα στα Windows, το [Setup OTA](docs/OTA_NEXT_STEP_WINDOWS_GR.md) καταχωρίζει τα ιδιωτικά secrets και διαβάζει τα υπάρχοντα Cloudflare bindings χωρίς δημοσίευση update.

Τα ιδιωτικά στοιχεία υπογραφής και το αρχικό κλειδί Server παραδίδονται ξεχωριστά. Δεν περιλαμβάνονται στο Git ούτε στο source ZIP. Τα νέα APK έχουν υπογραφεί με το αρχικό πιστοποιητικό· το δημόσιο fingerprint βρίσκεται στο signing-certificate.sha256.

Ο κώδικας έχει αποθηκευτεί στο ιδιωτικό GitHub. Οι παραγωγικές δημοσιεύσεις `fleet-v5.37.0` και `fleet-v5.37.1` ολοκληρώθηκαν επιτυχώς, μαζί με την ενεργοποίηση στο Cloudflare. Το πακέτο 5.37.2 προσθέτει τη διαδικασία αυτόματης εντολής έκδοσης, χωρίς αλλαγές στις εφαρμογές. Η επιτυχία δημοσίευσης επιβεβαιώνει τη διάθεση αρχείων· η πραγματική εγκατάσταση και η διατήρηση δεδομένων επιβεβαιώνονται στη συσκευή. Το [πρωτόκολλο δοκιμής OTA](docs/OTA_TEST_SERVER_2.1.1_GR.md) παραμένει διαθέσιμο.
