import assert from 'node:assert/strict';
import {inventoryD1Source} from './d1-source-inventory.mjs';
const files=[{path:'a.js',source:"await env.DB.prepare('SELECT * FROM x').first();\n await env.DB.prepare('UPDATE x SET ok=1').run();\n await env.DB.batch([])"},{path:'b.js',source:"const foo = true"}];
const got=inventoryD1Source(files);
assert.equal(got.length,1);assert.equal(got[0].calls,3);assert.equal(got[0].prepare,2);assert.equal(got[0].batch,1);assert.deepEqual(got[0].lines,[1,2,3]);assert(got[0].readSqlHints>0);assert(got[0].writeSqlHints>0);
console.log('PASS read-only lexical inventory. Source hints are NOT actual D1 quota metrics or server authority proof.');
