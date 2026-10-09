import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestPath, validateRequest, assertSourceCI, planPublication } from './validate-publish-request.mjs';
import { createRequest } from './request-publish.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-publication-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fleet test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(cwd, '.github'));
  fs.writeFileSync(path.join(cwd, requestPath), JSON.stringify({ schemaVersion: 1, mode: 'disabled' }));
  fs.writeFileSync(path.join(cwd, 'release-config.json'), JSON.stringify({ releaseVersion: '5.37.2' }));
  fs.writeFileSync(path.join(cwd, 'app.txt'), 'tested source');
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  const source = commit();
  const runs = [{ id: 10, path: '.github/workflows/check.yml', event: 'push', head_branch: 'main', head_sha: source, status: 'completed', conclusion: 'success' }];
  const request = mode => createRequest({ cwd, mode, reason: 'User requests publication' });
  const context = sha => ({ cwd, eventName: 'push', ref: 'refs/heads/main', sha,
    event: { before: source, after: sha }, getRuns: async pinned => { assert.equal(pinned, source); return runs; } });
  return { cwd, git, source, runs, request, commit, context };
}

for (const mode of ['verify', 'publish']) test(`${mode} request pins tested source and controls deployment`, async t => {
  const f = fixture(t), request = f.request(mode), sha = f.commit();
  const result = await planPublication(f.context(sha));
  assert.equal(result.sourceCommit, f.source);
  assert.equal(result.publish, mode === 'publish');
  assert.equal(result.checkRun, 10);
  assert.equal(result.requestId, request.requestId);
});

test('disabled initial request never calls CI or publishes', async t => {
  const f = fixture(t), context = f.context(f.source);
  context.getRuns = () => { throw new Error('must not call'); };
  assert.equal((await planPublication(context)).publish, false);
});
test('source edits mixed into request are rejected', async t => {
  const f = fixture(t); f.request('publish');
  fs.writeFileSync(path.join(f.cwd, 'app.txt'), 'unchecked change');
  await assert.rejects(planPublication(f.context(f.commit())), /Commit only the publication request/);
});
test('stale source request is rejected after a newer source commit', async t => {
  const f = fixture(t), request = f.request('publish');
  f.git('checkout', '--', requestPath);
  fs.writeFileSync(path.join(f.cwd, 'app.txt'), 'new source'); const newer = f.commit();
  fs.writeFileSync(path.join(f.cwd, requestPath), JSON.stringify(request));
  const context = f.context(f.commit()); context.event.before = newer;
  await assert.rejects(planPublication(context), /separate commit/);
});
test('request version must match pinned release configuration', async t => {
  const f = fixture(t), request = f.request('publish'); request.releaseVersion = '9.0.0';
  fs.writeFileSync(path.join(f.cwd, requestPath), JSON.stringify(request));
  await assert.rejects(planPublication(f.context(f.commit())), /version differs/);
});
test('missing successful CI blocks production', async t => {
  const f = fixture(t); f.request('publish'); f.runs.length = 0;
  await assert.rejects(planPublication(f.context(f.commit())), /must succeed/);
});
for (const [name, change] of [
  ['wrong branch', c => { c.ref = 'refs/heads/dev'; }],
  ['force push', c => { c.event.forced = true; }],
  ['deleted branch', c => { c.event.deleted = true; }],
  ['batched push', c => { c.event.before = 'a'.repeat(40); }],
  ['wrong event SHA', c => { c.event.after = 'a'.repeat(40); }],
  ['pull request event', c => { c.eventName = 'pull_request'; }],
  ['wrong checkout', c => { c.sha = 'a'.repeat(40); }],
]) test(`${name} cannot trigger automatic publication`, async t => {
  const f = fixture(t); f.request('publish'); const context = f.context(f.commit()); change(context);
  await assert.rejects(planPublication(context));
});
test('unrelated successful CI does not authorize source', t => {
  const f = fixture(t), run = f.runs[0];
  for (const change of [{ head_sha: 'a'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'dev' }, { path: '.github/workflows/release.yml' }]) {
    assert.throws(() => assertSourceCI([{ ...run, ...change }], f.source), /must succeed/);
  }
});
for (const state of [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'cancelled' }]) {
  test(`latest CI ${state.status}/${state.conclusion} overrides older success`, t => {
    const f = fixture(t);
    assert.throws(() => assertSourceCI([f.runs[0], { ...f.runs[0], id: 11, ...state }], f.source), /must succeed/);
  });
}
test('successful rerun of latest source run is accepted', t => {
  const f = fixture(t);
  assert.equal(assertSourceCI([{ ...f.runs[0], id: 9, conclusion: 'failure' }, f.runs[0]], f.source), 10);
});
for (const change of [
  { schemaVersion: 2 }, { mode: 'automatic' }, { requestId: 'unsafe\npublish=true' },
  { sourceCommit: 'HEAD' }, { releaseVersion: '1.2.3\npublish=true' }, { requestedAt: '2026-02-30T12:00:00.000Z' },
  { reason: '' }, { reason: 'line\ncontrol' }, { unexpected: true },
]) test(`invalid request field ${Object.keys(change)[0]} is rejected`, t => {
  const f = fixture(t), request = f.request('verify');
  assert.throws(() => validateRequest({ ...request, ...change }));
});
test('generator refuses unsaved tracked and untracked source', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, 'untracked.txt'), 'new source');
  assert.throws(() => f.request('publish'), /clean Git commit/);
  fs.unlinkSync(path.join(f.cwd, 'untracked.txt'));
  fs.writeFileSync(path.join(f.cwd, 'app.txt'), 'dirty source');
  assert.throws(() => f.request('publish'), /clean Git commit/);
});
test('generator requires main and an explicit mode', t => {
  const f = fixture(t); assert.throws(() => f.request('automatic'), /explicitly/);
  f.git('checkout', '-b', 'dev'); assert.throws(() => f.request('publish'), /main/);
});
test('manual and matching tag retain explicit publication route', async t => {
  const f = fixture(t);
  const manual = await planPublication({ ...f.context(f.source), eventName: 'workflow_dispatch' });
  const tag = await planPublication({ ...f.context(f.source), ref: 'refs/tags/fleet-v5.37.2' });
  assert.equal(manual.publish, true); assert.equal(tag.sourceCommit, f.source);
  await assert.rejects(planPublication({ ...f.context(f.source), ref: 'refs/tags/fleet-v5.37.1' }), /Tag does not match/);
});
test('production checkout is pinned and verification runs without deployment credentials', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const gate = workflow.slice(workflow.indexOf('  request:'), workflow.indexOf('  publish:'));
  assert.doesNotMatch(gate, /secrets\.|contents: write/);
  assert.match(workflow, /paths: \['\.github\/fleet-publish-request\.json'\]/);
  assert.match(workflow, /if: needs\.request\.outputs\.publish == 'true'/);
  assert.match(workflow, /ref: \$\{\{ needs\.request\.outputs\.source_commit \}\}/);
});
