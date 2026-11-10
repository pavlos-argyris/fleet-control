# #87 — Audit authority και στάδια Android SQLite / Named Tunnel

Αφετηρία: main `471c4e9052f419767ef3949917d1d7e6bab42a9c`, 10/11/2026. Κλάδος `codex/issue-87-android-tunnel`. Η νέα απαίτηση Android SQLite ως αποκλειστικός primary υπερισχύει του #85 Cloudflare-as-primary. **Καμία παραγωγική κατάσταση δεν έχει διαβαστεί/μεταβληθεί για το #87.** Η ύπαρξη πινάκων στον πηγαίο κώδικα/CI δεν αποδεικνύει φυσική βάση, εγκατάσταση, backup ή άδεια writer.

## Πραγματική σημερινή διαδρομή

| Σημείο | Τι κάνει ο κώδικας | Συνέπεια για #87 |
|---|---|---|
| `FleetDataStore` | SQLiteOpenHelper με WAL, `fleet-control-server.db`. Αν δεν υπάρχει, το `getReadableDatabase()` μπορεί να τη δημιουργήσει. Native projection σε prepared/active/cloud_return/needs_recovery/recovering. | Ο πρώτος έλεγχος απαιτεί `getDatabasePath().isFile()` και αυστηρό `OPEN_READONLY` πριν helper/schema. Απαγορεύεται άδεια production βάση. Απογραφή και retained cloud_remote πινάκων χωρίς αλλαγή phase. |
| `NativePrimaryState` | Durable phase/realm/generation· η phase μόνη δεν εξουσιοδοτεί writer. `cloud_remote` είναι ξεχωριστή κατάσταση. | Δεν γίνεται απλό UPDATE phase='active'. Τοπική παρουσία δεδομένων ελέγχεται ανεξάρτητα από παλιά cloud κατάσταση. |
| `NativePrimaryService` | Μοναδικός business executor, queue16, έως35s caller timeout. WebSocket reader και10s coordinator lease renewal. `available()` απαιτεί live cloud lease. `/api/primary/*` και OTA εξαιρούνται από local interception. | Το Tunnel δεν αρκεί για ανεξαρτησία. Θέλει νέο τοπικό authority mode/guard, bounded ingress, single writer και local OTA/static διαδρομή. Δεν αφαιρείται πρόωρα ο guard. |
| `NativePrimaryGuard` / `BusinessRuntime` | Realm/generation/phase και monotonic lease πριν request **και πριν commit**. Μία SQL request transaction περιλαμβάνει business/audit/receipt/outbox. | Διατηρούνται η ατομικότητα και τα checks. Τοπικό authority πρέπει να αποδεικνύεται από ξεχωριστή crash-safe cutover κατάσταση, όχι fake lease. |
| `server-runtime/entry.js` / `database.js` | Shared Worker handlers μέσα σε Rhino· `LOCAL_PRIMARY` και DB host→BusinessSqlite. Private paths και internal server credential αποκλείονται από εξωτερικό request. | Χρήσιμο υπάρχον business layer, χωρίς πραγματικό D1 στο local environment. Απαιτούνται επιπλέον δοκιμές όλων των routes με **απούσες cloud bindings και control network**· όχι υπόθεση από το όνομα DB. |
| `workforce.js` / `server-runtime/security.js` | PBKDF2 hashes/salt/iterations, local auth_sessions, roles/permissions, revoke, login attempts/audit. File handles δεσμεύονται σε τρέχον principal/security revision. | Κρατάμε υπάρχον PIN_PEPPER/authPepper και hashes. Νέο realm/hostname δεν σημαίνει νέο password ή pairing. Origin και peer δεν εμπιστεύονται απλές caller headers. |
| `DirectAccess` / `DirectServer` / `direct-relay.js` | Παλιά paired read-only εφεδρεία, καθρεφτισμένα δικαιώματα με όριο φρεσκάδας24h, συνεδρίες4h, DO μεταφορά encrypted πακέτων. | Δεν είναι production login του #87 και δεν επαναχρησιμοποιείται ως προϋπόθεση χρήστη. |
| `primary-transport.js` | Descriptor από cloud, pin/trust dialog αποτυπώματος, encrypted relay, pending operation IDs, response-file chunks/cache. | Νέο direct-HTTPS transport χρειάζεται ανεξάρτητη επιλεγμένη ρύθμιση. Δεν αφαιρείται γενικά το pinning από παλιές εγκαταστάσεις και δεν επαναπαίζεται unknown mutation σε άλλη γενιά. |
| `server-runtime/receipts.js` | Operation UUID, request+principal security hashes, cached αποτέλεσμα στην ίδια SQLite transaction. | Διατηρούνται idempotency semantics σε HTTP retries. Καμία επιτυχία πριν Android commit. |
| `SyncService` | Native service, παλιό pulse, mirror μόνο cloud mode, Ordexa/Cash/Stores/background lanes. Κάποια paths είναι διαφορετικά ανά phase. | Χρειάζεται audit κάθε job ώστε tunnel mode να μην κάνει control/health/mirror/backup D1/DO HTTP. Όχι μόνο απενεργοποίηση UI polling. |
| `NativeDatabaseSnapshot` / `NativeBackupBuilder` | VACUUM INTO με WAL-consistent snapshot, inventory/typed SQLite και private objects, encrypted FCB3/isolated restore. Sanitizes **copy**, source pins για object lifecycle. | Υπάρχον υλικό επαναχρησιμοποιείται μόνο μετά έλεγχο φυσικής βάσης και coverage όλων των private/local αρχείων. Δεν θεωρείται physical proof από CI. |
| `NativeBackupPreparation` | Σε cloud_remote επιλέγει `CloudBackupPreparation` με cloud HTTP. | Το κουμπί γενικού backup δεν είναι αυτομάτως ανεξάρτητο local preflight. Απαιτείται ρητή νέα local-only διαδρομή που δεν καλεί αυτόν τον branch. Δεν προτείνεται να τρέξει αδιακρίτως πριν έλεγχο phase. |
| `NativeMigrationCoordinator` | Παλιό cloud fence→seed→inventory/rows/cells import→files→backup→activate. | **Δεν καλείται** για το #87. Είναι υποχρεωτικό cloud import/compare που η νέα απαίτηση απαγορεύει από προεπιλογή. |
| `CloudReturnController` | Αντίστροφη μεταφορά σε νέο cloud primary, διατηρεί originals. | **Δεν καλείται** και δεν ενσωματώνεται στη νέα τοπική μετάβαση. |
| `OtaManager` / release handlers | `/api/server-update`, signed releases/downloads στο παλιό Worker. | Η νέα τακτική χρήση πρέπει να λειτουργεί χωρίς business authority/D1/DO. Συμφωνούνται static release manifests/immutable artifacts και συμβατή κατανομή πριν αλλαγή hostname. Δεν αλλάζουν αρχικά signing keys. |

