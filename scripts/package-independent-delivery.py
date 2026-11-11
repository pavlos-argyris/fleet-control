import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[1];folder=root/'.build/independent-delivery'
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()
files=[]
for file in sorted(folder.iterdir()):
 if file.is_file() and file.suffix in ('.apk','.zip','.md','.json'):
  files.append({'name':file.name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(folder/'delivery-manifest.json').write_text(json.dumps({'schema':1,'issue':90,'sourceCommit':sha,'sourceTree':tree,'profile':'independent-test','productionActivation':False,'physicalAndroidAcceptance':'pending','externalNovaAcceptance':'pending','artifacts':files},indent=2)+'\n')
(folder/'RELEASE_NOTES.md').write_text(f'''Δοκιμαστική ανεξάρτητη εγκατάσταση για δεύτερο κινητό — Issue #90.

- Ξεχωριστά Server/Client APK, έκδοση 1.0.0-test1, application IDs ανεξάρτητα από την παραγωγή.
- Τοπικό πλήρες FCB3 restore, username/password, shared business APIs και οικονομικό audit.
- HTTPS/DuckDNS/ACME, Android-hosted Web και owner-only readiness/activation gates.
- Αρχική υπογραφή APK επαληθευμένη μέσα στο CI· πλήρες source όλων των τμημάτων και SHA-256.
- Το υπάρχον Cloudflare/OTA/παραγωγικές εγκαταστάσεις δεν αλλάζουν.
- Η φυσική εγκατάσταση, το πραγματικό backup, Nova443/4G και live certificate issuance παραμένουν έλεγχοι ιδιοκτήτη.

Source `{sha}`, tree `{tree}`. Οδηγός: OWNER_TEST_GUIDE_GR.md. Δεν αποτελεί παραγωγική μετάβαση.
''')
(folder/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n' for file in sorted(folder.iterdir()) if file.is_file() and file.name!='SHA256SUMS.txt'))
print('Prepared complete isolated source/delivery inputs; production activation is false.')
