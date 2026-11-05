package gr.argyrismitsos.fleetserver;

import org.mozilla.javascript.*;
import org.json.*;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.TimeZone;

/** Executes only the signed APK's bundled handlers, with explicit primitive capabilities. */
public final class BusinessRuntime implements java.io.Closeable {
    public interface Host { String call(String command,String json)throws Exception; }
    private final Host host;
    private ScriptableObject scope;
    private volatile long deadline;
    private final ContextFactory contexts=new ContextFactory(){
        @Override protected Context makeContext(){
            Context c=super.makeContext();c.setInterpretedMode(true);c.setLanguageVersion(Context.VERSION_ES6);
            c.setClassShutter(new ClassShutter(){public boolean visibleToScripts(String name){return false;}});
            c.setMaximumInterpreterStackDepth(2048);c.setInstructionObserverThreshold(10000);
            c.setLocale(Locale.US);c.setTimeZone(TimeZone.getTimeZone("UTC"));return c;
        }
        @Override protected void observeInstructionCount(Context c,int count){
            if(Thread.currentThread().isInterrupted()||System.nanoTime()>deadline)throw new RuntimeException("Native business time budget exceeded");
        }
    };
    public BusinessRuntime(final Host host,String bundledCode,String expectedSha256,JSONObject configuration)throws Exception {
        this.host=host;
        if(!sha256(bundledCode.getBytes("UTF-8")).equals(expectedSha256))throw new IOException("Δεν επαληθεύτηκε ο ενσωματωμένος κώδικας Server.");
        deadline=System.nanoTime()+30000000000L;Context c=contexts.enterContext();
        try{
            scope=c.initSafeStandardObjects();
            BaseFunction capability=new BaseFunction(){@Override public Object call(Context cx,Scriptable s,Scriptable thisObject,Object[] args){
                if(args.length!=2)throw Context.reportRuntimeError("Invalid native capability call");
                try{return host.call(Context.toString(args[0]),Context.toString(args[1]));}
                catch(Exception error){throw Context.reportRuntimeError("Local capability failed");}
            }};
            capability.setParentScope(scope);capability.setPrototype(ScriptableObject.getFunctionPrototype(scope));
            ScriptableObject.defineProperty(scope,"__fleetNative",capability,ScriptableObject.READONLY|ScriptableObject.PERMANENT|ScriptableObject.DONTENUM);
            c.evaluateString(scope,bundledCode,"bundled-business",1,null);
            Function init=(Function)scope.get("__fleetInit",scope);init.call(c,scope,scope,new Object[]{configuration.toString()});c.processMicrotasks();
        }finally{Context.exit();}
    }
    public synchronized JSONObject request(JSONObject request,boolean internal,long budgetMillis)throws Exception {
        if(scope==null)throw new IOException("Η τοπική υπηρεσία δεν είναι διαθέσιμη.");
        String serialized=new JSONObject(request.toString()).put("internal",internal).toString();
        if(serialized.getBytes("UTF-8").length>(internal?64:2)*1024*1024)throw new IOException("Το αίτημα υπερβαίνει το επιτρεπόμενο μέγεθος.");
        deadline=System.nanoTime()+Math.min(30000,Math.max(100,budgetMillis))*1000000L;Context c=contexts.enterContext();
        try{
            Function dispatch=(Function)scope.get("__fleetRequest",scope);dispatch.call(c,scope,scope,new Object[]{serialized});c.processMicrotasks();
            Object result=scope.get("__fleetResult",scope);
            if(result==null||result==Undefined.instance||result==Scriptable.NOT_FOUND)throw new IOException("Η τοπική εργασία δεν ολοκληρώθηκε.");
            return new JSONObject(Context.toString(result));
        }catch(RhinoException e){throw new IOException("Η τοπική εργασία Server απέτυχε.");}
        finally{Context.exit();}
    }
    public synchronized JSONObject sandboxStatus()throws Exception {
        deadline=System.nanoTime()+1000000000L;Context c=contexts.enterContext();
        try{return new JSONObject(Context.toString(c.evaluateString(scope,"JSON.stringify({java:typeof java,packages:typeof Packages,adapter:typeof JavaAdapter,importer:typeof JavaImporter,getClass:typeof getClass,nativeReflection:typeof __fleetNative.getClass,load:typeof load})","sandbox-check",1,null)));}
        finally{Context.exit();}
    }
    public static String sha256(byte[] value)throws Exception {
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(value);StringBuilder out=new StringBuilder();for(byte b:hash){out.append(Character.forDigit((b>>>4)&15,16));out.append(Character.forDigit(b&15,16));}return out.toString();
    }
    @Override public synchronized void close(){scope=null;}
}
