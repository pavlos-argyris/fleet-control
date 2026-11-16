import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-work-queue-'));
try{
 fs.writeFileSync(path.join(dir,'QueueTest.java'),String.raw`package gr.argyrismitsos.fleetserver;import java.util.*;import java.util.concurrent.*;
 public class QueueTest{
  static void check(boolean b,String m){if(!b)throw new AssertionError(m);}
  public static void main(String[] args)throws Exception{
   IndependentWorkQueue q=new IndependentWorkQueue();CountDownLatch active=new CountDownLatch(1),release=new CountDownLatch(1);List<String> order=Collections.synchronizedList(new ArrayList<String>());
   try{Future<?> first=q.submit(()->{active.countDown();release.await();return null;},2);check(active.await(5,TimeUnit.SECONDS),"running writer started");
    Future<?> heavy=q.submit(()->{order.add("background");return null;},2),read=q.submit(()->{order.add("read");return null;},1),login=q.submit(()->{order.add("login");return null;},0);release.countDown();first.get();heavy.get();read.get();login.get();check(order.equals(Arrays.asList("login","read","background")),"queued login/read precede background, without interrupting the current transaction");
    CountDownLatch start=new CountDownLatch(1),finish=new CountDownLatch(1);Future<?> hold=q.submit(()->{start.countDown();finish.await();return null;},2);check(start.await(5,TimeUnit.SECONDS),"bounded writer active");List<Future<?>> queued=new ArrayList<Future<?>>();for(int i=0;i<24;i++)queued.add(q.submit(()->null,2));boolean full=false;try{q.submit(()->null,2);}catch(RejectedExecutionException expected){full=true;}check(full,"background queue bounded at24");for(int i=0;i<4;i++)queued.add(q.submit(()->null,1));full=false;try{q.submit(()->null,1);}catch(RejectedExecutionException expected){full=true;}check(full,"reads preserve four login/write slots");for(int i=0;i<4;i++)queued.add(q.submit(()->null,0));full=false;try{q.submit(()->null,0);}catch(RejectedExecutionException expected){full=true;}check(full&&q.getQueue().size()==32,"eight reserved interactive slots; total bound32");finish.countDown();hold.get();for(Future<?> task:queued)task.get();check(q.getLargestPoolSize()==1,"only one financial writer");
    System.out.println("PASS actual writer queue: bounded priorities, reserved interactive capacity, FIFO within priority, no transaction preemption and one writer");
   }finally{release.countDown();q.shutdownNow();}
  }
 }`);
 const compiler=path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),sources=[path.join(dir,'QueueTest.java'),path.resolve('independent-android/src/gr/argyrismitsos/fleetserver/IndependentWorkQueue.java')];
 if(fs.existsSync(compiler))execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-d',dir,...sources],{stdio:'inherit'});else execFileSync('javac',['-encoding','UTF-8','-d',dir,...sources],{stdio:'inherit'});
 execFileSync('java',['-cp',dir,'gr.argyrismitsos.fleetserver.QueueTest'],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