## Overlap / τρέχουσα δημοσίευση

- #52: ανοικτή ιστορική απαίτηση direct πρόσβασης, υλοποιήσεις paired fallback/native relay υπάρχουν ήδη. Δεν το κλείνουμε ως ανεξαρτησία Tunnel.
- #85: συγχωνευμένο Cloudflare return. Το retained σχήμα, cloud fences και backends διατηρούνται, δεν γίνεται downgrade/αντικατάσταση κώδικα.
- #86: συγχωνευμένη5.62.1, source471c4e9· κατά την ανάληψη εκτελούνται full main CI42833572749 και prepare42833572589. Αυτή η δημοσίευση είναι ανεξάρτητη και δεν τροποποιείται.
- Draft #54 και #66–72: ανεξάρτητες αρχικές φάσεις με κοινά `check-all.sh`/`CODE_MAP.json`. Οι εγγραφές τους δεν σβήνονται. Πριν κάθε merge χρειάζεται νέο main/overlap check. Δεν δημιουργήθηκαν sub-agents ή δεύτερος writer στον κλάδο άλλου agent.

## Διαχωρισμός φυσικής απογραφής από δημόσιο δίκτυο

**Ανεξάρτητο τοπικό preflight (προς ενσωμάτωση μετά την πρώτη πύλη):** ύπαρξη κύριου αρχείου, WAL/SHM και private dirs, read-only integrity_check/foreign_key_check, required schema, row counts (όχι values/κωδικοί σε logs), πραγματικά τελευταία timestamps ανά domain με σαφή προέλευση. Απαγορεύονται helper onCreate/onUpgrade, seed από cloud, αλλαγή phase ή αυτόματη «επισκευή». Λείπει/ασυνεπές → STOP. Δυνατότητα ελέγχου χωρίς Internet ή Tunnel.

