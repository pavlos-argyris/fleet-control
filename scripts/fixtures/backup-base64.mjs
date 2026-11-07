import fs from 'node:fs';import path from 'node:path';
export function backupBase64Fixture(dir){
 const files=[],write=(name,text)=>{const file=path.join(dir,name);fs.writeFileSync(file,text);files.push(file);};
 write('Base64.java','package android.util;public class Base64{public static final int DEFAULT=0,NO_PADDING=1,NO_WRAP=2,URL_SAFE=8;public static String encodeToString(byte[] b,int flags){java.util.Base64.Encoder e=(flags&URL_SAFE)!=0?java.util.Base64.getUrlEncoder():java.util.Base64.getEncoder();return ((flags&NO_PADDING)!=0?e.withoutPadding():e).encodeToString(b);}public static byte[] decode(String s,int flags){return ((flags&URL_SAFE)!=0?java.util.Base64.getUrlDecoder():java.util.Base64.getMimeDecoder()).decode(s);}}');
 write('Base64OutputStream.java','package android.util;import java.io.*;public class Base64OutputStream extends FilterOutputStream{public Base64OutputStream(OutputStream output,int flags){super(java.util.Base64.getEncoder().wrap(output));}@Override public void write(byte[] b,int off,int length)throws IOException{out.write(b,off,length);}}');
 write('Base64InputStream.java','package android.util;import java.io.*;public class Base64InputStream extends FilterInputStream{public Base64InputStream(InputStream input,int flags){super(java.util.Base64.getMimeDecoder().wrap(input));}}');
 return files;
}
