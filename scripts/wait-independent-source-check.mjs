// Read-only GitHub gate; no Cloudflare credentials/resources or publish-request fallback.
const repository=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA,token=process.env.GH_TOKEN;
if(!repository||!sha||!token)throw Error('Exact repository/source/token are required');
const started=Date.now(),limit=35*60*1000;
while(Date.now()-started<limit){
 const response=await fetch('https://api.github.com/repos/'+repository+'/actions/workflows/check.yml/runs?head_sha='+sha+'&per_page=30',{headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'}});
 if(!response.ok)throw Error('Cannot verify exact saved-source CI: HTTP '+response.status);
 const {workflow_runs:runs}=await response.json(),matching=runs.filter(run=>run.head_sha===sha&&run.event==='pull_request').sort((a,b)=>b.id-a.id),run=matching[0];
 if(run?.status==='completed'){
  if(run.conclusion!=='success')throw Error('Exact Check saved source did not succeed: '+run.html_url+' ('+run.conclusion+')');
  console.log('Verified exact Check saved source: '+run.html_url+' source '+sha);process.exit(0);
 }
 console.log('Waiting for exact saved-source CI for '+sha+'; test delivery has not been published.');await new Promise(resolve=>setTimeout(resolve,30000));
}
throw Error('Exact saved-source CI is still pending; no signed test release published.');
