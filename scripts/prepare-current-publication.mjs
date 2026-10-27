// Fallback for this authorized update when the interactive build environment is unavailable.
// It prepares an artifact only. Publishing still needs the separate request-only commit.
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync('release-config.json','utf8'));if(config.releaseVersion!=='5.51.6')throw new Error('This one-time request belongs to Fleet 5.51.6');
const sha=process.env.GITHUB_SHA,repo=process.env.GITHUB_REPOSITORY,token=process.env.GH_TOKEN;if(!/^[a-f0-9]{40}$/.test(sha||'')||!/^pavlos-argyris\/fleet-control$/.test(repo||'')||!token)throw new Error('Unexpected request context');
execFileSync('git',['checkout','-B','main',sha],{stdio:'inherit'});
let passed=false;const until=Date.now()+25*60*1000;
while(Date.now()<until){
 const response=await fetch('https://api.github.com/repos/'+repo+'/actions/runs?head_sha='+sha+'&event=push&per_page=100',{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Source CI lookup failed: '+response.status);
 const data=await response.json(),run=data.workflow_runs?.find(r=>r.name==='Check saved source'&&r.head_sha===sha);
 if(run?.status==='completed'){if(run.conclusion!=='success')throw new Error('Exact source CI did not pass');passed=true;console.log('Exact source CI passed: '+run.id);break;}
 await new Promise(r=>setTimeout(r,15000));
}
if(!passed)throw new Error('Source CI is still pending; no publication request created');
execFileSync(process.execPath,['scripts/request-publish.mjs','--publish','--reason','Εντολή χρήστη: μετά τη δημοσίευση 5.51.5 να διορθωθεί το HTTP 500 αντιγράφου προσωπικού και να δημοσιευθεί ξεχωριστή νέα έκδοση αυτόματα, με πλήρη πηγαίο κώδικα στο GitHub.'],{stdio:'inherit'});
const file='.github/fleet-publish-request.json',content=fs.readFileSync(file,'utf8'),request=JSON.parse(content);
if(request.sourceCommit!==sha||request.releaseVersion!==config.releaseVersion)throw new Error('Prepared request source mismatch');
console.log('FLEET_PREPARED_REQUEST='+JSON.stringify(request));
console.log('FLEET_REQUEST_BLOB_SHA='+execFileSync('git',['hash-object',file],{encoding:'utf8'}).trim());
