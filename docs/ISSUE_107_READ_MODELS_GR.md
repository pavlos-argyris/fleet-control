# #107 — Έτοιμες ιδιωτικές προβολές Direct και μετρήσεις

Ο Android Server/SQLite παραμένει μοναδική επιχειρησιακή αρχή. Το `IndependentReadModels` κρατά μόνο εξουσιοδοτημένα JSON αποτελέσματα στη RAM και τα διαβάζει από χωριστή read-only WAL σύνδεση. Έτσι ένα ήδη έτοιμο αποτέλεσμα μπορεί να εξυπηρετηθεί όσο ο μοναδικός writer εκτελεί άλλη συναλλαγή. Κανένα επιπλέον cloud backend ή persistent αντίγραφο οικονομικών δεδομένων δεν δημιουργείται.

## Ασφάλεια και συνέπεια

- Κάθε αίτημα ελέγχει ξανά την πραγματική SQLite συνεδρία, λήξη/ανάκληση, ενεργό χρήστη, forced logout και αλλαγές ρόλου/δικαιωμάτων. Partition ανά session/account, realm, backend revision και canonical παραμέτρους· η σειρά διπλών τιμών query διατηρείται. Τα response actor headers επιβεβαιώνονται πριν από αποθήκευση.
- Στο κανονικό APK ισχύουν και στη γρήγορη διαδρομή τα ίδια readiness/mode/epoch/pause gates μέσα σε `BackendMode.Guard`. Actual Android negative control σπέρνει επιτυχές hot DTO και απαιτεί503 από μη εγκεκριμένο Direct. Δεν παρακάμπτονται proof, file/export ή write endpoints.
- Μόνο επιτυχή JSON αντικείμενα από την allowlist επιτρέπονται. Auth tokens/secrets και υπάρχοντα domain snapshots αποκλείονται. Αν η optional cache αποτύχει, καλείται ο κανονικός authoritative handler.
- Scoped triggers ενημερώνουν revision counters μέσα στην ίδια business συναλλαγή. Ο χωριστός reader βλέπει αλλαγή μόνο μετά από commit. Rollback και presence-only `last_seen_at` δεν ακυρώνουν οικονομικά. Νέοι μη ταξινομημένοι business πίνακες ακυρώνουν συντηρητικά όλες τις προβολές. Staging παραγγελιών και session/file bookkeeping δεν προκαλούν περιττό rebuild.
- Ταυτόχρονα αιτήματα της ίδιας εξουσιοδοτημένης προβολής μοιράζονται μία background ανανέωση. Υπολογισμός που διασχίζει διαφορετικό committed revision δεν δημοσιεύεται. Διαφορετικές συνεδρίες διατηρούν χωριστή εξουσιοδότηση/DTO· τα υπάρχοντα κοινά Ordexa weekly projections παραμένουν στον Server.

## Πόροι και UX

Προετοιμασία κατά login μόνο για επιτρεπόμενες καρτέλες. Dirty προβολές ανανεώνονται μετά τα commits και οι ενεργά χρησιμοποιούμενες ανά15sec. Αχρησιμοποίητα warm αποτελέσματα δεν επανυπολογίζονται συνεχώς. Η writer ουρά έχει έως24 background, έως28 με reads και έως32 με login/writes, με FIFO εντός προτεραιότητας και χωρίς preemption συναλλαγής.

Έως256 προβολές/8MiB, έως1MiB ανά JSON, μέγιστη ηλικία5min. Σε διαθέσιμο heap κάτω32MiB το budget μειώνεται2MiB/512KiB. Οι αποκρίσεις περιέχουν revision, computedAt, sourceSyncedAt (null όταν δεν υπάρχει απόδειξη), coverage και stale/refreshing. Ένα παλιό ποσό παραμένει ορατό με ένδειξη ανανέωσης· δεν παρουσιάζεται ως επιβεβαιωμένο τρέχον μηδέν. Οι χειροκίνητοι editors δεν κλειδώνονται από background ανανέωση.

Web/Client κρατούν ιδιωτικά views μόνο στη RAM έως5min με session/ρόλο/δικαιώματα. Πρόσφατα PDF:4 αρχεία/16MiB/5min, επίσης RAM. Παλιά optional view caches καθαρίζονται· unsent drafts, operations και απαραίτητα bindings/pins διατηρούνται. Navigation/background checks συγκρίνουν revisions, διατηρούν ήδη φορτωμένο DOM και παύουν σε ενεργό editor. Ημερήσιο ταμείο ενημερώνει keyed rows χωρίς αλλαγή scroll/focus.

## Αναπαραγώγιμη επαλήθευση

`node scripts/test-independent-readmodels.mjs`: πραγματικές Java classes/SQLite WAL, EXPLAIN,32 concurrent readers, one refresh, stale/confirmed zero/partial, commit/rollback, νέα business table, actor mismatch, duplicate parameters, ανάκληση/λήξη/force logout, αλλαγές ρόλου και bounded age/shutdown. Τα artifacts γράφονται στο `.build/readmodel-verification/`.

Το synthetic benchmark έχει1/8/32 clients και κρατά επίτηδες τον disposable writer300ms. Η cache πρέπει να ολοκληρώσει τις αναγνώσεις πριν απελευθερωθεί ο ενεργός writer, με ακριβώς ίδιο μηδενικό JSON. Δεν είναι μέτρηση πραγματικού PDF/import ή Note10+. Σε μία εκτέλεση p50 baseline/cached ήταν299.8/12.2ms,310.9/254.5ms,318.6/83.4ms αντίστοιχα. Η διακύμανση p95 στον simulator δεν κρύβεται.

Χωριστή τοπική δοκιμή του πραγματικού business runtime με40 καταστήματα ×31 ημέρες (1.240 εγγραφές) έδωσε ακριβώς ίδιο report cold/hot,2.761ms/7ms. Πρόκειται για συνθετική βάση, όχι production baseline. Το authentication EXPLAIN χρησιμοποιεί ήδη primary-key indexes σε auth_sessions.token_hash και app_users.id: δεν προστίθενται διπλά indexes. Απαιτείται τελική φυσική μέτρηση με τον κανονικό Server.

`BusinessSqlite.profile()` μετρά μόνο allowlisted στάδια/count/mean/max/over100ms: queue wait, business request, SQL και PDF/XLSX/materialization. Δεν καταγράφει SQL κείμενα, παραμέτρους, IDs, credentials ή ιδιωτικά ποσά. Τα Direct health diagnostics εμφανίζουν τους counters/read-model budgets και D1 ως μη χρησιμοποιούμενο, χωρίς πλασματικά cloud quotas.

Πλήρες exact-source CI, normal-APK Android, original signatures και οι υπόλοιπες πύλες107 παραμένουν υποχρεωτικές. Η παρούσα αλλαγή δεν αποδεικνύει εγκατάσταση σε φυσική συσκευή ή παραγωγική αποκατάσταση ποσών.
