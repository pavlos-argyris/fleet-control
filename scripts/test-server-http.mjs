import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-http-'));
try {
  // Minimal JSON dependency fixture; tests execute the actual FleetHttp network code.
  fs.writeFileSync(path.join(temp, 'JSONObject.java'), `package org.json;
public class JSONObject {
  public JSONObject() {} public JSONObject(String value) {}
  public JSONObject put(String key, Object value) { return this; }
  public String optString(String key, String fallback) { return fallback; }
  public String toString() { return "{}"; }
}`);
  fs.writeFileSync(path.join(temp, 'ServerConfig.java'), `package gr.argyrismitsos.fleetserver;
public class ServerConfig { public static final String SERVER_VERSION = "test"; }`);
  fs.writeFileSync(path.join(temp, 'FleetHttpTest.java'), `
import gr.argyrismitsos.fleetserver.FleetHttp;
import org.json.JSONObject;
import java.net.*;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
public class FleetHttpTest {
  static final List<FakeConnection> opened = new ArrayList<FakeConnection>();
  static final LinkedList<Integer> codes = new LinkedList<Integer>();
  static class FakeConnection extends HttpURLConnection {
    boolean closed;
    FakeConnection(URL url, int code) { super(url); responseCode = code; }
    public void connect() {} public void disconnect() { closed = true; }
    public boolean usingProxy() { return false; }
    public int getResponseCode() { return responseCode; }
    public InputStream getInputStream() { return new ByteArrayInputStream("%PDF-test".getBytes()); }
    public InputStream getErrorStream() { return new ByteArrayInputStream("{}".getBytes()); }
    public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
    public String getHeaderField(String key) { return "CF-Ray".equals(key) ? "abc123-ATH" : null; }
  }
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  static void sequence(int... values) { opened.clear(); codes.clear(); for (int value: values) codes.add(value); }
  static void connections(int count, String method) {
    check(opened.size() == count, "request count " + opened.size());
    for (FakeConnection connection : opened) {
      check(connection.closed, "connection leaked");
      check(method.equals(connection.getRequestMethod()), "method changed");
      check(!connection.getInstanceFollowRedirects(), "credential redirect allowed");
      check("private-test-key".equals(connection.getRequestProperty("X-Server-Key")), "missing auth");
    }
  }
  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(new URLStreamHandlerFactory() {
      public URLStreamHandler createURLStreamHandler(String protocol) {
        if (!"https".equals(protocol)) return null;
        return new URLStreamHandler() {
          protected URLConnection openConnection(URL url) throws IOException {
            check(!codes.isEmpty(), "unexpected extra attempt");
            FakeConnection connection = new FakeConnection(url, codes.removeFirst()); opened.add(connection); return connection;
          }
        };
      }
    });
    Map<String, String> headers = Collections.singletonMap("X-Server-Key", "private-test-key");
    String url = "https://example.invalid/api/test";
    sequence(503, 200); FleetHttp.getJson(url, headers); connections(2, "GET");
    sequence(503, 503, 503);
    try { FleetHttp.getJson(url, headers); throw new AssertionError("503 accepted"); }
    catch (FleetHttp.HttpStatusException error) { check(error.statusCode == 503 && error.getMessage().contains("Ray abc123-ATH"), "503 diagnostics"); }
    connections(3, "GET");
    sequence(401);
    try { FleetHttp.getJson(url, headers); throw new AssertionError("401 accepted"); }
    catch (FleetHttp.HttpStatusException error) { check(error.statusCode == 401, "401 lost"); }
    connections(1, "GET");
    sequence(503);
    try { FleetHttp.sendJson(url, "POST", new JSONObject(), headers); throw new AssertionError("POST accepted"); }
    catch (FleetHttp.HttpStatusException expected) {} connections(1, "POST");
    sequence(503);
    try { FleetHttp.putStream(url, new ByteArrayInputStream(new byte[]{1}), 1, "application/pdf", headers); throw new AssertionError("PUT accepted"); }
    catch (FleetHttp.HttpStatusException expected) {} connections(1, "PUT");
    sequence(503, 200);
    File file = new File(args[0], "invoice.pdf"); FleetHttp.downloadToFile(url, file, headers);
    check("%PDF-test".equals(new String(Files.readAllBytes(file.toPath()))), "download corrupt"); connections(2, "GET");
    System.out.println("OK actual Java HTTP: bounded 503 GET retries, no auth/mutation retries, connection cleanup, redirect protection, PDF download and trace diagnostics.");
  }
}`);
  execFileSync('java', ['-jar', path.join(root, '.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'), '-proc:none', '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8', '-d', temp,
    path.join(root, 'server-android/src/gr/argyrismitsos/fleetserver/FleetHttp.java'), ...['JSONObject.java', 'ServerConfig.java', 'FleetHttpTest.java'].map(file => path.join(temp, file))], { stdio: 'inherit' });
  execFileSync('java', ['-cp', temp, 'FleetHttpTest', temp], { stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
