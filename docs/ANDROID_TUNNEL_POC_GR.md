# #87 — Απομονωμένο Android Named Tunnel PoC

Κατάσταση: **Φάση A, δοκιμαστικό εργαλείο. Δεν είναι ενημέρωση Fleet ή ολοκληρωμένη μετάβαση.** Η υπάρχουσα SQLite του φυσικού Note10+ δεν είναι προσβάσιμη από το περιβάλλον ανάπτυξης. Δεν έχει επιβεβαιωθεί backup/restore, εγκατάσταση, σύνδεση Tunnel ή παραγωγική ετοιμότητα.

## Τι κάνει το παραδοτέο

- Χωριστό package `gr.argyrismitsos.fleettunnelpoc`, έκδοση0.1.0, προσωρινή **TEST** υπογραφή. Δεν αντικαθιστά Server/Client, δεν εισάγει κλάσεις Fleet, δεν μπορεί να διαβάσει το sandbox τους και δεν έχει παραγωγικά signing secrets.
- Ενσωματωμένο ARM64 Android PIE executable, από το επίσημο `cloudflare/cloudflared`, tag2026.10.7 / commit `872b241f94871665c1c157adefcf90c11f0ead96`, Go1.27.3, χωρίς αυτόματη ενημέρωση ή λήψη εκτελέσιμου στη συσκευή. Ο build επαληθεύει modules και ELF· το app επαληθεύει SHA256 του packaged executable πριν από κάθε εκκίνηση. Το `connector.json` περιγράφει upstream/patch/go.mod/go.sum και τελικό SHA. Δεν είναι επίσημη υποστηριζόμενη διανομή Android της Cloudflare.
- Το executable τοποθετείται στο `lib/arm64-v8a/libcloudflared.so`, με `extractNativeLibs=true`. Εκκινεί από το read-only package nativeLibraryDir, όχι από writable files/assets. Δεν απαιτεί root, Termux, VPN ή εγκατάσταση άλλου app στους χρήστες Fleet.
- Μόνο `GET /poc/v1/health`: UUID δοκιμαστικής εκκίνησης, μετρητής αιτημάτων, χρόνος και `businessData:false`. Ακροατής **127.0.0.1:18787**, όχι LAN/0.0.0.0. Κανένα API επιχειρησιακών δεδομένων, login, αρχεία, SQL, D1/DO ή σύγκριση cloud. Η δημόσια πρόσβαση στα συνθετικά στοιχεία είναι σκόπιμη.
- Τοπικά διαχειριζόμενο **αποκλειστικό δοκιμαστικό Named Tunnel**, αποκλειστικό hostname, HTTP/2 εξερχόμενα, σταθερό τοπικό ingress και τελικό404. Δεν χρησιμοποιείται token υπάρχοντος production connector. Το app δεν δημιουργεί Tunnel/DNS/λογαριασμό, δεν αλλάζει ρυθμίσεις ή billing.
- Το credentials JSON εισάγεται μόνο στη συσκευή, σφραγίζεται με AES-GCM/AndroidKeyStore. Κατά τη λειτουργία απαιτείται ιδιωτικό0600 αρχείο credentials από το cloudflared· καθαρίζεται στη διακοπή/επανεκκίνηση της δοκιμής. Κανένα secret σε CLI arguments, URLs, Git ή logs. Η οθόνη setup έχει FLAG_SECURE και δεν αποθηκεύει το πεδίο σε activity state. Τα raw logs του connector απορρίπτονται.
- Foreground notification, opt-in αυτόματη εκκίνηση μετά το πρώτο unlock, bounded reconnect/backoff και έλεγχος default network/DNS ανά5s. Μερικό wake lock μόνο όσο ο ιδιοκτήτης έχει ενεργοποιήσει τη δοκιμή· χρειάζεται πραγματική μέτρηση μπαταρίας. Η διακοπή απενεργοποιεί και το boot restart.

## Πραγματικές προϋποθέσεις και όρια

