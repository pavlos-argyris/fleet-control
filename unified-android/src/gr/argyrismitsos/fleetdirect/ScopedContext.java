package gr.argyrismitsos.fleetdirect;

import android.content.*;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;

/** Same APK identity; independent database, files, preferences and process statics. */
public final class ScopedContext extends ContextWrapper {
    public ScopedContext(Context base){super(base);getFilesDir();getCacheDir();}
    private File directory(String name){File result=new File(getApplicationInfo().dataDir,"app_fleet_direct/"+name);if(!result.isDirectory()&&!result.mkdirs())throw new IllegalStateException("Direct storage unavailable");return result;}
    @Override public File getFilesDir(){return directory("files");}
    @Override public File getCacheDir(){return directory("cache");}
    @Override public File getNoBackupFilesDir(){return directory("no_backup");}
    @Override public File getDatabasePath(String name){return new File(directory("databases"),name(name));}
    @Override public boolean deleteDatabase(String name){return android.database.sqlite.SQLiteDatabase.deleteDatabase(getDatabasePath(name));}
    @Override public String[] databaseList(){String[] names=directory("databases").list();return names==null?new String[0]:names;}
    @Override public android.database.sqlite.SQLiteDatabase openOrCreateDatabase(String name,int mode,android.database.sqlite.SQLiteDatabase.CursorFactory factory){return android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name),factory);}
    @Override public android.database.sqlite.SQLiteDatabase openOrCreateDatabase(String name,int mode,android.database.sqlite.SQLiteDatabase.CursorFactory factory,android.database.DatabaseErrorHandler handler){return android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).getPath(),factory,handler);}
    private String name(String value){if(value==null||!value.matches("[A-Za-z0-9_.-]+")||value.equals(".")||value.equals(".."))throw new SecurityException("Invalid Direct filename");return value;}
    @Override public File getDir(String value,int mode){return directory("dirs/"+name(value));}
    @Override public FileInputStream openFileInput(String value)throws FileNotFoundException{return new FileInputStream(new File(getFilesDir(),name(value)));}
    @Override public FileOutputStream openFileOutput(String value,int mode)throws FileNotFoundException{if((mode&~MODE_APPEND)!=MODE_PRIVATE)throw new SecurityException("Private Direct files only");return new FileOutputStream(new File(getFilesDir(),name(value)),(mode&MODE_APPEND)!=0);}
    @Override public boolean deleteFile(String value){return new File(getFilesDir(),name(value)).delete();}
    @Override public String[] fileList(){String[] names=getFilesDir().list();return names==null?new String[0]:names;}
    @Override public File getExternalFilesDir(String type){File base=super.getExternalFilesDir(type);if(base==null)return null;File scoped=new File(base,"fleet-direct");return scoped.isDirectory()||scoped.mkdirs()?scoped:null;}
    @Override public File getExternalCacheDir(){File base=super.getExternalCacheDir();if(base==null)return null;File scoped=new File(base,"fleet-direct");return scoped.isDirectory()||scoped.mkdirs()?scoped:null;}
    @Override public SharedPreferences getSharedPreferences(String name,int mode){return super.getSharedPreferences("fleet_direct_"+name,mode);}
    @Override public Context getApplicationContext(){return this;}
}
