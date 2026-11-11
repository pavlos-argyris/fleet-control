package gr.argyrismitsos.fleettunnelpoc;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;

/** Retains only the first announced public test origin, never raw connector logs. */
public final class PocQuickUrl {
    private static final Pattern URL=Pattern.compile("(?:^|\\s|\\|)(https://[a-z0-9]+(?:-[a-z0-9]+)*\\.trycloudflare\\.com)(?=[\\s|\"']|$)");
    public interface Sink { void found(String origin); }
    private boolean announced,found;
    public String line(String value){
        if(found||value.length()>8192)return null;
        if(value.contains("Your quick Tunnel has been created!")){announced=true;return null;}
        if(!announced)return null;
        Matcher match=URL.matcher(value);if(!match.find())return null;found=true;return match.group(1);
    }
    public void scan(InputStream input,Sink sink)throws IOException {
        ByteArrayOutputStream line=new ByteArrayOutputStream();byte[] bytes=new byte[4096];boolean oversized=false;int n;
        while((n=input.read(bytes))!=-1)for(int i=0;i<n;i++){
            int b=bytes[i]&255;
            if(b=='\n'){
                if(!oversized){String url=line(new String(line.toByteArray(),StandardCharsets.UTF_8));if(url!=null)sink.found(url);}
                line.reset();oversized=false;
            }else if(line.size()<8192&&!oversized)line.write(b);else oversized=true;
        }
        if(!oversized&&line.size()>0){String url=line(new String(line.toByteArray(),StandardCharsets.UTF_8));if(url!=null)sink.found(url);}
    }
}
