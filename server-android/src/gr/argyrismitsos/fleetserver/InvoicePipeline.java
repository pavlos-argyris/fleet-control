package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import com.googlecode.tesseract.android.TessBaseAPI;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.*;

/** Text first, bounded local OCR second. Originals and user confirmations stay separate. */
public final class InvoicePipeline {
    public static final String VERSION="reader-2.0-pdfbox-2.0.27-tess-5.5.1-fast";
    public interface Progress { void stage(String text); }
    private static int activeOcr=0;
    private static boolean resourcesReady=false;
    private static final ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
    private InvoicePipeline() {}

    private static synchronized void resources(Context c) throws Exception {
        if (resourcesReady) return;
        PDFBoxResourceLoader.init(c.getApplicationContext());
        File folder=new File(c.getFilesDir(),"invoice-ocr/tessdata");folder.mkdirs();
        for(String language:new String[]{"ell","eng"}) {
            File target=new File(folder,language+".traineddata");
            File part=new File(folder,language+".part");
            try(InputStream input=c.getAssets().open("ocr/tessdata/"+language+".traineddata");OutputStream out=new FileOutputStream(part)) {
                byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)out.write(bytes,0,n);
            }
            if(!part.renameTo(target)) throw new IOException("Δεν αποθηκεύτηκε το μοντέλο OCR.");
        }
        resourcesReady=true;
    }

    private static synchronized void acquire(Context c) throws Exception {
        while(activeOcr>=Math.max(1,Math.min(3,c.getSharedPreferences(BackupManager.PREFS,0).getInt("ocr_parallelism",1)))) {
            if(Thread.currentThread().isInterrupted())throw new InterruptedException();
            InvoicePipeline.class.wait(250);
        }
        activeOcr++;
    }
    private static synchronized void release(){activeOcr--;InvoicePipeline.class.notifyAll();}
    private static String digest(File file,String extra) throws Exception {
        MessageDigest hash=MessageDigest.getInstance("SHA-256");
        try(InputStream in=new FileInputStream(file)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)hash.update(b,0,n);}
        hash.update(extra.getBytes("UTF-8"));StringBuilder s=new StringBuilder();for(byte b:hash.digest())s.append(String.format(Locale.US,"%02x",b&255));return s.toString();
    }
    private static String readFile(File file) throws Exception {
        if(file.length()>1000000)throw new IOException("Μεγάλο αρχείο cache.");
        ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=new FileInputStream(file)){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);}return out.toString("UTF-8");
    }
    private static String applyLabels(String text,String rules) {
        try{
            JSONArray list=new JSONArray(rules);String result=text;
            for(int i=0;i<list.length();i++){
                JSONObject rule=list.getJSONObject(i);
                if(!text.toLowerCase(Locale.ROOT).contains(rule.optString("supplier").toLowerCase(Locale.ROOT)))continue;
                String field=rule.optString("field"),label=rule.optString("label");
                String canonical=field.equals("plate")?"Πινακίδα":field.equals("odometerKm")?"Χιλιόμετρα":field.equals("invoiceDate")?"Ημερομηνία":field.equals("totalAmount")?"Γενικό σύνολο":"";
                if(label.length()>1&&canonical.length()>0)result=result.replace(label,canonical);
            }
            return result;
        }catch(Exception e){return text;}
    }
    private static boolean isPdf(File file) throws IOException {
        try(InputStream in=new FileInputStream(file)){return in.read()=='%'&&in.read()=='P'&&in.read()=='D'&&in.read()=='F';}
    }
    private static File imagePdf(Context c,File file) throws Exception {
        android.graphics.BitmapFactory.Options options=new android.graphics.BitmapFactory.Options();options.inJustDecodeBounds=true;
        android.graphics.BitmapFactory.decodeFile(file.getPath(),options);
        if(options.outWidth<=0||options.outHeight<=0)throw new IOException("Δεν υποστηρίζεται η εικόνα. Χρησιμοποίησε PDF, JPG, PNG ή WEBP.");
        options.inJustDecodeBounds=false;options.inSampleSize=1;
        while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>2400)options.inSampleSize*=2;
        Bitmap image=android.graphics.BitmapFactory.decodeFile(file.getPath(),options);
        if(image==null)throw new IOException("Δεν διαβάστηκε η εικόνα.");
        File output=File.createTempFile("invoice-image-",".pdf",c.getCacheDir());
        android.graphics.pdf.PdfDocument document=new android.graphics.pdf.PdfDocument();
        try{
            android.graphics.pdf.PdfDocument.Page page=document.startPage(new android.graphics.pdf.PdfDocument.PageInfo.Builder(image.getWidth(),image.getHeight(),1).create());
            page.getCanvas().drawColor(Color.WHITE);page.getCanvas().drawBitmap(image,0,0,null);document.finishPage(page);
            try(OutputStream out=new FileOutputStream(output)){document.writeTo(out);}return output;
        }catch(Exception e){output.delete();throw e;}finally{document.close();image.recycle();}
    }
    private static boolean confident(JSONObject value){return value!=null&&"confident".equals(value.optString("localReadStatus"));}

    public static JSONObject read(Context c,File pdf,String pageText,boolean force,Progress progress) throws Exception {return read(c,pdf,pageText,force,progress,null);}
    public static JSONObject read(Context c,File pdf,String pageText,boolean force,Progress progress,final java.util.concurrent.atomic.AtomicBoolean cancellation) throws Exception {
        if(!pdf.isFile()||pdf.length()==0||pdf.length()>15L*1024*1024)throw new IOException("Μη έγκυρο ή πολύ μεγάλο PDF.");
        long start=System.nanoTime();String rules=c.getSharedPreferences(BackupManager.PREFS,0).getString("invoice_reader_rules","[]");
        String key=digest(pdf,VERSION+rules+(pageText==null?"":pageText));File folder=new File(c.getCacheDir(),"invoice-analysis");folder.mkdirs();File cache=new File(folder,key+".json");
        if(!force&&cache.isFile())try{JSONObject old=new JSONObject(readFile(cache));if(confident(old)){old.put("analysisCacheHit",true);old.put("analysisDurationMs",(System.nanoTime()-start)/1000000);return old;}}catch(Exception ignored){}
        File temporary=null;if(!isPdf(pdf)){temporary=imagePdf(c,pdf);pdf=temporary;}
        try {
        JSONObject timing=new JSONObject();JSONObject result=null;String source="pdf-text";String evidence="";boolean sourceConflict=false;
        progress.stage("Τοπική ανάγνωση κειμένου σελίδας/PDF");long phase=System.nanoTime();
        try{result=LocalInvoiceReader.readBest(pdf,applyLabels(pageText==null?"":pageText,rules));evidence=result.optString("rawText");source=pageText!=null&&pageText.length()>40?"qr-page/pdf-text":"pdf-text";sourceConflict=result.optString("ocrFallbackReason").contains("διαφωνούν");}catch(Exception ignored){}
        timing.put("textMs",(System.nanoTime()-phase)/1000000);
        if(!confident(result)){
            resources(c);progress.stage("Δεύτερη ανάγνωση κειμένου PDF");phase=System.nanoTime();
            try(PDDocument document=PDDocument.load(pdf)){
                if(document.isEncrypted())throw new IOException("Κρυπτογραφημένο PDF.");
                PDFTextStripper stripper=new PDFTextStripper();stripper.setSortByPosition(true);stripper.setEndPage(10);
                String text=stripper.getText(document);if(text.length()>128000)text=text.substring(0,128000);
                JSONObject candidate=LocalInvoiceReader.readText(applyLabels(text,rules));
                if(result==null||candidate.optInt("ocrConfidence")>result.optInt("ocrConfidence")){result=candidate;evidence=text;source="pdfbox-text";}
            }catch(Exception ignored){}
            timing.put("pdfboxMs",(System.nanoTime()-phase)/1000000);
        }
        if(!confident(result)){
            progress.stage("Αναμονή διαθέσιμης θέσης τοπικού OCR");long wait=System.nanoTime();acquire(c);timing.put("ocrWaitMs",(System.nanoTime()-wait)/1000000);phase=System.nanoTime();
            try{
                final TessBaseAPI tess=new TessBaseAPI();
                final java.util.concurrent.atomic.AtomicBoolean alive=new java.util.concurrent.atomic.AtomicBoolean(true);
                try{
                    if(!tess.init(new File(c.getFilesDir(),"invoice-ocr").getAbsolutePath(),"ell+eng",TessBaseAPI.OEM_LSTM_ONLY))throw new IOException("Δεν αρχικοποιήθηκε το ελληνικό OCR.");
                    tess.setPageSegMode(TessBaseAPI.PageSegMode.PSM_AUTO);
                    StringBuilder text=new StringBuilder();int pageConfidence=100;boolean timedOut=false;
                    try(ParcelFileDescriptor fd=ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=new PdfRenderer(fd)){
                        if(renderer.getPageCount()>10)throw new IOException("Το τοπικό OCR δέχεται έως 10 σελίδες. Χρησιμοποίησε επιπλέον έλεγχο.");
                        for(int i=0;i<renderer.getPageCount();i++){
                            if(Thread.currentThread().isInterrupted())throw new InterruptedException();
                            progress.stage("Τοπικό ελληνικό OCR · σελίδα "+(i+1)+"/"+renderer.getPageCount());
                            try(PdfRenderer.Page page=renderer.openPage(i)){
                                float scale=Math.min(3.5f,2200f/Math.max(page.getWidth(),page.getHeight()));
                                Bitmap bitmap=Bitmap.createBitmap(Math.max(1,Math.round(page.getWidth()*scale)),Math.max(1,Math.round(page.getHeight()*scale)),Bitmap.Config.ARGB_8888);
                                try{
                                    new Canvas(bitmap).drawColor(Color.WHITE);page.render(bitmap,null,null,PdfRenderer.Page.RENDER_MODE_FOR_PRINT);tess.setImage(bitmap);
                                    final java.util.concurrent.atomic.AtomicBoolean expired=new java.util.concurrent.atomic.AtomicBoolean(false);
                                    final long began=System.nanoTime();final Thread readerThread=Thread.currentThread();
                                    ScheduledFuture<?> deadline=watchdog.scheduleWithFixedDelay(new Runnable(){public void run(){if(System.nanoTime()-began>45L*1000000000L||readerThread.isInterrupted()||cancellation!=null&&cancellation.get())synchronized(tess){if(alive.get()){expired.set(true);tess.stop();}}}},500,500,TimeUnit.MILLISECONDS);
                                    try{text.append(tess.getUTF8Text()).append('\n');pageConfidence=Math.min(pageConfidence,tess.meanConfidence());timedOut|=expired.get();}finally{deadline.cancel(false);}
                                }finally{bitmap.recycle();}
                            }
                            if(timedOut||text.length()>128000)break;
                        }
                    }
                    String raw=text.toString();if(raw.length()>128000)raw=raw.substring(0,128000);
                    JSONObject candidate=LocalInvoiceReader.readText(applyLabels(raw,rules));candidate.put("ocrEngineConfidence",pageConfidence);
                    if(timedOut||pageConfidence<65){candidate.put("localReadStatus","ambiguous");candidate.put("ocrFallbackReason",timedOut?"Το τοπικό OCR υπερέβη το χρονικό όριο.":"Χαμηλή αξιοπιστία τοπικού OCR.");}
                    if(result==null||confident(candidate)||candidate.optInt("ocrConfidence")>result.optInt("ocrConfidence")){result=candidate;evidence=raw;source="tesseract-ell-eng";}
                }finally{synchronized(tess){alive.set(false);tess.recycle();}}
            }catch(InterruptedException e){throw e;}catch(Exception | LinkageError | OutOfMemoryError e){if(result==null)result=new JSONObject();result.put("localReadStatus","ambiguous");result.put("ocrFallbackReason",e.getMessage()==null?"Δεν ήταν διαθέσιμος ο τοπικός αναγνώστης OCR.":e.getMessage());}
            finally{release();}
            timing.put("ocrMs",(System.nanoTime()-phase)/1000000);
        }
        if(result==null)result=new JSONObject();
        if(sourceConflict){result.put("localReadStatus","ambiguous");result.put("ocrConfidence",Math.min(60,result.optInt("ocrConfidence")));result.put("ocrFallbackReason","Διαφωνία σελίδας QR και PDF: απαιτείται επιπλέον έλεγχος.");}
        result.put("analysisEngine",source);result.put("analysisVersion",VERSION);result.put("analysisCacheHit",false);result.put("analysisTimings",timing);
        result.put("analysisDurationMs",(System.nanoTime()-start)/1000000);
        JSONObject fields=new JSONObject();
        for(String field:new String[]{"plate","odometerKm","invoiceDate","totalAmount","supplier","invoiceNumber"}){
            String value=result.optString(field);String snippet="";
            String wanted=field.equals("plate")?"πινακ|αριθμ.*κυκλο|plate":field.equals("odometerKm")?"χιλι|χλμ|km|οδόμετρ":field.equals("invoiceDate")?"ημερομ|date":field.equals("totalAmount")?"γενικ.*σύνο|πληρωτ|total":field.equals("invoiceNumber")?"παραστατ|τιμολογ|invoice": "";
            int offset=value.length()>0?evidence.indexOf(value):-1;
            if(offset>=0)snippet=evidence.substring(Math.max(0,offset-60),Math.min(evidence.length(),offset+value.length()+80));
            boolean label=false;
            if(value.length()>0&&wanted.length()>0)for(String line:evidence.split("\n"))if(java.util.regex.Pattern.compile(wanted,java.util.regex.Pattern.CASE_INSENSITIVE|java.util.regex.Pattern.UNICODE_CASE).matcher(line).find()){snippet=line.substring(0,Math.min(180,line.length()));label=true;break;}
            int score=value.length()==0?0:offset>=0||label?85:55;
            if(source.equals("tesseract-ell-eng"))score=Math.min(score,result.optInt("ocrEngineConfidence",55));
            if(sourceConflict)score=Math.min(score,40);
            String reason=value.length()==0?"Δεν βρέθηκε":sourceConflict?"Οι πηγές διαφωνούν":label?"Βρέθηκε σχετική επικεφαλίδα":offset>=0?"Βρέθηκε στο κείμενο":"Προέκυψε από κανόνα· χρειάζεται επιβεβαίωση";
            fields.put(field,new JSONObject().put("score",score).put("reason",reason).put("source",source).put("evidence",snippet));
        }
        result.put("fieldEvidence",fields);
        if(confident(result)){
            File part=new File(folder,key+"-"+Thread.currentThread().getId()+".part");try(OutputStream out=new FileOutputStream(part)){out.write(result.toString().getBytes("UTF-8"));}part.renameTo(cache);
            File[] files=folder.listFiles();if(files!=null&&files.length>250){java.util.Arrays.sort(files,new java.util.Comparator<File>(){public int compare(File a,File b){return Long.compare(a.lastModified(),b.lastModified());}});for(int i=0;i<files.length-250;i++)files[i].delete();}
        }
        return result;
        }finally{if(temporary!=null)temporary.delete();}
    }
}
