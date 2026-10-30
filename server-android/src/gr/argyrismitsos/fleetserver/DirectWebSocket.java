package gr.argyrismitsos.fleetserver;

import android.util.Base64;
import java.io.*;
import java.net.*;
import java.security.*;
import javax.net.ssl.*;

/** Bounded RFC6455 text transport. TLS trust and hostname checks are mandatory. */
public final class DirectWebSocket implements Closeable {
    private final SecureRandom random = new SecureRandom();
    private Socket socket;
    private InputStream input;
    private OutputStream output;
    private static final int MAX_FRAME = 4 * 1024 * 1024;

    public void connect(String base, String key, String pairHash) throws Exception {
        URL url = new URL(base);
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null)
            throw new IOException("Η απευθείας πρόσβαση χρειάζεται έγκυρη διεύθυνση HTTPS.");
        if (!key.matches("[A-Za-z0-9_\\-]{24,512}") || !pairHash.matches("[a-f0-9]{64}"))
            throw new IOException("Μη έγκυρα στοιχεία σύνδεσης Server.");
        int port = url.getPort() < 0 ? 443 : url.getPort();
        Socket tcp = new Socket();
        socket = tcp;
        tcp.connect(new InetSocketAddress(url.getHost(), port), 10000);
        SSLSocket tls = (SSLSocket)((SSLSocketFactory)SSLSocketFactory.getDefault()).createSocket(tcp, url.getHost(), port, true);
        socket = tls;
        SSLParameters parameters = tls.getSSLParameters();
        // API23's framework jar omits the setter available on current devices.
        try { SSLParameters.class.getMethod("setEndpointIdentificationAlgorithm", String.class).invoke(parameters, "HTTPS"); tls.setSSLParameters(parameters); }
        catch (NoSuchMethodException unavailable) {
            tls.startHandshake();
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(url.getHost(), tls.getSession())) throw new SSLHandshakeException("Hostname verification failed");
        }
        tls.setSoTimeout(45000); tls.startHandshake();
        input = new BufferedInputStream(tls.getInputStream()); output = new BufferedOutputStream(tls.getOutputStream());
        byte[] nonce = new byte[16]; random.nextBytes(nonce);
        String challenge = Base64.encodeToString(nonce, Base64.NO_WRAP);
        String path = url.getPath().replaceAll("/+$", "") + "/api/direct/connect";
        String host = url.getHost() + (port == 443 ? "" : ":" + port);
        String request = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + challenge + "\r\nX-Fleet-Server-Key: " + key + "\r\nX-Fleet-Direct-Pair: " + pairHash + "\r\n\r\n";
        output.write(request.getBytes("UTF-8")); output.flush();
        String headers = readHeaders(input);
        String expected = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((challenge + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("UTF-8")), Base64.NO_WRAP);
        if (!headers.startsWith("HTTP/1.1 101 ") || !header(headers, "Sec-WebSocket-Accept").equals(expected) ||
            !header(headers, "Upgrade").equalsIgnoreCase("websocket") || !header(headers, "Connection").toLowerCase(java.util.Locale.US).contains("upgrade"))
            throw new IOException("Η ασφαλής σύνδεση με την πύλη δεν ολοκληρώθηκε.");
    }
    private static String readHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int state = 0;
        while (bytes.size() < 16384) {
            int b = in.read(); if (b < 0) throw new EOFException(); bytes.write(b);
            state = state == 0 && b == 13 ? 1 : state == 1 && b == 10 ? 2 : state == 2 && b == 13 ? 3 : state == 3 && b == 10 ? 4 : b == 13 ? 1 : 0;
            if (state == 4) return new String(bytes.toByteArray(), "UTF-8");
        }
        throw new IOException("Oversized WebSocket handshake");
    }
    private static String header(String headers, String name) {
        for (String line : headers.split("\r\n")) { int colon = line.indexOf(':'); if (colon > 0 && name.equalsIgnoreCase(line.substring(0, colon))) return line.substring(colon + 1).trim(); }
        return "";
    }
    private int octet() throws IOException { int b = input.read(); if (b < 0) throw new EOFException(); return b; }
    public String read() throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream(); boolean started = false;
        for (;;) {
            int first = octet(), second = octet(), opcode = first & 15;
            if ((first & 112) != 0 || (second & 128) != 0) throw new IOException("Invalid WebSocket frame");
            long length = second & 127;
            if (length == 126) length = (octet() << 8) | octet();
            else if (length == 127) { length = 0; for (int i = 0; i < 8; i++) { int b=octet(); if(i==0&&b>=128)throw new IOException("Invalid frame length"); length = (length << 8) | b; } }
            if (length < 0 || length > MAX_FRAME || opcode >= 8 && (length > 125 || (first & 128) == 0)) throw new IOException("Oversized WebSocket frame");
            byte[] bytes = new byte[(int)length]; int at = 0;
            while (at < bytes.length) { int n=input.read(bytes,at,bytes.length-at); if(n<0)throw new EOFException(); at+=n; }
            if (opcode == 8) throw new EOFException("Server closed connection");
            if (opcode == 9) { frame(10, bytes); continue; }
            if (opcode == 10) continue;
            if (opcode != 1 && opcode != 0 || opcode == 0 && !started || opcode == 1 && started) throw new IOException("Unsupported WebSocket frame");
            started=true; if (message.size()+bytes.length > MAX_FRAME) throw new IOException("Oversized WebSocket message");
            message.write(bytes, 0, bytes.length);
            if ((first & 128) != 0) return new String(message.toByteArray(), "UTF-8");
        }
    }
    public void send(String value) throws IOException { frame(1, value.getBytes("UTF-8")); }
    private synchronized void frame(int opcode, byte[] data) throws IOException {
        if (data.length > MAX_FRAME || output == null) throw new IOException("Unavailable WebSocket");
        byte[] mask = new byte[4]; random.nextBytes(mask); output.write(128 | opcode);
        if (data.length < 126) output.write(128 | data.length);
        else if (data.length <= 65535) { output.write(128 | 126); output.write(data.length >>> 8); output.write(data.length); }
        else { output.write(128 | 127); for (int i = 7; i >= 0; i--) output.write((int)((long)data.length >>> (8*i)) & 255); }
        output.write(mask); for(int i=0;i<data.length;i++)output.write(data[i]^mask[i%4]); output.flush();
    }
    public void close() { try { if(socket!=null)socket.close(); } catch(IOException ignored){} }
}
