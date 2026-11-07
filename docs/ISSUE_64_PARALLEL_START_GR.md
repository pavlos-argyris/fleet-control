# Fleet Control — Issue #64, checkpoint εκκίνησης

Η εντολή υλοποίησης δόθηκε στις 04/11/2026. Issue: https://github.com/pavlos-argyris/fleet-control/issues/64.

- Branch: `codex/roadmap-64-safe-health-core`
- Ακριβές αρχικό main SHA: `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd`
- Scope πρώτης ανεξάρτητης φάσης: Pure status logic για freshness/unknown/alerts χωρίς D1 writes και χωρίς αληθινά δεδομένα.
- Καμία ενδιάμεση παραγωγική δημοσίευση: στόχος μία τελική κοινή έκδοση μετά την ολοκλήρωση όλων των modules και επιτυχείς ελέγχους.
- Ordexa αποκλειστικά read-only. Καμία αυθαίρετη μεταβολή μισθοδοσίας, παραγωγικής SQLite/D1, credentials, signing keys, τελικού publish.
- Το branch δεν θεωρείται έτοιμο όταν υπάρχει μόνο ένα foundation / audit. Έλεγχος ξεχωριστών tests και ακριβούς source CI πριν από merge. Το `docs/CHATGPT_HANDOFF_GR.md` του τρέχοντος main πρέπει να συγχωνευθεί στο τελικό integration checkpoint ώστε να μη χαθεί καταγραφή παράλληλου agent.

## Εκκρεμούν
- Εξαρτήσεις και πραγματική διαθεσιμότητα πηγής/συσκευής, ενσωμάτωση με ενεργό UI/API, έλεγχος permissions, backup και πλήρης αποδοχή.

## 05/11/2026 — πραγματική ενσωμάτωση στην οθόνη Server (PR #73)

Προστέθηκε στο υπάρχον μενού **Ρυθμίσεις → Διαγνωστικά → Άνοιγμα διάγνωσης** read-only ενότητα «Υγεία συστήματος», η οποία χρησιμοποιεί τα διαθέσιμα Native API snapshots (`getDashboard`, `getOrdexaStatus`, `getStoreBillingStatus`). Δεν υπάρχει νέο Worker endpoint, επαναλαμβανόμενο polling ή πρόσθετο D1 query/write.

- Πραγματική κατάσταση τοπικού Server/δικτύου, άγνωστο όταν το Native bridge δεν παρέχει απόδειξη.
- Ordexa παρουσίες με όριο φρεσκάδας 15 λεπτών, ξεχωριστή ένδειξη ανάγκης επανασύνδεσης, καμία διαχείριση διαπιστευτηρίων από το UI διάγνωσης.
- Καταστήματα με όριο 90 λεπτών, καθαρή ένδειξη εκκρεμών ημερών αποστολής από `StoreBillingSync.status` και διαφορετικό status για σφάλματα.
- Το υπάρχον `backupVerification.checkedAt/complete` αφορά **έλεγχο αναγνωσιμότητας** και **όχι** δοκιμή ανάκτησης· αναφέρεται ρητά ότι δεν υπάρχει τεκμήριο isolated restore (βλέπε #61).
- D1 quota: πάντα «άγνωστο» επειδή το Native bridge δεν παρέχει αξιόπιστο μετρητή από λογαριασμό Cloudflare. Απαγορεύεται η παρουσίαση πλασματικής τιμής 0.
- Αντιγραφή αναφοράς από σταθερή λίστα πεδίων. Δεν εξάγονται URL, account, credentials, ονόματα, raw orders, ακατέργαστα error strings. Η αναφορά **δεν** αποστέλλεται αυτόματα.
- Προστέθηκε `scripts/test-server-health-diagnostics.mjs` στο υποχρεωτικό `scripts/check-all.sh` και στο `docs/CODE_MAP.json`: missing/stale/future timestamps, credentials error, εκκρεμείς ημέρες, αποφυγή ψεύτικου restore/D1, rendering και προστασία export.

Αυτή είναι λειτουργική υποενότητα του Server APK branch, **όχι** ολοκλήρωση του #64. Δεν υπάρχει ακόμη επαληθευμένη φυσική εγκατάσταση, παρακολούθηση των πραγματικών quota counters ή ασφαλές alert acknowledgement. Το integration PR παραμένει draft και δεν αλλάζει παραγωγική έκδοση πριν ολοκληρωθούν τα #59–#64/#8 και περάσουν όλοι οι τελικοί έλεγχοι.
