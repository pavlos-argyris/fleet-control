package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.IOException;
import java.net.URI;

/** Same generation + monotonic live lease are checked on entry and immediately before commit. */
public final class NativePrimaryGuard implements NativeBusinessEngine.Authority {
    private final SQLiteDatabase db;
    private final NativePrimaryLease lease;
    private final String realm,generation;
    private String epoch="";
    private boolean setup,setupRequest;
    public NativePrimaryGuard(SQLiteDatabase db,NativePrimaryLease lease,String realm,String generation){this.db=db;this.lease=lease;this.realm=realm;this.generation=generation;}
    /** Called only by the serialized native executor, never accepted from packet fields. */
    public void begin(String epoch,boolean setup){this.epoch=epoch;this.setup=setup;this.setupRequest=false;}
    private void require(boolean candidate)throws Exception{
        JSONObject state=NativePrimaryState.read(db);String phase=state.optString("phase");
        if(!realm.equals(state.optString("realm"))||!generation.equals(state.optString("generation"))||!(candidate?(phase.equals("preparing")||phase.equals("importing")):phase.equals("active")))throw new IOException("Η κύρια βάση ή η γενιά Server άλλαξε. Η αποθήκευση δεν επιβεβαιώθηκε.");
        if(!candidate)lease.require(epoch,generation);
    }
    @Override public void beforeRequest(JSONObject request,boolean internal)throws Exception{
        URI uri=new URI(request.getString("url"));
        setupRequest=setup&&internal&&request.optString("method").equals("GET")&&uri.getPath().equals("/api/status");
        if(setup&&!setupRequest)throw new IOException("Η υποψήφια βάση επιτρέπει μόνο την προετοιμασία σχήματος.");
        require(setupRequest);
    }
    @Override public void beforeCommit(JSONObject response,boolean internal)throws Exception{require(setupRequest&&internal);}
}
