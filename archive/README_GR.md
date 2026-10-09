# Ακριβές αρχικό ιστορικό Fleet Control

Το `fleet-control-original-history.bundle` περιέχει ολόκληρο το αρχικό ιστορικό Git, τα ακριβή commits και τα tags πριν από την πρώτη εισαγωγή στο GitHub. Δεν περιλαμβάνει ιδιωτικά signing keys ή το πραγματικό Server credential. Έγινε έλεγχος όλων των αρχικών προσβάσιμων blobs πριν από τη μεταφορά.

Ο πλήρης κώδικας βρίσκεται επίσης στους κανονικούς φακέλους του αποθετηρίου. Τα commits εισαγωγής διατηρούν τα ίδια Git tree SHA με τις αρχικές εκδόσεις και καταγράφουν το αρχικό commit. Ο πίνακας αντιστοίχισης βρίσκεται στο `source-import-map.json`. Οι κωδικοί commits εισαγωγής διαφέρουν επειδή δημιουργήθηκαν στο GitHub· αυτό το bundle διατηρεί το ακριβές αρχικό ιστορικό.

Από τον κεντρικό φάκελο του έργου:

```bash
sha256sum --check archive/fleet-control-original-history.bundle.sha256
git bundle verify archive/fleet-control-original-history.bundle
git fetch archive/fleet-control-original-history.bundle 'refs/heads/main:refs/heads/archive/original-main' 'refs/tags/*:refs/tags/*'
git log --oneline --all
```

Το `main` του GitHub συνεχίζει να είναι η τρέχουσα έκδοση. Το `archive/original-main` και τα αρχικά tags δίνουν πρόσβαση στην ακριβή προηγούμενη ιστορία. Για ανεξάρτητη ανάκτηση σε νέο φάκελο:

```bash
git clone archive/fleet-control-original-history.bundle ../fleet-control-original
```

Κράτησε ξεχωριστά το ιδιωτικό ZIP ανάκτησης κλειδιών που παραδόθηκε. Ο κώδικας και το ιστορικό δεν είναι backup της παραγωγικής βάσης ή των τιμολογίων.
