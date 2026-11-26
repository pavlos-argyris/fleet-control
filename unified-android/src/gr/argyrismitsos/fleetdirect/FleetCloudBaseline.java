package gr.argyrismitsos.fleetdirect;

import android.util.Base64;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/** Copy a verified, Fleet-scoped archive by acknowledged chunks. */
final class FleetCloudBaseline {
    private static final String ROUTE="/api/fleet-sync/v1/baseline";
    private static final String ZERO="0000000000000000000000000000000000000000000000000000000000000000";
    private static final int CHUNK=48*1024;

    interface Transport {
        JSONObject send(String path,JSONObject payload) throws Exception;
        JSONObject putFile(String sha256,String contentType,long size,InputStream input) throws Exception;
    }

    interface Contents {
        InputStream open() throws IOException;
    }

    static final class Document {
        final String sha256,contentType;
        final long size;
        final Contents contents;

        Document(String sha256,String contentType,long size,Contents contents) throws IOException {
            if (!sha256.matches("[0-9a-f]{64}") || size<=0 || size>15L*1024*1024) throw invalidReceipt();
            this.sha256=sha256;
            this.contentType=contentType;
            this.size=size;
            this.contents=contents;
        }

        String fingerprint() throws Exception {
            return digest((sha256+":"+size).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static final class Position {
        long bytes;
        int next;
        String chain=ZERO;

        void advance(long size,String fingerprint) throws Exception {
            chain=digest((chain+":"+fingerprint).getBytes(StandardCharsets.UTF_8));
            bytes=Math.addExact(bytes,size);
            next++;
        }

        void require(JSONObject reply) throws Exception {
            if (reply.getInt("next")!=next || reply.getLong("bytes")!=bytes || !chain.equals(reply.getString("chain"))) {
                throw invalidReceipt();
            }
        }
    }

    private FleetCloudBaseline() { }

    static void stage(String epoch,String sourceSha256,File records,List<Document> files,Transport transport) throws Exception {
        if (!epoch.matches("[a-f0-9]{32}") || !sourceSha256.matches("[a-f0-9]{64}") ||
                records.length()==0 || records.length()>512L*1024*1024 || files.size()>30000) throw invalidReceipt();
        Position expectedRecords=new Position(), expectedFiles=new Position();
        readRecords(records,(bytes)->expectedRecords.advance(bytes.length,digest(bytes)));
        for (Document file:files) expectedFiles.advance(file.size,file.fingerprint());
        JSONObject manifest=new JSONObject().put("format","fleet-baseline-v1").put("sourceSha256",sourceSha256)
                .put("dataBytes",expectedRecords.bytes).put("dataChain",expectedRecords.chain)
                .put("files",expectedFiles.next).put("fileBytes",expectedFiles.bytes).put("fileChain",expectedFiles.chain);
        JSONObject started=transport.send(ROUTE+"/begin",manifest);
        requireManifest(started,manifest,epoch);
        verifyFiles(files,started.getJSONObject("files"),transport);
        verifyRecords(records,started.getJSONObject("records"),transport);
        JSONObject reconciled=transport.send(ROUTE+"/seal",new JSONObject());
        requireManifest(reconciled,manifest,epoch);
        expectedRecords.require(reconciled.getJSONObject("records"));
        expectedFiles.require(reconciled.getJSONObject("files"));
        if (!"staged".equals(reconciled.getString("phase"))) throw invalidReceipt();
    }

    private static void verifyRecords(File records,JSONObject saved,Transport transport) throws Exception {
        int next=saved.getInt("next");
        if (next<0) throw invalidReceipt();
        Position position=new Position();
        readRecords(records,(bytes)->{
            int ordinal=position.next;
            if (ordinal==next) position.require(saved);
            String digest=digest(bytes);
            position.advance(bytes.length,digest);
            if (ordinal<next) return;
            JSONObject page=new JSONObject().put("ordinal",ordinal).put("sha256",digest)
                    .put("data",Base64.encodeToString(bytes,Base64.NO_WRAP));
            position.require(transport.send(ROUTE+"/records",page));
        });
        if (next>position.next) throw invalidReceipt();
        if (next==position.next) position.require(saved);
    }

    private static void verifyFiles(List<Document> files,JSONObject saved,Transport transport) throws Exception {
        int next=saved.getInt("next");
        if (next<0 || next>files.size()) throw invalidReceipt();
        Position position=new Position();
        for (Document file:files) {
            int ordinal=position.next;
            if (ordinal==next) position.require(saved);
            position.advance(file.size,file.fingerprint());
            if (ordinal<next) continue;
            try (InputStream input=file.contents.open()) {
                JSONObject stored=transport.putFile(file.sha256,file.contentType,file.size,input);
                if (!stored.optBoolean("verified")||stored.getLong("size")!=file.size||!file.sha256.equals(stored.getString("sha256"))) {
                    throw invalidReceipt();
                }
            }
            position.require(transport.send(ROUTE+"/files",new JSONObject().put("ordinal",ordinal)
                    .put("size",file.size).put("sha256",file.sha256)));
        }
        if (next==position.next) position.require(saved);
    }

    private static void requireManifest(JSONObject reply,JSONObject sent,String epoch) throws Exception {
        JSONObject stored=reply.getJSONObject("manifest");
        if (!epoch.equals(reply.getString("epoch")) || stored.length()!=sent.length() ||
                !("copying".equals(reply.optString("phase")) || "staged".equals(reply.optString("phase")))) {
            throw invalidReceipt();
        }
        java.util.Iterator<String> names=sent.keys();
        while (names.hasNext()) {
            String name=names.next();
            Object value=sent.get(name), actual=stored.get(name);
            if (value instanceof Number) {
                if (!(actual instanceof Number)||((Number)value).longValue()!=((Number)actual).doubleValue()) throw invalidReceipt();
            } else if (!value.equals(actual)) throw invalidReceipt();
        }
    }

    private interface ChunkSink { void accept(byte[] bytes) throws Exception; }

    private static void readRecords(File records,ChunkSink sink) throws Exception {
        try (InputStream input=new BufferedInputStream(new FileInputStream(records))) {
            byte[] block=new byte[CHUNK];
            for (;;) {
                int size=0,count;
                while (size<block.length&&(count=input.read(block,size,block.length-size))!=-1) size+=count;
                if (size==0) return;
                if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException();
                sink.accept(size==block.length?block:java.util.Arrays.copyOf(block,size));
            }
        }
    }

    static String digest(byte[] bytes) throws Exception {
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder text=new StringBuilder(64);
        for (byte value:digest) text.append(Character.forDigit((value>>>4)&15,16)).append(Character.forDigit(value&15,16));
        return text.toString();
    }

    private static IOException invalidReceipt() {
        return new IOException("Δεν συμφωνούν τα αποτυπώματα της δοκιμαστικής μεταφοράς Fleet.");
    }
}
