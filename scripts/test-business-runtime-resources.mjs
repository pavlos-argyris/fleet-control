import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Deliberately remove dependency-JAR resources from the JVM classpath. Only the
// supplied APK may provide them, matching the classes-to-DEX Android build.
const args = process.argv.slice(2);
assert(args.length === 0 || (args[0] === '--apk' && args.length <= 2), 'Usage: --apk [server.apk]');
const config = JSON.parse(fs.readFileSync('release-config.json', 'utf8'));
const apk = args.length ? path.resolve(args[1] || `dist/Fleet_Control_Server_v${config.server.version}.apk`) : null;
const lock = JSON.parse(fs.readFileSync('android-build-support/business-dependencies.lock.json', 'utf8'));
const jar = path.resolve('.build/runtime-deps', lock.items[0].file);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-resources-'));
const python = (code, extra = []) => execFileSync('python3', ['-c', code, jar, dir, ...extra], { stdio: 'inherit' });
try {
  execFileSync('python3', ['scripts/prepare-business-dependencies.py'], { stdio: 'inherit' });
  python(`import sys,zipfile
from pathlib import Path
jar,root=Path(sys.argv[1]),Path(sys.argv[2])
with zipfile.ZipFile(jar) as source,zipfile.ZipFile(root/'classes-only.jar','w') as classes,zipfile.ZipFile(root/'missing.apk','w') as missing,zipfile.ZipFile(root/'messages-only.apk','w') as messages:
 for item in source.infolist():
  if item.filename.endswith('.class') and not item.filename.endswith('module-info.class'):classes.writestr(item,source.read(item))
  if item.filename.startswith('org/mozilla/javascript/resources/') and not item.is_dir():messages.writestr(item,source.read(item))
`);
  fs.writeFileSync(path.join(dir, 'RhinoResourceSmoke.java'), `
import java.util.*;
import org.mozilla.javascript.*;
public class RhinoResourceSmoke {
 public static void main(String[] args) throws Exception {
  Locale.setDefault(Locale.US);
  for(Locale locale:new Locale[]{Locale.US,Locale.FRANCE,Locale.SIMPLIFIED_CHINESE,Locale.forLanguageTag("el-GR")}) {
   ResourceBundle messages=ResourceBundle.getBundle("org.mozilla.javascript.resources.Messages",locale);
   if(messages.getString("msg.syntax").isEmpty())throw new AssertionError("Missing syntax message "+locale);
  }
  Context context=Context.enter();
  try {
   context.setInterpretedMode(true);context.setLanguageVersion(Context.VERSION_ES6);context.setLocale(Locale.US);
   context.setClassShutter(name->false);
   Scriptable scope=context.initSafeStandardObjects();
   Object result=context.evaluateString(scope,"/^fleet[0-9]+$/.test('fleet73') && JSON.parse('{\\\"name\\\":\\\"Δοκιμή\\\"}').name === 'Δοκιμή'", "packaged-runtime",1,null);
   if(!Context.toBoolean(result))throw new AssertionError("Regular expression/JSON runtime failed");
   boolean syntax=false;
   try{context.evaluateString(scope,"function (", "packaged-runtime-invalid",1,null);}
   catch(EvaluatorException expected){syntax=expected.getMessage()!=null&&!expected.getMessage().isEmpty();}
   if(!syntax)throw new AssertionError("Expected a readable JavaScript syntax error");
  } finally {Context.exit();}
  System.out.println("PASS APK-only Rhino resources: locales, RegExp ServiceLoader, sandboxed JSON and syntax diagnostics.");
 }
}
`);
  const toolchain = process.env.FLEET_ANDROID_TOOLCHAIN_ROOT || path.resolve('.android-toolchain');
  execFileSync('java', ['-jar', path.join(toolchain, 'usr/share/java/eclipse-jdt-core-3.32.0.jar'), '-proc:none', '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8', '-classpath', jar, '-d', dir, path.join(dir, 'RhinoResourceSmoke.java')], { stdio: 'inherit' });
  const probe = file => spawnSync('java', ['-cp', [dir, path.join(dir, 'classes-only.jar'), file].join(path.delimiter), 'RhinoResourceSmoke'], { encoding: 'utf8', timeout: 30000 });
  if (!apk) {
    const missing = probe(path.join(dir, 'missing.apk'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Can't find bundle for base name org\.mozilla\.javascript\.resources\.Messages, locale en_US/);
    const messagesOnly = probe(path.join(dir, 'messages-only.apk'));
    assert.notEqual(messagesOnly.status, 0, 'Messages alone must not hide the missing RegExp service provider');
    assert.match(messagesOnly.stderr, /regular expression|RegExp|regexp/i);
    const staged = path.join(dir, 'java-resources');
    execFileSync('python3', ['scripts/prepare-business-dependencies.py', '--resources', staged], { stdio: 'inherit' });
    python(`import sys,zipfile
from pathlib import Path
root=Path(sys.argv[2])
with zipfile.ZipFile(root/'complete.apk','w') as z:
 for item in sorted((root/'java-resources').rglob('*')):
  if item.is_file():z.write(item,item.relative_to(root/'java-resources').as_posix())
`);
  }
  const target = apk || path.join(dir, 'complete.apk');
  const result = probe(target);
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Packaged Rhino smoke failed');
  python(`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as jar,zipfile.ZipFile(sys.argv[3]) as apk:
 names=apk.namelist();expected=[]
 for item in jar.infolist():
  name=item.filename
  if item.is_dir() or name.endswith('.class') or (name.startswith('META-INF/') and not name.startswith('META-INF/services/')):continue
  assert names.count(name)==1,('Missing or duplicate dependency resource',name)
  assert apk.read(name)==jar.read(item),('Changed dependency resource',name)
  expected.append(name)
 assert 'META-INF/services/org.mozilla.javascript.RegExpLoader' in expected
 assert 'org/mozilla/javascript/resources/Messages.properties' in expected
 print('Verified exact pinned dependency bytes for',len(expected),'APK Java resources.')
`, [target]);
  process.stdout.write(result.stdout);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
