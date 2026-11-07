import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-task-results-'));
try{
 const main=fs.readFileSync('server-android/src/gr/argyrismitsos/fleetserver/MainActivity.java','utf8');
 const start=main.indexOf('    private void runTask(final String event, final String requestId, final Task task)');
 const end=main.indexOf('    private static String ordexaRequestId',start);
 if(start<0||end<0)throw Error('Missing actual native task dispatch method');
 fs.writeFileSync(path.join(dir,'TaskResultsTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.util.concurrent.*;
public class TaskResultsTest {
 interface Task{JSONObject run()throws Exception;}
 final ExecutorService executor=Executors.newSingleThreadExecutor();volatile JSONObject response;volatile CountDownLatch reply=new CountDownLatch(1);
 Object getApplicationContext(){return null;}
 void emit(String event,JSONObject payload){response=payload;reply.countDown();}
 void emitError(String event,String message){try{emit(event,new JSONObject().put("ok",false).put("message",message));}catch(Exception e){throw new IllegalStateException(e);}}
`+main.slice(start,end)+String.raw`
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 void received(String id,boolean ok)throws Exception{check(reply.await(2,TimeUnit.SECONDS),"native result delivered");check(id.equals(response.optString("requestId")),"every reply, including early OTA rejection, must keep the request ID");check(response.getBoolean("ok")==ok,"truthful success/failure");reply=new CountDownLatch(1);}
 public static void main(String[] args)throws Exception{
  TaskResultsTest test=new TaskResultsTest();try{
   ServerWorkTracker.allowed=false;test.runTask("authorityStage","blocked-request",new Task(){public JSONObject run(){throw new AssertionError("blocked task must not start");}});test.received("blocked-request",false);check(ServerWorkTracker.finished==0,"never-started task does not finish another lane");
   ServerWorkTracker.allowed=true;test.runTask("authorityStage","success-request",new Task(){public JSONObject run()throws Exception{return new JSONObject().put("stageId","fixture");}});test.received("success-request",true);
   test.runTask("authorityStage","failed-request",new Task(){public JSONObject run()throws Exception{throw new java.io.IOException("injected copy failure");}});test.received("failed-request",false);
   long until=System.currentTimeMillis()+1000;while(ServerWorkTracker.finished<2&&System.currentTimeMillis()<until)Thread.yield();check(ServerWorkTracker.finished==2,"both started tasks release their OTA blocker");
   test.runTask("backup","",new Task(){public JSONObject run()throws Exception{return new JSONObject();}});check(test.reply.await(2,TimeUnit.SECONDS)&&test.response.getBoolean("ok")&&!test.response.has("requestId"),"existing uncorrelated native callers remain compatible");
   System.out.println("PASS actual MainActivity task dispatcher: correlated OTA rejection, success/failure, never-started lane protection, critical-task release and legacy no-ID compatibility.");
  }finally{test.executor.shutdownNow();}
 }
}
class ServerWorkTracker{static volatile boolean allowed;static volatile int finished;static boolean begin(Object c,String lane,String title,String detail){return allowed;}static void finish(String lane){finished++;}}
`);
 const jar=path.join(root,'vendor/json-java/json-20240303.jar');
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,path.join(dir,'TaskResultsTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.TaskResultsTest'],{stdio:'inherit',timeout:10000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
