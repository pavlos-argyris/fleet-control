package gr.argyrismitsos.fleettunnelpoc;

import android.app.Activity;
import android.content.*;
import android.os.Bundle;
import android.os.Handler;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.JSONObject;

public final class PocActivity extends Activity {
    private TextView status;
    private EditText hostname,credentials;
    private final Handler timer=new Handler();
    private final Runnable refresh=new Runnable(){public void run(){update();timer.postDelayed(this,1000);}};
    private TextView text(String value,int size){TextView label=new TextView(this);label.setText(value);label.setTextSize(size);label.setPadding(0,12,0,12);return label;}
    private Button button(String title,Runnable action){Button button=new Button(this);button.setText(title);button.setOnClickListener(view->action.run());return button;}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);getWindow().addFlags(0x00002000); // FLAG_SECURE: setup secrets never appear in screenshots/recents.
        ScrollView scroll=new ScrollView(this);LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(28,28,28,28);scroll.addView(layout);setContentView(scroll);
        layout.addView(text("Fleet Tunnel — απομονωμένη δοκιμή",24));
        layout.addView(text("Ξεχωριστή εφαρμογή με συνθετικά δεδομένα. Η δωρεάν προσωρινή δοκιμή δεν χρειάζεται domain, λογαριασμό ή credentials και δεν ανοίγει τη βάση Fleet. Εκθέτει μόνο μια δημόσια δοκιμαστική απάντηση.",16));
        layout.addView(button("Έναρξη δωρεάν προσωρινής δοκιμής",()->startMode("quick")));
        layout.addView(text("Quick Tunnel: η διεύθυνση αλλάζει σε κάθε νέα σύνδεση, χωρίς εγγύηση διαθεσιμότητας ή SSE, έως200 ταυτόχρονα αιτήματα. Είναι μόνο για δοκιμή του κινητού. Η τελική σταθερή λύση και οι επαληθεύσεις Fleet παραμένουν εκκρεμείς. Η δοκιμή καταναλώνει ενέργεια όσο είναι ενεργή.",14));
        final LinearLayout named=new LinearLayout(this);named.setOrientation(LinearLayout.VERTICAL);named.setVisibility(View.GONE);
        layout.addView(button("Προαιρετική ρύθμιση Named Tunnel",()->named.setVisibility(named.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE)));layout.addView(named);
        named.addView(text("Χρειάζεται ήδη ιδιόκτητο domain και αποκλειστικό δοκιμαστικό τοπικά διαχειριζόμενο Named Tunnel.",14));
        hostname=new EditText(this);hostname.setHint("Δοκιμαστικό hostname, π.χ. poc.example.com");hostname.setSingleLine(true);hostname.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);hostname.setText(getSharedPreferences("poc",0).getString("hostname",""));named.addView(hostname);
        credentials=new EditText(this);credentials.setHint("Ιδιωτικό credentials JSON τοπικά διαχειριζόμενου Tunnel");credentials.setMinLines(3);credentials.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_VARIATION_PASSWORD);credentials.setSaveEnabled(false);named.addView(credentials);
        named.addView(text("Το JSON σφραγίζεται με Android Keystore. Δεν χρησιμοποιείται στην προσωρινή δοκιμή. Μην το στείλεις σε συνομιλία ή GitHub.",14));
        named.addView(button("Αποθήκευση ρύθμισης Named Tunnel",()->{
            getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();stopService(new Intent(this,PocService.class));
            try{PocConfig.save(this,hostname.getText().toString(),credentials.getText().toString());credentials.setText("");message("Η ρύθμιση αποθηκεύτηκε τοπικά. Δεν έχει ξεκινήσει σύνδεση.");}catch(Exception error){message("Έλεγξε το hostname και το JSON του αποκλειστικού τοπικά διαχειριζόμενου Tunnel.");}
        }));
        named.addView(button("Έναρξη δοκιμής Named Tunnel",()->startMode("named")));
        layout.addView(button("Διακοπή δοκιμής και αυτόματης εκκίνησης",()->{getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();stopService(new Intent(this,PocService.class));}));
        status=text("",16);status.setTextIsSelectable(true);layout.addView(status);
        layout.addView(button("Αντιγραφή διεύθυνσης δοκιμής",()->{String base=testOrigin();if(base.isEmpty()){message("Η διεύθυνση δεν είναι ακόμη διαθέσιμη.");return;}((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Fleet TEST URL",base+"/poc/v1/health"));message("Αντιγράφηκε η διεύθυνση για έλεγχο από άλλο δίκτυο.");}));
        layout.addView(button("Αντιγραφή ασφαλούς κατάστασης",()->{
            try{SharedPreferences prefs=getSharedPreferences("poc",0);String report=new JSONObject().put("schemaVersion",1).put("source","fleet-tunnel-poc").put("mode",prefs.getString("mode","unknown")).put("serviceActive",PocService.active()).put("publicTestUrl",testOrigin()).put("businessData",false).put("productionReady",false).put("physicalAcceptanceVerified",false).put("status",PocService.active()?prefs.getString("status",""):"Η δοκιμή δεν εκτελείται").put("instanceId",prefs.getString("instanceId","")).put("connectorSha256",prefs.getString("connectorSha256","")).toString(2);
                ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Fleet Tunnel TEST status",report));message("Αντιγράφηκε μόνο η τεχνική κατάσταση, χωρίς credentials.");}catch(Exception error){message("Δεν αντιγράφηκε η κατάσταση.");}
        }));
        layout.addView(text("Έλεγξε την εμφανιζόμενη διεύθυνση από ΑΛΛΟ δίκτυο. Η εμφάνιση URL ή ενεργού process δεν αποδεικνύει δημόσια πρόσβαση, reconnect, backup ή παραγωγική ετοιμότητα. Μετά τη δοκιμή πάτησε Διακοπή.",14));
    }
    private void message(String value){Toast.makeText(this,value,Toast.LENGTH_LONG).show();}
    private void startMode(String mode){
        try{if(mode.equals("named"))PocConfig.read(this);if(!getSharedPreferences("poc",0).edit().putString("mode",mode).remove("publicUrl").putLong("configurationRevision",System.currentTimeMillis()).putBoolean("enabled",true).commit())throw new java.io.IOException("Settings not saved");PocService.start(this);}
        catch(Exception error){getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();message("Δεν ξεκίνησε η δοκιμή. Έλεγξε ρύθμιση και άδεια υπηρεσίας Android.");}
    }
    private String testOrigin(){if(!PocService.active())return "";SharedPreferences prefs=getSharedPreferences("poc",0);boolean quick=prefs.getString("mode",prefs.contains("sealed")?"named":"quick").equals("quick");return quick?prefs.getString("publicUrl",""):"https://"+prefs.getString("hostname","");}
    private void update(){SharedPreferences prefs=getSharedPreferences("poc",0);String base=testOrigin();status.setText((PocService.active()?prefs.getString("status","Εκκίνηση δοκιμής…"):"Η δοκιμή δεν εκτελείται")+"\n\n"+(base.isEmpty()?(PocService.active()?"Αναμονή διεύθυνσης…":""):"Δοκιμαστικό endpoint:\n"+base+"/poc/v1/health"));}
    @Override public void onResume(){super.onResume();timer.post(refresh);}
    @Override public void onPause(){timer.removeCallbacks(refresh);super.onPause();}
}
