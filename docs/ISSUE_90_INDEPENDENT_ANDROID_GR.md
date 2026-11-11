# #90 — ανεξάρτητη δοκιμαστική εγκατάσταση Android

## Όριο παραγωγής και κατάσταση

Branch `codex/issue-90-independent-android`, βάση `ea38d7d557b2927794d5fa50ad482f171882fb57`. Νέα application IDs `gr.argyrismitsos.fleetserver.independent` και `gr.argyrismitsos.fleetindependentclient`, έκδοση `1.0.0-test1` / code 1. Η δοκιμή δεν αντικαθιστά Server/Client παραγωγής. Δεν δημιουργείται κανονικό publish request και δεν ενεργοποιείται OTA, Worker, Tunnel, DO, D1, R2, DNS ή billing Cloudflare. Τα PR #88/#89 παραμένουν ανεξάρτητα. Δεν υποστηρίζεται implicit fallback στο παλιό cloud.

**Εκκρεμεί φυσική παραλαβή.** Ο agent δεν έχει το συγκεκριμένο backup/κωδικό του ιδιοκτήτη, δεύτερο κινητό, router, καταχωρισμένο DDNS ή πραγματικό πιστοποιητικό για αυτό. Καμία συνθετική IP, test CA, τοπικό PASS ή CI δεν αποτελεί απόδειξη 4G/Nova, φυσικού restore ή επιτυχούς έκδοσης/ανανέωσης ACME σε Android. Το issue παραμένει ανοιχτό μέχρι τη φυσική παραλαβή.

## Inventory εξαρτήσεων και νέα διαδρομή

| Λειτουργία | Υφιστάμενη παραγωγική εξάρτηση | Ανεξάρτητη δοκιμή |
|---|---|---|
| Εκκίνηση Server | FleetApplication / NativePrimaryService / coordinator challenge, lease, relay | IndependentApplication / crash-safe local restore / IndependentRuntime, ξεχωριστό package και process file lock |
| SQLite / business APIs | Worker D1/DO ή leased Android backend | ίδιο NativeBusinessEngine / bundled shared handlers, τοπική SQLite, μία bounded writer lane, transactions/WAL |
| Login / roles / revoke | Worker endpoint και canonical auth tables | ίδιο τοπικό PBKDF2 KDF/χρήστες/roles/auth_sessions, API-level authorization σε κάθε κλήση, άμεσο revoke/logout |
| Web / Android Client | Workers static assets / cloud descriptor / encrypted relay | static assets μέσα στο Server APK, ίδια HTTPS origin, ξεχωριστός Client, καμία ταυτοποίηση με keys/pairing |
| Πρόγραμμα / βάρδιες / μισθοδοσία / μηχανάκια | cloud primary ή coordinator-backed native | ίδιοι shared business κανόνες, historical tariffs/locked payroll και audit στη local DB |
| Καταστήματα / ταμείο | source reader → cloud/native projections | υπάρχον StoreBillingSync / CashSync με injected local authority, ιστορικά 05:00 Europe/Athens, κανόνες/αντιστοιχίσεις διατηρούνται |
| Ordexa | Server read-only reader με Worker transport outputs | ίδιος επιτρεπόμενος read-only OrdexaClient, FleetHttp εξ ολοκλήρου intercepted locally· καμία HTTP fallback |
| Ιδιωτικά αρχεία / uploads / PDF/XLSX | R2 ή native object capabilities μέσω relay | local immutable BusinessObjects, actor/security-bound chunk transfers, ίδιοι PDF/XLSX exporters |
| Invoice OCR / QR | Server-first ή Workers AI | ίδιο τοπικό InvoicePipeline/renderer, μία εργασία ανά lane· Workers AI δεν είναι διαθέσιμο, αμφιβολίες απαιτούν έλεγχο |
| Live Client signals | FleetEvents/Worker WebSocket | TLS SSE μόνο για authenticated sessions, σήμα μετά το πραγματικό commit, bounded connections και επανέλεγχος session |
| Backup / restore | native FCB3 ή cloud preparation / recovery coordination | ρητά επιλεγμένο πλήρες FCB3 και όλα τα companion files, native isolated restore/cold journal· νέο verified encrypted export σε owner-selected ξεχωριστό χώρο |
| Health / σύνδεση | coordinator/Worker status | local authenticated readiness, πραγματικό write/rollback, αρχική ακεραιότητα, πραγματικός TCP peer και HTTPS |
| DNS / TLS | workers.dev / Tunnel | μόνο DuckDNS DNS API, embedded TLS1.2/1.3, ACME DNS-01 / full CA chain / exact SAN / matching key, private Keystore-wrapped config |
| Updates / installs | Worker hourly update check / auto OTA | χειροκίνητη εγκατάσταση των υπογεγραμμένων ανεξάρτητων GitHub prereleases· καμία υποχρεωτική runtime update υπηρεσία |

