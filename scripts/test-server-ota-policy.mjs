import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ota-policy-'));
try {
  const client = fs.readFileSync(path.join(root, 'client-android/src/gr/argyrismitsos/fleetcontrol/MainActivity.java'), 'utf8');
  const method = client.match(/^    private static String formatUpdateNotes\([\s\S]*?^    \}/m)?.[0]; assert.ok(method);
  fs.writeFileSync(path.join(temp, 'OtaPolicyTest.java'), `
import gr.argyrismitsos.fleetserver.OtaPolicy;
public class OtaPolicyTest {
  ${method}
  static void check(boolean value) { if (!value) throw new AssertionError(); }
  static void notes(String input, String expected) { if (!formatUpdateNotes(input).equals(expected)) throw new AssertionError(formatUpdateNotes(input)); }
  public static void main(String[] args) {
    check(!OtaPolicy.checkDue(100000, 90000, false, true));
    check(!OtaPolicy.checkDue(150000, 90000, false, true));
    check(OtaPolicy.checkDue(3690000, 90000, false, true));
    check(OtaPolicy.checkDue(100000, 90000, true, false));
    check(!OtaPolicy.checkDue(200000, 90000, false, false));
    check(OtaPolicy.checkDue(80000, 90000, false, true));
    check(OtaPolicy.yieldForUpdate(1000000, 0, true, false, true, true, true));
    check(!OtaPolicy.yieldForUpdate(1000000, 900000, true, false, true, true, true));
    check(OtaPolicy.yieldForUpdate(1000000, 900000, true, true, false, true, true));
    check(!OtaPolicy.yieldForUpdate(1000000, 0, true, false, false, true, true));
    check(!OtaPolicy.yieldForUpdate(1000000, 0, true, true, true, false, true));
    check(!OtaPolicy.yieldForUpdate(1000000, 0, true, true, true, true, false));
    check(!OtaPolicy.yieldForUpdate(1000000, 0, false, true, true, true, true));
    notes("• Πρώτο\\n• Δεύτερο", "• Πρώτο\\n• Δεύτερο");
    notes("Πρώτο, Δεύτερο", "• Πρώτο\\n• Δεύτερο");
    notes("  ", "• Βελτιώσεις λειτουργίας και ασφάλειας.");
    System.out.println("OK actual Java OTA policy: hourly check, forced check, clock change, 15-minute failure retry, permission/backup gates and native bullet notes.");
  }
}`);
  fs.writeFileSync(path.join(temp, 'PublicReleaseFeedTest.java'), String.raw`
package gr.argyrismitsos.fleetupdates;
import java.io.*;
import java.net.*;
import java.util.*;
import org.json.JSONObject;
public class PublicReleaseFeedTest {
    static final String ROOT = "https://github.com/pavlos-argyris/fleet-control/releases/";
    static class Hop extends HttpURLConnection {
        final int code; final String location; boolean closed;
        Hop(URL url, int code, String location) { super(url); this.code=code; this.location=location; }
        public void connect() { connected=true; }
        public void disconnect() { closed=true; }
        public boolean usingProxy() { return false; }
        public int getResponseCode() {
            check("application/vnd.android.package-archive".equals(getRequestProperty("Accept")), "accept is set before connecting");
            check(getRequestProperty("Authorization")==null && getRequestProperty("Cookie")==null, "no credential forwarding");
            check(getConnectTimeout()==15000 && getReadTimeout()==30000 && !getInstanceFollowRedirects() && !getUseCaches(), "each hop configured before connecting");
            connect();
            return code;
        }
        public String getHeaderField(String name) { return "Location".equals(name) ? location : null; }
    }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        JSONObject manifest = new JSONObject().put("releaseId","v5.67.2-123456abcdef");
        for (String kind : new String[]{"client","server"}) {
            boolean client = kind.equals("client");
            String version = client ? "5.67.2" : "2.16.2";
            String name = "Fleet_Control_" + (client ? "Client" : "Server") + "_v" + version + ".apk";
            JSONObject component = new JSONObject().put("version", version).put("versionCode", client ? 115 : 88)
                .put("sizeBytes", client ? 60957482 : 113872556).put("file", name)
                .put("sha256", String.join("", Collections.nCopies(64,"a")))
                .put("packageName", client ? "gr.argyrismitsos.fleetcontrol" : "gr.argyrismitsos.fleetserver");
            manifest.put(kind, component);
            JSONObject parsed = PublicReleaseFeed.parse(manifest, kind);
            check(parsed.getString("downloadUrl").equals(ROOT+"download/fleet-v5.67.2/"+name), "manifest pins the exact release asset");
            List<Hop> hops=new ArrayList<Hop>();
            URL initial=new URL(parsed.getString("downloadUrl"));
            HttpURLConnection release=PublicReleaseFeed.open(initial,url->{
                Hop hop = new Hop(url,hops.isEmpty()?302:200,hops.isEmpty()?"https://release-assets.githubusercontent.com/synthetic":"");
                hops.add(hop);return hop;
            });
            check(hops.size()==2 && hops.get(0).closed && release==hops.get(1) && !hops.get(1).closed, "redirect closes only the first hop");
            try { release.setRequestProperty("Accept","wrong");throw new AssertionError("returned connection must already be connected"); }
            catch(IllegalStateException expected) { }
            release.disconnect();
            try {
                PublicReleaseFeed.open(initial,url->{
                    check(url.equals(initial),"untrusted hop never opened");return new Hop(url,302,"https://invalid.example/leak");
                });throw new AssertionError("untrusted redirect followed");
            } catch(IOException expected) { }
            try { PublicReleaseFeed.parse(manifest.put(kind,component.put("packageName","other.android")),kind);throw new AssertionError("wrong package accepted"); }
            catch(IOException expected) { }
        }
        System.out.println("PASS real Java GitHub feed client: Client/Server identity, connected redirect response, redirect boundaries and no credentials.");
    }
}
`);
  const json = path.join(root, 'vendor/json-java/json-20240303.jar');
  execFileSync('java', ['-jar', path.join(root, '.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'), '-proc:none', '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8', '-classpath', json, '-d', temp,
    path.join(root, 'server-android/src/gr/argyrismitsos/fleetserver/OtaPolicy.java'), path.join(temp, 'OtaPolicyTest.java'), path.join(temp, 'PublicReleaseFeedTest.java'),
    path.join(root, 'common-android/src/gr/argyrismitsos/fleetupdates/PublicReleaseFeed.java')], { stdio: 'inherit' });
  execFileSync('java', ['-cp', temp, 'OtaPolicyTest'], { stdio: 'inherit' });
  execFileSync('java', ['-cp', [temp,json].join(path.delimiter), 'gr.argyrismitsos.fleetupdates.PublicReleaseFeedTest'], { stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
