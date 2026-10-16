const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),fixture=require('./v25-fixture.cjs');
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/v25-version.json'),'utf8'));
const report=[];let current,browser;
(async()=>{
 for(const mode of ['default','invalid','off','canary','all']){
  current=await fixture({...mode==='default'?{}:{STUDYQUEST_V25_ACCESS:mode},STUDYQUEST_V25_CANARY_USERS:'  QA-CANARY  '});
  const ordinary=await current.register('qa-ordinary'),canary=await current.register('qa-canary');
  const off=['default','invalid','off'].includes(mode);
  const code=await current.post('/api/admin/pairing-code',{deviceName:'Synthetic device'},current.admin);
  const paired=await current.post('/api/sync/pair',{code:code.body.code,deviceName:'Synthetic device'});assert.equal(paired.status,200);
  for(const route of ['/v25','/claudever25.html','/v25-version.json','/api/version?version=25']){
   assert.equal((await current.request(route)).status,off?404:route.startsWith('/api/')?401:302);
   assert.equal((await current.request(route,{},current.admin)).status,off?404:200);
   assert.equal((await current.request(route,{},canary.cookie)).status,off?404:200);
   assert.equal((await current.request(route,{},ordinary.cookie)).status,off?404:mode==='all'?200:403);
   assert.equal((await current.request(route,{headers:{authorization:'Bearer '+paired.body.token}})).status,off?404:403,'Device token cannot open v25 or read its version metadata');
  }
  for(const [file,hash]of Object.entries(manifest.assets)){
   const result=await current.request('/'+file,{},current.admin);assert.equal(result.status,off?404:200,file);
   assert.equal((await current.request('/'+file,{},ordinary.cookie)).status,off?404:mode==='all'?200:403,file);
   assert.equal((await current.request('/'+file,{headers:{authorization:'Bearer '+paired.body.token}})).status,off?404:403,file);
   if(!off)assert.equal(crypto.createHash('sha256').update(result.body).digest('hex'),hash,file);
  }
  assert.equal((await current.request('/v24',{},current.admin)).status,404,'V25 does not enable v24');
  assert.ok((await current.request('/',{},current.admin)).body.includes('STUDYQUEST_VERSION = 15'));
  assert.equal((await current.request('/app.html?stable=1',{},current.admin)).body.includes('next === "v25"'),false);
  assert.ok((await current.request('/app.html?next=v25')).body.includes('next === "v25"'));
  assert.equal((await current.request('/api/v2/state',{},ordinary.cookie)).body.state?.tasks?.length || 0,0);
  if(mode==='all'){
   browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext();
   const hosted='https://studyquest-v25-access.onrender.com';
   const traffic=[],errors=[];
   await context.route('**/*',async route=>{
    if(!route.request().url().startsWith(hosted+'/'))return route.abort();
    const url=new URL(route.request().url());const res=await fetch(current.origin+url.pathname+url.search,{method:route.request().method(),headers:{origin:current.origin,'content-type':route.request().headers()['content-type']||'application/json',...(route.request().headers().cookie?{cookie:route.request().headers().cookie}:{})},body:route.request().postDataBuffer()||undefined,redirect:'manual'});traffic.push({path:url.pathname,status:res.status});
    const headers={'content-type':res.headers.get('content-type')||'text/plain'};
    for(const name of ['set-cookie','location','cache-control'])if(res.headers.get(name))headers[name]=res.headers.get(name);
    await route.fulfill({status:res.status,headers,body:Buffer.from(await res.arrayBuffer())});
   });
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(hosted+'/app.html?next=v25');
   await page.locator('#sqLoginUsername').waitFor({timeout:10000}).catch(async error=>{console.error(JSON.stringify({url:page.url(),errors,traffic,body:(await page.locator('body').innerText()).slice(0,500)}));throw error;});
   await page.locator('#sqLoginUsername').fill('qa-ordinary');await page.locator('#sqLoginPassword').fill(ordinary.password);await page.locator('.sq-login-card button[type=submit]').click();await page.waitForURL(hosted+'/v25');
   await page.waitForFunction(()=>window.studyQuestV21Core);assert.equal(await page.evaluate(()=>window.__STUDYQUEST_AUTH_USER__.username),'qa-ordinary');
   const failures=[];page.on('pageerror',e=>failures.push(e.message));await page.reload();await page.waitForFunction(()=>window.studyQuestV21Core);assert.deepEqual(failures,[]);
   await browser.close();browser=null;
  }
  report.push({mode,assets:Object.keys(manifest.assets).length,passed:true});await current.close();current=null;
 }
 // A v24 session may still load immutable code when v25 is off.
 current=await fixture({STUDYQUEST_V25_ACCESS:'off',STUDYQUEST_V24_ACCESS:'all'});assert.equal((await current.request('/'+Object.keys(manifest.assets)[0],{},current.admin)).status,200);assert.equal((await current.request('/v24',{},current.admin)).status,200);
 console.log(JSON.stringify({ok:true,report,loginReturnVerified:true,deviceTokensRejected:true,sharedAssetUnionVerified:true,mainStill15:true}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await current?.close();});
