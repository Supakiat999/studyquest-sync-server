// Reuse the frozen synthetic harness plumbing and the actual client functions.
// Keep both pages on one disposable persistent profile, never a real profile.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
let source=fs.readFileSync(path.join(__dirname,'test-v24-save-failures.js'),'utf8');
source=source.slice(0,source.indexOf('const results=[];'));
source=source.replace("let mode='local'","let activeVersion=24,fixtureUsername='qa-safety';\nlet mode='local'")
 .replace("if(url.pathname==='/v24')filename='claudever24.html';","if(['/v24','/v25'].includes(url.pathname))filename='claudever'+url.pathname.slice(2)+'.html';")
 .replace("filename==='claudever24.html' && mode==='hosted'","/^claudever(?:24|25)\\.html$/.test(filename) && mode==='hosted'")
 .replaceAll('{username:"qa-safety"}',"' + JSON.stringify({username:fixtureUsername}) + '")
 .replace("user:{username:'qa-safety'}","user:{username:fixtureUsername}")
 .replace("mode==='hosted'?'/v24':'/claudever24.html'","mode==='hosted'?'/v'+activeVersion:'/claudever'+activeVersion+'.html'")
 .replace("res.setHeader('content-type',filename", "if(mode==='local' && /^claudever(?:24|25)\\.html$/.test(filename))body=body.replace('</head>','<link rel=\"stylesheet\" href=\"/studyquest-device-date-shifts.css?v=4\"></head>').replace('</body>','<script src=\"/studyquest-device-date-shifts.js?v=3\"></script></body>');\n  res.setHeader('content-type',filename")
 .replace('safety-transfer-2026-10-08','safety-v25-2026-10-14')
 .replaceAll("date:'2026-10-08'","date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date())");
source+=`
const report=[];
const full=page=>page.evaluate(()=>cloneV20CloudState(state));
const ui=async page=>{await page.evaluate(()=>{activeFilter='all';activeCatFilter=null;renderAll();activateStudyQuestTab('tasks');});await page.waitForTimeout(150);return page.evaluate(()=>({tasks:[...document.querySelectorAll('.task-item')].map(el=>({text:el.innerText.replaceAll('v24','v25'),width:Math.round(el.getBoundingClientRect().width),height:Math.round(el.getBoundingClientRect().height)})),controls:document.querySelectorAll('.sq-date-shift-inline-row').length,overflow:document.documentElement.scrollWidth>innerWidth}));};
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));loopback='http://127.0.0.1:'+server.address().port;
 for(const runtime of ['local','hosted']){
  mode=runtime;fixtureUsername='qa-safety';activeVersion=24;origin=runtime==='local'?loopback:'https://studyquest-continuity-fixture.onrender.com';
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-v25-continuity-'));await launch();let page=await open();
  const initial=await reset(page,25);control.offline=true;
  const pending=await commit(page,mutate(initial,'Pending from v24'),1000);const expected=pending.state;
  for(const version of [25,24]){
   activeVersion=version;const next=await open();await page.close();page=next;
   const durable=await bundle(page);assert.equal(durable.outbox.lineage.mutationId,pending.mutationId);
   assert.equal(stateHash(durable.outbox.state),stateHash(expected));assert.deepEqual(await full(page),expected,'Complete content must survive the version round trip');
  }
  control.offline=false;await page.evaluate(()=>refreshLiveSyncStatus());const roundTripSave=await save(page);assert.equal(roundTripSave.ok,true,JSON.stringify({runtime,roundTripSave,meta:await page.evaluate(()=>({revision:liveSync.revision,stateHash:liveSync.stateHash,pending:pendingCloudMutation,conflict:liveSync.conflict,paired:liveSync.paired}))}));assert.equal(stateHash(cloud),stateHash(expected));assert.equal((await bundle(page)).outbox,null);
  // A delayed v24 response crosses a v25 edit with a backwards clock.
  const first=await commit(page,mutate(expected,'Accepted by v24'),1000);control.fault='delay';await page.evaluate(()=>{window.__oldSave=saveStateToCloud();});await waitRelease(page);
  control.offline=true;activeVersion=25;const other=await open();const newer=await commit(other,mutate(first.state,'Newer pending in v25'),500);control.offline=false;
  control.release();await page.evaluate(()=>window.__oldSave);
  const latest=await bundle(other);assert.equal(latest.outbox.lineage.mutationId,newer.mutationId);assert.deepEqual(latest.outbox.state,newer.state,'Old reply cannot clear or alter v25 work');
  const copies=await other.evaluate(async()=>{const db=await openV13DeviceRecoveryDb();try{return await v13IdbRequest(db.transaction('recovery','readonly').objectStore('recovery').index('username').getAll(v13DurableUsername()));}finally{db.close();}});
  assert.ok(copies.some(row=>row.protectedCopy && row.state?.v24SupersededOutbox?.lineage?.mutationId===first.mutationId));
  await page.close();page=other;control.offline=true;
  // Closing/reopening the same profile preserves pending lineage across versions.
  await stopChrome();activeVersion=24;await launch();page=await open();assert.equal((await bundle(page)).outbox.lineage.mutationId,newer.mutationId);assert.equal(stateHash((await bundle(page)).outbox.state),stateHash(newer.state));
  if(runtime==='hosted'){
   fixtureUsername='qa-other';activeVersion=25;control.offline=false;const accountA={cloud,disk,revision};cloud={};disk={};revision=1;
   const accountB=await open();assert.equal((await bundle(accountB)).outbox,null,'Account B cannot read account A pending entry');
   assert.equal(JSON.stringify(await full(accountB)).includes('Newer pending in v25'),false,'Account B cannot read A content');await accountB.close();
   fixtureUsername='qa-safety';({cloud,disk,revision}=accountA);control.offline=true;const returned=await open();assert.equal((await bundle(returned)).outbox.lineage.mutationId,newer.mutationId);await page.close();page=returned;
  }
  // Same state, actual identical DOM geometry, desktop/tablet/mobile.
  control.offline=false;const visual=await reset(page,26);control.offline=true;
  const parity=[];
  for(const width of [390,820,1440]){
   await page.setViewportSize({width,height:900});activeVersion=24;const a=await open();await a.setViewportSize({width,height:900});await a.waitForTimeout(250);const before=await ui(a);
   activeVersion=25;const b=await open();await b.setViewportSize({width,height:900});await b.waitForTimeout(250);const after=await ui(b);
   assert.ok(after.tasks.length>0,'Parity must compare rendered synthetic tasks');assert.deepEqual(after,before,'V25 visual geometry must match v24 at '+width);assert.deepEqual(await full(b),visual);if(runtime==='hosted')assert.equal(await b.locator('#v13ModeLabel').textContent(),'Hosted v25');parity.push({width,tasks:after.tasks.length,controls:after.controls});await a.close();await b.close();
  }
  report.push({runtime,completeHashRoundTrip:true,pendingRoundTrip:true,oldReplyRetainsNewMutation:true,supersededRecoveryCopy:true,persistentReopen:true,accountSwitch:runtime==='hosted',parity});await stopChrome();
 }
 const result={ok:true,syntheticOnly:true,report};fs.writeFileSync(path.join(artifacts,'v25-continuity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{control.release?.();await stopChrome().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
`;
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=module.paths;compiled._compile(source,__filename);
