import assert from 'node:assert/strict';

// Parse compiled aapt XML, retaining explicit values rather than guessing defaults.
export function parseCompiledManifest(xml) {
  const nodes = [], stack = [];
  for (const line of xml.split(/\r?\n/)) {
    const element = line.match(/^(\s*)E: ([^\s(]+)/);
    if (element) {
      const indent = element[1].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const node = { tag: element[2], attrs: {}, indent, parent: stack.at(-1) || null };
      nodes.push(node); stack.push(node);
      continue;
    }
    const attr = line.match(/^\s*A: ([^\s(=]+)(?:\([^)]*\))?=(.*)$/);
    if (!attr || !stack.length) continue;
    let value = attr[2].trim();
    const quoted = value.match(/^"(?:[^"\\]|\\.)*"/);
    if (quoted) value = JSON.parse(quoted[0]);
    else {
      const typed = value.match(/^\(type 0x([a-f0-9]+)\)0x([a-f0-9]+)/i);
      if (typed) value = parseInt(typed[1], 16) === 0x12 ? parseInt(typed[2], 16) !== 0 : parseInt(typed[2], 16);
      else if (/^0x[0-9a-f]+$/i.test(value)) value = parseInt(value, 16);
    }
    stack.at(-1).attrs[attr[1].replace(/^android:/, '')] = value;
  }
  const manifest = nodes.find(n => n.tag === 'manifest');
  const app = nodes.find(n => n.tag === 'application');
  const sdk = nodes.find(n => n.tag === 'uses-sdk');
  assert.ok(manifest?.attrs.package && app, 'Compiled manifest must contain package and application');
  const explicit = (obj, key) => Object.hasOwn(obj || {}, key) ? obj[key] : null;
  return {
    packageName: manifest.attrs.package,
    versionName: explicit(manifest.attrs, 'versionName'),
    versionCode: explicit(manifest.attrs, 'versionCode'),
    minSdk: explicit(sdk?.attrs, 'minSdkVersion'),
    targetSdk: explicit(sdk?.attrs, 'targetSdkVersion'),
    application: Object.fromEntries(['allowBackup', 'usesCleartextTraffic', 'debuggable', 'testOnly'].map(k => [k, explicit(app.attrs, k)])),
    permissions: [...new Set(nodes.filter(n => /^uses-permission(?:-sdk-\d+)?$/.test(n.tag)).map(n => n.attrs.name))].sort(),
    components: nodes.filter(n => ['activity', 'activity-alias', 'service', 'receiver', 'provider'].includes(n.tag)).map(n => ({
      kind: n.tag, name: n.attrs.name, exported: explicit(n.attrs, 'exported'),
      permission: explicit(n.attrs, 'permission'), process: explicit(n.attrs, 'process'),
      actions: nodes.filter(a => a.tag === 'action' && a.parent?.parent === n).map(a => a.attrs.name).sort()
    })).sort((a, b) => (a.kind + ':' + a.name).localeCompare(b.kind + ':' + b.name))
  };
}
export function certificateDigests(output) {
  return [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gim)].map(m => m[1].toLowerCase()).sort();
}
export function assertCandidate(record, config, expectedCert, production, sourceManifest) {
  const m = record.manifest;
  assert.equal(m.packageName, config.packageName, 'Candidate package');
  assert.equal(m.versionName, config.version, 'Candidate version name');
  assert.equal(m.versionCode, config.versionCode, 'Candidate version code');
  assert.equal(m.application.allowBackup, false, 'Compiled allowBackup must be explicitly false');
  assert.equal(m.application.usesCleartextTraffic, false, 'Compiled cleartext must be explicitly false');
  assert.notEqual(m.application.debuggable, true, 'Candidate must not be debuggable');
  assert.notEqual(m.application.testOnly, true, 'Candidate must not use Android testOnly');
  const declared = [...sourceManifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map(x => x[1]).sort();
  assert.deepEqual(m.permissions, declared, 'Compiled/source permissions differ');
  for (const key of ['minSdkVersion', 'targetSdkVersion']) {
    const value = Number(sourceManifest.match(new RegExp('android:' + key + '="(\\d+)"'))?.[1]);
    assert.ok(Number.isInteger(value) && value > 0, 'Source SDK required');
    assert.equal(m[key === 'minSdkVersion' ? 'minSdk' : 'targetSdk'], value, 'Compiled/source SDK differs');
  }
  assert.equal(m.components.filter(c => c.exported === true).length, 1, 'Only launcher can be exported');
  for (const c of m.components) {
    const launcher = c.kind === 'activity' && (c.name === '.MainActivity' || c.name === config.packageName + '.MainActivity');
    assert.equal(c.exported, launcher, 'Unexpected or implicit exported component: ' + c.name);
  }
  assert.ok(record.signing.certificates.length, 'A valid signing certificate is required');
  if (production) assert.deepEqual(record.signing.certificates, [expectedCert], 'Original production signing certificate required');
}
export function compareApks(before, after) {
  const a = before.manifest, b = after.manifest;
  const previous = new Map(a.components.map(c => [c.kind + ':' + c.name, c]));
  const current = new Map(b.components.map(c => [c.kind + ':' + c.name, c]));
  return {
    from: before.label, to: after.label,
    originalCertificateUnchanged: JSON.stringify(before.signing.certificates) === JSON.stringify(after.signing.certificates),
    permissionsAdded: b.permissions.filter(p => !a.permissions.includes(p)),
    permissionsRemoved: a.permissions.filter(p => !b.permissions.includes(p)),
    sdk: { before: [a.minSdk, a.targetSdk], after: [b.minSdk, b.targetSdk] },
    application: { before: a.application, after: b.application },
    components: [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap(key =>
      JSON.stringify(previous.get(key)) === JSON.stringify(current.get(key)) ? [] : [{ key, before: previous.get(key) || null, after: current.get(key) || null }]),
    nativeAbis: { before: before.archive.nativeAbis, after: after.archive.nativeAbis },
    dexCount: { before: before.archive.dex.length, after: after.archive.dex.length }
  };
}
