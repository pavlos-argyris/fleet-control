import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {directTransport} from './fixtures/direct-transport.mjs';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright'),root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/client-landscape');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
try{for(const [mode,width,height]of[['desktop',1440,1000],['mobile',390,844],['client-landscape',1024,700]]){
 const transport=directTransport(),context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];let offline=false;
 page.on('pageerror',error=>errors.push(error.message));
 await context.addInitScript(()=>localStorage.setItem('fleet-control-auth-token','normal-cloud-token'));
 await context.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());if(url.protocol==='file:')return route.continue();if(url.pathname==='/api/direct/request'){
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST,OPTIONS'};if(r.method()==='OPTIONS')return route.fulfill({status:204,headers});
  assert.equal(r.headers()['x-fleet-direct-key'],transport.routingKey);const packet=r.postDataJSON(),clear=transport.open(packet);requests.push(clear);assert.ok(!r.postData().includes('Synthetic direct password'));
  if(offline)return route.fulfill({status:503,headers,json:{error:'Συνθετικός Server εκτός σύνδεσης'}});
  const base={user:{name:'Συνθετικός διαχειριστής'},snapshotAt:'2026-10-30T10:00:00Z',readOnly:true};let data;
  if(clear.path.endsWith('/login')){assert.equal(clear.body.password,'Synthetic direct password');data={...base,token:'b'.repeat(43)};}
  else{assert.equal(clear.headers.Authorization,'Bearer '+'b'.repeat(43));if(clear.path.endsWith('/me'))data={...base,views:['fleet','employees']};else if(clear.path.endsWith('/logout'))data={loggedOut:true};else{const offset=clear.body?.offset||0;data={...base,rows:Array.from({length:55},(_,i)=>({id:'bike-'+i,name:i===0?'<img src=x onerror=alert(1)>':'Συνθετικό μηχανάκι '+(i+1),currentKm:12000+i})).slice(offset,offset+50),offset,total:55,hasMore:offset<50};}}
  return route.fulfill({headers,json:transport.seal(packet,{status:200,body:JSON.stringify(data)})});
 }
 const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});});
 try{
  const target=mode==='client-landscape'?'file://'+path.resolve('client-android/assets/www/direct.html'):'https://fixture.invalid/direct.html';
  await page.goto(target+'#pair='+transport.code);await page.locator('#directPair').waitFor();assert.equal(await page.locator('#directPair').inputValue(),transport.code);
  assert.equal(await page.evaluate(()=>location.hash),'');await page.locator('#directUsername').fill('owner');await page.locator('#directPassword').fill('Synthetic direct password');await page.locator('#directLoginButton').click();
  await page.locator('.direct-record').first().waitFor();assert.equal(await page.locator('.direct-record').count(),50);assert.equal(await page.locator('#directRows img').count(),0);assert.equal(await page.locator('#directPassword').inputValue(),'');assert.match(await page.locator('#directWorkspace').textContent(),/Μόνο προβολή/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'responsive direct view has no horizontal overflow');await page.screenshot({path:path.join(output,'direct-'+mode+'.png')});
  await page.locator('#directNext').click();await page.waitForFunction(()=>document.getElementById('directRows').children.length===5);assert.equal(await page.locator('#directNext').isDisabled(),true);
  await page.locator('#directLogout').click();await page.locator('#directLogin').waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('directRows').children.length===0);assert.equal(await page.evaluate(()=>localStorage.getItem('fleet-control-auth-token')),'normal-cloud-token');
  await page.waitForTimeout(100);offline=true;const before=requests.length;await page.locator('#directPair').fill(transport.code);await page.locator('#directPassword').fill('Synthetic direct password');await page.locator('#directLoginButton').click();await page.locator('#directError').filter({hasText:'εκτός σύνδεσης'}).waitFor();assert.equal(requests.length,before+1);assert.deepEqual(errors,[]);
  console.log('PASS direct browser '+mode+': real WebCrypto, opaque relay, pinned identity, local session isolation, safe responsive views, pagination/logout and offline failure.');
 }catch(error){await page.screenshot({path:path.join(output,'direct-'+mode+'-FAILURE.png')});throw error;}finally{await context.close();}
}}finally{await browser.close();}
