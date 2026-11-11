package gr.argyrismitsos.fleetserver;
import java.io.*;import java.net.*;import javax.net.ssl.*;

/** DuckDNS IPv4 autodetection must actually use IPv4 even on dual-stack Nova Wi-Fi. */
public final class IndependentDns {
 private IndependentDns(){}
 static String get(String address)throws Exception{
  URI uri=new URI(address);if(!"https".equals(uri.getScheme())||!"www.duckdns.org".equals(uri.getHost())||!"/update".equals(uri.getPath())||uri.getPort()!=-1||uri.getUserInfo()!=null||uri.getFragment()!=null)throw new IOException("Invalid DDNS destination");
  InetAddress chosen=null;for(InetAddress ip:InetAddress.getAllByName(uri.getHost()))if(ip instanceof Inet4Address&&IndependentPolicy.publicPeer(ip)){chosen=ip;break;}if(chosen==null)throw new IOException("Δεν βρέθηκε δημόσια IPv4 του παρόχου DNS.");
  Socket tcp=new Socket();try{tcp.connect(new InetSocketAddress(chosen,443),10000);try(SSLSocket tls=(SSLSocket)((SSLSocketFactory)SSLSocketFactory.getDefault()).createSocket(tcp,uri.getHost(),443,true)){
   tls.setSoTimeout(15000);SSLParameters parameters=tls.getSSLParameters();boolean verified=false;
   try{SSLParameters.class.getMethod("setEndpointIdentificationAlgorithm",String.class).invoke(parameters,"HTTPS");tls.setSSLParameters(parameters);verified=true;}catch(ReflectiveOperationException unavailable){}
   tls.startHandshake();if(!verified&&!HttpsURLConnection.getDefaultHostnameVerifier().verify(uri.getHost(),tls.getSession()))throw new IOException("Δεν επαληθεύτηκε το HTTPS όνομα DuckDNS.");
   OutputStream out=tls.getOutputStream();out.write(("GET "+uri.getRawPath()+"?"+uri.getRawQuery()+" HTTP/1.1\r\nHost: www.duckdns.org\r\nConnection: close\r\nUser-Agent: Fleet-Independent-Android/1\r\n\r\n").getBytes("US-ASCII"));out.flush();InputStream input=new BufferedInputStream(tls.getInputStream());String first=IndependentHttps.line(input,2048);if(!first.matches("HTTP/1\\.[01] 200 .*"))throw new IOException("Η ενημέρωση DuckDNS δεν επιβεβαιώθηκε.");String encoding="";long length=-1;int total=0;
   for(int i=0;;i++){String line=IndependentHttps.line(input,4096);if(line.isEmpty())break;total+=line.length();if(i>40||total>16384)throw new IOException("Oversized DNS headers");int at=line.indexOf(':');if(at<1)throw new IOException("Invalid DNS response");String key=line.substring(0,at).toLowerCase(java.util.Locale.US),value=line.substring(at+1).trim();if(key.equals("content-length"))length=Long.parseLong(value);if(key.equals("transfer-encoding"))encoding=value;}
   ByteArrayOutputStream body=new ByteArrayOutputStream();if(encoding.equalsIgnoreCase("chunked")){for(;;){String line=IndependentHttps.line(input,128).split(";",2)[0];long count=Long.parseLong(line,16);if(count==0)break;copy(input,body,count);if(!IndependentHttps.line(input,2).isEmpty())throw new IOException("Invalid DNS chunk");}}else if(encoding.isEmpty()){if(length>=0)copy(input,body,length);else{int b;while((b=input.read())!=-1){if(body.size()>=8192)throw new IOException("Oversized DNS response");body.write(b);}}}else throw new IOException("Unsupported DNS response encoding");
   return new String(body.toByteArray(),"UTF-8");
  }}finally{tcp.close();}
 }
 private static void copy(InputStream in,ByteArrayOutputStream out,long count)throws Exception{if(count<0||count>8192-out.size())throw new IOException("Oversized DNS body");for(long i=0;i<count;i++){int b=in.read();if(b<0)throw new EOFException();out.write(b);}}
}
