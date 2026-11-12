# Issue #95 — κανονικό Server με πρόσθετο Direct backend

Κατάσταση: υποψήφια υλοποίηση στο `codex/issue-95-unified-server-mode`, από main ea38d7d και απομονωμένο #91/1de75ef. Δεν έχει δημοσιευτεί ούτε ενεργοποιηθεί σε παραγωγή. Οι δοκιμές, η υπογραφή και η πραγματική συσκευή καταγράφονται χωριστά στο handoff.

## Επιλογή και δεδομένα

Αρχικό default Cloudflare: `https://fleet-control.pavlosargyris.workers.dev`. Direct: `https://fleet-control.duckdns.org`. Ο μοχλός στις υπάρχουσες Ρυθμίσεις Server δεν κάνει cloud API, migration, διαγραφή, αντιγραφή ή συμφιλίωση. Username/password ιδιοκτήτη επαληθεύονται στην εισαχθείσα τοπική βάση, με πραγματικό ρόλο owner. Μη έτοιμο Direct αποθηκεύει μόνο ζητούμενη προετοιμασία, με ενεργό το προηγούμενο backend και σαφή αιτία. Offline Direct μετά ενεργοποίηση διατηρεί την επιλογή. Επιστροφή Cloudflare είναι τοπική επιλογή, όχι υπόσχεση διαθεσιμότητας Cloudflare.

Το `BackendMode` φυλάσσει schema/revision/selectedMode/activeMode σε atomic αρχείο με fsync. CAS αποτρέπει διπλές/παλιές εντολές. Shared OS file locks κρατούν τις εργασίες σε εξέλιξη μέχρι ολοκλήρωση· αποκλειστικό lock εφαρμόζει αλλαγή και μεταξύ processes. Κατεστραμμένη επιλογή μπλοκάρει cloud writes. Κάθε κανονικό FleetHttp operation κρατά lease μέχρι κατανάλωση απάντησης. Το Direct API ελέγχει active mode και revision πριν επιχειρησιακή εργασία, χωρίς επανάληψη χρηματικής εντολής σε άλλο backend.

Το ίδιο κανονικό package/signature διατηρεί MainActivity, tabs και Cloudflare SQLite. Τα γνωστά Independent backend/auth/restore/TLS υλικά παράγονται αναπαραγώγιμα σε namespace `gr.argyrismitsos.fleetdirect` και process `:direct`, με ξεχωριστά `app_fleet_direct` αρχεία/SQLite, pref prefixes, Keystore aliases και statics. Το κανονικό SQLite provider δεν αντικαθίσταται. Η Direct πλευρά χρησιμοποιεί pinned επίσημη SQLite με JSON/WAL/FULL και τους ελέγχους πλήρους FCB3. Δεν εισάγει αυτόματα το backup άλλης εφαρμογής. Ιδιωτικό same-UID ContentProvider/Activity/Service δεν εξάγει admin endpoint στο δίκτυο. Στατιστικά Direct προέρχονται από τη δική της βάση.

## Διανομή και πραγματικοί περιορισμοί

Ο HTTPS Direct listener διαθέτει μόνο ένα δημόσιο CORS discovery document `/fleet-mode.json`, χωρίς credentials/δεδομένα· τα business APIs παραμένουν same-origin, authenticated και role-checked. Client/Web ελέγχουν αυτό το σταθερό endpoint ανά 15s όταν είναι ορατά. Η Cloudflare CSP επιτρέπει μόνο αυτόν τον πρόσθετο HTTPS origin. Προϋπόθεση λήψης νέας εντολής είναι να φτάνει το δίκτυο στον Direct Server. Δεν υπάρχει καθολική στιγμιαία αλλαγή όταν Direct και Cloudflare είναι εκτός σύνδεσης.

Κάθε Client και κάθε browser origin κρατά last-known mode/revision. Η αλλαγή ακυρώνει προηγούμενα fetches/polling, απορρίπτει παλιές απαντήσεις και φορτώνει άλλο origin, με χωριστές browser sessions/caches. Native tokens έχουν ξεχωριστά κλειδιά ανά backend. Οι χρήστες συνδέονται ξανά με username/password της συγκεκριμένης βάσης. Τοπική «Ανάκτηση Cloudflare» λειτουργεί χωρίς endpoint, δεν αλλάζει τον ενιαίο Server διακόπτη, και δεν αναιρείται από παλιό discovery. «Λήψη επιλογής Server» επαναφέρει τη διανομή.

Νέος browser που δεν έχει ήδη φορτωμένη/αποθηκευμένη εφαρμογή δεν μπορεί να λάβει JavaScript από μη διαθέσιμο Cloudflare. Ανοίγει το γνωστό Direct URL. Ήδη ανοικτές καρτέλες και Android bundled shell μπορούν να κάνουν ανεξάρτητο discovery. Η native εφαρμογή δείχνει ανάκτηση/επανάληψη ακόμη όταν το Direct document δεν φορτώνει. Cross-origin storage δεν μοιράζεται· δεν προσποιείται αλλαγή όλων των offline καρτελών.

