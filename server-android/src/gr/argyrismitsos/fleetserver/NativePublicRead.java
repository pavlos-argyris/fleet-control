package gr.argyrismitsos.fleetserver;
import org.json.*;
import java.net.*;
import java.io.*;
import java.util.*;
import javax.net.ssl.*;

/** Invoice QR reads only. DNS is checked once; TLS connects to that exact public address. */
public final class NativePublicRead {
    private NativePublicRead(){}
    private static boolean publicAddress(InetAddress address){
        if(address.isAnyLocalAddress()||address.isLoopbackAddress()||address.isLinkLocalAddress()||address.isSiteLocalAddress()||address.isMulticastAddress())return false;
        byte[] bytes=address.getAddress();int a=bytes[0]&255,b=bytes[1]&255;
        if(bytes.length==4)return a!=0&&a<224&&!(a==100&&b>=64&&b<=127)&&!(a==169&&b==254)&&!(a==192&&b==0)&&!(a==198&&(b==18||b==19));
        return bytes.length==16&&(a&254)!=252&&!(a==0&&b==0)&&!(a==1&&b==0);
    }
    private static String line(InputStream input,int max)throws Exception{ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(;;){int c=input.read();if(c<0)throw new EOFException();if(c==10){byte[] raw=bytes.toByteArray();if(raw.length==0||raw[raw.length-1]!=13)throw new IOException("Invalid HTTP line");return new String(raw,0,raw.length-1,"ISO-8859-1");}if(bytes.size()>=max)throw new IOException("Oversized HTTP header");bytes.write(c);}}
    private static void copy(InputStream input,OutputStream output,long count)throws Exception{byte[] buffer=new byte[65536];while(count>0){int n=input.read(buffer,0,(int)Math.min(count,buffer.length));if(n<0)throw new EOFException();output.write(buffer,0,n);count-=n;}}
    public static JSONObject fetch(JSONObject request,BusinessObjects objects)throws Exception{
        URI uri=new URI(request.getString("url"));String host=uri.getHost();
        if(!request.getString("method").equals("GET")||!uri.getScheme().equals("https")||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null||uri.getPort()!=-1&&uri.getPort()!=443||host==null||host.equalsIgnoreCase("ordexa.gr")||host.toLowerCase(Locale.US).endsWith(".ordexa.gr")||host.toLowerCase(Locale.US).endsWith(".local")||host.toLowerCase(Locale.US).endsWith(".internal"))throw new IOException("Η διεύθυνση δεν επιτρέπεται για ανάγνωση τιμολογίου.");
        InetAddress[] addresses=InetAddress.getAllByName(host);if(addresses.length==0)throw new IOException("Δεν βρέθηκε η διεύθυνση τιμολογίου.");for(InetAddress address:addresses)if(!publicAddress(address))throw new IOException("Δεν επιτρέπεται ιδιωτική διεύθυνση τιμολογίου.");
        Socket tcp=new Socket();File body=objects.exportTarget("bin");
        try{
            tcp.connect(new InetSocketAddress(addresses[0],443),5000);
            try(SSLSocket tls=(SSLSocket)((SSLSocketFactory)SSLSocketFactory.getDefault()).createSocket(tcp,host,443,true)){
                SSLParameters parameters=tls.getSSLParameters();boolean verified=false;
                try{SSLParameters.class.getMethod("setEndpointIdentificationAlgorithm",String.class).invoke(parameters,"HTTPS");tls.setSSLParameters(parameters);verified=true;}catch(NoSuchMethodException ignored){}
                tls.setSoTimeout(5000);tls.startHandshake();if(!verified&&!HttpsURLConnection.getDefaultHostnameVerifier().verify(host,tls.getSession()))throw new SSLHandshakeException("Hostname verification failed");
                String target=uri.getRawPath();if(target==null||target.isEmpty())target="/";if(uri.getRawQuery()!=null)target+="?"+uri.getRawQuery();target=new URI(target).toASCIIString();
                OutputStream wire=new BufferedOutputStream(tls.getOutputStream());wire.write(("GET "+target+" HTTP/1.1\r\nHost: "+host+"\r\nAccept: text/html,application/pdf,application/json,image/*\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: Fleet-Control-Server\r\n\r\n").getBytes("US-ASCII"));wire.flush();
                InputStream input=new BufferedInputStream(tls.getInputStream());String status=line(input,1024);if(!status.matches("HTTP/1\\.[01] [2-5][0-9][0-9]( .*)?"))throw new IOException("Invalid invoice response");int code=Integer.parseInt(status.substring(9,12));JSONObject headers=new JSONObject();int size=0;
                for(;;){String header=line(input,8192);size+=header.length();if(size>16384)throw new IOException("Oversized invoice headers");if(header.isEmpty())break;int colon=header.indexOf(':');if(colon<1)throw new IOException("Invalid invoice header");String name=header.substring(0,colon).toLowerCase(Locale.US),value=header.substring(colon+1).trim();if(Arrays.asList("content-type","content-length","location","transfer-encoding","content-encoding").contains(name)){if(headers.has(name))throw new IOException("Duplicate invoice framing");headers.put(name,value);}}
                if(!headers.optString("content-encoding","identity").equalsIgnoreCase("identity"))throw new IOException("Unsupported invoice encoding");
                try(FileOutputStream output=new FileOutputStream(body)){
                    String encoding=headers.optString("transfer-encoding");long total=0;
                    if(!encoding.isEmpty()){
                        if(!encoding.equalsIgnoreCase("chunked")||headers.has("content-length"))throw new IOException("Invalid invoice framing");
                        for(;;){String part=line(input,128).split(";",2)[0];if(!part.matches("[A-Fa-f0-9]{1,8}"))throw new IOException("Invalid invoice chunk");long length=Long.parseLong(part,16);if(length==0){int trailer=0;for(;;){String item=line(input,8192);trailer+=item.length();if(trailer>16384)throw new IOException("Oversized invoice trailer");if(item.isEmpty())break;}break;}total+=length;if(total>BusinessObjects.MAX_FILE)throw new IOException("Το τιμολόγιο είναι πολύ μεγάλο.");copy(input,output,length);if(!line(input,2).isEmpty())throw new IOException("Invalid invoice chunk boundary");}
                    }else if(headers.has("content-length")){String length=headers.getString("content-length");if(!length.matches("[0-9]{1,10}"))throw new IOException("Invalid invoice length");long count=Long.parseLong(length);if(count>BusinessObjects.MAX_FILE)throw new IOException("Το τιμολόγιο είναι πολύ μεγάλο.");copy(input,output,count);}
                    else{byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){total+=n;if(total>BusinessObjects.MAX_FILE)throw new IOException("Το τιμολόγιο είναι πολύ μεγάλο.");output.write(buffer,0,n);}}
                    output.getFD().sync();
                }
                return new JSONObject().put("status",code).put("headers",headers).put("bodyFile",objects.importFile(body,"invoice-source",headers.optString("content-type","application/octet-stream")));
            }
        }finally{try{tcp.close();}finally{body.delete();}}
    }
}
