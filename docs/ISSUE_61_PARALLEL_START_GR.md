# Fleet Control — Issue #61, checkpoint εκκίνησης

Η εντολή υλοποίησης δόθηκε στις 04/11/2026. Issue: https://github.com/pavlos-argyris/fleet-control/issues/61.

- Branch: `codex/roadmap-61-restore-verification`
- Ακριβές αρχικό main SHA: `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd`
- Scope πρώτης ανεξάρτητης φάσης: Μη καταστροφικοί έλεγχοι backup και σχέδιο πραγματικής μη παραγωγικής ανάκτησης· χωρίς restore.
- Καμία ενδιάμεση παραγωγική δημοσίευση: στόχος μία τελική κοινή έκδοση μετά την ολοκλήρωση όλων των modules και επιτυχείς ελέγχους.
- Ordexa αποκλειστικά read-only. Καμία αυθαίρετη μεταβολή μισθοδοσίας, παραγωγικής SQLite/D1, credentials, signing keys, τελικού publish.
- Το branch δεν θεωρείται έτοιμο όταν υπάρχει μόνο ένα foundation / audit. Έλεγχος ξεχωριστών tests και ακριβούς source CI πριν από merge. Το `docs/CHATGPT_HANDOFF_GR.md` του τρέχοντος main πρέπει να συγχωνευθεί στο τελικό integration checkpoint ώστε να μη χαθεί καταγραφή παράλληλου agent.

## Εκκρεμούν
- Εξαρτήσεις και πραγματική διαθεσιμότητα πηγής/συσκευής, ενσωμάτωση με ενεργό UI/API, έλεγχος permissions, backup και πλήρης αποδοχή.
