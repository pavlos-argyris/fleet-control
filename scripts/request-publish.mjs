import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { requestPath, validateRequest } from './validate-publish-request.mjs';

export function createRequest({ cwd = process.cwd(), mode, reason }) {
  if (!['verify', 'publish'].includes(mode)) throw new Error('Choose --verify or --publish explicitly');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Save all source changes in a clean Git commit before requesting publication');
  if (git('branch', '--show-current') !== 'main') throw new Error('Publication requests must be prepared on main');
  const config = JSON.parse(fs.readFileSync(path.join(cwd, 'release-config.json'), 'utf8'));
  const request = validateRequest({ schemaVersion: 1, mode, requestId: `fleet-${crypto.randomUUID()}`,
    sourceCommit: git('rev-parse', 'HEAD'), releaseVersion: config.releaseVersion,
    requestedAt: new Date().toISOString(), reason });
  fs.writeFileSync(path.join(cwd, requestPath), JSON.stringify(request, null, 2) + '\n');
  return request;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || !['--verify', '--publish'].includes(args[0]) || args[1] !== '--reason') {
      throw new Error('Usage: node scripts/request-publish.mjs --verify|--publish --reason "Explicit user instruction"');
    }
    const result = createRequest({ mode: args[0].slice(2), reason: args[2] });
    console.log(JSON.stringify({ prepared: true, mode: result.mode, sourceCommit: result.sourceCommit, requestId: result.requestId }));
    console.log(`Commit and push only ${requestPath}. GitHub will verify the pinned source CI before any publication.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
