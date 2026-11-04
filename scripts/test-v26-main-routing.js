// Real server + isolated PGlite accounts. No production credentials or database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),fixture=require('./v26-fixture.cjs');
const report=[];let current,browser;
(async()=>{
 for(const [configured,access,effective] of [['26','all','26'],['26','canary','15'],['26','off','15'],['invalid','all','15'],['15','all','15']]){
  current=await fixture({STUDYQUEST_MAIN_VERSION:configured,STUDYQUEST_V26_ACCESS:access});
  const ordinary=await current.register('qa-main-user');
  const health=await current.request('/api/health');assert.equal(health.body.mainVersion,effective);
  const anon=await current.request('/');assert.equal(anon.status,302);assert.equal(anon.location,effective==='26'?'/app.html?next=v26-main':'/app.html?next=v15-main');
  for(const cookie of [current.admin,ordinary.cookie]){
   const before=(await current.request('/api/v2/state',{},cookie)).body;
   const root=await current.request('/',{},cookie);assert.equal(root.status,200);assert.ok(root.body.includes('const STUDYQUEST_VERSION = '+effective));
   if(effective==='26'){
    assert.match(root.headers.get('cache-control'),/no-store/);
    assert.ok(root.body.includes('window.__STUDYQUEST_MULTI_ACCOUNT__=true'));
    assert.ok(!root.body.includes("location.replace('http://127.0.0.1:3000/claudever26.html')"));
   }
   const after=(await current.request('/api/v2/state',{},cookie)).body;
   delete before.serverTime;delete after.serverTime; // Response clock is not persisted account state.
   assert.deepEqual(after,before,'Opening the main route must not mutate account state');
  }
  if(access!=='off'){
   const meta=await current.request('/api/version?version=26',{},current.admin);assert.equal(meta.status,200);assert.equal(meta.body.main,effective==='26');assert.equal(meta.body.route,effective==='26'?'/':'/v26');
   const manifest=await current.request('/v26-version.json',{},current.admin);assert.equal(manifest.body.main,effective==='26');assert.equal(manifest.body.route,meta.body.route);
  }
  assert.equal((await current.request('/v15',{},ordinary.cookie)).status,200,'Explicit v15 fallback remains available');
  const stable=await current.request('/app.html?stable=1');assert.equal(stable.status,200);
  if(effective==='26'){
   const pageHtml=await current.request('/app.html');assert.ok(pageHtml.body.includes('!wantsStable && !next'));
   assert.ok(pageHtml.body.includes('next === "v26-main"'));assert.ok(pageHtml.body.includes('next === "v26"'));
   const code=await current.post('/api/admin/pairing-code',{deviceName:'Synthetic release device'},current.admin);
   const pair=await current.post('/api/sync/pair',{code:code.body.code,deviceName:'Synthetic release device'});assert.equal(pair.status,200);
   const token=pair.body.token;assert.equal((await current.request('/',{headers:{authorization:'Bearer '+token}})).status,302);
   assert.equal((await current.request('/v26',{headers:{authorization:'Bearer '+token}})).status,403);
   assert.equal((await current.request('/api/version?version=26',{headers:{authorization:'Bearer '+token}})).status,403);
   browser=await chromium.launch({channel:'chrome',headless:true});
   for(const [username,password]of [['admin',current.password],[ordinary.username,ordinary.password]]){
    const context=await browser.newContext();await context.route('**/*',r=>r.request().url().startsWith(current.origin+'/')?r.continue():r.abort());
    const page=await context.newPage();await page.goto(current.origin+'/app.html');await page.locator('#sqLoginUsername').fill(username);await page.locator('#sqLoginPassword').fill(password);await page.locator('.sq-login-card button[type=submit]').click();await page.waitForURL(current.origin+'/');
    await page.waitForFunction(()=>window.studyQuestV21Core);assert.match(await page.title(),/v26/);
    await page.goto(current.origin+'/v15');await page.waitForFunction(()=>typeof STUDYQUEST_VERSION!=='undefined'&&STUDYQUEST_VERSION===15);assert.match(await page.title(),/v15/);
    await context.close();
   }
   await browser.close();browser=null;
  }
  report.push({configured,access,effective,passed:true});await current.close();current=null;
 }
 const result={ok:true,syntheticOnly:true,report,loginMainVerified:true,explicitFallbackPreserved:true};
 fs.mkdirSync(path.join(__dirname,'../.test-artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.test-artifacts/v26-main-routing.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await current?.close();});
