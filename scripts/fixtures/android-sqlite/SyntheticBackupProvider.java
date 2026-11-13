package gr.argyrismitsos.fleetserver;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.*;

/** Test APK only: real ContentResolver streams and folder queries, synthetic data. */
public final class SyntheticBackupProvider extends DocumentsProvider {
    private File directory;
    public boolean onCreate(){directory=new File(getContext().getFilesDir(),"synthetic-backup");try{
        String target=getContext().getPackageManager().getInstrumentationInfo(new ComponentName(getContext(),AndroidSqliteChecks.class),0).targetPackage;
        getContext().grantUriPermission(target,DocumentsContract.buildTreeDocumentUri(getContext().getPackageName()+".backup","root"),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    }catch(Exception e){throw new IllegalStateException(e);}return directory.mkdirs()||directory.isDirectory();}
    private File file(String name){if(name==null||!name.matches("FleetControl_(backup|database|documents)_[0-9]{8}_[0-9]{6}\\.(fcbackup|fcdb|fcdocs)"))throw new IllegalArgumentException("Fixture path only");return new File(directory,name);}
    @Override public Bundle call(String method,String arg,Bundle input){
        if(method.equals("prepare")){Bundle result=new Bundle();result.putBoolean("ready",true);return result;}
        if(!method.equals("append"))return super.call(method,arg,input);
        try(FileOutputStream out=new FileOutputStream(file(arg),!input.getBoolean("first"))){out.write(input.getByteArray("data"));out.getFD().sync();return Bundle.EMPTY;}catch(IOException error){throw new IllegalStateException(error);}
    }
    public Cursor queryRoots(String[] projection){return new MatrixCursor(projection==null?new String[]{DocumentsContract.Root.COLUMN_ROOT_ID}:projection);}
    public boolean isChildDocument(String parent,String id){try{return parent.equals("root")&&file(id).isFile();}catch(IllegalArgumentException invalid){return false;}}
    public Cursor queryChildDocuments(String parent,String[] projection,String sort){return rows(null,projection,true);}
    public Cursor queryDocument(String id,String[] projection){return rows(id,projection,false);}
    private Cursor rows(String id,String[] projection,boolean children){
        String[] columns=projection==null?new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME}:projection;
        MatrixCursor result=new MatrixCursor(columns);
        if(children){File[] files=directory.listFiles();if(files!=null)for(File f:files)add(result,columns,f);}
        else if(id.equals("root")){Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++)row[i]=columns[i].equals(DocumentsContract.Document.COLUMN_MIME_TYPE)?DocumentsContract.Document.MIME_TYPE_DIR:columns[i].equals(DocumentsContract.Document.COLUMN_FLAGS)?DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE:"root";result.addRow(row);}
        else add(result,columns,file(id));
        return result;
    }
    private void add(MatrixCursor cursor,String[] columns,File file){Object[] row=new Object[columns.length];for(int i=0;i<columns.length;i++)row[i]=columns[i].equals(DocumentsContract.Document.COLUMN_SIZE)?file.length():file.getName();cursor.addRow(row);}
    public String createDocument(String parent,String type,String name)throws FileNotFoundException{File f=file(name);try{if(!f.createNewFile())throw new IOException("Fixture immutable collision");return name;}catch(IOException e){throw new FileNotFoundException(e.getMessage());}}
    public void deleteDocument(String id)throws FileNotFoundException{if(!file(id).delete())throw new FileNotFoundException(id);}
    public ParcelFileDescriptor openDocument(String id,String mode,CancellationSignal signal)throws FileNotFoundException{return ParcelFileDescriptor.open(file(id),ParcelFileDescriptor.parseMode(mode));}
}
