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
  execFileSync('java', ['-jar', path.join(root, '.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'), '-proc:none', '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8', '-d', temp,
    path.join(root, 'server-android/src/gr/argyrismitsos/fleetserver/OtaPolicy.java'), path.join(temp, 'OtaPolicyTest.java')], { stdio: 'inherit' });
  execFileSync('java', ['-cp', temp, 'OtaPolicyTest'], { stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
