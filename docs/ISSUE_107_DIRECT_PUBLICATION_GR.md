# #107 — Direct-only δημοσίευση και εισαγωγές

Η μοναδική ενεργή business πηγή είναι ο Android Server/SQLite στο https://fleet-control.duckdns.org. Το παλιό workers.dev Worker γίνεται μόνο redirect. GET/HEAD οδηγούν στο σταθερό HTTPS root χωρίς παλιά path/query/fragment. POST/PUT/DELETE/OPTIONS επιστρέφουν410 χωρίς Location. Δεν εκτελείται proxy/fetch, δεν διαβιβάζονται cookies/credentials και δεν υπάρχουν ενεργά D1/R2/AI/DO bindings ή assets που παρακάμπτουν τον redirect handler.

Η υπάρχουσα FleetEvents class/migration ταυτότητα διατηρείται. Η αδρανής class δεν διαβάζει/γράφει storage, δεν ανανεώνει alarms και κλείνει παλιά sockets. Δεν προστίθεται deleted_classes/rename/transfer και δεν διαγράφονται D1, buckets, namespaces ή δεδομένα. Τα προηγούμενα business source/config παραμένουν στο Git ως ιστορικό. Τα προηγούμενα Cron Triggers αφαιρούνται ρητά με triggers.crons=[]: η απλή παράλειψη δεν τα αφαιρεί, σύμφωνα με https://developers.cloudflare.com/workers/configuration/cron-triggers/. Η πολιτική namespace διατήρησης ακολουθεί https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/.

## Διανομή και πύλες

Η κανονική release.yml κρατά το ακριβές source CI, αρχικά signing secrets, history/signature verification, πλήρες source ZIP, manifest και SHA256SUMS. Το ενεργό publish path δεν χρησιμοποιεί RELEASE_TOKEN, cloud aggregate upload/activation ή mirror probe. Τα APK/πηγές δημοσιεύονται στο GitHub και ο μικρός redirect αναπτύσσεται στο ίδιο προηγούμενο Worker.

Το PublicReleaseFeed του Direct Server/Client χρησιμοποιεί ήδη τα δημόσια GitHub manifests και ελέγχει επιτρεπόμενα URLs/bytes/signatures. Η Web εφαρμογή περιέχεται στο Server APK: η δημοσίευση μόνη της δεν εγκαθιστά τη νέα Web έκδοση στο Note10+. Ενημέρωση πρώτα Server2.16.0, μετά Client5.67.0, χωρίς απεγκατάσταση. Δεν γίνεται αυτόματη εγκατάσταση/restore ή παραγωγική οικονομική δοκιμή από τον agent.

Το verify-direct-publication.mjs συγκρίνει το public manifest με το τοπικό ακριβές source, ολόκληρα APK και source ZIP με hashes/μεγέθη/checksum inventory, και το redirect/write policy. Δεν στέλνει Fleet/Ordexa credentials και δεν κάνει business probe στην ιδιωτική βάση. Δηλώνει χωριστά androidInstallationVerified:false μέχρι να υπάρχει πραγματική παραλαβή. Candidate mode παραμένει χωρίς GitHub public release, deploy ή παραγωγικό probe και παράγει αρχικά υπογεγραμμένα artifacts για τις φυσικές πύλες.

Τα παλιά manual cloud-resume/mirror workflows παραμένουν ως αδρανείς ενημερωτικές ενέργειες. Για rollback σταματά η νέα εγκατάσταση και ακολουθεί το υπάρχον verified backup/owner recovery runbook. Καμία σιωπηλή επιστροφή σε cloud writes ή αυτόματο database restore. Ο παλιός Worker μπορεί να αποκατασταθεί από προηγούμενο source μόνο με χωριστή ρητή εντολή· δεν ενεργοποιείται από failure του Direct.

## Εισαγωγή καταστημάτων

Η υπάρχουσα resumable ουρά, ιστορικοί όροι, dedup, δύο πλήρεις συγκρινόμενες λήψεις και cancellation proofs διατηρούνται. Το ίδιο reader παρέχει ήδη και cash identities χωρίς δεύτερο ανεξάρτητο reader. Δεν επαναχρησιμοποιούνται σελίδες από διαφορετικά day-1/day+1 παράθυρα: ίδια παραγγελία σε επικαλυπτόμενο εύρος δεν αποδεικνύει ίδια ταξινόμηση, totals/pages ή σταθερότητα μεταξύ των δύο passes. Αυτή είναι τεκμηριωμένη no-op στη μη αποδεδειγμένα ασφαλή μεταβολή, όχι δήλωση μείωσης Ordexa κλήσεων.

Προστίθεται bounded durable πρόοδος ανά εισαγωγή: έως31 completed ημερομηνίες, completed/pending/failed counts, τρέχουσα ημέρα και retry state. Ολοκληρωμένη ημέρα μετρά μόνο μετά από πραγματικό completeDay commit. Αποτυχία διατηρεί την τελευταία πρόοδο/αποτελέσματα και επανεκκίνηση την ανακτά. Οι υπάρχουσες backoff/source guards δεν παρακάμπτονται.

Τα διαθέσιμα actual HTTP duration observations αθροίζονται χωριστά από count-query, υπολογισμό ημερήσιων τιμών, local commit και active step wall times. Άγνωστο network timing παραμένει null. Τα timings είναι επιμέρους στάδια, όχι συνολική CPU ή φυσικό Note10+ benchmark. Οι μετρήσεις/ημέρες εμφανίζονται στα Direct diagnostics χωρίς ιδιωτικά source order IDs/ονόματα. Η ουρά κάνει μικρές παρτίδες και διατηρεί προτεραιότητα interactive APIs· ο υπολογισμός reports επαναχρησιμοποιεί ήδη committed snapshots, χωρίς νέο provider fetch με το άνοιγμα καρτέλας.

Τα παλιά cloud-wait μηνύματα αντικαθίστανται από τοπική αποθήκευση/επαλήθευση. D1 quota κάρτες/ιστορικές D1 ειδοποιήσεις αποκλείονται από το ενεργό Direct UI, διατηρώντας τα ιστορικά rows ανέπαφα.

## Επαλήθευση

Απαιτούνται test-redirect-worker, test-direct-publication, publish-request candidate isolation, actual native store pipeline/recovery, full exact-source CI, πραγματικό Chromium, κανονικό APK Android και Wrangler dry-run. Οι φυσικές πύλες του107 (Note10+, Wi-Fi/κινητό δίκτυο, πραγματικό backup/isolated restore, ιδιωτική οικονομική σύγκριση) παραμένουν ξεχωριστές και δεν θεωρούνται αποδεδειγμένες από CI.
