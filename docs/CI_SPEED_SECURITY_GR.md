# Fleet Control — ταχύτερες και ασφαλείς αλλαγές (CI pipeline)

## Τι αλλάζει στο παρόν PR

- Νέα μικρή **Fast source checks** σουίτα μόνο σε pull requests ή χειροκίνητο `workflow_dispatch`. Το `scripts/check-fast.sh` ελέγχει **shell/JS syntax, tracked-source credentials, αντιστοιχίσεις δικαιωμάτων, release capacity, pinned publication request και release transport**. Δεν χρειάζεται npm/browser/Android toolchain, επομένως δίνει γρήγορη πρώτη ένδειξη χωρίς κατέβασμα μεγάλων εξαρτήσεων.
- Το υπάρχον **Check saved source** παραμένει το υποχρεωτικό full gate σε PR και `main`: `check-all.sh`, πραγματικό Chromium/browser, native/SQLite/Worker tests, δοκιμαστικές υπογραφές και Android builds, Worker dry-run και πλήρες source ZIP. Ο έλεγχος δημοσίευσης εξακολουθεί να δέχεται **μόνο επιτυχές exact-source main CI**. Το fast job **δεν** εξουσιοδοτεί merge/deploy.
- Στο full CI ενεργοποιείται `actions/setup-node` npm cache με κλειδί lockfile και `actions/cache` για Chromium/Playwright με κλειδί package-lock hash. Το `npm ci` και το `npx playwright install chromium` **εξακολουθούν να εκτελούνται**, ώστε stale cache να μη θεωρείται υποκατάστατο εγκατάστασης.
- Νέα `concurrency`: μόνο νέες αναθεωρήσεις **του ίδιου PR** ακυρώνουν παλαιότερους ελέγχους του ίδιου τύπου. Οι ξεχωριστές main source CI runs έχουν μοναδικό group ανά source SHA και **δεν ακυρώνονται**. Το workflow παραγωγικής δημοσίευσης παραμένει ανεπηρέαστο, σειριοποιημένο και κλειδωμένο στο συγκεκριμένο source.
- Αν αποτύχει το fast/full CI δημιουργείται GitHub job summary με run/source σύνδεσμο. Η αποτυχία αποθήκευσης **προαιρετικών browser screenshots** δεν ακυρώνει επιτυχώς εκτελεσμένα tests· οι ουσιαστικοί έλεγχοι, ο υποχρεωτικός source handoff και η πιστοποίηση APK παραμένουν required.
- Δεν αλλάζουν application logic, API, ιδιωτικά κλειδιά, έκδοση Client/Server/Web/Worker, release workflow, schema D1, παραγωγικά δεδομένα ή υπάρχοντα APK.

## Μέτρηση πριν/μετά

Επιβεβαιωμένες durations του πλήρους CI στις 04/11/2026 (διάρκεια run):
- #41889668185: **8m15s** (success).
- #41890780098: **8m58s** (success).
- #41892445599: **10m04s** (success).

**Στόχοι, όχι εγγυημένες μετρήσεις:** πρώτη ένδειξη fast <2min και ίση ή χαμηλότερη μέση πλήρης διάρκεια μετά τα warm caches. Κατέγραψε τις πραγματικές διάρκειες των πρώτων τουλάχιστον 3 fast/full PR runs, bytes/χρόνο cache restore/save και συνολικά Actions minutes. Μη θεωρείς την πρόβλεψη επιτυχία πριν μετρηθεί. Τα επιπλέον fast jobs έχουν κάποιο κόστος runner minutes και cache storage· αν αυξάνουν τη συνολική κατανάλωση, αναθεώρησέ τα.

## Feature-to-code map — λιγότερες περιττές αναγνώσεις

Ο κεντρικός [χάρτης λειτουργιών](CODE_MAP_GR.md) και τα μηχανικά επικυρώσιμα [ownership patterns](CODE_MAP.json) καταγράφουν 13 ομάδες λειτουργιών, τα βασικά paths, τις εξαρτήσεις τους και σχετικά tests. Ο απλός `node scripts/code-map.mjs --paths ...` προτείνει δοκιμές· το `--base origin/main` προβάλλει impact από το branch. Το `--check` τρέχει πλέον σε γρήγορο και πλήρες CI, αποτρέποντας stale ρητές διαδρομές/δοκιμές χωρίς να προβάλλει ψευδή εγγύηση πλήρους κάλυψης. Οι νέες λειτουργίες ενημερώνουν τον χάρτη στο ίδιο PR.

