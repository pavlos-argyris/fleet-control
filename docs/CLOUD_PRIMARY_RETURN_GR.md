# Επιστροφή σε Cloudflare primary — 08/11/2026

## Νεότερη εξουσιοδότηση

Ο ιδιοκτήτης ζήτησε διατήρηση όλων των αναβαθμίσεων, κύρια αποθήκευση στη D1 και απευθείας login/χρήση Web και Client μέσω Cloudflare. Ο Android Server παραμένει αναγνώστης Ordexa/βοηθητικός υπολογιστής. Έδωσε ρητή άδεια υλοποίησης και δημοσίευσης. Η παρούσα οδηγία υπερισχύει της προηγούμενης επιλογής native primary. Δεν επιτρέπονται εικονική επιτυχία, απώλεια νεότερων δεδομένων ή απλή άρση του writer fence στην παλιά D1.

## Πραγματικά ευρήματα

- Δημόσιο read-only descriptor στην αρχή ελέγχου: `mode=active`, `connected=true`. Η ολοκληρωμένη ενεργοποίηση δεν ακυρώνεται από `/api/primary/abort`.
- Το `routePrimary` προηγείται του ensureSchema και της παλιάς διαδρομής D1. Οι D1 business tables έχουν writer-fence triggers. Αλλαγή descriptor μόνο δεν αποκαθιστά σωστά τη βάση.
- Τα Web/Client αποθηκεύουν accepted server identity. Η νέα cloud ενεργοποίηση χρειάζεται ρητή αυθεντική απόδειξη αποδέσμευσης της παλιάς authority και καθαρισμό/λήξη των παλιών συνεδριών. Μην αποδυναμώσεις γενικά το encrypted transport ή αποδεχθείς παλιό cloud ως fallback.
- Τα νέα `server-runtime` cash/reports/payroll review/health handlers χρησιμοποιούν D1-compatible SQL αλλά και native ports. Δεν αρκεί ένα Worker redeploy: `FleetHost`, private files/exports, store context και οι νέοι local tables πρέπει να αποκτήσουν πραγματική cloud υλοποίηση.
- `store_billing_local`, source snapshots, mappings, immutable cash ledger/history, aliases, payroll αποφάσεις και native objects χρειάζονται ταξινόμηση και επαληθευμένη μεταφορά. Τα local paths/Keystore/device identity/Ordexa credentials δεν μεταφέρονται στη D1.

## Σειρά υλοποίησης

1. Λήψη πρόσφατου πλήρους φορητού backup από τη συσκευή και χωριστό D1/R2 rollback αντίγραφο. Η δημόσια περιγραφή δεν περιέχει τις επιχειρησιακές εγγραφές και δεν αποδεικνύει backup.
2. Read-only inventory/σύγκριση συνεπών SQLite snapshots. Καμία σιωπηρή παράλειψη άγνωστου πίνακα, schema, 64-bit integer, REAL, BLOB ή duplicate row. Έλεγχος καταχωρίσεων που υπάρχουν μόνο στη μία πλευρά. Ταυτότητα/credentials μένουν ιδιωτικά.
3. Shared business handlers με request-scoped cloud ports, D1 schemas και R2 exports/files. Όλες οι νέες οθόνες πρέπει να λειτουργούν και χωρίς κινητό συνδεδεμένο. Πραγματική διατήρηση scope, historical tariffs, source coverage, receipts/reversals και CAS.
4. Αντίστροφη μεταφορά με αυθεντικοποιημένο resumable staging, ατομικό έλεγχο hashes/πληθών/σχέσεων και πλήρη έλεγχο objects. Προσωρινό σταμάτημα όλων των native writers/jobs/outbox για τελικό συνεπές snapshot. Καμία ταυτόχρονη εγγραφή δύο primary.
5. Activate cloud μόνο μετά πλήρη αντιπαραβολή και backend readiness. Crash-safe coordinator/local state, χαμένο ACK/resume, replay rejection και rollback χωρίς διαγραφή πρωτοτύπου. Το παλιό native lease/transport πρέπει να πάψει να γράφει πριν δεχτεί cloud writes.
6. Android cloud-mode εργασίες Ordexa στέλνουν μόνο αλλαγές/παρτίδες. Μεταγενέστερη συνδεσιμότητα δεν επανενεργοποιεί native primary. Μετρημένος D1 προϋπολογισμός, όχι υπόσχεση ότι το free όριο επαρκεί.
7. Πραγματικά D1/SQLite/objects/transport και offline-server Web/Client acceptance, πλήρες exact-head/main CI, αρχικές υπογραφές και κανονική exact-source δημοσίευση. Η δημοσίευση λογισμικού και η μεταφορά παραγωγικών δεδομένων καταγράφονται χωριστά.

## Υπάρχον πρώτο εργαλείο

`python3 scripts/cloud-return-preflight.py --source SOURCE_SNAPSHOT.db --cloud CLOUD_SNAPSHOT.db`

Είναι μόνο το πρώτο read-only εργαλείο σύγκρισης, όχι αντίστροφη μεταφορά ή ολοκληρωμένο backend. Δέχεται ήδη συνεπή standalone SQLite snapshots, όχι FCB3/ZIP ή live database. Δεν εκτελεί DDL/import/activate και επιστρέφει πάντοτε `activationAllowed=false`. Δεν δημοσιεύονται παραγωγικά δεδομένα ή exports στο GitHub.

`python3 scripts/test-cloud-return-preflight.py` επαληθεύει 64-bit ακρίβεια, INTEGER≠REAL, empty BLOB≠NULL, διπλότυπα, ανισότητα δεδομένων, απουσία row values από output, read-only και απόρριψη WAL/missing files. Δεν αποτελεί πραγματικό production reconciliation ή full CI.

## Κατάσταση

Ολοκληρώθηκαν η στοχευμένη ανάλυση και το αρχικό εργαλείο με συνθετικούς ελέγχους. Δεν έχουν υλοποιηθεί ακόμη τα βήματα 3–7. Δεν έγινε production migration, activation, restore, D1 write ή δημοσίευση. Πρώτη εξωτερική ανάγκη: πρόσφατο πλήρες φορητό backup του ενεργού Android Server και ασφαλής πρόσβαση σε snapshot της D1. Δεν ζητούνται κωδικοί στη συνομιλία ή δημόσιο GitHub.