Backup μόνο local-first: consistent snapshot με writers quiesced μέσω του ίδιου executor/work gate, πλήρης απογραφή αντικειμένων και λοιπών ιδιωτικών αρχείων, immutable encrypted backup, byte hashes/counts/coverage, απομονωμένη πραγματική αποκρυπτογράφηση/SQL read-write-rollback/επαλήθευση documents. Στο physical proof περιλαμβάνονται snapshot source generation/revision, backup ID/hash, counts και χρόνος, χωρίς προσωπικά rows/secrets. Πριν cutover επανέλεγχος ότι δεν άλλαξε το snapshot. Η ενέργεια δεν κάνει cloud request και δεν καλεί CloudReturn ή παλιό migration coordinator. Το source ZIP είναι διαφορετικό από αυτό το backup.

**Δίκτυο:** το χωριστό [PoC](ANDROID_TUNNEL_POC_GR.md) έχει δικό του sandbox και συνθετικά bytes. Ακόμη και επιτυχημένο public health δεν αποδεικνύει υπάρχουσα SQLite, επάρκεια backup ή single-writer fence. Αντίστοιχα το τοπικό backup δεν αποδεικνύει Tunnel.

## Πύλες και σειρά συνέχειας

| Πύλη | Απαραίτητη απόδειξη | Τρέχουσα κατάσταση |
|---|---|---|
| A1 source/overlap | Latest main, issue/AGENTS/handoff/code map, source audit | Καταγράφηκαν· πριν τελική συνέχεια χρειάζεται νέα διασταύρωση main |
| A2 connector supply chain | Pinned official source, Android ELF/APK/hash, απομονωμένα tests | Χτίζεται/ελέγχεται χωριστά από production release |
| A3 physical connector | Εγκατάσταση στο Note10+, verified SHA, πραγματικό Named hostname, Wi-Fi↔mobile/Doze/reboot/reconnect | **ΜΗ ΕΠΑΛΗΘΕΥΜΕΝΟ — BLOCKER** |
| A4 physical local source | Υπάρχουσα SQLite, απαιτούμενα domains/αρχεία/χρόνοι, πλήρες verified local backup και isolated restore | **ΜΗ ΕΠΑΛΗΘΕΥΜΕΝΟ — BLOCKER** |
| B origin/security | Restricted loopback + connector-only credential, authn/authz, local username/password, TLS/CORS/CSRF, endpoint/file limits | Μετά A3/A4, όχι ενεργό από PoC |
| C performance | Events/revisions/catch-up/idempotency και πραγματικοί30 logged-in χρήστες/βαριά reports, P50/P95/CPU/RSS/μπαταρία/data | Εκκρεμεί· synthetic health δεν υποκαθιστά business benchmark |
| D single writer | Ρητή owner ενέργεια, τρέχουσα cloud authority/fence/drain proof, local snapshot recheck, crash-safe atomic activation | **ΜΠΛΟΚΑΡΙΣΜΕΝΟ** μέχρι όλες τις προηγούμενες πύλες |
| Release | Full exact-head/main CI, approved signed CI με original keys, full source ZIP/checksums/notes, physical proof πριν merge/deploy | Δεν υπάρχει production candidate/release για #87 |

### B — σχεδιασμός origin, login και transition

Μετά πραγματικά αξιόπιστο connector: app-managed packaged executable, sealed connector configuration, non-exported service, exact hostname/ingress, loopback-only origin με ανεξάρτητο random per-install connector credential που δεν φτάνει στους χρήστες. Web και Client μιλούν κανονικό HTTPS στο συμφωνημένο stable hostname. Δεν εμπιστευόμαστε αυθαίρετα Host/CF-Connecting-IP/X-Forwarded-*· πρέπει να αποδεικνύεται connector προέλευση πριν peer extraction/rate limit. Στη συνέχεια διατηρούνται username/password PBKDF2, session revocation και permissions ανά route. Local root/server credentials δεν γίνονται εξωτερικό authentication.

Προτιμάται same-origin Web/static assets και API ώστε CORS να είναι κλειστό από προεπιλογή. Client WebView file-origin απαιτεί αυστηρά καθορισμένο origin/headers, όχι `Access-Control-Allow-Origin:*` με credentials. Cookie flags Secure/HttpOnly/SameSite και anti-CSRF για mutations επιβεβαιώνονται σε πραγματικό WebView/Chromium. Ο TLS trust model αλλάζει συνειδητά από pinned ciphertext relay σε Cloudflare edge TLS termination, χωρίς παραπλανητικό end-to-end ισχυρισμό.

