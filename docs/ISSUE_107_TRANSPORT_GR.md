# Issue #107 — HTTPS και προτεραιότητες Direct writer

## Αλλαγή

Η TLS σύνδεση επαναχρησιμοποιείται για πλήρως καταναλωμένα, ελεγμένα GET/HEAD. Κάθε επόμενο αίτημα ξαναπερνά Host, origin/CSRF, framing, ασφαλή headers, πραγματική TCP προέλευση και κανονικό handler/auth. Δεν μεταφέρεται εξουσιοδότηση από προηγούμενο αίτημα. Όρια:32 αιτήματα/σύνδεση,3sec idle,60sec ζωή. Write, streaming download χωρίς μήκος, SSE και explicit `Connection: close` κλείνουν. HEAD/304 έχουν σαφή framing. Max8 SSE κρατούν διαθέσιμους τους υπόλοιπους HTTPS readers. Gzip/ETag/cache ισχύουν μόνο στα δημόσια bundled assets· τα επιχειρησιακά responses παραμένουν private/no-store.

Ο μοναδικός SQLite/Rhino writer παραμένει σειριακός και δεν διακόπτει ενεργή transaction. Η bounded ουρά επιλέγει πρώτα διαδραστικές εγγραφές/login, έπειτα αναγνώσεις, έπειτα εργασίες παρασκηνίου, FIFO στην ίδια προτεραιότητα. Συνολικό όριο32 και background24 κρατούν8 θέσεις για διαδραστικά αιτήματα. Η βαριά εργασία που ήδη εκτελείται εξακολουθεί να χρειάζεται χωριστό ασφαλές read model· δεν δηλώνεται ότι αυτό λύθηκε μόνο με προτεραιότητες.

## Μετρήσεις και έλεγχοι

Πραγματικά τοπικά TLS sockets, Java, συνθετικό health JSON,4 reads/client. Before: νέα σύνδεση για κάθε read (η παλιά συμπεριφορά). After: επαναχρησιμοποίηση της ίδιας TLS σύνδεσης. Ίδιο ακριβώς σώμα JSON. Τα δεδομένα δεν περιγράφουν Note10+, WAN ή το πραγματικό dataset της εταιρείας.

| Clients | Close p50 / p95 / p99 ms | Reuse p50 / p95 / p99 ms | Συνολικός χρόνος close → reuse ms |
|---|---|---|---|
|1|48,79 /55,30 /55,30|0,61 /96,89 /96,89|206,16 →100,22|
|8|56,56 /73,36 /81,94|1,11 /93,33 /106,25|255,23 →118,91|
|32|65,09 /108,55 /118,29|0,93 /100,78 /115,59|402,46 →175,48|

Η επαναχρησιμοποίηση μειώνει το τυπικό επόμενο read και τον συνολικό χρόνο αυτού του δείγματος. Το πρώτο handshake εξακολουθεί να κοστίζει: τα μικρά δείγματα1/8 clients έχουν μεγαλύτερο p95/p99 στο reuse. Δεν αποτελεί εγγύηση βελτίωσης κάθε request ή χρήστη.

`test-independent-network.mjs` επιβεβαίωσε πραγματικό TLS, ανά αίτημα handler authorization,401 στο δεύτερο read, επόμενο λάθος Host, ακριβή HEAD/304 boundaries, explicit/write close, όριο32 και idle timeout. Διατηρούνται SAN/key/CA, plaintext rejection, CSRF/smuggling/traversal,30 παράλληλοι clients, ACME και certificate-transfer regressions. Τα μηχανικά αποτελέσματα αποθηκεύονται στο `.build/independent-network/transport-benchmark.json` και στο CI artifact.

`test-independent-work-queue.mjs` εκτελεί την πραγματική Java ουρά: σειρά προτεραιοτήτων, καμία διακοπή ενεργής εργασίας, όρια24/32 και μοναδικός writer. Πλήρες exact-source CI/APK build παραμένει προϋπόθεση merge. Στο #107 εκκρεμούν τα read models, query profiling και οι φυσικοί τελικοί έλεγχοι.
