package gr.argyrismitsos.fleetdirect;
import android.content.*;import android.content.pm.*;import android.net.Uri;import org.json.*;
import java.io.*;import java.util.*;import java.util.zip.*;
import gr.argyrismitsos.fleetupdates.OtaInstaller;

/** Native release controls keep an immutable, private Direct release catalogue. */
public final class UpdateManager{
    private static final long APK_LIMIT=192L*1024*1024;
    private UpdateManager(){}
    private static File root(Context c){File f=new File(c.getFilesDir(),"direct-releases");if(!f.isDirectory()&&!f.mkdirs())throw new IllegalStateException("Δεν δημιουργήθηκε ο χώρος εκδόσεων Direct.");return f;}
    private static JSONObject index(Context c)throws Exception{File file=new File(root(c),"index.json");return file.isFile()?ServiceDocumentArchive.readJson(file):new JSONObject();}
    private static void save(Context c,JSONObject value)throws Exception{ServiceDocumentArchive.atomicJson(new File(root(c),"index.json"),value);}
    private static void copy(InputStream input,File file,long limit)throws Exception{if(input==null)throw new IOException("Το αρχείο δεν είναι διαθέσιμο.");try(InputStream in=input;FileOutputStream out=new FileOutputStream(file)){byte[] b=new byte[65536];long size=0;int n;while((n=in.read(b))!=-1){size+=n;if(size>limit)throw new IOException("Το αρχείο υπερβαίνει το όριο έκδοσης.");out.write(b,0,n);}out.getFD().sync();}}
    private static Set<String> signatures(PackageInfo p){Set<String> s=new HashSet<String>();if(p!=null&&p.signatures!=null)for(Signature v:p.signatures)s.add(v.toCharsString());return s;}
    private static File bundledClient(Context c)throws Exception{
        File apk=new File(root(c),"bundled-client.apk"),part=new File(root(c),"bundled-client.part");
        int code=c.getPackageManager().getPackageInfo(c.getPackageName(),0).versionCode;
        File marker=new File(root(c),"bundled-client-version.json");JSONObject old=marker.isFile()?ServiceDocumentArchive.readJson(marker):new JSONObject();
        if(!apk.isFile()||old.optInt("serverCode")!=code){copy(c.getAssets().open("independent-www/download/client.apk"),part,APK_LIMIT);if(!part.renameTo(apk))throw new IOException("Δεν αποθηκεύτηκε ο ενσωματωμένος Client.");ServiceDocumentArchive.atomicJson(marker,new JSONObject().put("serverCode",code));}return apk;
    }
    private static JSONObject entry(Context c,File apk,String id)throws Exception{
        PackageInfo p=c.getPackageManager().getPackageArchiveInfo(apk.getPath(),PackageManager.GET_SIGNATURES);
        if(p==null||!"gr.argyrismitsos.fleetcontrol".equals(p.packageName))throw new IOException("Χρειάζεται έγκυρο Fleet Control Client APK.");
        return new JSONObject().put("id",id).put("kind","client").put("version",p.versionName).put("versionCode",p.versionCode).put("packageName",p.packageName).put("sha256",OtaInstaller.sha256(apk)).put("sizeBytes",apk.length()).put("created_at",IndependentRuntime.iso()).put("notes","Έκδοση στον Direct Server");
    }
    public static synchronized JSONObject uploadClientApk(Context c,Uri uri)throws Exception{
        String id=UUID.randomUUID().toString();File file=new File(root(c),id+".apk");boolean saved=false;
        try{
            copy(c.getContentResolver().openInputStream(uri),file,APK_LIMIT);
            PackageManager pm=c.getPackageManager();Set<String> trusted=signatures(pm.getPackageArchiveInfo(bundledClient(c).getPath(),PackageManager.GET_SIGNATURES)),candidate=signatures(pm.getPackageArchiveInfo(file.getPath(),PackageManager.GET_SIGNATURES));
            if(trusted.isEmpty()||!trusted.equals(candidate))throw new IOException("Η υπογραφή Client διαφέρει από την αρχική ενσωματωμένη εφαρμογή.");
            JSONObject release=entry(c,file,id),value=index(c);JSONArray releases=value.optJSONArray("releases");if(releases==null)releases=new JSONArray();releases.put(release);value.put("releases",releases).put("client",id);save(c,value);saved=true;return release;
        }finally{if(!saved)file.delete();}
    }
    public static synchronized JSONObject uploadWebPackage(Context c,Uri uri)throws Exception{
        String id=UUID.randomUUID().toString();File folder=new File(root(c),id);if(!folder.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο χώρος Web.");
        Set<String> names=new HashSet<String>();long total=0;boolean saved=false;
        try(ZipInputStream zip=new ZipInputStream(c.getContentResolver().openInputStream(uri))){ZipEntry e;while((e=zip.getNextEntry())!=null){if(e.isDirectory())continue;String name=e.getName();if(!safe(name)||!names.add(name)||names.size()>250)throw new IOException("Μη έγκυρο περιεχόμενο Web πακέτου.");File target=new File(folder,name);if(!target.getParentFile().isDirectory()&&!target.getParentFile().mkdirs())throw new IOException("Δεν δημιουργήθηκε ο φάκελος Web.");long size=0;try(FileOutputStream out=new FileOutputStream(target)){byte[] b=new byte[65536];int n;while((n=zip.read(b))!=-1){size+=n;total+=n;if(size>10L*1024*1024||total>60L*1024*1024)throw new IOException("Το Web πακέτο υπερβαίνει το όριο έκδοσης.");out.write(b,0,n);}out.getFD().sync();}}
            if(!names.contains("index.html")||!names.contains("portal.html"))throw new IOException("Χρειάζονται index.html και portal.html στο Web πακέτο.");
            for(String html:new String[]{"index.html","portal.html"}){File file=new File(folder,html);String text=text(file);if(!text.contains("backend-mode.js")||!text.contains("primary-transport.js")||text.indexOf("backend-mode.js")>text.indexOf("primary-transport.js"))throw new IOException("Το Web πακέτο δεν υποστηρίζει ασφαλή εναλλαγή λειτουργίας.");}
            JSONObject release=new JSONObject().put("id",id).put("kind","web").put("version",IndependentRuntime.iso()).put("created_at",IndependentRuntime.iso()).put("notes","Web πακέτο στον Direct Server"),value=index(c);JSONArray releases=value.optJSONArray("releases");if(releases==null)releases=new JSONArray();releases.put(release);value.put("releases",releases).put("web",id);save(c,value);saved=true;return release;
        }finally{if(!saved)remove(folder);}
    }
    private static void remove(File f){File[] files=f.listFiles();if(files!=null)for(File child:files)remove(child);f.delete();}
    private static boolean safe(String path){return path!=null&&path.matches("[A-Za-z0-9_@+.-]+(?:/[A-Za-z0-9_@+.-]+)*")&&!path.contains("..")&&path.length()<=220;}
    private static String text(File file)throws Exception{try(InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1){if(out.size()+n>10*1024*1024)throw new IOException("Μεγάλο αρχείο Web.");out.write(bytes,0,n);}return out.toString("UTF-8");}}
    public static synchronized JSONObject listReleases(Context c)throws Exception{
        JSONObject index=index(c);JSONArray saved=index.optJSONArray("releases"),rows=new JSONArray();if(saved!=null)for(int i=saved.length()-1;i>=0;i--){JSONObject entry=new JSONObject(saved.getJSONObject(i).toString());entry.put("active",entry.getString("id").equals(index.optString(entry.getString("kind")))?1:0);rows.put(entry);}
        rows.put(entry(c,bundledClient(c),"bundled-client").put("active",index.optString("client").isEmpty()?1:0));
        rows.put(new JSONObject().put("id","bundled-web").put("kind","web").put("version",ServerConfig.SERVER_VERSION).put("active",index.optString("web").isEmpty()?1:0).put("notes","Ενσωματωμένο Web της εγκατεστημένης έκδοσης Server"));
        rows.put(new JSONObject().put("id","bundled-server").put("kind","server").put("version",ServerConfig.SERVER_VERSION).put("active",1).put("notes","Αυτόματες υπογεγραμμένες ενημερώσεις μέσω GitHub, με προηγούμενο πλήρες backup Direct"));return new JSONObject().put("releases",rows);
    }
    public static synchronized JSONObject activateRelease(Context c,String id)throws Exception{
        JSONObject value=index(c);String kind=id.equals("bundled-client")?"client":id.equals("bundled-web")?"web":"";JSONArray rows=value.optJSONArray("releases");if(rows!=null)for(int i=0;i<rows.length();i++){JSONObject entry=rows.getJSONObject(i);if(entry.optString("id").equals(id))kind=entry.getString("kind");}
        if(kind.isEmpty()||!id.startsWith("bundled-")&&!id.matches("[a-f0-9-]{36}"))throw new IOException("Δεν βρέθηκε η έκδοση Direct.");
        if(id.startsWith("bundled-"))value.remove(kind);else value.put(kind,id);save(c,value);return new JSONObject().put("activated",true).put("id",id);
    }
    static synchronized JSONObject localClientInfo(Context c)throws Exception{
        JSONObject value=index(c);String active=value.optString("client");JSONArray rows=value.optJSONArray("releases");
        if(!active.matches("[a-f0-9-]{36}")||rows==null)return null;
        for(int i=0;i<rows.length();i++){JSONObject entry=rows.getJSONObject(i);if(active.equals(entry.optString("id"))&&entry.optString("kind").equals("client"))return new JSONObject(entry.toString()).put("available",true).put("releaseId","direct-"+active).put("downloadUrl",gr.argyrismitsos.fleetserver.BackendMode.DIRECT+"/download/client.apk");}
        throw new IOException("Δεν βρέθηκε η επιλεγμένη έκδοση Client στον Direct Server.");
    }
    static InputStream asset(Context c,String path)throws Exception{
        if(!safe(path))throw new FileNotFoundException();JSONObject index=index(c);String client=index.optString("client"),web=index.optString("web");
        if(path.equals("download/client.apk")&&client.matches("[a-f0-9-]{36}"))return new FileInputStream(new File(root(c),client+".apk"));
        String base=path.substring(path.lastIndexOf('/')+1);
        if(Arrays.asList("fleet-config.js","backend-mode.js","primary-transport.js","live-changes.js","client-ota.js","independent-owner.js","service-worker.js").contains(base))return c.getAssets().open("independent-www/"+base);
        if(web.matches("[a-f0-9-]{36}")){File file=new File(new File(root(c),web),path);if(file.isFile()){
            if(path.endsWith(".html")){String text=text(file).replace("./index.html?embedded=1","./fleet.html?embedded=1");if(!text.contains("independent-owner.js"))text=text.replace("</head>","<script src=\"/independent-owner.js\" defer></script></head>");return new ByteArrayInputStream(text.getBytes("UTF-8"));}return new FileInputStream(file);
        }}return c.getAssets().open("independent-www/"+path);
    }
}
