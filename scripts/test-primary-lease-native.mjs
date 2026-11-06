import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-primary-lease-'));
try{
 fs.writeFileSync(path.join(dir,'LeaseTest.java'),`import gr.argyrismitsos.fleetserver.NativePrimaryLease;import java.io.*;import java.util.*;public class LeaseTest{
 static long now=1000;static final String GEN="11111111-1111-4111-8111-111111111111",OTHER="22222222-2222-4222-8222-222222222222";static void ok(boolean b,String message){if(!b)throw new AssertionError(message);}
 public static void main(String[]args)throws Exception{
  NativePrimaryLease lease=new NativePrimaryLease(()->now);String socket=lease.connecting(GEN);ok(!lease.valid(socket,GEN),"durable active state or socket creation grants no authority");now=11000;ok(lease.ready(socket,GEN,30000),"authenticated ready accepted");ok(lease.remaining(socket,GEN)==20000,"ready bounded from before handshake, not receive");now=31000;ok(!lease.valid(socket,GEN),"exact original deadline expires");
  now=40000;String nonce=lease.renewal(socket);now=50000;ok(lease.acknowledge(socket,GEN,nonce,30000),"fresh coordinator ACK renews");ok(lease.remaining(socket,GEN)==20000,"late ACK cannot extend from receive time");now=60000;ok(!lease.acknowledge(socket,GEN,nonce,30000),"consumed nonce cannot extend authority");now=70000;ok(!lease.valid(socket,GEN),"receiver-time extension rejected");
  now=80000;nonce=lease.renewal(socket);now=111001;ok(!lease.acknowledge(socket,GEN,nonce,30000)&&!lease.valid(socket,GEN),"ACK delayed beyond TTL never grants authority");
  now=120000;nonce=lease.renewal(socket);ok(!lease.acknowledge(socket,GEN,nonce,30001),"oversized TTL rejected");nonce=lease.renewal(socket);ok(!lease.acknowledge(socket,GEN,nonce,0),"zero TTL rejected");nonce=lease.renewal(socket);ok(lease.acknowledge(socket,GEN,nonce,30000),"current lease starts");
  // elapsedRealtime advances through sleep: a suspended process cannot wake
  // with an apparently fresh lease after recovery on a different phone.
  now+=600000;ok(!lease.valid(socket,GEN),"deep sleep must expire ownership");
  String old=socket;socket=lease.connecting(GEN);nonce=lease.renewal(socket);ok(!lease.acknowledge(old,GEN,nonce,30000),"old socket cannot acknowledge new nonce");ok(lease.acknowledge(socket,GEN,nonce,30000),"new socket owns nonce");lease.close(old);ok(lease.valid(socket,GEN),"late old close cannot revoke new connection");
  nonce=lease.renewal(socket);ok(!lease.acknowledge(socket,OTHER,nonce,30000)&&!lease.valid(socket,GEN),"generation change invalidates current authority immediately");
  socket=lease.connecting(GEN);ok(lease.ready(socket,GEN,30000),"reconnected authority");lease.close(socket);ok(!lease.valid(socket,GEN),"socket loss invalidates immediately");
  socket=lease.connecting(GEN);ok(lease.ready(socket,GEN,30000),"before clock reset");now=1;ok(!lease.valid(socket,GEN),"monotonic clock reset fails closed");
  socket=lease.connecting(GEN);String first=lease.renewal(socket);Set<String> nonces=new HashSet<String>();for(int i=0;i<20;i++)nonces.add(lease.renewal(socket));ok(nonces.size()==20&&!lease.acknowledge(socket,GEN,first,30000),"bounded renewal queue and unguessable unique nonces");
  now=Long.MAX_VALUE-100;socket=lease.connecting(GEN);ok(!lease.ready(socket,GEN,30000),"overflow cannot grant authority");
  try{lease.require(socket,GEN);throw new AssertionError("expired commit accepted");}catch(IOException expected){}
  System.out.println("PASS actual native primary lease: request-send deadlines, delayed/replayed ACK rejection, deep-sleep expiry, generation/socket fencing, late close isolation, bounded pending nonces, monotonic reset/overflow and fail-closed commit guard.");
 }
}`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',dir,path.join(dir,'LeaseTest.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/NativePrimaryLease.java')],{stdio:'inherit'});execFileSync('java',['-cp',dir,'LeaseTest'],{stdio:'inherit'});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
