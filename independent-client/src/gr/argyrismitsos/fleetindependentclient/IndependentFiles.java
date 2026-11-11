package gr.argyrismitsos.fleetindependentclient;
import android.content.*;import android.database.*;import android.net.Uri;import android.os.ParcelFileDescriptor;import java.io.*;
public final class IndependentFiles extends ContentProvider {
 @Override public boolean onCreate(){return true;}
 private File file(Uri uri)throws FileNotFoundException{String name=uri.getLastPathSegment();if(name==null||!name.matches("[a-f0-9-]{36}\\.pdf"))throw new FileNotFoundException();File file=new File(getContext().getCacheDir(),name);if(!file.isFile()||System.currentTimeMillis()-file.lastModified()>3600000)throw new FileNotFoundException();return file;}
 @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!mode.equals("r"))throw new FileNotFoundException();return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
 @Override public String getType(Uri uri){return "application/pdf";}
 @Override public Cursor query(Uri uri,String[] columns,String selection,String[] args,String order){try{File file=file(uri);MatrixCursor cursor=new MatrixCursor(new String[]{"_display_name","_size"});cursor.addRow(new Object[]{file.getName(),file.length()});return cursor;}catch(Exception error){return null;}}
 @Override public Uri insert(Uri uri,ContentValues values){throw new SecurityException();}@Override public int delete(Uri uri,String where,String[] args){throw new SecurityException();}@Override public int update(Uri uri,ContentValues values,String where,String[] args){throw new SecurityException();}
}
