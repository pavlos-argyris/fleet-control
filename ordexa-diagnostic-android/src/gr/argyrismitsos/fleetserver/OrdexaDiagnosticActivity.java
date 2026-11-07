package gr.argyrismitsos.fleetserver;

import android.app.Activity;
import android.app.DatePickerDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

/** Separate manual test app; no WebView, persisted credentials or Fleet business access. */
public final class OrdexaDiagnosticActivity extends Activity {
    private final OrdexaDiagnosticSession session=new OrdexaDiagnosticSession();
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private Future<?> running;
    private long uiGeneration;
    private boolean busy;
    private EditText username,password;
    private Button login,capture,dayButton;
    private TextView status,reportText;
    private Spinner city;
    private LinearLayout samplePane,resultPane;
    private String day,report;
    private JSONArray availableCities;
    private final int ink=Color.rgb(22,49,45),green=Color.rgb(8,127,105),muted=Color.rgb(87,110,103);

    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        Calendar today=Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"));if(today.get(Calendar.HOUR_OF_DAY)<5)today.add(Calendar.DATE,-1);
        SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd",Locale.US);format.setTimeZone(today.getTimeZone());day=format.format(today.getTime());
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(Color.rgb(241,246,244));
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(20),dp(24),dp(20),dp(28));scroll.addView(body);setContentView(scroll);
        text(body,"FLEET CONTROL · ΔΙΑΓΝΩΣΤΙΚΟ",12,true,green);
        text(body,"Έλεγχος Ordexa",26,true,ink);
        text(body,"Μικρό χειροκίνητο δείγμα παραγγελιών για τη σύνδεση του αυτόματου Ταμείου.",16,false,muted);
        text(body,"Ξεχωριστή δοκιμαστική εφαρμογή 0.1.0. Δεν αντικαθιστά Server ή Client. Τα αποτελέσματα δεν είναι οικονομικά σύνολα.",14,false,muted);
        LinearLayout auth=card(body);
        text(auth,"1. Σύνδεση Ordexa",19,true,ink);
        username=input(auth,"Όνομα χρήστη",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        password=input(auth,"Κωδικός",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        login=button(auth,"Σύνδεση",new View.OnClickListener(){public void onClick(View v){login();}});
        text(auth,"Τα στοιχεία μένουν μόνο στη μνήμη. Καθαρίζονται όταν φύγεις από την εφαρμογή.",13,false,muted);
        samplePane=card(body);samplePane.setVisibility(View.GONE);
        text(samplePane,"2. Μικρό δείγμα",19,true,ink);text(samplePane,"Πόλη",14,true,ink);
        city=new Spinner(this);samplePane.addView(city,new LinearLayout.LayoutParams(-1,dp(52)));
        dayButton=button(samplePane,"Ημέρα: "+day,new View.OnClickListener(){public void onClick(View v){chooseDay();}});
        text(samplePane,"Θα διαβαστούν έως τρία αιτήματα, χωρίς αυτόματες επαναλήψεις. Η σημασία των ωρών/καταστάσεων θα ελεγχθεί από το δείγμα.",14,false,muted);
        capture=button(samplePane,"Λήψη δείγματος",new View.OnClickListener(){public void onClick(View v){capture();}});
        status=text(body,"Συνδέσου για να ξεκινήσει ο έλεγχος.",15,true,ink);status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        resultPane=card(body);resultPane.setVisibility(View.GONE);
        text(resultPane,"3. Αποτέλεσμα",19,true,ink);
        text(resultPane,"Αντέγραψε το ανωνυμοποιημένο διαγνωστικό και επικόλλησέ το στη συνομιλία. Δεν περιλαμβάνει κωδικό, token ή πραγματικές τιμές παραγγελιών.",14,false,muted);
        button(resultPane,"Αντιγραφή αποτελέσματος",new View.OnClickListener(){public void onClick(View v){copy();}});
        reportText=text(resultPane,"",12,false,muted);reportText.setTypeface(Typeface.MONOSPACE);reportText.setTextIsSelectable(true);
        button(body,"Αποσύνδεση και καθαρισμός",new View.OnClickListener(){public void onClick(View v){reset("Τα στοιχεία καθαρίστηκαν. Μπορείς να συνδεθείς ξανά.");}});
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private TextView text(LinearLayout parent,String value,int size,boolean bold,int color){
        TextView view=new TextView(this);view.setText(value);view.setTextColor(color);view.setTextSize(size);
        if(bold)view.setTypeface(Typeface.DEFAULT,Typeface.BOLD);view.setPadding(0,dp(5),0,dp(9));parent.addView(view,new LinearLayout.LayoutParams(-1,-2));return view;
    }
    private LinearLayout card(LinearLayout parent){
        LinearLayout view=new LinearLayout(this);view.setOrientation(LinearLayout.VERTICAL);view.setPadding(dp(16),dp(15),dp(16),dp(15));
        GradientDrawable background=new GradientDrawable();background.setColor(Color.WHITE);background.setCornerRadius(dp(18));background.setStroke(dp(1),Color.rgb(210,225,219));view.setBackground(background);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(16);params.bottomMargin=dp(8);parent.addView(view,params);return view;
    }
    private EditText input(LinearLayout parent,String label,int kind){
        text(parent,label,14,true,ink);EditText input=new EditText(this);input.setSingleLine(true);input.setInputType(kind);input.setSaveEnabled(false);
        input.setFilterTouchesWhenObscured(true);parent.addView(input,new LinearLayout.LayoutParams(-1,dp(52)));return input;
    }
    private Button button(LinearLayout parent,String label,View.OnClickListener click){
        Button button=new Button(this);button.setText(label);button.setAllCaps(false);button.setTextColor(green);button.setMinHeight(dp(48));button.setFilterTouchesWhenObscured(true);button.setOnClickListener(click);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(6);parent.addView(button,params);return button;
    }
    private void busy(boolean value){busy=value;login.setEnabled(!value);capture.setEnabled(!value);dayButton.setEnabled(!value);city.setEnabled(!value);username.setEnabled(!value);password.setEnabled(!value);}
    private void login(){
        if(busy)return;final String user=username.getText().toString(),secret=password.getText().toString();
        if(user.trim().length()==0||secret.length()==0){status.setText("Συμπλήρωσε όνομα χρήστη και κωδικό Ordexa.");return;}
        password.setText("");username.setText("");report=null;resultPane.setVisibility(View.GONE);samplePane.setVisibility(View.GONE);availableCities=null;
        final long expected=++uiGeneration;busy(true);status.setText("Σύνδεση και ανάγνωση διαθέσιμων πόλεων…");
        running=executor.submit(new Runnable(){public void run(){try{
            final JSONArray choices=session.login(user,secret);
            runOnUiThread(new Runnable(){public void run(){if(uiGeneration!=expected)return;busy(false);availableCities=choices;ArrayList<String> names=new ArrayList<String>();
                for(int i=0;i<choices.length();i++){JSONObject row=choices.optJSONObject(i);String name=row.optString("name","");names.add(name.length()>160?name.substring(0,160):name);}
                ArrayAdapter<String> adapter=new ArrayAdapter<String>(OrdexaDiagnosticActivity.this,android.R.layout.simple_spinner_item,names);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);city.setAdapter(adapter);
                samplePane.setVisibility(View.VISIBLE);capture.setEnabled(choices.length()>0);status.setText(choices.length()>0?"Σύνδεση επιβεβαιωμένη. Επίλεξε πόλη και ημέρα.":"Ο λογαριασμός δεν επέστρεψε διαθέσιμες πόλεις.");}});
        }catch(final Exception error){fail(expected,error);}}});
    }
    private void chooseDay(){
        if(busy)return;String[] parts=day.split("-");new DatePickerDialog(this,new DatePickerDialog.OnDateSetListener(){public void onDateSet(DatePicker v,int y,int m,int d){day=String.format(Locale.US,"%04d-%02d-%02d",y,m+1,d);dayButton.setText("Ημέρα: "+day);}},Integer.parseInt(parts[0]),Integer.parseInt(parts[1])-1,Integer.parseInt(parts[2])).show();
    }
    private void capture(){
        if(busy||availableCities==null||city.getSelectedItemPosition()<0)return;
        final String selected=availableCities.optJSONObject(city.getSelectedItemPosition()).optString("id"),from=day;final long expected=uiGeneration;
        report=null;resultPane.setVisibility(View.GONE);busy(true);status.setText("Ανάγνωση μικρού δείγματος…");
        running=executor.submit(new Runnable(){public void run(){try{
            final JSONObject result=session.capture(selected,from,StoreBillingEngine.addDay(from,1),new OrdexaDiagnosticSession.Progress(){public void update(final int request){runOnUiThread(new Runnable(){public void run(){if(uiGeneration==expected)status.setText("Ανάγνωση δείγματος · αίτημα "+request+" από έως 3…");}});}});
            runOnUiThread(new Runnable(){public void run(){if(uiGeneration!=expected)return;busy(false);report=result.toString();reportText.setText(result.toString());resultPane.setVisibility(View.VISIBLE);
                int code=result.optInt("httpStatus",0);if(code==401||code==403)capture.setEnabled(false);
                status.setText("sample-read".equals(result.optString("outcome"))?"Το δείγμα διαβάστηκε. Η σύνδεση παραγγελίας–διανομέα χρειάζεται τώρα τεχνικό έλεγχο.":"Η λήψη σταμάτησε με HTTP "+code+". Μπορείς να αντιγράψεις το τεχνικό αποτέλεσμα.");}});
        }catch(final Exception error){fail(expected,error);}}});
    }
    private void fail(final long expected,final Exception error){runOnUiThread(new Runnable(){public void run(){
        if(uiGeneration!=expected)return;busy(false);password.setText("");username.setText("");
        status.setText(error instanceof OrdexaClient.HttpFailure?"Το Ordexa επέστρεψε HTTP "+((OrdexaClient.HttpFailure)error).statusCode+". Έλεγξε τα στοιχεία ή τα δικαιώματα του λογαριασμού.":"Ο έλεγχος δεν ολοκληρώθηκε. Έλεγξε τη σύνδεση και προσπάθησε ξανά.");
    }});}
    private void copy(){
        if(report==null)return;ClipboardManager clipboard=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
        if(clipboard==null){status.setText("Η αντιγραφή δεν είναι διαθέσιμη στη συσκευή.");return;}
        try{clipboard.setPrimaryClip(ClipData.newPlainText("Fleet Ordexa diagnostic",report));status.setText("Το ανωνυμοποιημένο αποτέλεσμα αντιγράφηκε. Επικόλλησέ το στη συνομιλία.");}catch(Exception error){status.setText("Η αντιγραφή δεν ολοκληρώθηκε.");}
    }
    private void reset(String message){
        uiGeneration++;session.clear();if(running!=null)running.cancel(true);running=null;report=null;availableCities=null;
        if(username!=null){username.setText("");password.setText("");reportText.setText("");city.setAdapter(null);samplePane.setVisibility(View.GONE);resultPane.setVisibility(View.GONE);busy(false);status.setText(message);}
    }
    @Override protected void onStop(){reset("Η συνεδρία καθαρίστηκε επειδή έφυγες από την εφαρμογή. Συνδέσου ξανά.");super.onStop();}
    @Override protected void onDestroy(){session.clear();executor.shutdownNow();super.onDestroy();}
}
