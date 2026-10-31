// Synthetic accounts and disposable persistent Chrome profiles only.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
let source=fs.readFileSync(path.join(__dirname,'test-v24-save-failures.js'),'utf8');
source=source.slice(0,source.indexOf('const results=[];'))
 .replace("let mode='local'","let activeVersion=25,fixtureUsername='qa-display-a';\nlet mode='local'")
 .replace("if(url.pathname==='/v24')filename='claudever24.html';","if(['/v24','/v25'].includes(url.pathname))filename='claudever'+url.pathname.slice(2)+'.html';")
 .replace("filename==='claudever24.html' && mode==='hosted'","/^claudever(?:24|25)\\.html$/.test(filename) && mode==='hosted'")
 .replaceAll('{username:"qa-safety"}',"' + JSON.stringify({username:fixtureUsername}) + '")
 .replace("user:{username:'qa-safety'}","user:{username:fixtureUsername}")
 .replace("mode==='hosted'?'/v24':'/claudever24.html'","mode==='hosted'?'/v'+activeVersion:'/claudever'+activeVersion+'.html'")
 .replace("res.setHeader('content-type',filename", "if(mode==='local' && /^claudever(?:24|25)\\.html$/.test(filename))body=body.replace('</head>','<link rel=\"stylesheet\" href=\"/studyquest-device-date-shifts.css\"></head>').replace('</body>','<script src=\"/studyquest-device-date-shifts.js\"></script></body>');\n  res.setHeader('content-type',filename")
 .replace('safety-transfer-2026-10-08','safety-v25-display-size-2026-10-17');
