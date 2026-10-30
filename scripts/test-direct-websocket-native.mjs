import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import crypto from 'node:crypto';import {execFileSync,spawn} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-direct-tls-'));let server;const sockets=new Set();let scenario='valid',packets=0;
function frame(opcode,body,fin=true){body=Buffer.from(body);assert.ok(body.length<126);return Buffer.concat([Buffer.from([(fin?128:0)|opcode,body.length]),body]);}
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'pipe'});
 execFileSync('keytool',['-importcert','-noprompt','-storetype','PKCS12','-alias','loopback','-file',path.join(dir,'cert.pem'),'-keystore',path.join(dir,'trust.p12'),'-storepass','synthetic-only'],{stdio:'pipe'});
 fs.writeFileSync(path.join(dir,'Base64.java'),'package android.util;public class Base64{public static final int NO_WRAP=2;public static String encodeToString(byte[] b,int f){return java.util.Base64.getEncoder().encodeToString(b);}}');
 fs.writeFileSync(path.join(dir,'SocketTest.java'),String.raw`import gr.argyrismitsos.fleetserver.DirectWebSocket;public class SocketTest{public static void main(String[] args)throws Exception{DirectWebSocket ws=new DirectWebSocket();boolean reject=args[1].startsWith("reject");try{ws.connect(args[0],"synthetic-direct-server-key-123456",new String(new char[64]).replace('\0','a'));if(args[1].equals("reject-connect"))throw new AssertionError("Invalid TLS/handshake accepted");String text=ws.read();if(args[1].equals("reject-read"))throw new AssertionError("Invalid frame accepted");if(!text.equals("Hello Ελληνικά"))throw new AssertionError(text);ws.send(new String(new char[70000]).replace('\0','X'));if(!ws.read().equals("done"))throw new AssertionError("response");System.out.println("OK");}catch(Exception e){if(!reject)throw e;System.out.println("REJECTED");}finally{ws.close();}}}`);
 const compile=['-proc:none','-source','8','-target','8','-encoding','UTF-8','-d',dir,path.join(dir,'Base64.java'),path.join(dir,'SocketTest.java'),'server-android/src/gr/argyrismitsos/fleetserver/DirectWebSocket.java'];
 const ecj=path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
 try{if(fs.existsSync(ecj))execFileSync('java',['-jar',ecj,...compile],{stdio:'pipe'});else execFileSync('javac',compile,{stdio:'pipe'});}catch(error){throw Error(String(error.stderr||error));}
 server=https.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))});server.on('tlsClientError',()=>{});server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.on('upgrade',(request,socket,head)=>{
  assert.equal(request.url,'/api/direct/connect');assert.equal(request.headers['x-fleet-server-key'],'synthetic-direct-server-key-123456');assert.equal(request.headers['x-fleet-direct-pair'],'a'.repeat(64));
  const accept=crypto.createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+(scenario==='bad-accept'?'invalid':accept)+'\r\n\r\n');
  if(scenario==='bad-accept')return;
  if(scenario==='oversized'){socket.write(Buffer.from([0x81,127,0,0,0,0,0,0x50,0,0]));return;}
  socket.write(Buffer.concat([frame(1,'Hello ',false),frame(9,'heartbeat'),frame(0,'Ελληνικά')]));let buffer=head;
  socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=2){const opcode=buffer[0]&15;assert.ok(buffer[1]&128,'Client must mask frames');let length=buffer[1]&127,at=2;if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);at=4;}else if(length===127){if(buffer.length<10)return;length=Number(buffer.readBigUInt64BE(2));at=10;}if(buffer.length<at+4+length)return;const mask=buffer.subarray(at,at+4),payload=Buffer.from(buffer.subarray(at+4,at+4+length));for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];buffer=buffer.subarray(at+4+length);
   if(opcode===10){assert.equal(payload.toString(),'heartbeat');packets++;}else if(opcode===1){assert.equal(payload.length,70000);assert.ok(payload.every(b=>b===88));packets++;socket.write(frame(1,'done'));}else assert.fail('Unexpected client frame');
  }});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const run=async(host,mode,trust=true)=>{const args=[...(trust?['-Djavax.net.ssl.trustStore='+path.join(dir,'trust.p12'),'-Djavax.net.ssl.trustStorePassword=synthetic-only']:[]),'-cp',dir,'SocketTest',`https://${host}:${port}`,mode];const child=spawn('java',args,{stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>child.kill(),20000);try{const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0,error);assert.equal(out.trim(),mode.startsWith('reject')?'REJECTED':'OK');}finally{clearTimeout(timer);}};
 await run('localhost','valid');assert.equal(packets,2);
 await run('127.0.0.1','reject-connect');
 await run('localhost','reject-connect',false);
 scenario='bad-accept';await run('localhost','reject-connect');
 scenario='oversized';await run('localhost','reject-read');
 console.log('OK actual Java/TLS/RFC6455: trusted hostname, rejection of wrong hostname/untrusted CA/bad upgrade, fragmentation, UTF-8, ping/pong, masked 70KB frames and bounded incoming length.');
}finally{for(const socket of sockets)socket.destroy();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