Δεν αντικαθίσταται σιωπηρά το workers.dev. Σχέδιο συμβατότητας: νέα build-time native-HTTPS ρύθμιση, stable immutable assets και τοπικό status, ελεγχόμενη μετάβαση παλιών clients μόνο αφού αποδειχθεί writer fence. Παλιό endpoint παραμένει ασφαλώς paused/explicit unavailable όπου χρειάζεται, ποτέ stale fallback. Μόνο με κατάλληλη άδεια αλλάζουν DNS/zone ή legacy Worker. API/release metadata διαχωρίζονται από cloud business handlers. Η κανονική ωριαία OTA παραμένει χωρίς cloud business access.

### C — σειρά βελτίωσης χωρίς concurrent writes

Μέτρηση ανά queue wait/runtime/SQLite/payload/round trips πριν αλλαγή executor. Το πραγματικό `NativeBusinessEngine`/Rhino environment έχει mutable global principal/file context και μία connection· **δεν** καλείται ταυτόχρονα από πολλούς HTTP threads. Bounded ingress, serial mutations/transactions, βαριά export δουλειά έξω από critical section μόνο με ασφαλές frozen/read snapshot, σελιδοποίηση/conditional reads. Ξεχωριστή βαθμονόμηση ρυθμού Ordexa (~5min) από network reconnect και UI events.

Διατηρούνται `native_operation_receipts` και current account security hash. Νέος transport αποστέλλει ίδιο operation UUID μετά timeout και διατηρεί unknown status μέχρι επιβεβαίωση από τη SQLite. Scope-only change notifications μετά commit με per-principal authorization και version cursor· reconnect κάνει incremental catch-up, όχι full JSON upload. Πραγματική persistently versioned πηγή, όχι process counter PoC. Περιορισμός queue/bytes/requests ανά χρήστη, no-store για auth/private responses. Offline: Server εκτός σύνδεσης + πραγματικό last confirmed time, draft παραμένει χωρίς «αποθηκεύτηκε».

### D — προστατευμένη ενεργοποίηση

Η πραγματική τρέχουσα phase/backend δεν είναι γνωστή από το repository. Αν cloud writer παραμένει, απαιτείται ρητό pause/fence και ολοκλήρωση in-flight αιτημάτων/λήξη παλιών leases, μαζί με επιβεβαιωμένη απενεργοποίηση όλων των legacy write/control paths. Δεν μπορεί να θεωρηθεί ότι DNS μόνο, αποσύνδεση κινητού ή ένα local flag σταματά old Worker/DO sessions.

Η τελική διαδικασία πρέπει να είναι journalled και επαναλήψιμη: ελεγμένο local snapshot/backup → A3/B/C αποδεικτικά → physical owner επιβεβαίωση → cloud write pause/drain proof → snapshot revision recheck → atomic local authority generation → public origin smoke → ενεργό status `Primary: Android SQLite`, `Transport: Tunnel`. Crash σε οποιοδήποτε σημείο δεν επιτρέπεται να ενεργοποιήσει δύο writers. Αν cloud pause δεν μπορεί να επαληθευτεί, STOP, χωρίς αυτόματο downgrade ή cloud restore.

Μετά ενεργοποίηση, καμία cloud comparison/import/mirror/backup/control/business read/write. Προαιρετική μελλοντική read-only σύγκριση είναι ανεξάρτητη owner-only ενέργεια, αν υλοποιηθεί, με χωριστή άδεια για οποιαδήποτε εισαγωγή. Originals D1/DO/SQLite/files/backups διατηρούνται. Release/εγκατάσταση/activation/cutover είναι διακριτές αποδείξεις.

## Αναγκαίο φυσικό βήμα / handoff

Πριν προχωρήσει ο agent στη Φάση B χρειάζονται: πρόσβαση στον φυσικό Note10+ για χωριστό ελεγμένο PoC και local-only inventory/backup, καθώς και επιβεβαιωμένο ήδη ιδιόκτητο domain/zone ή συμφωνημένη εναλλακτική. **Δεν ζητούνται secrets στη συνομιλία.** Το όριο αυτό προκύπτει ρητά από τις προϋποθέσεις και τη σειρά του #87, όχι από γενική ανάγκη νέας άδειας για συγγραφή κώδικα. Το issue δεν κλείνει και δεν συγχωνεύεται η δοκιμή ως πλήρης υλοποίηση.