## Στάνταρ ασφαλούς ανάπτυξης (GitHub ή Cursor/Work)

1. Διάβασε νέο `AGENTS.md`, `docs/CHATGPT_HANDOFF_GR.md`, issues/PR και την κατάσταση production publish. Κράτα κάθε εργασία σε αποκλειστικό branch με σαφές scope και checkpoint. Μην πατάς πάνω σε κώδικα παράλληλου agent.
2. Εκτέλεσε `bash scripts/check-fast.sh` για πρώτη ανατροφοδότηση σε μικρές αλλαγές. Εκτέλεσε στοχευμένες δοκιμές της σχετικής λειτουργίας πριν από push. Δεν παρακάμπτονται source safety checks.
3. Κάνε push και εξέτασε **και** Fast source checks **και** Check saved source. Αν αποτύχει fast/full: αναθεώρησε το πρώτο πραγματικό failing step, μην επανεκκινείς στα τυφλά ούτε καταγράφεις ψευδή επιτυχία.
4. Έλεγξε συγκρούσεις με νεότερο `main`, επιβεβαίωσε ξανά full CI για το τελικό head και ενσωμάτωσε μόνο όταν ισχύουν τα κριτήρια. Για source commit στο `main`, αναμένεις το απαιτούμενο exact-source CI και όχι αποτέλεσμα άλλου commit.
5. Αν η αλλαγή απαιτεί νέα παραγωγική έκδοση, χρησιμοποίησε **μία** ξεχωριστή ρητά εξουσιοδοτημένη publish request σύμφωνα με `docs/AUTOMATIC_PUBLISH_GR.md`. Καμία ταυτόχρονη ανταγωνιστική έκδοση, κανένα rewrite των δημοσιευμένων release bytes ή αλλαγή αρχικών signing keys. Ενεργοποίηση σημαίνει επιβεβαιωμένο `activated:true` και live checks, όχι απλώς uploaded GitHub Release.
6. Πριν κλείσει ένα λειτουργικό issue: πραγματική συσκευή/υφιστάμενα δεδομένα ή σαφής καταγραφή ότι πρόκειται μόνο για synthetic δοκιμές, σχέδιο backup/rollback, σημειώσεις source SHA και αποτελέσματα.

## Επόμενες βελτιώσεις μετά τη μέτρηση (δεν υλοποιούνται με αυτό το PR)

- **Διαχωρισμός πλήρους suite** σε ανεξάρτητες browser/native/Worker ομάδες με απομονωμένα fixtures, συγκρίνοντας πραγματικά wall-clock και συνολικά runner minutes. Όχι τυφλή παράλληλη εκτέλεση tests που μοιράζονται SQLite/ports/source output.
- **Πιο έξυπνη τοπική επιλογή tests** ανά αλλαγμένα αρχεία με ρητό dependency map· ο full PR/main gate δεν περιορίζεται ούτε παραλείπεται λόγω path filters.
- **Ντετερμινιστικές ημερομηνίες/ώρα**: test clock/fake clock στα σενάρια "σήμερα", "εντός προγράμματος" και νυχτερινής αλλαγής ημέρας· ιστορικές ημερομηνίες παραμένουν για payroll regression. Σχετικά με προηγούμενη αποτυχία fixture #57.
- **Reproducible/attested build artifacts**: αξιολόγηση byte-identical reuse από ήδη ελεγμένο source για να μην επαναλαμβάνονται μεγάλα tests στο publish, ΜΟΝΟ εφόσον υπάρχει ισχυρή ανεξάρτητη provenance/source/signature verification και πραγματικός rollback. Το σημερινό full publish gate **μένει ανέπαφο**.
- **Pinned GitHub Actions commit SHAs και περιοδικές ενημερώσεις εξαρτήσεων**, τεκμηριωμένα least-privilege permissions, επιλεγμένα offline/security scans, όχι αυτοματοποιημένο deploy από PR ή untrusted forks.
- **Pilot deployment / smoke tests / stop-and-rollback plan** για αλλαγές με schema migration, με μη παραγωγικό restore verification. Μην επιχειρείται παραγωγικό restore χωρίς νέα εντολή.

## Όρια ασφαλείας

Το `check-fast.sh` δεν υπογράφει APK, δεν λαμβάνει production secrets, δεν τρέχει Workers/D1, δεν κάνει web updates και δεν μεταβάλλει Ordexa. Τα caches δεν αποθηκεύουν κλειδιά. Σε private repository ελέγξτε τα Actions/caches quota πριν θεωρήσετε την αλλαγή οικονομικά ουδέτερη.
