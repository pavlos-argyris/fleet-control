package gr.argyrismitsos.fleetupdates;

import java.io.*;import java.net.*;import org.json.JSONObject;

/** Public signed-APK channel. Never receives Fleet/Ordexa credentials. */
public final class PublicReleaseFeed {
    private static final String ROOT="https://github.com/pavlos-argyris/fleet-control/releases/";
    private PublicReleaseFeed(){}
    public static boolean downloadUrl(String value){try{URL u=new URL(value);return "https".equals(u.getProtocol())&&u.getUserInfo()==null&&u.getRef()==null&&u.getPort()==-1&&u.getHost().equals("github.com")&&u.getPath().matches("/pavlos-argyris/fleet-control/releases/download/fleet-v[0-9.]+/Fleet_Control_(Client|Server)_v[0-9.]+\\.apk")&&u.getQuery()==null;}catch(Exception invalid){return false;}}
    public static HttpURLConnection open(URL initial)throws Exception{
        if(!initial.toString().equals(ROOT+"latest/download/release-manifest.json")&&!downloadUrl(initial.toString()))throw new IOException("Μη έγκυρη διεύθυνση έκδοσης.");
        URL next=initial;for(int i=0;i<6;i++){
            if(!"https".equals(next.getProtocol())||next.getUserInfo()!=null||next.getPort()!=-1||next.getRef()!=null||!next.getHost().equals("github.com")&&!next.getHost().equals("release-assets.githubusercontent.com"))throw new IOException("Μη έγκυρη ανακατεύθυνση έκδοσης.");
            HttpURLConnection c=(HttpURLConnection)next.openConnection();c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setInstanceFollowRedirects(false);c.setUseCaches(false);
            int status=c.getResponseCode();if(status>=300&&status<=399){String location=c.getHeaderField("Location");c.disconnect();if(location==null)throw new IOException("Η λήψη έκδοσης δεν επιβεβαιώθηκε.");next=new URL(next,location);continue;}return c;
        }throw new IOException("Πολλές ανακατευθύνσεις έκδοσης.");
    }
    public static JSONObject latest(String kind)throws Exception{
        if(!kind.equals("client")&&!kind.equals("server"))throw new IllegalArgumentException("Invalid component");
        HttpURLConnection c=open(new URL(ROOT+"latest/download/release-manifest.json"));JSONObject manifest;
        try{if(c.getResponseCode()!=200)throw new IOException("Δεν επιβεβαιώθηκε η διαθέσιμη έκδοση GitHub.");try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1){if(out.size()+n>131072)throw new IOException("Μεγάλο manifest έκδοσης.");out.write(b,0,n);}manifest=new JSONObject(out.toString("UTF-8"));}}finally{c.disconnect();}
        JSONObject value=new JSONObject(manifest.getJSONObject(kind).toString());String release=manifest.getString("releaseId"),version=value.getString("version"),file=value.getString("file");
        if(!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")||!release.matches("v[0-9.]+-[a-f0-9]{12}")||!value.getString("sha256").matches("[a-f0-9]{64}")||value.getLong("sizeBytes")<1||!file.equals("Fleet_Control_"+(kind.equals("client")?"Client":"Server")+"_v"+version+".apk"))throw new IOException("Μη έγκυρο manifest έκδοσης.");
        String tag="fleet-"+release.substring(0,release.lastIndexOf('-'));return value.put("available",true).put("releaseId",release).put("notes",manifest.optString("notes")).put("downloadUrl",ROOT+"download/"+tag+"/"+file);
    }
}