Τα παλιά Worker handlers παραμένουν **κοινή πηγή κώδικα**, όχι εκτελούμενη Cloudflare υπηρεσία. Στο native bundle DB/object/event ports αντιστοιχούν μόνο στη συσκευή. Το standalone flag δεν ενεργοποιείται στην παραγωγική διαδρομή. Η εξαίρεση `independent_source_realm` χρησιμοποιείται μόνο ως σταθερό input του ήδη υπάρχοντος scoped Ordexa account/city identity, ώστε αλλαγή hostname να μη χάνει οικονομικές αντιστοιχίσεις. Δεν είναι δικτυακός προορισμός.

## Ασφαλής σειρά δοκιμής για ιδιοκτήτη

1. Εγκατάσταση **Fleet Independent Server — Δοκιμή** μόνο στο δεύτερο τηλέφωνο. Το παραγωγικό APK παραμένει όπως είναι.
2. Αντιγραφή των τριών τμημάτων του τελευταίου δικού του backup στον ίδιο φάκελο: `FleetControl_backup_…fcbackup`, `FleetControl_database_…fcdb`, και `FleetControl_documents_…fcdocs` όταν υπάρχουν ιδιωτικά αρχεία. Εισαγωγή φορητού κωδικού, «Εισαγωγή backup», επιλογή φακέλου και συγκεκριμένου backup. Το αρχικό πακέτο δεν μεταβάλλεται. Παλιά/μερικά backup σταματούν με STOP.
3. «Έλεγχος σύνδεσης» με **username/password ιδιοκτήτη από το backup**. Αυτό επιβεβαιώνει local auth/read/write/rollback/integrity και γράφει ρητά ότι το εξωτερικό test εκκρεμεί.
4. Ο ιδιοκτήτης καταχωρίζει το δικό του διαθέσιμο/καταχωρισμένο DuckDNS όνομα και το DNS-update token μόνο στον Server, αποδέχεται τους όρους έκδοσης του δικού του TLS certificate και ξεκινά HTTPS. Κανένα όνομα δεν έχει ήδη αγοραστεί/καταχωριστεί από τον agent. Δεν επιτρέπονται invalid/self-signed certificates ή HTTP workaround.
5. Μόνο όταν το APK δείξει έγκυρο trusted certificate και HTTPS listener, DHCP reservation στο ZTE H288A με το πραγματικό Wi-Fi IP/MAC της δεύτερης συσκευής. Ο ιδιοκτήτης ανοίγει **μόνο TCP 443 εξωτερικά → TCP8443 στη συσκευή**. Χωρίς UPnP, DMZ, HTTP80, router remote admin ή debug port. Οι ακριβείς θέσεις των μενού εξαρτώνται από το firmware· δεν έχουν παρατηρηθεί από agent. Η ισότητα WAN/public IP δεν υποκαθιστά inbound proof.
6. Από διαφορετική συσκευή σε **4G/5G και Wi-Fi κλειστό**, άνοιγμα `https://<το-δικό-σου-όνομα>.duckdns.org` ή εγκατάσταση του ανεξάρτητου Client. Στον Client ο ιδιοκτήτης ορίζει μία φορά endpoint με owner username/password· μετά οι χρήστες βλέπουν μόνο την κανονική φόρμα username/password. Τίποτε δεν αλλάζει στους παλιούς Clients.
7. Δοκιμή login, βαρδιών/προγράμματος/μισθοδοσίας/μηχανών/καταστημάτων/ταμείου/αρχείων/αναφορών και περιορισμών employee. «Έλεγχος σύνδεσης» από την owner Web οθόνη κάνει πραγματικό HTTPS request στο ίδιο endpoint με owner session και write/rollback. Το TCP peer προκύπτει από το socket, ποτέ από X-Forwarded-For/CF headers. LAN/localhost δεν δίνουν external PASS. Σε hairpin NAT που δεν μπορεί να διακριθεί τεχνικά απαιτείται η ρητή επιβεβαίωση πραγματικού δικτύου κινητής από τον ιδιοκτήτη.
8. Ordexa test sync αρχικά OFF. Προαιρετική συνειδητή ενεργοποίηση μόνο από ιδιοκτήτη, με σωστό account/city και έλεγχο ότι δεν τρέχει δεύτερος reader. Default παρουσίες 5min, οικονομικά source jobs 120sec όταν απαιτούνται, καταστήματα hourly, persisted backoff/non-overlap. **Δεν ενεργοποιήθηκαν αυθαίρετα 15sec** χωρίς provider permission/load measurement.
9. Πλήρες encrypted backup σε ξεχωριστό μέσο/provider. Η εφαρμογή ελέγχει ξανά bytes/hash όλων των exported files, γράφει το manifest τελευταίο και κρατά εσωτερικό ελεγμένο αντίγραφο. Ο ιδιοκτήτης επιβεβαιώνει ότι ο επιλεγμένος χώρος δεν είναι μόνο το ίδιο τηλέφωνο.
10. **Καμία τελική ενεργοποίηση από τον agent.** Αφού παραλάβει/εγκρίνει ο ιδιοκτήτης, owner Web «Ενεργοποίηση Android ως κύριου Server»: πρόσφατο session-bound external proof, trusted certificate, ρητή επιβεβαίωση 4G και παύσης παλιών business writes, λέξη ΕΝΕΡΓΟΠΟΙΗΣΗ. Η αλλαγή mode/audit/receipt είναι ενιαία SQLite συναλλαγή. Δεν διαβάζει/συγχωνεύει/αλλάζει Cloudflare. Οι συσκευές χρησιμοποιούν πλέον την ανεξάρτητη έκδοση/URL, ενώ το cloud διατηρείται αρχειακό. Δεν ενεργοποιούνται δύο writers ταυτόχρονα.

