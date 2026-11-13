package gr.argyrismitsos.fleetserver;
import android.app.*;import android.os.*;import android.content.*;import android.net.Uri;import android.provider.DocumentsContract;import android.database.Cursor;import android.graphics.Color;import android.view.*;import android.widget.*;import org.json.*;import java.util.*;import java.util.concurrent.*;import java.io.*;

/** Owner-only setup console; clients continue to use the existing username/password UI. */
public final class IndependentActivity extends Activity {
    private final ExecutorService work=Executors.newSingleThreadExecutor();private TextView status,message;private LinearLayout content;private EditText username,password,backupCode,hostname,ddnsToken,ordexaUser,ordexaPassword,certificateTransferCode;private CheckBox terms,sync;private String ownerToken="";private int folderAction;
    private final SharedPreferences.OnSharedPreferenceChangeListener stateChanges=(preferences,key)->runOnUiThread(()->{if(!isFinishing())refresh();});
    interface Task{String run()throws Exception;}
    @Override public void onCreate(Bundle state){super.onCreate(state);IndependentConfig.require(this);build();if(Build.VERSION.SDK_INT>=33)requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},90);refresh();try{JSONObject configured=IndependentConfig.read(this);if(configured.has("backupSha256")&&!configured.optString("hostname").isEmpty())IndependentService.start(this);}catch(Exception error){message.setText("Ο Server χρειάζεται έλεγχο πριν την επανεκκίνηση.");}}
    private TextView text(String value,int size){TextView label=new TextView(this);label.setText(value);label.setTextSize(size);label.setTextColor(Color.rgb(30,41,59));label.setPadding(0,12,0,12);content.addView(label);return label;}
    private EditText field(String hint,boolean secret){EditText field=new EditText(this);field.setHint(hint);field.setTextSize(16);field.setSingleLine(true);field.setInputType(secret?129:1);content.addView(field,new LinearLayout.LayoutParams(-1,-2));return field;}
    private void button(String name,View.OnClickListener action){Button button=new Button(this);button.setText(name);button.setOnClickListener(action);content.addView(button,new LinearLayout.LayoutParams(-1,-2));}
    private void task(final Task action){message.setText("Η εργασία εκτελείται…");work.execute(new Runnable(){public void run(){String result;try{IndependentSqlite.requireReady();result=action.run();}catch(Exception error){result=error.getMessage();if(result==null||result.contains("\n")||result.length()>500)result="Η εργασία δεν ολοκληρώθηκε. Τα δεδομένα διατηρούνται· μπορείς να επαναλάβεις.";}final String value=result;runOnUiThread(new Runnable(){public void run(){if(!isFinishing()){message.setText(value);refresh();}}});}});}
    private void build(){ScrollView scroll=new ScrollView(this);content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(28,24,28,48);content.setBackgroundColor(Color.rgb(241,245,249));scroll.addView(content);setContentView(scroll);
        text("Fleet Independent Server",25);status=text("Νέα ανεξάρτητη εγκατάσταση / Δοκιμή",17);message=text("Η υπάρχουσα εγκατάσταση παραμένει ανέπαφη. Εισήγαγε το πλήρες τελευταίο backup στη δεύτερη συσκευή.",15);
        backupCode=field("Κωδικός φορητού backup (μόνο για εισαγωγή/εξαγωγή)",true);
        button("Εισαγωγή backup",v->{folderAction=1;folder();});
        text("Ιδιοκτήτης",20);username=field("Username ιδιοκτήτη από το backup",false);password=field("Password",true);
        button("Έλεγχος σύνδεσης",v->{final String u=username.getText().toString(),p=password.getText().toString();password.setText("");task(()->{login(u,p);JSONObject response=IndependentRuntime.get(this).localProbe(ownerToken);if(response.getInt("status")!=200)throw new Exception(new JSONObject(response.getString("body")).optString("error"));return new JSONObject(response.getString("body")).getString("message");});});
        text("Απομακρυσμένη πρόσβαση",20);text("Μόνο ο ιδιοκτήτης ρυθμίζει μία φορά το δικό του καταχωρισμένο όνομα DuckDNS. Τα στοιχεία αυτά δεν ζητούνται από τους χρήστες.",14);hostname=field("Το δικό σου όνομα .duckdns.org",false);ddnsToken=field("Προστατευμένο token ενημέρωσης DuckDNS",true);terms=new CheckBox(this);terms.setText("Έχω καταχωρίσει το όνομα και αποδέχομαι τους τρέχοντες όρους Let's Encrypt για το δικό μου πιστοποιητικό.");content.addView(terms);
        button("Ρύθμιση HTTPS και έναρξη Server",v->{final String host=hostname.getText().toString(),token=ddnsToken.getText().toString();final boolean accepted=terms.isChecked();ddnsToken.setText("");task(()->{requireOwner();String selected=IndependentPolicy.hostname(host);JSONObject config=IndependentConfig.read(this);if(!config.optString("hostname").isEmpty()&&!config.optString("hostname").equals(selected))throw new Exception("Η αλλαγή ενεργού ονόματος χρειάζεται νέα ελεγχόμενη δοκιμή. Διατήρησε την τρέχουσα διεύθυνση.");if(!accepted)throw new Exception("Χρειάζεται αποδοχή των όρων για το πιστοποιητικό σου.");if(!token.matches("[A-Za-z0-9-]{20,128}"))throw new Exception("Χρειάζεται το δικό σου έγκυρο token DuckDNS.");boolean first=config.optString("hostname").isEmpty();config.put("hostname",selected).put("ddnsToken",token).put("acmeTermsAccepted",true);IndependentConfig.save(this,config);if(first){IndependentRuntime.get(this).close();ownerToken="";}IndependentService.start(this);return "Η προετοιμασία HTTPS ξεκίνησε. Θα εμφανιστεί η πραγματική κατάσταση πιστοποιητικού. Ο έλεγχος από 4G/5G παραμένει εκκρεμής.";});});
        text("Μεταφορά υπάρχοντος HTTPS από άλλη συσκευή",20);
        text("Μόνο ο ιδιοκτήτης μπορεί να εξαγάγει ή να εισαγάγει το ενεργό πιστοποιητικό και το αντίστοιχο ιδιωτικό κλειδί. Το αρχείο κρυπτογραφείται με ξεχωριστό κωδικό 12+ χαρακτήρων, δεν περιέχει δεδομένα/κωδικούς Fleet ή ACME και δεν αποστέλλεται στο διαδίκτυο. Φύλαξέ το εκτός κοινόχρηστου χώρου και διέγραψέ το μετά τη μεταφορά.",14);
        certificateTransferCode=field("Ξεχωριστός κωδικός μεταφοράς HTTPS (12+ χαρακτήρες)",true);
        button("Εξαγωγή υπάρχοντος πιστοποιητικού HTTPS",v->certificatePicker(true));
        button("Εισαγωγή υπάρχοντος πιστοποιητικού HTTPS",v->certificatePicker(false));
        text("Ανάκτηση κλειδιού πιστοποιητικού",20);
        text("Μόνο για επίμονο CERT_STORAGE_… και μετά από σύνδεση ιδιοκτήτη. SQLite, backup, λογαριασμοί και παλιά κλειδιά διατηρούνται. Δημιουργείται μόνο μία νέα απομονωμένη ταυτότητα Let's Encrypt.",14);
        button("Νέος απομονωμένος λογαριασμός πιστοποιητικού",v->new AlertDialog.Builder(this)
            .setTitle("Επιβεβαίωση αλλαγής μόνο ACME")
            .setMessage("Θα δημιουργηθεί νέο κλειδί λογαριασμού Let's Encrypt χωρίς να διαγραφούν τα προηγούμενα δεδομένα ή κλειδιά. Μόνο για CERT_STORAGE_…. Συνέχεια;")
            .setNegativeButton("Άκυρο",null)
            .setPositiveButton("Επιβεβαίωση",(dialog,which)->task(()->{
                requireOwner();
                IndependentAcme.prepareFreshAccount(this);
                IndependentService.start(this);
                return "Ο νέος λογαριασμός ACME αποθηκεύτηκε και επαληθεύτηκε. Η υπηρεσία θα επαναλάβει την έκδοση πιστοποιητικού. Δεν απαιτούνται HTTP ή ports για DNS-01.";
            })).show());
        button("Άνοιγμα Web δοκιμής",v->task(()->{JSONObject config=IndependentConfig.read(this);String host=config.optString("hostname");if(!IndependentTls.valid(this,host))throw new Exception("Δεν υπάρχει ακόμη έγκυρο έμπιστο πιστοποιητικό. Δεν ανοίγει ανασφαλής σύνδεση.");runOnUiThread(()->startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse("https://"+host))));return "Συνδέσου μόνο με username και password. Για τον εξωτερικό έλεγχο άνοιξε την ίδια διεύθυνση σε συσκευή με δεδομένα κινητής.";}));
        text("Ordexa — μόνο ανάγνωση",20);text("Αρχικά ανενεργό. Ενεργοποίησέ το συνειδητά για τη δοκιμή ώστε να αποφευχθεί δεύτερος παράλληλος reader. Ασφαλής αρχική συχνότητα 5 λεπτών· τα καταστήματα ανά ώρα. Το ~15s απαιτεί πραγματική μέτρηση και άδεια πλατφόρμας.",14);ordexaUser=field("Username Ordexa",false);ordexaPassword=field("Password Ordexa",true);sync=new CheckBox(this);sync.setText("Ενεργοποίηση δοκιμαστικού Ordexa read-only");content.addView(sync);
        button("Σύνδεση Ordexa / επιλογή πόλης",v->{final String u=ordexaUser.getText().toString(),p=ordexaPassword.getText().toString();final boolean enable=sync.isChecked();ordexaPassword.setText("");task(()->{requireOwner();JSONObject result=OrdexaSync.login(this,new JSONObject().put("username",u).put("password",p));JSONArray cities=result.getJSONArray("cities");runOnUiThread(()->{String[] labels=new String[cities.length()];for(int i=0;i<labels.length;i++)labels[i]=cities.optJSONObject(i).optString("name",cities.optJSONObject(i).optString("id"));new AlertDialog.Builder(this).setTitle("Πόλη Ordexa").setItems(labels,(dialog,index)->task(()->{requireOwner();OrdexaSync.configure(this,new JSONObject().put("cityId",cities.getJSONObject(index).getString("id")).put("enabled",enable));IndependentConfig.save(this,IndependentConfig.read(this).put("testOrdexa",enable));IndependentService.start(this);return enable?"Ενεργοποιήθηκε ο δοκιμαστικός reader. Οι πραγματικές ώρες και η φρεσκάδα εμφανίζονται στην κατάσταση.":"Η σύνδεση αποθηκεύτηκε με τον δοκιμαστικό συγχρονισμό κλειστό.";})).setNegativeButton("Άκυρο",null).show();});return "Η σύνδεση Ordexa επιβεβαιώθηκε. Επίλεξε πόλη.";});});
        button("Παύση δοκιμαστικού Ordexa",v->task(()->{requireOwner();IndependentConfig.save(this,IndependentConfig.read(this).put("testOrdexa",false));return "Ο δοκιμαστικός συγχρονισμός σταμάτησε. Η ήδη εκτελούμενη μικρή παρτίδα μπορεί να ολοκληρωθεί τοπικά.";}));
        text("Ασφαλές αντίγραφο",20);text("Επίλεξε ξεχωριστό μέσο ή δικό σου εξωτερικό αποθηκευτικό χώρο. Ένα αντίγραφο μόνο σε αυτό το κινητό δεν καλύπτει απώλεια συσκευής.",14);
        button("Εξαγωγή πλήρους κρυπτογραφημένου backup",v->{folderAction=2;folder();});
        button("Ανανέωση κατάστασης",v->refresh());button("Ρυθμίσεις λειτουργίας στο παρασκήνιο",v->startActivity(new Intent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS")));
        text("Ενεργοποίηση Android ως κύριου Server",20);text("Γίνεται μόνο από τον ιδιοκτήτη στη Web οθόνη μετά από πραγματικό HTTPS έλεγχο με 4G/5G και ρητή επιβεβαίωση. Η εφαρμογή δεν αλλάζει το Cloudflare και δεν μεταφέρει αυτόματα τους παλιούς Clients.",14);
    }
    private void login(String u,String p)throws Exception{JSONObject response=IndependentRuntime.get(this).localLogin(u,p);JSONObject body=new JSONObject(response.getString("body"));if(response.getInt("status")!=200)throw new Exception(body.optString("error","Η σύνδεση απέτυχε."));if(!body.getJSONObject("user").getString("role").equals("owner"))throw new Exception("Χρειάζεται λογαριασμός ιδιοκτήτη.");ownerToken=body.getString("token");}
    private void requireOwner()throws Exception{if(ownerToken.isEmpty())throw new Exception("Πρώτα κάνε Έλεγχο σύνδεσης με username/password ιδιοκτήτη.");JSONObject response=IndependentRuntime.get(this).external(new JSONObject().put("url",IndependentRuntime.get(this).realm()+"/api/auth/me").put("method","GET").put("headers",new JSONObject().put("Authorization","Bearer "+ownerToken)));if(response.getInt("status")!=200||!new JSONObject(response.getString("body")).getJSONObject("user").optString("role").equals("owner")){ownerToken="";throw new Exception("Η συνεδρία ιδιοκτήτη έληξε ή ανακλήθηκε. Συνδέσου ξανά.");}}
    private void certificatePicker(boolean export){
        Intent intent=new Intent(export?Intent.ACTION_CREATE_DOCUMENT:Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE).setType(export?"application/octet-stream":"*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if(export)intent.putExtra(Intent.EXTRA_TITLE,"FleetControl_HTTPS_"+
            new java.text.SimpleDateFormat("yyyyMMdd_HHmmss",Locale.US).format(new Date())+".fctls");
        startActivityForResult(intent,export?91:92);
    }
    private static byte[] readSmall(Context c,Uri uri)throws Exception{
        try(InputStream input=c.getContentResolver().openInputStream(uri);ByteArrayOutputStream out=new ByteArrayOutputStream()){
            if(input==null)throw new IOException("Το αρχείο μεταφοράς δεν ανοίγει.");
            byte[] buffer=new byte[8192];int n;
            while((n=input.read(buffer))!=-1){
                if(out.size()+n>65536)throw new IOException("Το αρχείο μεταφοράς υπερβαίνει το επιτρεπόμενο μέγεθος.");
                out.write(buffer,0,n);
            }
            return out.toByteArray();
        }
    }
    private String exportExistingCertificate(Uri uri,String passphrase)throws Exception{
        requireOwner();JSONObject config=IndependentConfig.read(this);
        if(!config.has("backupSha256"))throw new IOException("Χρειάζεται πρώτα πλήρες επαληθευμένο backup.");
        String host=IndependentPolicy.hostname(config.getString("hostname"));
        if(!IndependentTls.valid(this,host))throw new IOException("Δεν υπάρχει έγκυρο πιστοποιητικό HTTPS για εξαγωγή στη συσκευή.");
        JSONObject identity=IndependentTls.read(this);
        IndependentTls.chain(identity,host,true);
        byte[] encrypted=IndependentCertificateTransfer.encrypt(identity,host,passphrase);
        boolean complete=false;
        try{
            try(OutputStream output=getContentResolver().openOutputStream(uri,"w")){
                if(output==null)throw new IOException("Δεν γράφτηκε το κρυπτογραφημένο αρχείο πιστοποιητικού.");
                output.write(encrypted);output.flush();
            }
            if(!Arrays.equals(encrypted,readSmall(this,uri)))
                throw new IOException("Το αρχείο δεν επαληθεύτηκε μετά την εγγραφή.");
            complete=true;
        }finally{
            Arrays.fill(encrypted,(byte)0);
            if(!complete)try{DocumentsContract.deleteDocument(getContentResolver(),uri);}catch(Exception ignored){}
        }
        return "Το πιστοποιητικό HTTPS εξήχθη κρυπτογραφημένο και επαληθεύτηκε. Μετάφερέ το ιδιωτικά στο Note 10+ και κράτησε χωριστά τον κωδικό μεταφοράς. Το S24 Ultra παραμένει ανέπαφο.";
    }
    private String importExistingCertificate(Uri uri,String passphrase)throws Exception{
        requireOwner();JSONObject config=IndependentConfig.read(this);
        if(!config.has("backupSha256"))throw new IOException("Εισήγαγε πρώτα το πλήρες FCB3 backup για να ενεργοποιηθεί ο ιδιοκτήτης.");
        String host=IndependentPolicy.hostname(config.optString("hostname"));
        if(!config.optBoolean("acmeTermsAccepted"))throw new IOException("Ρύθμισε πρώτα το όνομα HTTPS και αποδέξου τους όρους στην οθόνη Server.");
        byte[] encrypted=readSmall(this,uri);JSONObject identity;
        try{identity=IndependentCertificateTransfer.decrypt(encrypted,host,passphrase);}
        catch(Exception error){throw new IOException("Λάθος κωδικός μεταφοράς, άλλο όνομα DuckDNS ή μη έγκυρο αρχείο HTTPS.");}
        finally{Arrays.fill(encrypted,(byte)0);}
        IndependentAcme.installExistingCertificate(this,identity,host);
        if(!getSharedPreferences("independent_ui",MODE_PRIVATE).edit()
            .remove("certificateRetryAt").remove("certificateFailureCode")
            .putString("certificate","Έγκυρο πιστοποιητικό HTTPS μεταφέρθηκε με ασφάλεια από άλλη συσκευή. Δεν έγινε νέα αίτηση Let's Encrypt.").commit())
            throw new IOException("Το πιστοποιητικό αποθηκεύτηκε, αλλά δεν ενημερώθηκε η κατάσταση· επανεκκίνησε την υπηρεσία.");
        IndependentService.start(this);
        return "Εισαγωγή επιτυχής: έγκυρη αλυσίδα, ακριβές DuckDNS και ιδιωτικό κλειδί. Η εκκίνηση HTTPS στην 8443 ακολουθεί τοπικά· έλεγξε τον listener και μετά δοκίμασε εξωτερική σύνδεση.";
    }
    private void folder(){Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(intent,90);}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
        if(request==91||request==92){
            if(result!=RESULT_OK||data==null||data.getData()==null)return;
            final Uri file=data.getData();
            final String code=certificateTransferCode.getText().toString();
            certificateTransferCode.setText("");
            task(()->request==91?exportExistingCertificate(file,code):importExistingCertificate(file,code));
            return;
        }
        if(request!=90||result!=RESULT_OK||data==null)return;final Uri tree=data.getData();getContentResolver().takePersistableUriPermission(tree,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));final String code=backupCode.getText().toString();backupCode.setText("");
        if(folderAction==2){task(()->{requireOwner();IndependentBackup.export(this,tree,code);return "Το πλήρες κρυπτογραφημένο backup εξήχθη και διαβάστηκε ξανά με επιβεβαιωμένα αποτυπώματα. Κράτησε τον κωδικό ανάκτησης ξεχωριστά.";});return;}
        getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putString(BackupManager.KEY_FOLDER_URI,tree.toString()).commit();task(()->{final List<String> names=new ArrayList<String>();final List<Uri> files=new ArrayList<Uri>();Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));try(Cursor cursor=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(cursor!=null)while(cursor.moveToNext()){String name=cursor.getString(1);if(name!=null&&name.matches("(?i)FleetControl_backup_[0-9]{8}_[0-9]{6}\\.fcbackup")){names.add(name);files.add(DocumentsContract.buildDocumentUriUsingTree(tree,cursor.getString(0)));}}}if(files.isEmpty())throw new Exception("Δεν βρέθηκε πλήρες πακέτο FleetControl_backup_….fcbackup στον επιλεγμένο φάκελο. Κράτησε μαζί .fcbackup, .fcdb και .fcdocs.");runOnUiThread(()->new AlertDialog.Builder(this).setTitle("Επίλεξε το δικό σου τελευταίο backup").setItems(names.toArray(new String[0]),(dialog,index)->task(()->IndependentRestore.importBackup(this,files.get(index),code).optBoolean("imported")?"Το backup ανακτήθηκε αποκλειστικά στη δοκιμαστική εγκατάσταση. Συνδέσου ως ιδιοκτήτης για Έλεγχο σύνδεσης.":"Η εισαγωγή δεν επιβεβαιώθηκε.")).setNegativeButton("Άκυρο",null).show());return "Επίλεξε ρητά το backup που θα δοκιμαστεί.";});
    }
    private void refresh(){try{JSONObject config=IndependentConfig.read(this);String blocked=getSharedPreferences("independent_ui",MODE_PRIVATE).getString("blocked","");String value=blocked.isEmpty()?config.has("backupSha256")?(getSharedPreferences("independent_ui",MODE_PRIVATE).getString("mode","test").equals("primary")?"Κύριο":"Δοκιμαστικό")+" · "+IndependentConfig.realm(config)+"\nBackup: "+config.optString("backupCreatedAt")+"\nOrdexa: "+OrdexaSync.status(this).optString("lastSuccess","δεν έχει γίνει συγχρονισμός"):"Νέα ανεξάρτητη εγκατάσταση / Δοκιμή":blocked;String publicIp=getSharedPreferences("independent_ui",MODE_PRIVATE).getString("ipv4","");if(!publicIp.isEmpty())value+="\nΔημόσια IPv4: "+publicIp;String lan=localIp();if(!lan.isEmpty())value+="\nIP Wi-Fi Server: "+lan;for(String key:new String[]{"sqlite","runtime","listener","listenerError","network","certificate","backup","invoice"}){String row=getSharedPreferences("independent_ui",MODE_PRIVATE).getString(key,"");if(!row.isEmpty())value+="\n"+row;}status.setText(value);if(hostname.getText().length()==0)hostname.setText(config.optString("hostname"));}catch(Exception error){status.setText("Η προστατευμένη ρύθμιση χρειάζεται έλεγχο. Καμία cloud σύνδεση δεν έγινε.");}}
    private String localIp(){try{java.util.Enumeration<java.net.NetworkInterface> interfaces=java.net.NetworkInterface.getNetworkInterfaces();while(interfaces.hasMoreElements()){java.net.NetworkInterface network=interfaces.nextElement();if(!network.getName().matches("(?i).*(wlan|wifi).*"))continue;java.util.Enumeration<java.net.InetAddress> addresses=network.getInetAddresses();while(addresses.hasMoreElements()){java.net.InetAddress address=addresses.nextElement();if(address instanceof java.net.Inet4Address&&address.isSiteLocalAddress())return address.getHostAddress();}}}catch(Exception ignored){}return "";}
    @Override protected void onStart(){super.onStart();getSharedPreferences("independent_ui",MODE_PRIVATE).registerOnSharedPreferenceChangeListener(stateChanges);refresh();}
    @Override protected void onStop(){getSharedPreferences("independent_ui",MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(stateChanges);super.onStop();}
    @Override protected void onDestroy(){work.shutdown();ownerToken="";super.onDestroy();}
}