Η Cloudflare δεν διανέμει τυπικό επίσημο Android connector στις [λήψεις](https://developers.cloudflare.com/tunnel/downloads/). Το compilation/ELF δεν αποδεικνύει επιτυχές exec/SELinux, DNS, TLS, Doze ή ανθεκτικότητα Samsung. Το app πρέπει πρώτα να δοκιμαστεί με συνθετικό endpoint. Εάν αποτύχει, **STOP**· δεν μπαίνει Durable Object relay ως υποκατάστατο.

Το Named Tunnel για δημόσια εφαρμογή χρειάζεται [domain στο Cloudflare](https://developers.cloudflare.com/tunnel/get-started/). Το `fleet-control.pavlosargyris.workers.dev` δεν είναι domain που ελέγχει ο ιδιοκτήτης για τέτοιο Tunnel. Αν δεν υπάρχει ήδη κατάλληλο domain/zone, λείπει εξωτερική προϋπόθεση. Δεν αγοράζουμε domain/εξοπλισμό ή συνδρομή. Το κόστος απόκτησης/ανανέωσης domain εξαρτάται από τον υπάρχοντα καταχωρητή και πρέπει να εγκριθεί χωριστά, εφόσον απαιτείται.

Η μεταφορά περνά από την Cloudflare και υπόκειται στους όρους/δικτυακά της όρια. Το TLS του browser τερματίζεται στο edge· το edge→connector κρυπτογραφείται από το Tunnel, connector→127.0.0.1 είναι HTTP μέσα στη συσκευή. Δεν ισχυριζόμαστε end-to-end κρυπτογράφηση μέχρι την εφαρμογή. Το loopback δεν είναι από μόνο του όριο εμπιστοσύνης από άλλα Android apps· production origin θα χρειαστεί ανεξάρτητο origin credential/αυστηρή auth σε κάθε call.

Η μικρή Android-only προσθήκη Go αντικαθιστά τον resolver του connector με αριθμητικούς DNS servers του τρέχοντος default Android network. Το Go χωρίς cgo δεν διαβάζει σωστά το ανύπαρκτο `/etc/resolv.conf` Android. **Αυτό το PoC δεν ισχυρίζεται συμβατότητα με strict Private DNS, VPN DNS, captive portals ή IPv6 link-local DNS με scope.** Δεν παρακάμπτει σιωπηρά τη ρύθμιση με δικό μας hardcoded public DNS. Το upstream cloudflared έχει δικό του υπάρχον SRV-discovery DoT fallback. Αυτές οι διαδρομές/ιδιωτικότητα πρέπει να ελεγχθούν πριν επιλεγεί production connector· ενδεχομένως χρειάζεται Bionic/NDK ή Android DNS bridge αντί της προσθήκης PoC.

Force stop από Android/ιδιοκτήτη δεν επιτρέπεται να παρακαμφθεί. Reboot πριν το πρώτο unlock δεν έχει secrets/υπηρεσία. Samsung battery management και νεότεροι Android foreground-service περιορισμοί δεν λύνονται από το build. Δεν δηλώνουμε αδιάλειπτη λειτουργία.

## Κατασκευή χωρίς παραγωγικά secrets

```bash
bash scripts/unpack-toolchain.sh
git clone --branch 2026.10.7 --single-branch https://github.com/cloudflare/cloudflared.git /tmp/fleet-cloudflared-source
python3 scripts/build-tunnel-poc-connector.py --source /tmp/fleet-cloudflared-source --go /absolute/path/to/go1.27.3/bin/go
node scripts/test-tunnel-poc.mjs
bash scripts/build-tunnel-poc.sh
```

Ο builder κάνει archive του pinned Git object σε νέο προσωρινό directory και προσθέτει μόνο το καταγεγραμμένο DNS patch. Δεν εκτελεί upstream Makefile/install/service scripts. Go modules με `-mod=readonly`, `go mod verify`, checksum database. Το πλήρες upstream source και η άδεια περιλαμβάνονται στο CI artifact, μαζί με TEST APK, connector manifest, public certificate, compiled manifest και SHA256SUMS. Ο ιδιωτικός προσωρινός test key διαγράφεται. Νέος ανεξάρτητος build μπορεί να έχει άλλο test certificate· αυτό αφορά μόνο το χωριστό test app.

Το `.github/workflows/tunnel-poc.yml` κάνει μόνο tests/build/artifact και δεν διαθέτει production secrets, περιβάλλον deployment ή permissions εγγραφής. Το υποχρεωτικό κανονικό `Check saved source` παραμένει ανεξάρτητο. Καμία έκδοση Fleet/Worker/Client/Server δεν αυξάνεται για αυτό το χωριστό εργαλείο.

## Δοκιμή από ιδιοκτήτη — μόνο αφού ελεγχθεί το artifact

1. Επιβεβαίωση ότι υπάρχει ήδη domain/zone και **ρητή επιλογή** αποκλειστικού test hostname. Η δημιουργία Named Tunnel/DNS γίνεται από τον εξουσιοδοτημένο ιδιοκτήτη αφού συμφωνηθεί· δεν έχει γίνει από τον agent. Για locally-managed tunnel ακολουθούνται οι [επίσημες οδηγίες](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/). Χρειάζεται το ιδιωτικό JSON του συγκεκριμένου tunnel με AccountTag/TunnelID/TunnelSecret, όχι account API token ή cert.pem. Δεν αποστέλλεται σε συνομιλία/public issue. Το remote-managed token του dashboard δεν είναι αυτό το JSON.
2. Εγκατάσταση μόνο του `Fleet_Tunnel_TEST_0.1.0.apk` ως ξεχωριστού test app. Δεν απεγκαθίσταται/αντικαθίσταται ο Server. Συμπλήρωση test hostname/JSON **μόνο στη συσκευή**, αποθήκευση και έπειτα έναρξη.
3. Από διαφορετικό Wi-Fi ή4G/5G: `https://<test-hostname>/poc/v1/health`. Απαιτούνται HTTP200, marker `fleet-tunnel-poc`, `businessData:false`, no-store και UUID που συμφωνεί με το app. «Connector σε λειτουργία» σημαίνει μόνο ζωντανό process.
4. Πραγματική μέτρηση30 ταυτόχρονων συνθετικών αιτημάτων από εξωτερικό υπολογιστή:

   ```bash
   node scripts/probe-tunnel-poc.mjs https://poc.example.com .build/poc-wifi.json
   ```

   Γράφει90 αιτήματα/3 κύκλους, P50/P95/bytes/αποτυχίες. Δεν στέλνει cookies ή Fleet credentials, δεν ακολουθεί redirects. Δεν είναι μέτρηση production API/login/payroll ούτε30 logged-in χρηστών.
5. Επανάληψη από διαφορετικό δίκτυο: Wi-Fi→4G/5G→Wi-Fi, αεροπορική λειτουργία/διακοπή Internet και επαναφορά, οθόνη κλειστή/Doze, επανεκκίνηση Note10+ και πρώτο unlock. Καταγραφή χρόνου απώλειας/ανάκτησης, αλλαγής process/UUID, CPU/RSS/μπαταρίας/bytes και συνθηκών Android. Παραμονή hostname ίδια. Πραγματικά αρχεία αποτελεσμάτων δεν υπάρχουν ακόμη.
6. Διακοπή από το test app. Έλεγχος ότι κλείνουν process/loopback/wake lock και ότι δεν ξεκινά μετά reboot. Αφαίρεση αποκλειστικού test routing μόνο κατόπιν εντολής ιδιοκτήτη· δεν αλλάζει production DNS.

Αντιγραφή ασφαλούς κατάστασης από το app επιτρέπεται, **όχι** αντιγραφή credentials ή raw connector logs. Δεν ζητείται screenshot της οθόνης setup.

## Υποχρεωτικό STOP πριν από Φάση B

Απαιτούνται ταυτόχρονα πραγματική επαλήθευση connector στη συσκευή, συμφωνημένο hostname/ιδιοκτησία, έλεγχος υπάρχουσας SQLite/ιδιωτικών αρχείων και verified τοπικό backup με απομονωμένη ανάκτηση. Η δοκιμή δεν ανοίγει/επαληθεύει τη βάση Fleet και δεν υποκαθιστά αυτό το ανεξάρτητο βήμα. Αν λείπει/είναι ασυνεπής η βάση, δεν δημιουργείται άδεια production SQLite και δεν γίνεται cloud restore/comparison. Η υπάρχουσα cloud φραγή/authority πρέπει να αποτυπωθεί και να επιβεβαιωθεί πριν δεύτερος writer.

Σχέδιο επόμενων σταδίων και source audit: [ISSUE_87_ANDROID_TUNNEL_AUDIT_GR.md](ISSUE_87_ANDROID_TUNNEL_AUDIT_GR.md). Το #87 μένει ανοικτό και το PR draft μέχρι όλα τα απαιτούμενα physical/security/performance/release gates. Δεν γίνεται merge/deploy από το παρόν PoC.
