# Issue #61 — πύλες ελέγχου αποκατάστασης

Διατηρούμε τα υπάρχοντα `BackupManager.java`, `BackupCipher.java`, `BackupArchiveVerifier.java`, `BackupJobs.java` και `BackupStatus.java`· **δεν** δημιουργούμε δεύτερο σύστημα αρχείων ασφαλείας.

## Τι προστέθηκε στην πρώτη φάση

- `cloudflare-worker/src/backup-recovery-evidence.js`: καθαρή συνάρτηση που **αρνείται** να εμφανίσει αποδεικτικό επαναφοράς αν λείπουν στοιχεία για κρυπτογραφική ακεραιότητα, πλήρη κάλυψη δεδομένων, πραγματικά ξεχωριστή μη παραγωγική ανάκτηση, row-count και referential checks. Δεν ανοίγει αρχεία και δεν επαναφέρει στοιχεία.
- `scripts/test-backup-recovery-evidence.mjs`: synthetic regression για καλό ZIP χωρίς restore, κατεστραμμένο tag, ελλιπή datasets, μη απομονωμένο restore, διαφορά μετρήσεων και ενδεχόμενη παραγωγική εγγραφή.
- Η ήδη υπάρχουσα `scripts/test-backup-archive.mjs` επαληθεύει πραγματικό Java ZIP verifier σε synthetic archives (CRC, SHA, manifest, path traversal, όριο μεγέθους) και το `BackupManager.verifyBackup`. Αυτά δεν αποτελούν απόδειξη πραγματικού restore.

## Τι εκκρεμεί για ολοκλήρωση

1. Εξαγωγή ενός μη προσωπικού δοκιμαστικού backup από actual Server APK και επιβεβαίωση πλήρους coverage (fleet, καταστήματα, μισθοδοσία, τιμολόγια, δικαιώματα, schedules).
2. Πλήρης απομονωμένη ανάκτηση σε προσωρινό SQLite και πραγματικός έλεγχος με `PRAGMA integrity_check`, foreign keys, row counts, IDs, source reconciliation και δικαιώματα.
3. Προσθήκη αξιόπιστου native evidence, encrypted automatic scheduling, επιλεγμένου προορισμού, retention, έλεγχος απώλειας/αποτυχίας backup και ορατό αποτέλεσμα.
4. Καμία δοκιμαστική ή κανονική επαναφορά στα παραγωγικά δεδομένα χωρίς ξεχωριστή άδεια. Τα original signing keys και οι κωδικοί Ordexa δεν εξάγονται.

Αυτό το branch είναι **θεμέλιο κανόνων και tests**, όχι backup/restore complete.
