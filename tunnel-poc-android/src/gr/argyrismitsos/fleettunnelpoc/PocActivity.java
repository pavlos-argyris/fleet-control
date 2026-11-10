package gr.argyrismitsos.fleettunnelpoc;

import android.app.Activity;
import android.content.*;
import android.os.Bundle;
import android.os.Handler;
import android.text.InputType;
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
        layout.addView(text("Ξεχωριστή εφαρμογή με συνθετικά δεδομένα. Δεν ανοίγει τη βάση Fleet και δεν ενεργοποιεί μεταφορά. Χρησιμοποίησε αποκλειστικό δοκιμαστικό Named Tunnel και hostname από domain που ήδη διαθέτεις.",16));
        hostname=new EditText(this);hostname.setHint("Δοκιμαστικό hostname, π.χ. poc.example.com");hostname.setSingleLine(true);hostname.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);hostname.setText(getSharedPreferences("poc",0).getString("hostname",""));layout.addView(hostname);
        credentials=new EditText(this);credentials.setHint("Ιδιωτικό credentials JSON τοπικά διαχειριζόμενου Tunnel");credentials.setMinLines(3);credentials.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_VARIATION_PASSWORD);credentials.setSaveEnabled(false);layout.addView(credentials);
        layout.addView(text("Το JSON μένει κρυπτογραφημένο στο Android Keystore αυτής της δοκιμής. Μην το στείλεις σε συνομιλία ή GitHub. Η δοκιμή καταναλώνει ενέργεια όσο είναι ενεργή. Οι εφαρμογές Fleet παραμένουν ανεξάρτητες.",14));
        layout.addView(button("Αποθήκευση δοκιμαστικής ρύθμισης",()->{
            getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();stopService(new Intent(this,PocService.class));
            try{PocConfig.save(this,hostname.getText().toString(),credentials.getText().toString());credentials.setText("");message("Η ρύθμιση αποθηκεύτηκε τοπικά. Δεν έχει ξεκινήσει σύνδεση.");}catch(Exception error){message("Έλεγξε το hostname και το JSON του αποκλειστικού τοπικά διαχειριζόμενου Tunnel.");}
        }));
        layout.addView(button("Έναρξη δοκιμής / αυτόματη επανασύνδεση",()->{
            try{PocConfig.read(this);getSharedPreferences("poc",0).edit().putBoolean("enabled",true).commit();PocService.start(this);}
            catch(Exception error){getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();message("Δεν ξεκίνησε η δοκιμή. Έλεγξε ρύθμιση και άδεια υπηρεσίας Android.");}
        }));
        layout.addView(button("Διακοπή δοκιμής και αυτόματης εκκίνησης",()->{getSharedPreferences("poc",0).edit().putBoolean("enabled",false).commit();stopService(new Intent(this,PocService.class));}));
        status=text("",16);status.setTextIsSelectable(true);layout.addView(status);
        layout.addView(button("Αντιγραφή ασφαλούς κατάστασης",()->{
            try{SharedPreferences prefs=getSharedPreferences("poc",0);String report=new JSONObject().put("schemaVersion",1).put("source","fleet-tunnel-poc").put("businessData",false).put("physicalAcceptanceVerified",false).put("status",prefs.getString("status","")).put("instanceId",prefs.getString("instanceId","")).put("connectorSha256",prefs.getString("connectorSha256","")).toString(2);
                ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Fleet Tunnel TEST status",report));message("Αντιγράφηκε μόνο η τεχνική κατάσταση, χωρίς credentials.");}catch(Exception error){message("Δεν αντιγράφηκε η κατάσταση.");}
        }));
        layout.addView(text("Μετά την εκκίνηση έλεγξε από ΑΛΛΟ δίκτυο το https://<hostname>/poc/v1/health. Η ένδειξη «connector σε λειτουργία» δεν αποδεικνύει δημόσια πρόσβαση, reconnect, backup ή παραγωγική ετοιμότητα.",14));
    }
    private void message(String value){Toast.makeText(this,value,Toast.LENGTH_LONG).show();}
    private void update(){SharedPreferences prefs=getSharedPreferences("poc",0);status.setText(prefs.getString("status","Η δοκιμή δεν έχει ξεκινήσει")+"\n\nEndpoint: https://"+prefs.getString("hostname","<hostname>")+"/poc/v1/health");}
    @Override public void onResume(){super.onResume();timer.post(refresh);}
    @Override public void onPause(){timer.removeCallbacks(refresh);super.onPause();}
}
