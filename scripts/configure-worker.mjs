import fs from 'node:fs';
const example=JSON.parse(fs.readFileSync('cloudflare-worker/wrangler.example.jsonc','utf8'));
if(example.main!=='src/redirect.js'||['d1_databases','r2_buckets','durable_objects','ai','assets'].some(k=>k in example)||JSON.stringify(example.triggers)!==JSON.stringify({crons:[]})||example.migrations.some(m=>Object.keys(m).some(k=>k!=='tag'&&k!=='new_sqlite_classes')))throw Error('Expected redirect-only configuration with preserved historical migration and no scheduled jobs');
example.name=process.env.FLEET_WORKER_NAME||example.name;
if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(example.name))throw Error('Unexpected Worker name');
fs.writeFileSync('cloudflare-worker/wrangler.jsonc',JSON.stringify(example,null,2)+'\n');
console.log('Configured the redirect-only Worker; historical storage remains without active bindings.');
