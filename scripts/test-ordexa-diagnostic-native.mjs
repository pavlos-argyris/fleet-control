import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ordexa-diagnostic-test-'));
const jar=path.resolve('vendor/json-java/json-20240303.jar');
try{
 fs.writeFileSync(path.join(dir,'DiagnosticTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import java.net.*;import java.io.*;import java.util.*;import java.util.concurrent.*;import javax.net.ssl.*;import org.json.*;
public class DiagnosticTest {
 static List<Integer> pages=Collections.synchronizedList(new ArrayList<Integer>());static int count=51,fail=0,requests=0,closed=0;static boolean unknown=false;
 static volatile String hold="";static volatile CountDownLatch entered,release;
 static void check(boolean x,String m){if(!x)throw new AssertionError(m);}
 static class Wire extends HttpsURLConnection {
  Wire(URL u){super(u);}public void connect(){}public void disconnect(){closed++;}public boolean usingProxy(){return false;}
  public String getCipherSuite(){return "synthetic-only";}public java.security.cert.Certificate[] getLocalCertificates(){return null;}public java.security.cert.Certificate[] getServerCertificates(){return null;}
  public OutputStream getOutputStream(){return new ByteArrayOutputStream();}public String getContentType(){return "application/json; charset=utf-8";}
  public int getResponseCode(){return url.getPath().endsWith("/orders")&&fail!=0?fail:200;}
  public InputStream getInputStream()throws IOException{
   try{
    String route=url.getPath();JSONObject out;
    if(route.endsWith("/login"))out=new JSONObject().put("token","PRIVATE-TOKEN-SENTINEL");
    else if(route.endsWith("/cities"))out=new JSONObject().put("cities",new JSONArray().put(new JSONObject().put("id",7).put("name","PRIVATE-CITY-SENTINEL")));
    else{check("GET".equals(getRequestMethod())&&getRequestProperty("Authorization").equals("Bearer PRIVATE-TOKEN-SENTINEL"),"bound authorized read");int page=url.getQuery().contains("page=2")?2:1;pages.add(page);
      JSONArray rows=new JSONArray();for(int i=(page-1)*50;i<Math.min(count,page*50);i++)rows.put(new JSONObject().put("id","PRIVATE-ORDER-"+i).put("providerRiderReference",17).put("shopId",7).put("at","2026-11-07T04:59:00+02:00").put("status","PRIVATE-STATUS-SENTINEL").put("riderName","PRIVATE-NAME-SENTINEL").put("customerEmail","PRIVATE-CONTACT-SENTINEL"));
      out=unknown?new JSONObject().put("unknownEnvelope",rows):new JSONObject().put("rows",rows).put("page",page).put("pages",Math.max(1,(count+49)/50)).put("total",count);
    }
    if(!hold.isEmpty()&&route.endsWith(hold)){entered.countDown();release.await(5,TimeUnit.SECONDS);}
    return new ByteArrayInputStream(out.toString().getBytes("UTF-8"));
   }catch(Exception e){throw new IOException(e);}
  }
 }
 static void prepareBlock(String path){hold=path;entered=new CountDownLatch(1);release=new CountDownLatch(1);}
 static String tag(JSONObject report)throws Exception{return report.getJSONArray("reads").getJSONObject(0).getJSONObject("evidence").getJSONArray("frames").getJSONObject(0).getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("id").getString("valueProof");}
 public static void main(String[] args)throws Exception{
  URL.setURLStreamHandlerFactory(protocol->"https".equals(protocol)?new URLStreamHandler(){protected URLConnection openConnection(URL u){requests++;return new Wire(u);}}:null);
  OrdexaDiagnosticSession session=new OrdexaDiagnosticSession();boolean denied=false;try{session.capture("7","2026-11-07","2026-11-08",null);}catch(Exception expected){denied=true;}check(denied&&requests==0,"no read before explicit login");
  session.login("PRIVATE-USER","PRIVATE-PASSWORD");String previousTag=null;
  for(int n:new int[]{0,1,50,51,1055}){
   count=n;pages.clear();JSONObject result=session.capture("7","2026-11-07","2026-11-08",null);
   check(pages.equals(n>50?Arrays.asList(1,1,2):Arrays.asList(1,1)),"bounded manual pagination/repeat, never full source scan");
   check(!result.toString().contains("PRIVATE-")&&!result.toString().contains("2026-11-07T04:59"),"no credentials, names, raw IDs/status/row timestamps in copy report");
   check(!result.getBoolean("automaticWritesEnabled")&&!result.getBoolean("semanticsVerified")&&!result.getBoolean("coverageVerified")&&!result.getBoolean("completeSnapshot"),"sample never authorizes money or coverage");
   if(n>0){String first=tag(result),second=result.getJSONArray("reads").getJSONObject(1).getJSONObject("evidence").getJSONArray("frames").getJSONObject(0).getJSONArray("samples").getJSONObject(0).getJSONObject("fields").getJSONObject("id").getString("valueProof");check(first.equals(second),"same-session keyed order identity across actual HTTPS-class repeat");previousTag=first;}
  }
  session.login("PRIVATE-OTHER-USER","PRIVATE-PASSWORD");check(!previousTag.equals(tag(session.capture("7","2026-11-07","2026-11-08",null))),"different explicit login cannot correlate proof tags");
  int before=requests;for(String[] range:new String[][]{{"bad","2026-11-08"},{"2026-11-09","2026-11-08"},{"2026-11-01","2026-11-08"}}){denied=false;try{session.capture("7",range[0],range[1],null);}catch(Exception expected){denied=true;}check(denied,"bad/broad ranges rejected");}
  denied=false;try{session.capture("8","2026-11-07","2026-11-08",null);}catch(Exception expected){denied=true;}check(denied&&requests==before,"city must come from current authenticated account; rejection before network");
  unknown=true;pages.clear();JSONObject unknownResult=session.capture("7","2026-11-07","2026-11-08",null);check(pages.equals(Arrays.asList(1,1))&&!unknownResult.getBoolean("coverageVerified"),"unknown envelope is sampled, never guessed/traversed/accepted as coverage");unknown=false;
  for(int code:new int[]{401,403,429,503}){session.login("PRIVATE-USER","PRIVATE-PASSWORD");fail=code;before=requests;JSONObject result=session.capture("7","2026-11-07","2026-11-08",null);check(result.getInt("httpStatus")==code&&requests==before+1&&result.getJSONArray("reads").length()==0,"HTTP error preserved without automatic retry");check(!result.toString().contains("PRIVATE-"),"failed request report contains no secret");fail=0;}
  session.login("PRIVATE-USER","PRIVATE-PASSWORD");prepareBlock("/orders");final Throwable[] failures=new Throwable[1];Thread pending=new Thread(()->{try{session.capture("7","2026-11-07","2026-11-08",null);}catch(Throwable e){failures[0]=e;}});before=requests;pending.start();check(entered.await(5,TimeUnit.SECONDS),"in-flight read reached");denied=false;try{session.capture("7","2026-11-07","2026-11-08",null);}catch(Exception expected){denied=true;}check(denied,"double capture is fenced");session.clear();release.countDown();pending.join(5000);check(!pending.isAlive()&&failures[0]!=null&&requests==before+1,"logout cancels result and further page/repeat requests");hold="";
  prepareBlock("/login");failures[0]=null;Thread login=new Thread(()->{try{session.login("PRIVATE-USER","PRIVATE-PASSWORD");}catch(Throwable e){failures[0]=e;}});before=requests;login.start();check(entered.await(5,TimeUnit.SECONDS),"in-flight login reached");session.clear();release.countDown();login.join(5000);hold="";check(!login.isAlive()&&failures[0]!=null&&requests==before+1,"late login cannot resurrect session or request cities after clear");
  check(requests==closed,"every response disconnected");
  System.out.println("PASS standalone manual diagnostic actual Java session: HTTPS-class synthetic transport, bounded0/1/50/51/1055 sampling, scoped privacy, unknown envelope, HTTP/no-retry, current city/range, concurrent capture, clear during login/read and no financial approval. No live provider or physical Android claim.");
 }
}`);
 const provider='server-android/src/gr/argyrismitsos/fleetserver/';
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,...['OrdexaClient','StoreBillingProtocol','StoreBillingEngine'].map(n=>provider+n+'.java'),'ordexa-diagnostic-android/src/gr/argyrismitsos/fleetserver/OrdexaDiagnosticSession.java',path.join(dir,'DiagnosticTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.DiagnosticTest'],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