source+=`
const output=process.env.STUDYQUEST_DISPLAY_OUTPUT || artifacts;fs.mkdirSync(output,{recursive:true});
const report={checks:[],matrix:[],productionRequests:0,ok:false};
const prefKey=page=>page.evaluate(()=>'studyquest_v25_device_display_v1:'+encodeURIComponent(studyQuestV21Core.accountKey().trim().toLowerCase()));
async function ready(page){await page.waitForTimeout(800);await page.evaluate(()=>{for(const overlay of document.querySelectorAll('.modal-overlay.open'))closeModal(overlay.id);});}
async function settings(page){await ready(page);await page.locator('#profileBtn').click();await page.locator('#v25DeviceDisplaySettings').waitFor({state:'visible'});}
async function choose(page,value){await page.locator('#v25DeviceDisplaySize').selectOption(String(value));await page.waitForTimeout(60);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),String(value));assert.equal(await page.evaluate(()=>Number(document.documentElement.style.zoom || 1)),value/100);}
async function fit(page,label){const geometry=await page.evaluate(()=>{const r=document.querySelector('.modal-overlay.open .modal').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};});assert.ok(geometry.x>=-1 && geometry.y>=-1 && geometry.right<=geometry.width+1 && geometry.bottom<=geometry.height+1,label+' dialog must fit '+JSON.stringify(geometry));return geometry;}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));loopback='http://127.0.0.1:'+server.address().port;
 for(const runtime of ['local','hosted']){
  mode=runtime;activeVersion=25;fixtureUsername='qa-display-a';origin=runtime==='local'?loopback:'https://studyquest-display-fixture.onrender.com';
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-device-display-'));await launch();let page=await open();await reset(page,71);await settings(page);
  const key=await prefKey(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'100');
  const expected=await page.evaluate(()=>cloneV20CloudState(state)),beforeBundle=await bundle(page),start=control.requests.length;
  for(const [width,height]of [[1440,1000],[820,1180],[390,844]]){
   await page.setViewportSize({width,height});
   for(const value of [75,80,90,100,110,125]){await choose(page,value);const geometry=await fit(page,runtime+' '+width+' '+value);report.matrix.push({runtime,width,value,geometry});assert.match(await page.locator('#v25DeviceDisplayStatus').innerText(),/remembered/);await page.evaluate(()=>{closeModal('profileSettingsModal');openCreateTask();});await page.waitForTimeout(220);await fit(page,'Task editor '+runtime+' '+width+' '+value);await page.locator('#taskName').fill('Unsubmitted display test');await page.evaluate(()=>{closeModal('taskModal');openProfileSettings();});}
   await page.locator('#v25DeviceDisplayReset').click();assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'100');
  }
  assert.deepEqual(await page.evaluate(()=>cloneV20CloudState(state)),expected,'Display changes cannot modify any account data');
  assert.deepEqual((await bundle(page)).outbox,beforeBundle.outbox,'Display changes cannot modify pending work');
  assert.equal(control.requests.slice(start).some(r=>r.method==='POST' && ['/api/state','/api/live-state','/api/v2/state'].includes(r.path)),false,'Display choices cannot trigger account/device saves');
  report.checks.push(runtime+': all sizes, responsive dialogs, reset and zero state writes');
  await page.setViewportSize({width:1440,height:1000});await choose(page,90);await page.evaluate(()=>closeModal('profileSettingsModal'));await page.reload();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'90');
  await page.screenshot({path:path.join(output,runtime+'-display-settings.png')});
  await page.evaluate(()=>closeModal('profileSettingsModal'));activeVersion=24;await page.goto(origin+(runtime==='local'?'/claudever24.html':'/v24'));await ready(page);assert.equal(await page.locator('#v25DeviceDisplaySettings').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.style.zoom),'');
  activeVersion=25;page=await open();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'90');report.checks.push(runtime+': reload and v25-v24-v25 preserve preference without changing v24');
  if(runtime==='hosted'){
   fixtureUsername='qa-display-b';const b=await open();await settings(b);assert.equal(await b.locator('#v25DeviceDisplaySize').inputValue(),'100');await choose(b,110);await b.close();fixtureUsername='qa-display-a';await page.reload();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'90');report.checks.push('hosted: account preferences isolated');
  }
  const sibling=await open();await settings(sibling);await choose(page,110);await sibling.waitForFunction(()=>document.getElementById('v25DeviceDisplaySize').value==='110');await sibling.close();await choose(page,90);report.checks.push(runtime+': same-account tabs update their display preference');
  // A pending edit must survive a display-size choice with identical lineage.
  const seed=await reset(page,72);control.offline=true;const pending=await commit(page,mutate(seed,'Pending while changing display'));await settings(page);await choose(page,80);const durable=await bundle(page);assert.equal(durable.outbox.lineage.mutationId,pending.mutationId);assert.deepEqual(durable.outbox.state,pending.state);report.checks.push(runtime+': pending outbox unchanged');
  const savedProfile=profile;await stopChrome();await launch();page=await open();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'80');assert.equal((await bundle(page)).outbox.lineage.mutationId,pending.mutationId);report.checks.push(runtime+': persistent-profile restart retains size and pending edit');
  await stopChrome();profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-other-display-device-'));await launch();page=await open();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'100');await stopChrome();profile=savedProfile;await launch();page=await open();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'80');report.checks.push(runtime+': different device has independent size');
  await page.evaluate(key=>localStorage.setItem(key,'9999'),key);await page.reload();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'100');
  await page.evaluate(()=>{window.__displaySet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('studyquest_v25_device_display_v1:'))throw new DOMException('Synthetic full storage','QuotaExceededError');return window.__displaySet.call(this,k,v);};});
  await choose(page,75);assert.match(await page.locator('#v25DeviceDisplayStatus').innerText(),/visit only/);assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),'9999');report.checks.push(runtime+': malformed value defaults safely; quota failure is not falsely remembered');
  await page.evaluate(()=>{Storage.prototype.setItem=window.__displaySet;window.__displayGet=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k.startsWith('studyquest_v25_device_display_v1:'))throw new DOMException('Synthetic storage blocked','SecurityError');return window.__displayGet.call(this,k);};});await page.evaluate(key=>window.dispatchEvent(new StorageEvent('storage',{key})),key);assert.equal(await page.locator('#v25DeviceDisplaySize').inputValue(),'100');assert.match(await page.locator('#v25DeviceDisplayStatus').innerText(),/could not read/);report.checks.push(runtime+': blocked preference reads default safely');
  await context.addInitScript(()=>{const supports=CSS.supports.bind(CSS);CSS.supports=(property,value)=>property==='zoom'?false:supports(property,value);});await page.reload();await settings(page);assert.equal(await page.locator('#v25DeviceDisplaySize').isDisabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.style.zoom),'');assert.match(await page.locator('#v25DeviceDisplayStatus').innerText(),/cannot apply/);report.checks.push(runtime+': unsupported browser keeps normal display');
  await stopChrome();
 }
 report.ok=true;fs.writeFileSync(path.join(output,'display-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,checks:report.checks,matrixCases:report.matrix.length}));
})().catch(error=>{report.error=String(error.stack);fs.writeFileSync(path.join(output,'display-test.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(async()=>{await stopChrome();server.close();});
`;
const test=new Module(__filename,module);test.filename=__filename;test.paths=module.paths;test._compile(source,__filename);
