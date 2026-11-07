# Server 2.10.20 — αρχικοποίηση τοπικού σχήματος SQLite

## Περιστατικό και αναπαραγωγή

Μετά τη διόρθωση πόρων Rhino της 5.61.1 ο ιδιοκτήτης ανέφερε αποτυχία
`Local capability failed (bundled-business#2)` στη μεταφορά/σύγκριση δεδομένων.
Η δημόσια περιγραφή έδειξε `mode=preparing`. Το γενικό μήνυμα καλύπτει πολλές
διαφορετικές native αιτίες και δεν θεωρείται από μόνο του ακριβής διάγνωση συσκευής.

Βρέθηκε συγκεκριμένο σφάλμα στο `BusinessSqlite`: η native υλοποίηση του D1
`exec` εκτελούσε κάθε μη κενή γραμμή με `SQLiteDatabase.execSQL`, μαζί με τα
standalone `--` σχόλια του σχήματος Ταμείου. Η Python SQLite του παλιού fixture
δεχόταν αυτά τα σχόλια ως no-op. Η SQLite C API επιστρέφει null statement για
κενό SQL/σχόλια· η Android JNI διαδρομή που το εκτελεί αποτυγχάνει.

Επαληθεύτηκε απευθείας με `sqlite3_prepare_v2`/`sqlite3_step` (status21 για
comment-only). Ο αυστηρότερος adapter δοκιμών αναπαρήγαγε το ακριβές παλιό
μήνυμα κατά την αρχικοποίηση του πραγματικού production runtime.

Πρωτογενείς αναφορές: [SQLite prepare](https://www.sqlite.org/c3ref/prepare.html),
[Android execSQL](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase#execSQL(java.lang.String)),
[Android12 SQLite JNI](https://android.googlesource.com/platform/frameworks/base/+/android12-release/core/jni/android_database_SQLiteConnection.cpp).

## Διόρθωση και έλεγχοι

- Οι newline-separated SQL εγγραφές χωρίς εκτελέσιμη εντολή παραλείπονται.
  Το SQL που εκτελείται παραμένει αυτούσιο: εισαγωγικά, comment markers μέσα σε
  literals και ολόκληρα trigger bodies διατηρούνται.
- Το native fixture απορρίπτει comment-only SQL και αποτελέσματα από execSQL,
  όπως η Android API, ενώ οι πραγματικές εγγραφές/queries παραμένουν σε SQLite.
- Ελέγχονται μετρητής εκτελεσμένων εντολών, CRLF, inline σχόλια, literals και
  πραγματικό rollback όταν αποτύχει επόμενη εντολή του script.
- Τα σφάλματα capability εμφανίζουν σταθερή κατηγορία, όπως
  `SQL_EXEC/SQLITE_SCHEMA`. Άγνωστο command, raw SQL, παράμετροι και αρχικό
  exception message δεν αντιγράφονται στο μήνυμα. Η αναζήτηση cause είναι bounded.
- Η πλήρης δοκιμή production runtime/SQLite/migration/cash/backup περνά με
  τον αυστηρότερο adapter. Οι αρνητικοί έλεγχοι και οι canaries διάγνωσης
  διατηρούν την προστασία δεδομένων και το αμετάβλητο οικονομικό ιστορικό.

Η διόρθωση των πέντε πόρων Rhino, οι αρχικές υπογραφές και οι πύλες
owner/lease/backup παραμένουν. Δεν εκτελείται παραγωγικό restore από agent.
Οι δοκιμές JVM/SQLite με Android API contract δεν υποκαθιστούν την τελική
φυσική εγκατάσταση και ολοκλήρωση της μεταφοράς.

## Συνέχεια στη συσκευή μετά τη δημοσίευση

1. Αν η αποτυχημένη μεταφορά κρατά φραγή καταχωρίσεων, χρησιμοποίησε την
   υπάρχουσα ρητή Ρυθμίσεις → Κύρια βάση Server → Ακύρωση μεταφοράς.
2. Ενημέρωσε μόνο τον Server σε 2.10.20 πάνω στην υπάρχουσα εφαρμογή.
   Client/Web 5.61.0 παραμένουν συμβατά.
3. Επανάλαβε «Μεταφορά και έλεγχος» ή «Συνέχεια μεταφοράς», ανά την
   αποθηκευμένη κατάσταση. Ο φορητός κωδικός ανάκτησης διατηρείται.
4. Ολοκλήρωση μόνο με «Η κύρια βάση λειτουργεί σε αυτόν τον Server», μετά
   την πλήρη σύγκριση, το backup και την απομονωμένη δοκιμή ανάκτησης.
