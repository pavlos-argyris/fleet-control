import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {origin,probe,summarize} from './probe-tunnel-poc.mjs';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-tunnel-poc-'));
let child;
try{
  const compiler=path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
  if(!fs.existsSync(compiler))execFileSync('bash',['scripts/unpack-toolchain.sh'],{stdio:'pipe'});
  const source=path.join(root,'tunnel-poc-android/src/gr/argyrismitsos/fleettunnelpoc');
  const android=path.join(root,'.android-toolchain/usr/share/java/com.android.android-23.jar'),json=path.join(root,'vendor/json-java/json-20240303.jar');
  fs.writeFileSync(path.join(dir,'Base64.java'),'package android.util;public final class Base64{public static final int NO_WRAP=2;public static byte[] decode(String value,int flags){return java.util.Base64.getDecoder().decode(value);}public static String encodeToString(byte[] value,int flags){return java.util.Base64.getEncoder().encodeToString(value);}}');
  fs.writeFileSync(path.join(dir,'PocTest.java'),String.raw`package gr.argyrismitsos.fleettunnelpoc;
import org.json.*;import java.io.*;
public class PocTest {
 public static void main(String[]args)throws Exception {
  String secret=java.util.Base64.getEncoder().encodeToString(new byte[32]);
  JSONObject credentials=new JSONObject().put("AccountTag",new String(new char[32]).replace('\0','a')).put("TunnelID","11111111-1111-4111-8111-111111111111").put("TunnelSecret",secret);
  if(!PocConfig.validate("poc.example.com",credentials.toString()).getString("hostname").equals("poc.example.com"))throw new AssertionError("named config");
  for(String invalid:new String[]{"https://poc.example.com","poc.example.com\ningress: bad","poc.example.com:443","127.0.0.1","localhost","poc.workers.dev","test.trycloudflare.com","poc.example.com/secret","poc.example.com#secret","-poc.example.com","poc..example.com"}){
   try{PocConfig.validate(invalid,credentials.toString());throw new AssertionError("unsafe hostname accepted");}catch(Exception expected){}
  }
  credentials.put("TunnelSecret","not-a-tunnel-secret");try{PocConfig.validate("poc.example.com",credentials.toString());throw new AssertionError("invalid credentials accepted");}catch(Exception expected){}
  try{PocConfig.validate("poc.example.com",new String(new char[20000]));throw new AssertionError("oversize accepted");}catch(Exception expected){}
  PocQuickUrl url=new PocQuickUrl();if(url.line("https://before.trycloudflare.com")!=null)throw new AssertionError("unannounced URL");
  url.line("INF Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):");
  for(String invalid:new String[]{"https://a.trycloudflare.com.evil.invalid","https://a.trycloudflare.com/?token=private","https://u:p@a.trycloudflare.com","http://a.trycloudflare.com","https://a.b.trycloudflare.com","nothttps://a.trycloudflare.com","https://evil.invalid/?next=https://a.trycloudflare.com"})if(url.line(invalid)!=null)throw new AssertionError("unsafe quick URL accepted");
  if(!"https://safe-test.trycloudflare.com".equals(url.line("2026 INF | https://safe-test.trycloudflare.com  |")))throw new AssertionError("announced quick origin");
  if(url.line("https://second.trycloudflare.com")!=null)throw new AssertionError("URL repinning");
  final java.util.List<String> found=new java.util.ArrayList<String>();String stream="Your quick Tunnel has been created!\\n";
  stream=stream.replace("\\n","\n")+new String(new char[9000]).replace('\0','X')+" https://overflow.trycloudflare.com\n| https://fragmented-test.trycloudflare.com |\nraw-secret-log\nhttps://later.trycloudflare.com\n";
  InputStream fragments=new FilterInputStream(new ByteArrayInputStream(stream.getBytes("UTF-8"))){public int read(byte[]b)throws IOException{return super.read(b,0,1);}};
  new PocQuickUrl().scan(fragments,new PocQuickUrl.Sink(){public void found(String origin){found.add(origin);}});
  if(found.size()!=1||!found.get(0).equals("https://fragmented-test.trycloudflare.com"))throw new AssertionError("bounded fragmented URL-only scan");
  PocOrigin origin=new PocOrigin(0);
  try{System.out.println(origin.port());System.out.flush();System.in.read();}finally{origin.close();}
 }
}`);
  try{execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-cp',json+path.delimiter+android,'-d',dir,path.join(dir,'Base64.java'),path.join(dir,'PocTest.java'),path.join(source,'PocOrigin.java'),path.join(source,'PocConfig.java'),path.join(source,'PocQuickUrl.java')],{stdio:'pipe'});}catch(error){throw Error(String(error.stderr||error));}
  child=spawn('java',['-cp',dir+path.delimiter+json+path.delimiter+android,'gr.argyrismitsos.fleettunnelpoc.PocTest'],{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const port=await Promise.race([new Promise((resolve,reject)=>{child.stdout.once('data',chunk=>resolve(Number(String(chunk).trim())));child.once('exit',code=>reject(Error('Java origin stopped '+code+': '+stderr)));}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Java origin startup timeout')),10000).unref())]);
  assert.ok(port>0&&port<65536);
  const request=raw=>new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port}),chunks=[];socket.setTimeout(7000,()=>socket.destroy(Error('test timeout')));
    socket.on('connect',()=>socket.write(raw));socket.on('data',chunk=>chunks.push(chunk));socket.on('error',reject);socket.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const read=await request('GET /poc/v1/health HTTP/1.1\r\nHost: poc.example.com\r\n\r\n');
  assert.match(read,/HTTP\/1.1 200 OK/);assert.match(read,/Cache-Control: no-store/);
  const health=JSON.parse(read.split('\r\n\r\n')[1]);assert.equal(health.source,'fleet-tunnel-poc');assert.equal(health.businessData,false);
  for(const [method,url,status]of [['POST','/poc/v1/health',405],['GET','/api/auth/user-login',404],['GET','/api/sync',404],['GET','/../private/file',404],['GET','/poc/v1/health?redirect=https://evil.invalid',404]])assert.match(await request(`${method} ${url} HTTP/1.1\r\nHost: poc.example.com\r\n\r\n`),new RegExp('HTTP/1.1 '+status));
  assert.match(await request('GET /poc/v1/health HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n'),/400/);
  assert.match(await request('GET /poc/v1/health HTTP/1.1\r\nHost: a\r\nContent-Length: 10\r\n\r\n'),/400/);
  assert.equal(await request('GET /poc/v1/health HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n'),'');
  assert.equal(await request('GET /poc/v1/health HTTP/1.1\r\nHost: a\r\nX-Huge: '+'X'.repeat(9000)+'\r\n\r\n'),'');
  const parallel=await Promise.all(Array.from({length:30},()=>request('GET /poc/v1/health HTTP/1.1\r\nHost: poc.example.com\r\n\r\n')));
  const values=parallel.map(value=>JSON.parse(value.split('\r\n\r\n')[1]));assert.equal(new Set(values.map(v=>v.requests)).size,30);assert.ok(values.every(v=>v.instanceId===health.instanceId));
  const reject=()=>{throw Error('must reject before fetch');};
  for(const value of ['http://poc.example.com','https://u:p@poc.example.com','https://poc.workers.dev','https://poc.example.com/path','https://poc.example.com/#secret','https://poc.example.com/?token=x'])assert.throws(()=>origin(value));
  await assert.rejects(probe('https://poc.example.com',{concurrency:2,fetcher:reject}));
  const fixture=()=>new Response(JSON.stringify({...health,observedAtMs:Date.now()}),{headers:{'cache-control':'no-store'}});
  assert.throws(()=>origin('https://safe-test.trycloudflare.com'));
  assert.equal(origin('https://safe-test.trycloudflare.com',{allowQuick:true}),'https://safe-test.trycloudflare.com');
  assert.throws(()=>origin('https://a.b.trycloudflare.com',{allowQuick:true}));
  await assert.rejects(probe('https://safe-test.trycloudflare.com',{fetcher:reject}));
  const quickReport=await probe('https://safe-test.trycloudflare.com',{fetcher:fixture,allowQuick:true,rounds:1});assert.equal(quickReport.transport,'quick-test');assert.equal(quickReport.productionReady,false);assert.equal(quickReport.physicalAcceptanceVerified,false);assert.equal(quickReport.summary.successful,30);
  const report=await probe('https://poc.example.com',{fetcher:fixture});assert.equal(report.summary.successful,90);assert.equal(report.summary.consistent,true);assert.equal(report.physicalAcceptanceVerified,false);
  const stale=await probe('https://poc.example.com',{rounds:1,fetcher:()=>new Response(JSON.stringify({...health,observedAtMs:1}),{headers:{'cache-control':'no-store'}})});assert.equal(stale.summary.successful,0);
  const huge=await probe('https://poc.example.com',{rounds:1,fetcher:()=>new Response('x'.repeat(9000),{headers:{'cache-control':'no-store'}})});assert.equal(huge.summary.successful,0);
  assert.equal(summarize([{ok:true,ms:1,bytes:100,instanceId:'a'},{ok:true,ms:9,bytes:100,instanceId:'b'}]).consistent,false);
  // Confirm actual bind is loopback; production business classes are absent.
  assert.match(fs.readFileSync(path.join(source,'PocOrigin.java'),'utf8'),/getByAddress\(new byte\[\]\{127,0,0,1\}\)/);
  for(const file of fs.readdirSync(source))assert.doesNotMatch(fs.readFileSync(path.join(source,file),'utf8'),/fleetserver\.|FleetDataStore|CloudReturnController|DirectRelay|\/api\/primary/);
  const exited=once(child,'exit');child.stdin.end('\n');const [code]=await exited;assert.equal(code,0,stderr);child=null;
  await assert.rejects(request('GET /poc/v1/health HTTP/1.1\r\nHost: a\r\n\r\n'));
  console.log('PASS actual Java loopback/config/Quick URL: 30 concurrent synthetic requests, no business routes, bounded framing, fragmented/oversized log rejection and first-announced-origin pin; explicit Quick probe flag with no readiness claim; stale/oversize/mixed instances rejected. No physical/Tunnel claim.');
}finally{child?.kill();fs.rmSync(dir,{recursive:true,force:true});}
