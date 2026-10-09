# Αρχική σύνδεση GitHub και OTA

Το παραδοτέο περιλαμβάνει πλήρη πηγαίο κώδικα Client, Server, Web, Portal, Worker, κοινό installer, scripts, εξαρτήσεις και φορητά εργαλεία Android Linux x86_64. Περιλαμβάνει επίσης τοπικό ιστορικό Git. Δεν έχει συνδεθεί ακόμη με τον δικό σου λογαριασμό και δεν έχει γίνει deploy.

## 1. Αποθήκευση του κώδικα στον δικό σου λογαριασμό

Εγκατάστησε Git for Windows και GitHub CLI από τους επίσημους ιστοτόπους. Αποσυμπίεσε το πλήρες πακέτο και άνοιξε PowerShell στον φάκελο `fleet-control`. Εκτέλεσε:

```powershell
powershell -ExecutionPolicy Bypass -File .\Setup_GitHub.ps1 -Repository fleet-control
```

Το script ζητά σύνδεση στο δικό σου GitHub, δημιουργεί ιδιωτικό αποθετήριο αν δεν υπάρχει, ανεβάζει `main` και τα tags πηγαίου κώδικα. Αποτυγχάνει αν βρει δημόσιο αποθετήριο ή διαφορετικό origin· δεν κάνει force push. Η ολοκλήρωση επιβεβαιώνεται με έλεγχο ότι τα αρχεία και το τελευταίο commit εμφανίζονται στο GitHub.

Για εργασία από αυτή τη συνομιλία χρειάζεται επίσης η σύνδεση GitHub στο ChatGPT και επαλήθευση διαθέσιμου δικαιώματος εγγραφής. Η εγκατάσταση μιας σύνδεσης δεν εξασφαλίζει από μόνη της push ή deploy. Αν δεν προσφέρονται αυτά τα δικαιώματα εδώ, το ίδιο έργο λειτουργεί στο Cursor/Codex με τον δικό σου λογαριασμό Git και η δημοσίευση γίνεται από το GitHub Actions.

## 2. Μία φορά: ιδιωτικές ρυθμίσεις έκδοσης

Στο ιδιωτικό αποθετήριο: Settings → Secrets and variables → Actions. Χρησιμοποίησε repository secrets ώστε να μη χρειάζεται συνδρομή για environment secrets σε ιδιωτικό αποθετήριο.

| Secret | Περιεχόμενο / προέλευση |
|---|---|
| `FLEET_KEYSTORE_BASE64` | Base64 του αρχικού `signing/fleet-control-release.p12` από το ιδιωτικό αντίγραφο |
| `FLEET_STORE_PASSWORD` | `STORE_PASSWORD` από το ιδιωτικό `PRIVATE_SETUP_KEYS.txt` |
| `FLEET_KEY_PASSWORD` | `KEY_PASSWORD` από το ίδιο αρχείο |
| `FLEET_KEY_ALIAS` | `ALIAS` από το ίδιο αρχείο |
| `FLEET_SERVER_KEY` | Το αρχικό `serverKey` από `server-secrets.json`. Διατηρείται ακριβώς για σύνδεση και αποκρυπτογράφηση backup |
| `FLEET_RELEASE_TOKEN` | Νέο τυχαίο token τουλάχιστον 32 χαρακτήρων, μόνο για δημοσίευση |
| `CLOUDFLARE_API_TOKEN` | Περιορισμένο token για το υπάρχον Worker: Workers Scripts Edit και ανάγνωση του account |
| `CLOUDFLARE_ACCOUNT_ID` | ID του υπάρχοντος Cloudflare λογαριασμού |

Ο υπάρχων Worker πρέπει να διατηρήσει τα secrets `SERVER_KEY`, `CLIENT_KEY`, `PIN_PEPPER` και όσα ήδη χρησιμοποιεί. Το workflow προσθέτει/ενημερώνει μόνο το `RELEASE_TOKEN`. Δεν δημιουργεί νέα βάση και δεν μετακινεί παραγωγικά δεδομένα.

