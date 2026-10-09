import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const requestPath = '.github/fleet-publish-request.json';
const shaPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const requireValue = (value, message) => { if (!value) throw new Error(message); };
export function validateRequest(request) {
  requireValue(request && request.schemaVersion === 1, 'Unsupported publication request schema');
  requireValue(['disabled', 'verify', 'publish'].includes(request.mode), 'Unsupported publication mode');
  const fields = request.mode === 'disabled' ? ['schemaVersion', 'mode'] :
    ['schemaVersion', 'mode', 'requestId', 'sourceCommit', 'releaseVersion', 'requestedAt', 'reason'];
  requireValue(Object.keys(request).length === fields.length && fields.every(key => Object.hasOwn(request, key)), 'Unexpected or missing request fields');
  if (request.mode === 'disabled') return request;
  requireValue(typeof request.requestId === 'string' && /^[a-z0-9][a-z0-9-]{7,79}$/.test(request.requestId), 'Invalid publication request ID');
  requireValue(typeof request.sourceCommit === 'string' && shaPattern.test(request.sourceCommit), 'Invalid source commit');
  requireValue(typeof request.releaseVersion === 'string' && versionPattern.test(request.releaseVersion), 'Invalid release version');
  requireValue(typeof request.requestedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.requestedAt) &&
    Number.isFinite(Date.parse(request.requestedAt)) && new Date(request.requestedAt).toISOString() === request.requestedAt, 'Invalid request timestamp');
  requireValue(typeof request.reason === 'string' && request.reason.trim().length > 0 && request.reason.length <= 500 && !/[\u0000-\u001f\u007f]/.test(request.reason), 'A printable user instruction is required');
  return request;
}

export function assertSourceCI(runs, sourceCommit) {
  requireValue(Array.isArray(runs), 'Invalid source CI response');
  const matches = runs.filter(run => run.path === '.github/workflows/check.yml' && run.event === 'push' &&
    run.head_branch === 'main' && run.head_sha === sourceCommit).sort((a, b) => Number(b.id) - Number(a.id));
  requireValue(matches.length && matches[0].status === 'completed' && matches[0].conclusion === 'success',
    'The latest Check saved source run for the pinned main commit must succeed before publication');
  return matches[0].id;
}

export async function planPublication({ eventName, ref, sha, event = {}, cwd = process.cwd(), getRuns }) {
  requireValue(shaPattern.test(sha || ''), 'Invalid workflow commit');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  requireValue(git('rev-parse', 'HEAD') === sha, 'Workflow checkout does not match the event commit');
  const configAt = commit => JSON.parse(git('show', `${commit}:release-config.json`));
  if (eventName === 'workflow_dispatch' || (eventName === 'push' && ref.startsWith('refs/tags/fleet-v'))) {
    const config = configAt(sha);
    requireValue(versionPattern.test(config.releaseVersion || ''), 'Invalid configured release version');
    if (eventName === 'push') requireValue(ref === `refs/tags/fleet-v${config.releaseVersion}`, 'Tag does not match the configured release version');
    return { mode: 'publish', sourceCommit: sha, publish: true };
  }
  requireValue(eventName === 'push' && ref === 'refs/heads/main' && event.after === sha && !event.deleted && !event.forced,
    'Only a normal main push can submit an automatic publication request');
  const request = validateRequest(JSON.parse(fs.readFileSync(path.join(cwd, requestPath), 'utf8')));
  if (request.mode === 'disabled') return { mode: 'disabled', sourceCommit: sha, publish: false };
  const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  requireValue(parents.length === 1 && parents[0] === request.sourceCommit && event.before === request.sourceCommit,
    'Publication request must be a separate commit immediately after its pinned source');
  const changed = git('diff', '--name-only', request.sourceCommit, sha).split('\n');
  requireValue(changed.length === 1 && changed[0] === requestPath, 'Commit only the publication request; save and check source changes first');
  requireValue(configAt(request.sourceCommit).releaseVersion === request.releaseVersion, 'Requested version differs from the pinned source');
  requireValue(typeof getRuns === 'function', 'Source CI verification is required');
  const checkRun = assertSourceCI(await getRuns(request.sourceCommit), request.sourceCommit);
  return { mode: request.mode, sourceCommit: request.sourceCommit, publish: request.mode === 'publish', requestId: request.requestId, checkRun };
}

async function main() {
  const getRuns = async sourceCommit => {
    const repository = process.env.GITHUB_REPOSITORY;
    requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') && process.env.GH_TOKEN, 'GitHub source CI access is required');
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${sourceCommit}&event=push&per_page=100`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000),
    });
    requireValue(response.ok, `Could not verify source CI (HTTP ${response.status})`);
    return (await response.json()).workflow_runs;
  };
  const result = await planPublication({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA, event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), getRuns });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `source_commit=${result.sourceCommit}\npublish=${result.publish}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Publication mode: **${result.mode}**\n\nPinned source: \`${result.sourceCommit}\`\n\n${result.publish ? 'Production publication authorized by this explicit request.' : 'Validation only. Production publication skipped.'}\n`);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
