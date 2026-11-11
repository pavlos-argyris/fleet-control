package gr.argyrismitsos.fleetserver;
import android.app.Application;
public final class IndependentApplication extends Application {
    @Override public void onCreate(){super.onCreate();IndependentConfig.require(this);try{IndependentRestore.startup(this);getSharedPreferences("independent_ui",MODE_PRIVATE).edit().remove("blocked").commit();}catch(Exception error){getSharedPreferences("independent_ui",MODE_PRIVATE).edit().putString("blocked","Η εισαγωγή χρειάζεται ασφαλή συνέχεια πριν ανοίξει η βάση. Τα προηγούμενα αρχεία διατηρούνται.").commit();}}
}