Για Base64 στον υπολογιστή σου, χωρίς εμφάνιση του κλειδιού στο terminal:

```powershell
$FleetKeyPath = '.\private\signing\fleet-control-release.p12'
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $FleetKeyPath))).Trim() | Set-Clipboard
```

Επικόλλησε το clipboard απευθείας στο αντίστοιχο GitHub secret. Τα κλειδιά δεν μπαίνουν σε commit ούτε χρειάζεται να σταλούν στη συνομιλία.

| Repository variable | Τιμή |
|---|---|
| `FLEET_D1_DATABASE_ID` | ID της υπάρχουσας `fleet-control-db` |
| `FLEET_WORKER_URL` | `https://fleet-control.pavlosargyris.workers.dev` |
| `FLEET_WORKER_NAME` | `fleet-control` |
| `FLEET_RELEASES_BUCKET` | `fleet-control-releases` |
| `FLEET_DOCUMENTS_BUCKET` | `fleet-control-service-documents` |

Επιβεβαίωσε τα ονόματα bucket και το ID από το τρέχον Cloudflare. Μην χρησιμοποιήσεις νέα/κενή βάση. Τα GitHub Actions πρέπει να είναι ενεργά και ο token του workflow να έχει το `contents: write` που ορίζεται στο αρχείο του.

## 3. Πρώτη δημοσίευση και εγκατάσταση

1. Πάρε και κράτησε εξωτερικό backup Server πριν από την πρώτη χειροκίνητη εγκατάσταση. Κράτησε μαζί το `.fcbackup` και το συνοδευτικό `.fcdocs`, όταν υπάρχει.
2. Στο GitHub: Actions → Publish Fleet update → Run workflow, από το `main`. Η αρχική σύνδεση λογαριασμών είναι απαραίτητη πριν από αυτό.
3. Επιβεβαίωσε επιτυχία όλων των βημάτων, συμπεριλαμβανομένου του “Upload and activate verified Server, Client and Web together”. Ένα GitHub release μπορεί να έχει δημιουργηθεί πριν από την ολοκλήρωση του Cloudflare deploy· μόνο η επιτυχία του τελευταίου βήματος επιβεβαιώνει την ενεργοποίηση στο Fleet Control.
4. Εγκατέστησε **ως ενημέρωση**, πάνω στην υπάρχουσα εφαρμογή, το Server 2.1.0 στο S24 Ultra. Αυτή είναι η μία αρχική χειροκίνητη ενημέρωση που προσθέτει OTA. Μην κάνεις απεγκατάσταση για το κανονικό update.
5. Στον Server επίλεξε/επιβεβαίωσε φάκελο backup, ενεργοποίησε την άδεια εγκατάστασης από αυτή την εφαρμογή και τις ειδοποιήσεις. Η καρτέλα «Ενημερώσεις» δείχνει έλεγχο OTA, αυτόματη λειτουργία και το backup της τελευταίας εγκατάστασης.
6. Οι υπάρχοντες Clients μπορούν να λάβουν το 5.37.0 από τον ήδη διαθέσιμο έλεγχο ενημερώσεων. Εναλλακτικά εγκατέστησε το APK από το πακέτο ως ενημέρωση. Το Web ενεργοποιείται από τη διαδικασία δημοσίευσης.

Ο Server ελέγχει ανά 15 λεπτά όσο τρέχει η υπηρεσία. Η λήψη γίνεται ανεξάρτητα από τον κύκλο συγχρονισμού. Η εγκατάσταση ακολουθεί έναν επιτυχή ολοκληρωμένο συγχρονισμό και επιτυχές backup στον εξωτερικό φάκελο. Αν δεν υπάρχει άδεια, φάκελος ή επιτυχές backup, παραμένει εγκατεστημένη η τρέχουσα έκδοση και εμφανίζεται μήνυμα.

