package gr.argyrismitsos.fleetserver;

import org.mozilla.javascript.*;
import org.json.*;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.TimeZone;

/** Executes only the signed APK's bundled handlers, with explicit primitive capabilities. */
public final class BusinessRuntime implements java.io.Closeable {
    static {
        // Rhino 1.9 resolves its RegExp service once, through the caller's
        // context loader. Android Binder threads can start with the boot loader.
        // Initialize from the signed APK before any Rhino ContextFactory field,
        // then restore the caller; the script ClassShutter stays unchanged.
        Thread thread=Thread.currentThread();ClassLoader previous=thread.getContextClassLoader();
        try{
            ClassLoader application=BusinessRuntime.class.getClassLoader();thread.setContextClassLoader(application);
            Class.forName("org.mozilla.javascript.Context",true,application);
        }catch(ClassNotFoundException unavailable){throw new ExceptionInInitializerError(unavailable);}
        finally{thread.setContextClassLoader(previous);}
    }
    public interface Host {
        String call(String command,String json)throws Exception;
        default void beforeRequest(JSONObject request,boolean internal)throws Exception{}
        default void beforeCommit(JSONObject response,boolean internal)throws Exception{}
        default void afterRequest()throws Exception{}
    }
    private final Host host;
    private ScriptableObject scope;
    private volatile long deadline;
    /** Report a bounded category only. Android SQLite messages can contain the
     * full statement, including historical personal data or credential binds. */
    private static String capabilityFailure(String command,Exception error){
        String area="LOCAL";
        if(command!=null){
            if(command.matches("sql\\.(exec|query|raw|run|batch|request\\.begin|request\\.end)"))area="SQL_"+command.substring(4).replace('.','_').toUpperCase(Locale.US);
            else if(command.startsWith("crypto."))area="CRYPTO";
            else if(command.startsWith("objects.")||command.startsWith("file.")||command.equals("response.file"))area="FILES";
            else if(command.equals("url.parse"))area="URL";
            else if(command.equals("date.parts"))area="TIMEZONE";
        }
        String code="NATIVE_FAILURE";
        Throwable cause=error;
        for(int depth=0;cause!=null&&depth<8;depth++,cause=cause.getCause()){
            if(cause.getClass().getName().startsWith("android.database.sqlite.")){
                String message=String.valueOf(cause.getMessage()).toLowerCase(Locale.US);
                code="SQLITE_ERROR";
                if(message.contains("sqlite_misuse")||message.contains("empty sql statement"))code="SQLITE_EMPTY_STATEMENT";
                else if(message.contains("query or rawquery"))code="SQLITE_QUERY_API";
                else if(message.contains("no such function"))code="SQLITE_FUNCTION_UNAVAILABLE";
                else if(message.contains("no such table")||message.contains("no such column")||message.contains("has no column"))code="SQLITE_SCHEMA";
                else if(message.contains("database is locked")||message.contains("database is busy"))code="SQLITE_BUSY";
                else if(message.contains("constraint"))code="SQLITE_CONSTRAINT";
                break;
            }
            if(cause instanceof IOException)code="LOCAL_IO";
            else if(cause instanceof IllegalArgumentException)code="INVALID_ARGUMENT";
            if(cause.getCause()==cause)break;
        }
        return "Local capability failed ["+area+"/"+code+"]";
    }
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
                catch(Exception error){throw Context.reportRuntimeError(capabilityFailure(Context.toString(args[0]),error));}
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
        boolean transaction=false;
        try{
            host.beforeRequest(request,internal);
            host.call("sql.request.begin","{}");transaction=true;
            Function dispatch=(Function)scope.get("__fleetRequest",scope);dispatch.call(c,scope,scope,new Object[]{serialized});c.processMicrotasks();
            Object result=scope.get("__fleetResult",scope);
            if(result==null||result==Undefined.instance||result==Scriptable.NOT_FOUND)throw new IOException("Η τοπική εργασία δεν ολοκληρώθηκε.");
            JSONObject response=new JSONObject(Context.toString(result));
            if(response.optInt("status",500)<500)host.beforeCommit(response,internal);
            try{host.call("sql.request.end",new JSONObject().put("commit",response.optInt("status",500)<500).toString());}finally{transaction=false;}
            return response;
        }catch(RhinoException e){throw new IOException("Η τοπική εργασία Server απέτυχε.");}
        finally{try{if(transaction)host.call("sql.request.end","{\"commit\":false}");}finally{try{host.afterRequest();}finally{Context.exit();}}}
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
