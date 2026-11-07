import fs from 'node:fs';import path from 'node:path';
/** Only Android platform calls are adapted; PDFBox/font/ZIP remain real. */
export function pdfboxFixture(dir){
 const files=[],write=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,value);files.push(file);};
 write('Log.java','package android.util;public class Log{public static int d(String a,String b){return 0;}public static int d(String a,String b,Throwable c){return 0;}public static int i(String a,String b){return 0;}public static int w(String a,String b){return 0;}public static int w(String a,String b,Throwable c){return 0;}public static int e(String a,String b){return 0;}public static int e(String a,String b,Throwable c){return 0;}public static int v(String a,String b){return 0;}public static boolean isLoggable(String a,int n){return false;}}');
 write('AssetManager.java','package android.content.res;public class AssetManager{private final String root;public AssetManager(String root){this.root=root;}public java.io.InputStream open(String name)throws java.io.IOException{return new java.io.FileInputStream(new java.io.File(root,name));}}');
 write('Context.java','package android.content;public class Context{private final android.content.res.AssetManager assets;private final java.io.File root;public Context(String root){this.root=new java.io.File(root);assets=new android.content.res.AssetManager(root);}public android.content.res.AssetManager getAssets(){return assets;}public Context getApplicationContext(){return this;}public java.io.File getCacheDir(){java.io.File f=new java.io.File(root,"cache");f.mkdirs();return f;}public java.io.File getFilesDir(){java.io.File f=new java.io.File(root,"files");f.mkdirs();return f;}}');
 write('PointF.java','package android.graphics;public class PointF{public float x,y;public PointF(){}public PointF(float x,float y){this.x=x;this.y=y;}}');
 write('Path.java','package android.graphics;public class Path{}');
 write('ContextWrapper.java','package android.content;public class ContextWrapper extends Context{protected final Context base;public ContextWrapper(Context base){super(System.getProperty("java.io.tmpdir"));this.base=base;}public java.io.File getFilesDir(){return base.getFilesDir();}public java.io.File getCacheDir(){return base.getCacheDir();}}');
 return files;
}
