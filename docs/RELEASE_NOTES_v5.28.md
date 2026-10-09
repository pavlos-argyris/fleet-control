# Fleet Control v5.28 / Server 2.0.6

## Τι προστέθηκε

- Το QR τιμολογίου δεν προσπαθεί πλέον να κατεβάσει απλό HTML από τον Worker. Δημιουργείται εργασία `service_document_render` και εκτελείται από τον Server APK.
- Ο Server APK ανοίγει την ηλεκτρονική σελίδα της Impact σε WebView, χρησιμοποιεί το Android print pipeline και αποθηκεύει PDF με τα print styles της σελίδας.
- Το PDF ανεβαίνει στο ιδιωτικό R2 μέσω server-authenticated endpoint και κρατιέται ταυτόχρονα στο τοπικό storage του Server APK.
- Προστέθηκε OCR του παραγόμενου PDF στον Worker. Τα αποτελέσματα εμφανίζονται στον admin για έλεγχο και επιβεβαίωση.
- Προστέθηκε status polling για την εργασία QR, ώστε το Client να περιμένει περιορισμένο χρόνο ή να εμφανίσει το PDF στο επόμενο συγχρονισμό.
- Στο πλήρες ιστορικό service εμφανίζονται επισκευές/ανταλλακτικά από το OCR, QR, «Άνοιγμα PDF» και «Λήψη PDF».
- Η αναφορά ιστορικού ανοίγει μέσα στην εφαρμογή με κανονικό navigation state. Το Android Back επιστρέφει στην καρτέλα μηχανής και δεν κλείνει το APK.
- Η χειροκίνητη μεταφόρτωση PDF/φωτογραφίας παραμένει διαθέσιμη ως εφεδρική λύση.

## Εγκατάσταση

1. Στον υπάρχοντα φάκελο Worker κράτησε το δικό σου `wrangler.jsonc` και το πραγματικό `database_id`.
2. Αντέγραψε μόνο τους φακέλους `src/`, `public/` και το `package.json` του Worker από το update. Μην αντικαταστήσεις τυφλά το `wrangler.jsonc`.
3. Επιβεβαίωσε ότι τα bindings παραμένουν `DB`, `RELEASES`, `SERVICE_DOCS`, `AI` και `ASSETS`.
4. Εκτέλεσε στον φάκελο `cloudflare-worker`:

   ```text
   npm install
   npm run deploy
   ```

5. Αν το δικό σου R2 bucket τιμολογίων υπάρχει ήδη, δεν το ξαναδημιουργείς. Αν όχι, δημιούργησέ το μία φορά με `npx wrangler r2 bucket create fleet-control-service-documents`.
6. Ανέβασε πρώτα το `Fleet_Control_Server_v2.0.6.apk` και άφησέ το online.
7. Από το Server APK ανέβασε το `Fleet_Control_Client_v5.28.apk` στην επιλογή ενημερώσεων ή εγκατέστησέ το χειροκίνητα.
8. Έλεγξε ότι το `/api/status` δείχνει `serverOnline`, `databaseOk`, `storageOk` και `fleetControlOk` ως `true`.

Η δημιουργία PDF του QR απαιτεί ο Server APK να είναι ενεργός και συνδεδεμένος. Αν ο Server καθυστερεί, το QR παραμένει σε αναμονή και δεν χάνεται.
