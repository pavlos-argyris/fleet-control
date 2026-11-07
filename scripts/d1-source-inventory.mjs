// Offline, read-only source inventory for D1 migration planning.
// Counts lexical call sites, NOT actual executions, D1 rows or a complete dataflow audit.
import fs from 'node:fs';
import path from 'node:path';
export function inventoryD1Source(files){
 if(!Array.isArray(files))throw new TypeError('Files array required');
 const list=[];
 for(const file of files){
  const p=file.path,s=file.source;
  if(typeof p!=='string'||typeof s!=='string')throw new TypeError('Invalid source input');
  const calls=[...s.matchAll(/\bDB\s*\.\s*(prepare|batch|exec)\s*\(/g)].map(m=>({method:m[1],line:s.slice(0,m.index).split('\n').length}));
  if(!calls.length)continue;
  const readHints=(s.match(/\bSELECT\b|\bPRAGMA\b/gi)||[]).length;
  const writeHints=(s.match(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b/gi)||[]).length;
  list.push({path:p,calls:calls.length,prepare:calls.filter(c=>c.method==='prepare').length,batch:calls.filter(c=>c.method==='batch').length,exec:calls.filter(c=>c.method==='exec').length,readSqlHints:readHints,writeSqlHints:writeHints,lines:calls.map(c=>c.line)});
 }
 return list.sort((a,b)=>b.calls-a.calls||a.path.localeCompare(b.path));
}
function gather(dir,prefix=''){
 const results=[];
 for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(ent.isDirectory())results.push(...gather(path.join(dir,ent.name),prefix+ent.name+'/'));
  else if(ent.isFile()&&/\.(?:mjs|js)$/.test(ent.name))results.push({path:prefix+ent.name,source:fs.readFileSync(path.join(dir,ent.name),'utf8')});
 }
 return results;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const root=path.resolve('cloudflare-worker/src'),result=inventoryD1Source(gather(root,'cloudflare-worker/src/'));
 console.log(JSON.stringify({type:'static-lexical-d1-source-inventory',productionRowsMeasured:false,authorityProven:false,generatedFrom:'checked-out source',fileCount:result.length,files:result},null,2));
}