## Αξιοπιστία και περιορισμοί πραγματικής συσκευής

- User-started foreground `specialUse` service, sticky recovery, boot receiver με σαφές μήνυμα όταν Android/OEM εμποδίσει background start. Δεν υπόσχεται παρακάμψη force-stop/OS restrictions.
- Bounded partial wakelock μόνο κατά την always-on λειτουργία του server. Επιλογή εξαίρεσης από battery optimisation από τον ιδιοκτήτη. Χρειάζεται φυσικός έλεγχος screen-off/Doze, reboot, Wi-Fi outage, φόρτισης/θερμοκρασίας/κατανάλωσης και μακράς λειτουργίας.
- Trusted full-chain TLS, SAN/key match, periodic DNS update και certificate renewal με backoff. Η υπάρχουσα έγκυρη αλυσίδα διατηρείται αν αποτύχει ανανέωση. Έληξε/άκυρη αλυσίδα → fail closed, ποτέ HTTP. Το πραγματικό Let's Encrypt/DuckDNS issuance/renewal σε Android δεν έχει ακόμη παρατηρηθεί.
- Ασφαλής επιλογή μετά από αποτυχία: διατήρηση test SQLite/αρχικού backup, επανάληψη υποστηριζόμενης ενέργειας. Ανάκτηση/rollback της **παραγωγής** δεν εκτελείται από αυτό το test channel. Μετά από μελλοντικές business αλλαγές στη νέα κύρια βάση, επιστροφή σε παλιό cloud δεν είναι ασφαλής χωρίς νέα ξεχωριστή διαδικασία.

## Έλεγχοι και αναπαραγωγή

- `node scripts/test-business-runtime-native.mjs`: πραγματικός shared Java/Rhino/SQLite, κανόνες/ρόλοι, χρηματοοικονομικό audit/201 automatic orders, uploads/PDF/XLSX, πλήρες FCB3 decrypt + isolated/cold restore, original preservation/corruption. Δεν χρησιμοποιεί backup ιδιοκτήτη.
- `node scripts/test-independent-business.mjs`: πραγματικό standalone shared runtime, 30+ sessions/8 concurrent clients, 0 outbound capabilities, actual readiness write/rollback, owner/session/TLS/staleness gates, atomic activation/receipt failure/replay. Public-peer/certificate evidence είναι fixture inputs.
- `node scripts/test-independent-network.mjs`: πραγματικές TLS συνδέσεις/trusted disposable test CA, SAN/key validation, malformed/plaintext/CSRF/Host/smuggling/traversal και 30 parallel clients, πραγματικό RSA JWS/PKCS#10 verified by OpenSSL. Δεν εκτελεί live DNS/CA issuance ή Nova probe.
- `bash scripts/build-independent-android.sh`: ξεχωριστό staged tree `.build/independent-source`, αρχικά manifests/assets ανέπαφα. Build με disposable key μόνο για local/CI checks· τελική διανομή με αρχική υπογραφή αποκλειστικά στο εγκεκριμένο CI, χωριστά APK IDs, χωρίς production secret embedded. Ο παλιός απαιτούμενος build marker είναι δημόσιο source-tree digest, δεν γίνεται αποδεκτός από δικτυακό API· τα πραγματικά εσωτερικά credentials δημιουργούνται στη συσκευή.
- `python3 scripts/check-independent-apks.py .build/independent-delivery`: πραγματικά compiled manifests/app IDs, TLS-only, native runtime/resources και Android-hosted Web.
- `test-independent-web.mjs` καλύπτει το scoped DOM/transport και `test-independent-browser.mjs` πραγματικό Chromium/IndexedDB σε 320/390/1280 με ρητά συνθετικά δεδομένα/peer. Πριν τελική παράδοση: νέο full exact-source Check saved source και πλήρης source ZIP όλων των τμημάτων/inputs/SHA256. Τοπικό build, GitHub upload, trusted issuance, πραγματική εγκατάσταση και τελική ενεργοποίηση καταγράφονται χωριστά.

Πρωτογενείς προδιαγραφές που ελέγχθηκαν: [DuckDNS DNS/TXT API](https://www.duckdns.org/spec.jsp), [RFC8555](https://www.rfc-editor.org/rfc/rfc8555.html), [Let's Encrypt integration](https://letsencrypt.org/docs/integration-guide/). Η πρακτική υποστήριξη στη φυσική συσκευή παραμένει acceptance gate.
