package gr.argyrismitsos.fleetserver;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import java.io.*;

/** Test APK only: real ContentResolver streams and folder queries, synthetic data. */
public final class SyntheticBackupProvider extends ContentProvider {
    private File directory;
    public boolean onCreate(){directory=new File(getContext().getFilesDir(),"synthetic-backup");return directory.mkdirs()||directory.isDirectory();}
    private File file(String name){if(name==null||!name.matches("FleetControl_(backup|database|documents)_20261111_120000\\.(fcbackup|fcdb|fcdocs)"))throw new IllegalArgumentException("Fixture path only");return new File(directory,name);}
    @Override public Bundle call(String method,String arg,Bundle input){
        if(!method.equals("append"))throw new IllegalArgumentException("Fixture append only");
        try(FileOutputStream out=new FileOutputStream(file(arg),!input.getBoolean("first"))){out.write(input.getByteArray("data"));out.getFD().sync();return Bundle.EMPTY;}catch(IOException error){throw new IllegalStateException(error);}
    }
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){
        String[] columns=projection==null?new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME}:projection;
        MatrixCursor result=new MatrixCursor(columns);
        if(uri.getLastPathSegment().equals("children")){File[] files=directory.listFiles();if(files!=null)for(File f:files)add(result,columns,f);}
        else add(result,columns,file(DocumentsContract.getDocumentId(uri)));
        return result;
    }
    private void add(MatrixCursor cursor,String[] columns,File file){Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++)row[i]=columns[i].equals(DocumentsContract.Document.COLUMN_SIZE)?file.length():file.getName();cursor.addRow(row);}
    public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException {if(!mode.equals("r"))throw new FileNotFoundException("Fixture read only");return ParcelFileDescriptor.open(file(DocumentsContract.getDocumentId(uri)),ParcelFileDescriptor.MODE_READ_ONLY);}
    public String getType(Uri uri){return "application/octet-stream";}
    public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
    public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
}