Το Android μπορεί να επιτρέψει εγκατάσταση χωρίς επιβεβαίωση για self-update. Αν δεν επιτρέπεται, ανοίγει η επιβεβαίωση όταν η εφαρμογή είναι μπροστά ή εμφανίζεται ειδοποίηση. Συσκευή, έκδοση Android και πολιτικές επηρεάζουν το αποτέλεσμα. Η συμπεριφορά πρέπει να ελεγχθεί στο συγκεκριμένο S24 Ultra. Ο Client συνεχίζει να προσφέρει την ενημέρωση στον χρήστη ώστε να μπορεί να επιλέγει πότε θα εγκατασταθεί.

## 4. Κάθε επόμενη αλλαγή

- Τροποποίηση, έλεγχοι, ενημέρωση εκδόσεων στα manifests, `release-config.json`, cache/query versions Web και σημειώσεων έκδοσης.
- Αύξηση Android `versionCode` για κάθε τμήμα του οποίου αλλάζει το APK. Το workflow παράγει αναπαραγώγιμα APK, οπότε αμετάβλητο APK μπορεί να παραμείνει στην ίδια έκδοση.
- Commit και push του πλήρους έργου. Παραδίδεται το commit URL και επιβεβαιώνεται το απομακρυσμένο SHA. Αν δεν έγινε push, δηλώνεται ως εκκρεμότητα.
- Με ρητή εντολή δημοσίευσης: Run workflow ή push tag `fleet-v<releaseVersion>`. Το ανέβασμα συνηθισμένου commit ενεργοποιεί μόνο ελέγχους, όχι παραγωγικό deploy.
- Το workflow ελέγχει, υπογράφει, αποθηκεύει πλήρες ZIP πηγών/APK/Web στο ιδιωτικό GitHub release, αναπτύσσει συμβατό Worker, ανεβάζει αμετάβλητα αρχεία και ενεργοποιεί Client/Web/Server με μία συναλλαγή στη D1.
- Αν μια προσπάθεια αποτύχει μετά την αποθήκευση του GitHub release, μπορεί να επαναληφθεί με ακριβώς το ίδιο manifest. Διαφορετικά αρχεία στην ίδια έκδοση απορρίπτονται.

Ο Worker δημοσιεύεται ως ξεχωριστό βήμα πριν από την ενεργοποίηση των αρχείων. Απαιτείται να διατηρεί συμβατότητα με τις ήδη ενεργές εφαρμογές. Το τρέχον update προσθέτει endpoints χωρίς αφαίρεση των παλιών.

## 5. Ανάκτηση και ανεξάρτητη ανάπτυξη

```bash
git clone https://github.com/OWNER/fleet-control.git
git log --oneline --all
git checkout source-v5.37.0-server-v2.1.0
```

Αποθήκευσε επίσης ένα τοπικό αντίγραφο κώδικα/ιστορικού και το ξεχωριστό ιδιωτικό αντίγραφο κλειδιών. Το GitHub αποθηκεύει κώδικα και εκδόσεις· δεν αποθηκεύει αυτόματα τη βάση D1, τα τιμολόγια R2 ή πραγματικά δεδομένα συσκευών.

Για να επανέλθει προηγούμενη λειτουργία Android, ο ασφαλής δρόμος είναι νέο APK από τον προηγούμενο κώδικα με **μεγαλύτερο versionCode** και την ίδια υπογραφή. Το OTA απορρίπτει downgrade. Η απεγκατάσταση διαγράφει τοπικά δεδομένα και απαιτεί πλήρες εξωτερικό backup. Η υπάρχουσα επαναφορά κάνει συγχώνευση και δεν εγγυάται ακριβή επαναφορά όλου του Cloudflare σε προηγούμενη χρονική στιγμή. Το Web μπορεί να επανενεργοποιήσει προηγούμενη έκδοση από την υπάρχουσα διαχείριση εκδόσεων.

## Επίσημη τεκμηρίωση

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)
