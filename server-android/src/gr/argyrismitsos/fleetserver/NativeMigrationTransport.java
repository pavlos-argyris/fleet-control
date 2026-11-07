package gr.argyrismitsos.fleetserver;
import org.json.*;import java.io.*;import java.net.*;import java.util.*;

/** Narrow migration control plane; only fixed primary paths and validated document exports. */
public final class NativeMigrationTransport implements NativeMigrationCoordinator.Cloud {
    private final JSONObject identity;
    private final String serverKey;
    public NativeMigrationTransport(JSONObject identity,String serverKey)throws Exception{this.identity=identity;this.serverKey=serverKey;URI uri=new URI(identity.getString("realm"));if(!uri.getScheme().equals("https")||uri.getHost()==null||uri.getUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||uri.getPath().length()>0)throw new IOException("Μη έγκυρη διεύθυνση μεταφοράς Fleet.");}
    private Map<String,String> headers(){Map<String,String> headers=new HashMap<String,String>();headers.put("X-Fleet-Server-Key",serverKey);headers.put("X-Fleet-Primary-Ticket",identity.optString("migrationTicket"));return headers;}
    @Override public JSONObject json(String path,String method,JSONObject body)throws Exception{
        if(!path.matches("/(prepare|abort|seed|inventory|rows|cell|objects|activate|descriptor)(\\?[^\\r\\n#]*)?")||!Arrays.asList("GET","POST").contains(method))throw new IOException("Μη επιτρεπτή διαδρομή μεταφοράς.");
        String address=identity.getString("realm")+"/api/primary"+path;return method.equals("GET")?FleetHttp.getJson(address,headers()):FleetHttp.sendJson(address,method,body,headers());
    }
    @Override public void document(JSONObject metadata,File target)throws Exception{
        long expected=metadata.getLong("size");if(expected<1||expected>BusinessObjects.MAX_FILE)throw new IOException("Μη συμβατό μέγεθος ιδιωτικού αρχείου.");
        HttpURLConnection connection=(HttpURLConnection)new URL(identity.getString("realm")+"/api/primary/document").openConnection();File part=new File(target.getPath()+".part");
        try{connection.setRequestMethod("POST");connection.setConnectTimeout(15000);connection.setReadTimeout(45000);connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);for(Map.Entry<String,String> header:headers().entrySet())connection.setRequestProperty(header.getKey(),header.getValue());connection.setRequestProperty("Content-Type","application/json");connection.setDoOutput(true);byte[] body=new JSONObject().put("key",metadata.getString("key")).put("etag",metadata.getString("etag")).toString().getBytes("UTF-8");connection.setFixedLengthStreamingMode(body.length);try(OutputStream output=connection.getOutputStream()){output.write(body);}
            if(connection.getResponseCode()!=200||!metadata.getString("etag").equals(connection.getHeaderField("X-Fleet-Source-Etag")))throw new IOException("Το ιδιωτικό αρχείο άλλαξε ή δεν είναι διαθέσιμο. Επανάλαβε τη μεταφορά.");
            try(InputStream input=new BufferedInputStream(connection.getInputStream());FileOutputStream output=new FileOutputStream(part)){long count=0;byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){count+=n;if(count>expected)throw new IOException("Διαφορετικό μέγεθος ιδιωτικού αρχείου.");output.write(buffer,0,n);}if(count!=expected)throw new IOException("Η μεταφορά ιδιωτικού αρχείου διακόπηκε.");output.getFD().sync();}if(!part.renameTo(target))throw new IOException("Δεν αποθηκεύτηκε το ιδιωτικό αρχείο μεταφοράς.");
        }finally{connection.disconnect();part.delete();}
    }
    @Override public void signedProbe(JSONObject identity)throws Exception{
        JSONObject challenge=FleetHttp.sendJson(identity.getString("realm")+"/api/primary/challenge","POST",new JSONObject().put("generation",identity.getString("generation")),headers());
        try(DirectWebSocket socket=new DirectWebSocket()){socket.connectPrimary(identity.getString("realm"),serverKey,PrimaryCipher.connectionProof(identity,challenge).toString());JSONObject ready=new JSONObject(socket.read());if(!ready.optString("type").equals("ready")||!ready.optString("generation").equals(identity.getString("generation"))||ready.optLong("leaseMs")<1||ready.optLong("leaseMs")>NativePrimaryLease.MAX_TTL_MS)throw new IOException("Δεν επαληθεύτηκε η υπογεγραμμένη σύνδεση κύριου Server.");}
    }
}
