#!/usr/bin/env node
// Maintained human-reviewed ownership map. This CLI suggests targeted tests;
// it NEVER replaces required full source CI or controls publication.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapFile = path.join(root, 'docs/CODE_MAP.json');
const inventory = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const inventorySet = new Set(inventory);
const doc = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternRx = pattern => new RegExp('^' + pattern.split('*').map(escapeRx).join('.*') + '$');
function matches(file, rule) {
  return rule.endsWith('/') ? file.startsWith(rule) : patternRx(rule).test(file);
}
function expand(rule) { return inventory.filter(file => matches(file, rule)); }
function validate() {
  const errors = [], ids = new Set();
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.modules) || !doc.modules.length) {
    throw Error('Invalid code-map schema');
  }
  for (const mod of doc.modules) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mod.id || '') || ids.has(mod.id)) {
      errors.push('Duplicate or invalid module id: ' + mod.id);
    }
    ids.add(mod.id);
    if (!mod.title || !mod.paths?.length || !mod.tests?.length) errors.push('Incomplete map: ' + mod.id);
    for (const rule of [...(mod.paths || []), ...(mod.tests || [])]) {
      if (rule.startsWith('/') || rule.includes('..') || rule.includes('\\') || !expand(rule).length)
        errors.push(mod.id + ': stale or unsafe mapping ' + rule);
    }
    for (const rule of mod.tests || []) {
      if (!rule.startsWith('scripts/test-')) errors.push(mod.id + ': test is not a test script: ' + rule);
    }
    for (const file of mod.docs || []) if (!inventorySet.has(file)) errors.push(mod.id + ': missing guide ' + file);
  }
  for (const mod of doc.modules) {
    for (const rel of mod.related || []) if (rel === mod.id || !ids.has(rel))
      errors.push(mod.id + ': invalid related module ' + rel);
  }
  if (errors.length) throw Error('Code map validation failed:\n' + errors.map(s => ' - ' + s).join('\n'));
  console.log('PASS code map: ' + doc.modules.length + ' modules, source patterns and test references verified.');
}
validate();

const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === '--check')) process.exit(0);
let changed;
if (args.length === 2 && args[0] === '--base') {
  const base = args[1];
  if (!/^[A-Za-z0-9_./-]+$/.test(base) || base.startsWith('-')) throw Error('Unsafe base ref');
  changed = execFileSync('git', ['diff', '--name-only', '-z', base + '...HEAD'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
} else if (args[0] === '--paths' && args.length > 1) {
  changed = args.slice(1);
} else {
  throw Error('Usage: node scripts/code-map.mjs [--check | --base origin/main | --paths PATH ...]');
}
if (!changed.length) { console.log('No changed paths.'); process.exit(0); }
const affected = doc.modules.filter(mod => changed.some(file => mod.paths.some(rule => matches(file, rule))));
const unknown = changed.filter(file => !affected.some(mod => mod.paths.some(rule => matches(file, rule))));
console.log('Changed paths: ' + changed.length + ' | relevant map sections: ' + affected.length);
const tests = new Set();
for (const mod of affected) {
  console.log('\n[' + mod.id + '] ' + mod.title);
  for (const rule of mod.tests) for (const file of expand(rule)) tests.add(file);
  if (mod.related?.length) console.log('Also inspect interfaces: ' + mod.related.join(', '));
  for (const guide of mod.docs || []) console.log('Guide: ' + guide);
}
if (tests.size) console.log('\nSuggested targeted tests (run in a suitable prepared environment):\n' +
  [...tests].sort().map(s => '  node ' + s).join('\n'));
if (unknown.length) console.log('\nUNMAPPED paths (inspect and update docs/CODE_MAP.json if business logic changed):\n' +
  unknown.map(s => '  ' + s).join('\n'));
console.log('\nRequired before merge/release: full check.yml and exact-source publish verification, regardless of suggestions.');
