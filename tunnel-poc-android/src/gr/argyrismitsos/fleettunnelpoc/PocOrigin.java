package gr.argyrismitsos.fleettunnelpoc;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** Diagnostic bytes only. This class cannot dispatch a Fleet API or read files. */
public final class PocOrigin implements Closeable {
    public static final int PORT=18787;
    private final ServerSocket listener;
    private final String instance=UUID.randomUUID().toString();
    private final AtomicLong requests=new AtomicLong();
    private final long started=System.nanoTime();
    private final Set<Socket> sockets=Collections.newSetFromMap(new ConcurrentHashMap<Socket,Boolean>());
    private final ThreadPoolExecutor pool=new ThreadPoolExecutor(8,32,30,TimeUnit.SECONDS,new ArrayBlockingQueue<Runnable>(64));
    private final Thread acceptor;
    private volatile boolean closed;

    public PocOrigin(int port)throws IOException {
        listener=new ServerSocket();listener.setReuseAddress(false);
        listener.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127,0,0,1}),port),64);
        acceptor=new Thread(new Runnable(){public void run(){accept();}},"fleet-poc-origin");acceptor.start();
    }
    public int port(){return listener.getLocalPort();}
    public String instance(){return instance;}
    public long requests(){return requests.get();}
    private void accept(){
        while(!closed)try{
            final Socket socket=listener.accept();socket.setSoTimeout(5000);sockets.add(socket);
            try{pool.execute(new Runnable(){public void run(){serve(socket);}});}catch(RejectedExecutionException busy){sockets.remove(socket);socket.close();}
        }catch(IOException stopped){if(!closed)close();}
    }
    private static String line(InputStream input,int[] remaining)throws IOException {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();int previous=-1;
        for(;;){int b=input.read();if(b<0||--remaining[0]<0||bytes.size()>2048)throw new IOException("Invalid HTTP framing");
            if(previous=='\r'&&b=='\n'){byte[] raw=bytes.toByteArray();return new String(raw,0,raw.length-1,StandardCharsets.US_ASCII);}
            if(b=='\n'||b>127||(b<32&&b!='\r'&&b!='\t')||previous=='\r')throw new IOException("Invalid HTTP header");bytes.write(b);previous=b;
        }
    }
    private void serve(Socket socket){
        try{
            InputStream input=socket.getInputStream();int[] remaining={8192};String request=line(input,remaining);
            String[] parts=request.split(" ",-1);Map<String,String> headers=new HashMap<String,String>();
            for(;;){String header=line(input,remaining);if(header.isEmpty())break;int at=header.indexOf(':');if(at<1)throw new IOException("Invalid header");
                String name=header.substring(0,at).toLowerCase(Locale.US);if(!name.matches("[a-z0-9-]+")||headers.put(name,header.substring(at+1).trim())!=null)throw new IOException("Duplicate header");}
            int status=200;String body;
            if(parts.length!=3||!parts[2].equals("HTTP/1.1")||!headers.containsKey("host")||headers.containsKey("transfer-encoding")||!headers.getOrDefault("content-length","0").equals("0")){status=400;body="{\"error\":\"invalid_request\"}";}
            else if(!parts[0].equals("GET")){status=405;body="{\"error\":\"diagnostic_get_only\"}";}
            else if(!parts[1].equals("/poc/v1/health")){status=404;body="{\"error\":\"diagnostic_route_only\"}";}
            else body="{\"source\":\"fleet-tunnel-poc\",\"businessData\":false,\"instanceId\":\""+instance+"\",\"requests\":"+requests.incrementAndGet()+",\"observedAtMs\":"+System.currentTimeMillis()+",\"uptimeMs\":"+((System.nanoTime()-started)/1000000)+"}";
            byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
            OutputStream out=socket.getOutputStream();out.write(("HTTP/1.1 "+status+" "+(status==200?"OK":"Rejected")+"\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: "+bytes.length+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(bytes);out.flush();
        }catch(IOException ignored){/* Never retain request bytes or exception text. */}
        finally{sockets.remove(socket);try{socket.close();}catch(IOException ignored){}}
    }
    public void close(){closed=true;try{listener.close();}catch(IOException ignored){}for(Socket socket:sockets)try{socket.close();}catch(IOException ignored){}pool.shutdownNow();}
}