## HTTPS και router

Χρησιμοποιείται ACME **DNS-01**, όχι HTTP-01. Η έκδοση/ανανέωση πιστοποιητικού δεν χρειάζεται inbound80. Κώδικας: `IndependentAcme` επιλέγει dns-01 και περιμένει μη κενό matching TXT. Επίσημη τεκμηρίωση: https://letsencrypt.org/docs/challenge-types/ . Δεν εκτίθεται ανασφαλής HTTP υπηρεσία.

Η αλυσίδα PEM διαβάζεται ανά πιστοποιητικό (διόρθωση #94/ace4a71), με SAN, validity, trust και keypair proof. Το `CERT_CHAIN_CHAIN` δεν αποδίδεται σε κλειστό router port. Υπάρχουν ασφαλείς επιμέρους κωδικοί χωρίς secrets. Ο listener δεσμεύει **8443** και εκθέτει πραγματική bound κατάσταση/διεύθυνση/θύρα, όχι υπόθεση443. DNS update, CA/TXT, TLS και inbound reachability εμφανίζονται χωριστά.

Ο ιδιοκτήτης, μετά έγκυρο TLS/listener, κρατά σταθερή DHCP διεύθυνση κινητού και ορίζει TCP **εξωτερική443 → IPκινητού:8443**. Δεν απαιτείται κανόνας80→8080. Ελέγχει ότι Nova WAN/public IP συμφωνούν και δοκιμάζει από διαφορετικό 4G/5G στο σωστό hostname. Αποτυχία LAN hostname με επιτυχή WAN πιθανόν χρειάζεται NAT loopback/split DNS· δεν παρακάμπτεται TLS με πρόσβαση IP/trust-all.

Πρώτη προετοιμασία από browser: `https://fleet-control.duckdns.org/?fleetSetup=1`, login owner → Έλεγχος σύνδεσης σε δεδομένα κινητής. Επιχειρησιακά Direct writes παραμένουν μπλοκαρισμένα όσο activeMode είναι Cloudflare. Ο Server μοχλός επιτρέπει Direct μόνο με verified full backup, owner auth, έγκυρο TLS, πρόσφατη κατάσταση listener και πρόσφατο πραγματικό public-peer read/write-rollback probe. Δεν έγινε τέτοια φυσική δοκιμή από agent.

## Ενημερώσεις, backups και gates

Κανονική έκδοση υποψηφίου: Client5.63.0/code107, Server2.12.0/code77, Web5.63.0, Worker5.20.0. Αρχικά signing keys μόνο στο εγκεκριμένο CI. Τοπικές υπογραφές είναι disposable και δεν παραδίδονται ως εγκαταστάσιμη ενημέρωση. Τα παλιά immutable Web snapshots διατηρούνται.

Direct Client ενημερώσεις διαβάζουν δημόσιο GitHub release manifest, με allowlisted HTTPS redirects χωρίς Fleet/Ordexa credentials, digest/μέγεθος και υπάρχον έλεγχο Android υπογραφής/package. Νεότερη ρητή οδηγία ιδιοκτήτη: επιτρέπεται APK πάνω από50MB, με προτεραιότητα σε όλες τις λειτουργίες. Ο Server περιλαμβάνει ολόκληρο το υπογεγραμμένο Client byte προς byte και όλα τα SQLite ABI. Τα νέα Android download/installer/audit και publishing όρια γίνονται192MiB. Μεγάλα APK ανεβαίνουν σε R2 με bounded FixedLengthStream και SHA-256 verification. Η πρώτη εγκατάσταση πάνω σε παλιό updater50MiB μπορεί να γίνει χειροκίνητα από το αρχικό signed GitHub APK, με ίδιο package/κλειδί και χωρίς απεγκατάσταση. Δεν παρουσιάζεται ως ήδη συμβατή αυτόματη λήψη από παλιό updater που δεν γνωρίζει το νέο όριο. Ο Direct Server ελέγχει ανά ώρα το ίδιο δημόσιο κανάλι και ζητά πλήρες Direct backup/χειροκίνητη εγκατάσταση νεότερης υπογεγραμμένης έκδοσης. Η cloud automatic OTA δεν χρησιμοποιείται ως εναλλακτική Direct checkpoint. Η πλήρως αυτόματη Direct OTA/προγραμματισμένη ανεξάρτητη εξαγωγή backup παραμένουν gate που χρειάζεται περαιτέρω ενοποίηση πριν δηλωθεί πλήρης ισοδυναμία με Cloudflare.

Merge/publish απαιτούν πλήρες exact-source CI, compiled APKs/αρχικές υπογραφές/μεγέθη, instrumentation και screenshots. Πραγματικά backup ιδιοκτήτη/κινητό/Nova4G/reboot/θερμική δοκιμή είναι διαφορετικά acceptance checkpoints και δεν αντικαθίστανται με fixtures. Δεν γίνεται ενεργοποίηση Direct από agent, Cloudflare disable, έξοδο ή παραγωγικό restore/delete.
