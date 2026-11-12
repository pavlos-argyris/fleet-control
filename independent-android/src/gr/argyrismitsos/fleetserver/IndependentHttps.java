package gr.argyrismitsos.fleetserver;
import org.json.*;import java.net.*;import java.io.*;import java.util.*;import java.util.concurrent.*;import javax.net.ssl.*;

/** TLS-only bounded HTTP/1.1 origin. No plaintext port, proxy trust or arbitrary file roots. */
public final class IndependentHttps implements AutoCloseable {
    public interface Handler {
        JSONObject api(JSONObject request)throws Exception;
        InputStream asset(String path)throws Exception;
        long revision();long await(long revision)throws Exception;
        default JSONObject routing()throws Exception{return null;}
        default JSONObject update()throws Exception{return null;}
    }
    private final SSLServerSocket listener;private final Handler handler;private final String realm,host;
    private final ThreadPoolExecutor readers=new ThreadPoolExecutor(0,48,30,TimeUnit.SECONDS,new SynchronousQueue<Runnable>());
    private final Set<Socket> sockets=Collections.synchronizedSet(new HashSet<Socket>());private volatile boolean closed;
    public IndependentHttps(SSLContext tls,InetAddress bind,int port,String realm,Handler handler)throws Exception{
        this.realm=IndependentPolicy.origin(realm);host=new URI(realm).getHost();this.handler=handler;
        listener=(SSLServerSocket)tls.getServerSocketFactory().createServerSocket();listener.setReuseAddress(true);List<String> versions=new ArrayList<String>();for(String protocol:listener.getSupportedProtocols())if(protocol.equals("TLSv1.2")||protocol.equals("TLSv1.3"))versions.add(protocol);listener.setEnabledProtocols(versions.toArray(new String[0]));listener.bind(new InetSocketAddress(bind,port),48);
    }
    int port(){return listener.getLocalPort();}
    boolean online(){return !closed&&listener.isBound()&&!listener.isClosed();}
    String bindAddress(){return listener.getInetAddress().getHostAddress();}
    public void start(){Thread thread=new Thread(new Runnable(){public void run(){while(!closed)try{final SSLSocket socket=(SSLSocket)listener.accept();sockets.add(socket);try{readers.execute(new Runnable(){public void run(){serve(socket);}});}catch(RejectedExecutionException full){sockets.remove(socket);socket.close();}}catch(IOException error){if(closed)return;}}},"fleet-independent-https");thread.setDaemon(true);thread.start();}
    static String line(InputStream input,int maximum)throws Exception{ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(;;){int b=input.read();if(b<0)throw new EOFException();if(b==10){byte[] raw=bytes.toByteArray();if(raw.length==0||raw[raw.length-1]!=13)throw new IOException("Invalid HTTP line");return new String(raw,0,raw.length-1,"ISO-8859-1");}if(b==0||bytes.size()>=maximum)throw new IOException("Oversized HTTP line");bytes.write(b);}}
    private void serve(SSLSocket socket){
        try(SSLSocket connection=socket){connection.setSoTimeout(10000);connection.startHandshake();InputStream input=new BufferedInputStream(connection.getInputStream());OutputStream output=new BufferedOutputStream(connection.getOutputStream());
            String[] start=line(input,8192).split(" ",-1);if(start.length!=3||!start[2].equals("HTTP/1.1")||!Arrays.asList("GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS").contains(start[0])||!start[1].startsWith("/")||start[1].startsWith("//"))throw new IOException("Invalid request line");
            Map<String,String> headers=new HashMap<String,String>();int total=0;for(int count=0;;count++){String row=line(input,8192);total+=row.length();if(row.isEmpty())break;if(count>=64||total>32768)throw new IOException("Oversized headers");int colon=row.indexOf(':');if(colon<1)throw new IOException("Invalid header");String name=row.substring(0,colon).toLowerCase(Locale.US);if(!name.matches("[a-z0-9!#$%&'*+.^_`|~-]+")||headers.containsKey(name))throw new IOException("Duplicate/invalid header");String value=row.substring(colon+1).trim();if(value.indexOf('\r')>=0||value.indexOf('\n')>=0)throw new IOException("Invalid header value");headers.put(name,value);}
            if(!host.equalsIgnoreCase(headers.get("host"))&&!(host+":443").equalsIgnoreCase(headers.get("host")))throw new IOException("Wrong Host");
            // Only this public, credential-free discovery document permits cross-origin reads.
            // Business APIs retain the original same-origin/CSRF checks below.
            if(start[0].equals("GET")&&start[1].equals("/fleet-mode.json")){
                JSONObject routing=handler.routing();if(routing==null){respond(output,error(404,"Δεν βρέθηκε."),false);return;}
                byte[] publicDocument=routing.toString().getBytes("UTF-8");head(output,200,publicDocument.length,new JSONObject().put("Content-Type","application/json"),true);output.write(publicDocument);output.flush();return;
            }
            IndependentPolicy.headers(start[0],headers,realm);if(headers.containsKey("transfer-encoding")||headers.containsKey("expect"))throw new IOException("Unsupported body encoding");
            String length=headers.get("content-length");if(length!=null&&!length.matches("[0-9]{1,8}"))throw new IOException("Invalid body length");int size=length==null?0:Integer.parseInt(length);if(size>2*1024*1024)throw new IOException("Oversized body");byte[] body=new byte[size];for(int at=0;at<size;){int n=input.read(body,at,size-at);if(n<0)throw new EOFException();at+=n;}
            URI uri=new URI(realm+start[1]);if(!realm.equals("https://"+uri.getRawAuthority())||uri.getRawFragment()!=null)throw new IOException("Invalid target");String path=uri.getPath();
            if(path.equals("/health")&&start[0].equals("GET")){respond(output,new JSONObject().put("status",200).put("body","{\"server\":\"independent\",\"online\":true}"),false);return;}
            if(path.equals("/api/client-update")&&start[0].equals("GET")){JSONObject update=handler.update();if(update!=null){respond(output,new JSONObject().put("status",200).put("body",update.toString()),false);return;}}
            if(path.startsWith("/api/")){
                if(!IndependentPolicy.api(path)&&!path.equals("/api/sync")||path.equals("/api/sync")&&!start[0].equals("GET")){respond(output,error(403,"Η διαδρομή δεν είναι διαθέσιμη από το δίκτυο."),false);return;}
                Map<String,String> accepted=IndependentPolicy.safeHeaders(headers);accepted.put("CF-Connecting-IP",socket.getInetAddress().getHostAddress());
                JSONObject request=new JSONObject().put("url",realm+start[1]).put("method",start[0]).put("headers",new JSONObject(accepted)).put("independentPeer",socket.getInetAddress().getHostAddress()).put("independentExternal",IndependentPolicy.publicPeer(socket.getInetAddress()));
                if(size>0){String value=new String(body,"UTF-8");if(headers.getOrDefault("content-type","").equals("application/vnd.fleet-form+json")){request.put("form",new JSONObject(value).getJSONObject("form"));request.getJSONObject("headers").put("content-type","multipart/form-data");}else request.put("body",value);}
                if(path.equals("/api/independent/events")&&start[0].equals("GET")){events(output,request);return;}
                respond(output,handler.api(request),start[0].equals("HEAD"));return;
            }
            if(!Arrays.asList("GET","HEAD").contains(start[0])){respond(output,error(405,"Μη επιτρεπτή μέθοδος."),false);return;}
            String decoded=URLDecoder.decode(uri.getRawPath(),"UTF-8");if(decoded.contains("..")||decoded.contains("\\")||decoded.contains("\0")||!decoded.matches("/[A-Za-z0-9_./@+-]*"))throw new IOException("Invalid static path");String asset=decoded.equals("/")||decoded.equals("/index.html")?"portal.html":decoded.substring(1);if(asset.equals("fleet.html"))asset="index.html";
            if(!asset.equals("download/client.apk")&&!asset.matches("[A-Za-z0-9_./@+-]+\\.(html|js|mjs|css|json|webmanifest|svg|png|jpg|jpeg|ico|woff|woff2|ttf|map|bcmap|pfb|wasm)")){respond(output,error(404,"Δεν βρέθηκε."),false);return;}
            try(InputStream staticInput=handler.asset(asset)){if(asset.equals("download/client.apk")){head(output,200,-1,new JSONObject().put("Content-Type",mime(asset)));if(!start[0].equals("HEAD")){byte[] chunk=new byte[65536];int read;while((read=staticInput.read(chunk))!=-1)output.write(chunk,0,read);}output.flush();return;}ByteArrayOutputStream data=new ByteArrayOutputStream();byte[] buffer=new byte[65536];int n;while((n=staticInput.read(buffer))!=-1){if(data.size()+n>16*1024*1024)throw new IOException("Oversized asset");data.write(buffer,0,n);}byte[] bytes=data.toByteArray();head(output,200,bytes.length,new JSONObject().put("Content-Type",mime(asset)));if(!start[0].equals("HEAD"))output.write(bytes);output.flush();}catch(FileNotFoundException missing){respond(output,error(404,"Δεν βρέθηκε."),false);}
        }catch(Exception rejected){/* Bounded fail-closed connection. Never emit request values or credentials. */}finally{sockets.remove(socket);}
    }
    private void events(OutputStream out,JSONObject request)throws Exception{
        JSONObject auth=new JSONObject(request.toString()).put("url",realm+"/api/auth/me");JSONObject response=handler.api(auth);if(response.getInt("status")!=200){respond(out,response,false);return;}
        head(out,200,-1,new JSONObject().put("Content-Type","text/event-stream").put("Cache-Control","private, no-store"));out.write("event: ready\ndata: {}\n\n".getBytes("UTF-8"));out.flush();long revision=handler.revision();long until=System.currentTimeMillis()+300000;
        while(!closed&&System.currentTimeMillis()<until){long next=handler.await(revision);if(handler.api(auth).getInt("status")!=200)return;if(next!=revision){revision=next;out.write(("event: changed\ndata: {\"scopes\":[\"fleet\",\"invoices\",\"workforce\",\"schedule\",\"payroll\",\"stores\",\"cash\",\"status\"]}\n\n").getBytes("UTF-8"));}else out.write(": heartbeat\n\n".getBytes("UTF-8"));out.flush();}
    }
    static JSONObject error(int status,String message)throws Exception{return new JSONObject().put("status",status).put("headers",new JSONObject().put("Content-Type","application/json")).put("body",new JSONObject().put("error",message).toString());}
    private static void head(OutputStream output,int status,long length,JSONObject supplied)throws Exception{head(output,status,length,supplied,false);}
    private static void head(OutputStream output,int status,long length,JSONObject supplied,boolean discovery)throws Exception{
        StringBuilder headers=new StringBuilder("HTTP/1.1 "+status+" Response\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nStrict-Transport-Security: max-age=31536000\r\nCache-Control: private, no-store\r\nContent-Security-Policy: default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'\r\n");
        if(discovery)headers.append("Access-Control-Allow-Origin: *\r\n");
        if(length>=0)headers.append("Content-Length: ").append(length).append("\r\n");
        for(String name:new String[]{"content-type","content-disposition","set-cookie","x-fleet-replayed"}){Iterator<String> names=supplied.keys();while(names.hasNext()){String key=names.next();String value=supplied.optString(key);if(key.equalsIgnoreCase(name)&&value.indexOf('\r')<0&&value.indexOf('\n')<0)headers.append(name).append(": ").append(value).append("\r\n");}}
        if(!supplied.has("content-type")&&!supplied.has("Content-Type"))headers.append("Content-Type: application/json\r\n");headers.append("\r\n");output.write(headers.toString().getBytes("ISO-8859-1"));
    }
    private static void respond(OutputStream output,JSONObject response,boolean headOnly)throws Exception{
        if(response.has("localFile")){File file=new File(response.getString("localFile"));try{head(output,response.getInt("status"),file.length(),response.optJSONObject("headers")==null?new JSONObject():response.getJSONObject("headers"));if(!headOnly)try(InputStream input=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)output.write(bytes,0,n);}output.flush();}finally{file.delete();}return;}
        byte[] body=response.optString("body","").getBytes("UTF-8");head(output,response.getInt("status"),body.length,response.optJSONObject("headers")==null?new JSONObject():response.getJSONObject("headers"));if(!headOnly)output.write(body);output.flush();
    }
    private static String mime(String file){if(file.endsWith(".html"))return"text/html; charset=utf-8";if(file.endsWith(".js")||file.endsWith(".mjs"))return"application/javascript; charset=utf-8";if(file.endsWith(".css"))return"text/css; charset=utf-8";if(file.endsWith(".svg"))return"image/svg+xml";if(file.endsWith(".png"))return"image/png";if(file.endsWith(".json")||file.endsWith(".webmanifest"))return"application/json";if(file.endsWith(".woff2"))return"font/woff2";if(file.endsWith(".wasm"))return"application/wasm";if(file.equals("download/client.apk"))return"application/vnd.android.package-archive";return"application/octet-stream";}
    @Override public void close()throws Exception{closed=true;listener.close();synchronized(sockets){for(Socket socket:sockets)try{socket.close();}catch(IOException ignored){}sockets.clear();}readers.shutdownNow();}
}
