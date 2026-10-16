// Disposable Chrome profiles and synthetic HTTP accounts only. No production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {stateHash,stateRecordDiff}=require('../lib/state-safety');
const hostedRoot=path.resolve(__dirname,'..'),root=path.resolve(hostedRoot,'..'),pub=path.join(hostedRoot,'public');
const modes=process.argv.includes('--hosted-only')?['hosted']:['local','hosted'];
const seedCount=modes.length===1?100:50;
const artifacts=fs.existsSync(path.join(root,'safety-transfer-2026-10-08'))?path.join(root,'safety-transfer-2026-10-08'):path.join(hostedRoot,'.test-artifacts');
fs.mkdirSync(artifacts,{recursive:true});
let mode='local',cloud={},disk={},revision=1,versions=[],events=[],seen=new Map();
const control={offline:false,fault:null,release:null,requests:[]};
const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');control.requests.push({path:url.pathname,method:req.method});
  if(url.pathname.startsWith('/api/') && control.offline){res.destroy();return;}
  const live=['/api/live-state','/api/v2/state'].includes(url.pathname);
  if(live && req.method==='POST'){
    let raw='';req.on('data',part=>raw+=part);req.on('end',()=>{
      const body=JSON.parse(raw),old=seen.get(body.mutationId);
      let reply;
      if(old)reply={...old,idempotent:true,requiresRefresh:old.revision!==revision,currentRevision:revision,currentStateHash:stateHash(cloud)};
      else{
        if(body.baseRevision!==revision || body.baseHash!==stateHash(cloud))return json(res,{ok:false,error:'BASE_HASH_MISMATCH',state:cloud,revision,stateHash:stateHash(cloud)},409);
        const removed=stateRecordDiff(cloud,body.state).removed;
        if(removed.some(item=>!(body.changeSet?.deletes || []).some(d=>d.key===item.key)))return json(res,{ok:false,error:'DESTRUCTIVE_CHANGE_REVIEW_REQUIRED',state:cloud,revision,stateHash:stateHash(cloud)},409);
        cloud=body.state;
        if(control.fault==='namespace')cloud={...cloud,_futureServerNamespace:{records:[{id:'server-preserved',value:'Keep server copy'}]}};
        revision++;versions.push(structuredClone(cloud));events.push({mutationId:body.mutationId,revision,hash:stateHash(cloud)});
        reply={ok:true,acknowledgedMutationId:body.mutationId,revision,stateHash:stateHash(cloud),savedAt:new Date().toISOString(),requiresRefresh:false};seen.set(body.mutationId,{...reply});
      }
      const fault=control.fault;control.fault=null;
      if(fault==='drop'){res.destroy();return;}
      if(fault==='delay'){control.release=()=>{control.release=null;json(res,reply);};return;}
      if(fault==='missing-id')delete reply.acknowledgedMutationId;
      if(fault==='wrong-id')reply.acknowledgedMutationId='wrong-synthetic-id';
      if(fault==='wrong-hash')reply.stateHash='0'.repeat(64);
      if(fault==='missing-hash')delete reply.stateHash;
      if(fault==='missing-revision')delete reply.revision;
      if(fault==='negative-revision')reply.revision=-1;
      if(fault==='string-revision')reply.revision=String(reply.revision);
      if(fault==='wrong-revision')reply.revision+=99;
      if(fault==='malformed-flags')reply.requiresRefresh='true';
      if(fault==='malformed'){res.writeHead(200,{'content-type':'application/json'});res.end('{invalid');return;}
      if(fault==='refresh')reply.requiresRefresh=true;
      return json(res,reply);
    });return;
  }
  if(live){
    const result={ok:true,state:cloud,revision,stateHash:stateHash(cloud)};
    if(control.delayRead){control.release=()=>{control.delayRead=false;control.release=null;json(res,result);};return;}
    return json(res,result);
  }
  if(['/api/live-state/meta','/api/v2/state/meta'].includes(url.pathname))return json(res,{ok:true,revision,stateHash:stateHash(cloud),integrity:{status:'ok'}});
  if(url.pathname==='/api/state'){
    if(req.method==='GET')return json(res,disk);
    let raw='';req.on('data',p=>raw+=p);req.on('end',()=>{disk=JSON.parse(raw);json(res,{ok:true});});return;
  }
  if(url.pathname==='/api/live-sync/status')return json(res,{ok:true,paired:true,username:'admin',localServerHealthy:true,liveHealthy:true});
  if(url.pathname==='/api/health')return json(res,{ok:true,db:'postgres'});
  if(url.pathname==='/api/me')return json(res,{ok:true,user:{username:'qa-safety'}});
  if(url.pathname.startsWith('/api/'))return json(res,{ok:true});
  if(url.pathname==='/fixture.html')return res.end('<title>Synthetic safety fixture</title>');
  let filename=url.pathname.slice(1),base=mode==='local'?root:pub;
  if(url.pathname==='/v24')filename='claudever24.html';
  if(!/^[\w.-]+\.(html|js|json|css)$/.test(filename)){res.writeHead(404);res.end();return;}
  const file=path.join(base,filename);if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  let body=fs.readFileSync(file,'utf8');
  if(filename==='claudever24.html' && mode==='hosted')body=body.replace('</head>','<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__={username:"qa-safety"};window.__STUDYQUEST_SAFE_SYNC_V2__=true;window.__STUDYQUEST_V20_HOSTED__=true;window.__STUDYQUEST_V21_HOSTED__=true;window.__STUDYQUEST_V24_HOSTED__=true;</script></head>');
  res.setHeader('content-type',filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'application/json');res.end(body);
});
let browser,context,chromeChild,profile,origin,loopback;
async function launch() {
  const chrome=process.env.STUDYQUEST_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const portFile=path.join(profile,'DevToolsActivePort');
  if(fs.existsSync(portFile))fs.unlinkSync(portFile);
  chromeChild=spawn(chrome,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:'ignore',windowsHide:true});
  let port;
  for(let i=0;i<200;i++){try{port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);if(port>0)break;}catch{}if(chromeChild.exitCode!==null)throw new Error('Disposable Chrome exited');await new Promise(r=>setTimeout(r,25));}
  assert.ok(port,'Disposable Chrome debugging port must be ready');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);context=browser.contexts()[0];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
    try{
      const reply=await fetch(loopback+url.pathname+url.search,{method:route.request().method(),headers:{'content-type':route.request().headers()['content-type'] || 'application/json'},body:route.request().postDataBuffer() || undefined});
      await route.fulfill({status:reply.status,headers:{'content-type':reply.headers.get('content-type') || 'application/json'},body:Buffer.from(await reply.arrayBuffer())});
    }catch{await route.abort();}
  });
}
async function stopChrome(force=false) {
  if(!chromeChild)return;
  const child=chromeChild;
  if(force || !browser){
    assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir())+path.sep),'Only the disposable temporary profile may be killed');
    assert.ok(child.pid>0 && child.exitCode===null);
    if(process.platform==='win32'){const result=spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});assert.equal(result.status,0,'Only this newly spawned Chrome tree should be stopped');}
    else child.kill('SIGKILL');
  }else {
    const session=await browser.newBrowserCDPSession();
    await session.send('Browser.close').catch(()=>{});
  }
  if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  chromeChild=null;browser=null;context=null;
}
async function open() {
  const page=await context.newPage();await page.goto(origin+(mode==='hosted'?'/v24':'/claudever24.html'));
  await page.waitForFunction(()=>window.studyQuestV21Core);await page.waitForTimeout(250);
  await page.evaluate(()=>{
    v16UserInteracted=true;
    for(const timer of [serverSaveTimer,cloudSaveTimer,liveSyncScheduleTimer,v21UploadRetryTimer])clearTimeout(timer);
    queueServerStateSave=()=>{};queueLiveCloudSave=()=>{};scheduleNextLiveSync=()=>{};
    // Direct fault cases control reconciliation explicitly. Prevent an earlier
    // acknowledgement's delayed background cycle from entering the next fixture.
    runLiveSyncCycle=async()=>({ok:false,syntheticBackgroundPaused:true});
    liveSync.inFlight=false;liveSync.conflict=null;liveSync.preview=null;
  });return page;
}
function projection(value) {
  return {tasks:value.tasks.map(t=>({id:t.id,title:t.title,date:t.date})),notes:value.notes.map(n=>({id:n.id,title:n.title,content:n.content})),files:value.fileLinks.map(f=>({id:f.id,name:f.name,url:f.url})),grades:value.grades,
    trips:value.trips.map(t=>({id:t.id,name:t.name})),weeks:value.tracker.weeks.map(w=>({id:w.id,label:w.label})),subtasks:value._studyquestSubtasks,future:value._futureQuest};
}
async function reset(page,seed) {
  control.offline=false;control.fault=null;control.release=null;seen=new Map();versions=[];events=[];revision=1;
  const value=await page.evaluate(async seed=>{
    if(v13DurableSaveDrainPromise)await v13DurableSaveDrainPromise;
    window.__safetyBaseState ||= cloneStateForSafety(state);
    const next=cloneStateForSafety(window.__safetyBaseState);
    next.tasks=[{id:'task-'+seed,title:'Task '+seed,date:'2026-10-08',done:false,createdAt:1},{id:'delete-'+seed,title:'Explicitly deletable',date:'2026-10-08',done:false,createdAt:2}];
    next.notes=[{id:'note-'+seed,title:'Note '+seed,content:'Keep '+seed}];next.fileLinks=[{id:'file-'+seed,name:'File '+seed,url:'https://example.invalid/'+seed}];next.grades={course:{score:seed}};
    next.trips=[{id:'trip-'+seed,name:'Trip '+seed,places:[],days:[]}];next.tracker={weeks:[{id:'week-'+seed,label:'Week '+seed,rows:[]}]};
    next._studyquestSubtasks={schemaVersion:1,records:{['task-'+seed]:{subtasks:[{id:'subtask-'+seed,title:'Subtask '+seed}]}}};next._futureQuest={records:[{id:'future-'+seed,value:'Future '+seed}],flag:seed};next.updatedAt=1000;
    setSQState(next,{resetSyncBaseline:true});ensureTrackerSemesters();ensureTravelState();ensureWeeklyTrackerData({persist:false});ensureWeeklyProgramMetadata();
    const db=await openV13DeviceRecoveryDb();try{const tx=db.transaction(['accountStates','outbox'],'readwrite');tx.objectStore('accountStates').delete(v13DurableUsername());tx.objectStore('outbox').delete(v13DurableUsername());await v13IdbTransactionDone(tx);}finally{db.close();}
    pendingCloudMutation=null;v13DurableOutboxPending=false;pendingServerSync=false;liveSync.pending=false;liveSync.conflict=null;liveSync.preview=null;window.__v21StorageError='';corruptSaveInfo=null;
    await queueV13DeviceStatePersistence(state,{pending:false,label:'synthetic-seed'});writeV13BrowserState(state);
    liveSync.revision=1;liveSync.stateHash=await verifiedCloudStateHash(cloneV20CloudState(state));confirmedCloudState=cloneV20CloudState(state);setLiveSyncMeta({revision:1,stateHash:liveSync.stateHash,pending:false});
    return cloneV20CloudState(state);
  },seed);
  cloud=value;disk=structuredClone(value);versions.push(structuredClone(value));return structuredClone(value);
}
async function commit(page,next,stamp=1000,explicitDelete=false) {
  const removed=stateRecordDiff(cloud,next).removed;
  return page.evaluate(async({next,stamp,deletes})=>{
    v16UserInteracted=true;setSQState(next);state.updatedAt=stamp;syncSQStateReference();
    const lineage=newCloudMutation(state);if(deletes)lineage.changeSet={deletes,source:'synthetic-explicit-user-delete'};
    pendingCloudMutation=lineage;liveSync.pending=true;setLiveSyncMeta({pending:true});
    await queueV13DeviceStatePersistence(state,{pending:true,label:'synthetic-edit',lineage});writeV13BrowserState(state);
    return {state:cloneV20CloudState(state),mutationId:lineage.mutationId};
  },{next,stamp,deletes:explicitDelete?removed.map(item=>({key:item.key})):null});
}
const save=page=>page.evaluate(()=>saveStateToCloud());
const bundle=page=>page.evaluate(()=>readV13DeviceStateBundle());
async function waitRelease(page){for(let i=0;i<200 && !control.release;i++)await page.waitForTimeout(10);assert.ok(control.release,'Delayed reply should be waiting');}
function mutate(value,label) {
  const next=structuredClone(value);next.tasks[0].title=label;next.notes[0].content=label;next.fileLinks[0].name=label;next.grades.course.score++;next.trips[0].name=label;next.tracker.weeks[0].label=label;next._studyquestSubtasks.records[next.tasks[0].id].subtasks[0].title=label;next._futureQuest.records[0].value=label;return next;
}
// Reproducible variation in edit values, clocks and restart placement.
function seededRandom(seed) {
  let value=seed >>> 0;
  return ()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
}
const results=[];
async function runMode(currentMode) {
  mode=currentMode;origin=mode==='hosted'?'https://studyquest-v24-safety.onrender.com':loopback;
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-v24-synthetic-'));await launch();let page=await open();
  assert.equal(await page.evaluate(async()=>{const db=await openV13DeviceRecoveryDb();try{const tx=v24DurableTransaction(db,'outbox'),durability=tx.durability;await v13IdbTransactionDone(tx);return durability;}finally{db.close();}}),'strict');
  let expected=await reset(page,1),pending;
  for(const fault of ['missing-id','wrong-id','wrong-hash','missing-hash','missing-revision','negative-revision','string-revision','wrong-revision','malformed-flags','malformed','refresh','namespace']) {
    expected=await reset(page,2);const pending=await commit(page,mutate(expected,'Unverified '+fault));control.fault=fault;
    const outcome=await save(page);assert.notEqual(outcome.ok,true,fault+' must not acknowledge');
    const copies=await bundle(page);assert.equal(copies.outbox.lineage.mutationId,pending.mutationId);assert.deepEqual(projection(copies.outbox.state),projection(pending.state));
    assert.equal(await page.evaluate(()=>!!pendingCloudMutation && liveSync.pending),true);
    assert.notEqual(await page.evaluate(()=>studyQuestV21Core.hostedSync?.()?.acknowledged),true,'An unverified reply must not display an acknowledged account save');
    if(fault==='namespace')assert.equal(cloud._futureServerNamespace.records[0].value,'Keep server copy');
    await page.evaluate(()=>{for(const id of [v21UploadRetryTimer,cloudSaveTimer])clearTimeout(id);});
    // Any requested full refresh is allowed to verify the accepted copy later.
    await page.waitForTimeout(300);
  }
  expected=await reset(page,8);pending=await commit(page,mutate(expected,'Hash verification unavailable'));
  await page.evaluate(()=>{window.__digestOriginal=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async()=>{throw new Error('Synthetic verifier unavailable');};});
  assert.equal((await save(page)).ok,false);assert.equal((await bundle(page)).outbox.lineage.mutationId,pending.mutationId);
  await page.evaluate(()=>{crypto.subtle.digest=window.__digestOriginal;});
  expected=await reset(page,9);pending=await commit(page,mutate(expected,'Accepted before a newer cloud edit'));control.fault='drop';assert.equal((await save(page)).ok,false);
  cloud=mutate(cloud,'Other device after lost reply');revision++;
  assert.equal((await save(page)).requiresRefresh,true);
  assert.equal(await page.evaluate(()=>confirmedCloudState),null);
  assert.equal((await bundle(page)).outbox.lineage.mutationId,pending.mutationId);
  assert.equal(cloud.tasks[0].title,'Other device after lost reply');await page.waitForTimeout(300);
  expected=await reset(page,10);control.delayRead=true;
  await page.evaluate(()=>{window.__readRace=syncLiveState({manual:true,reason:'manual'});});await waitRelease(page);
  const futureOnly=structuredClone(expected);futureOnly._futureQuest.records[0].value='Unknown field edited during full read';
  const fullReadPending=await commit(page,futureOnly,500);
  control.release();await page.evaluate(()=>window.__readRace);
  const readRaceCopy=await bundle(page);
  assert.ok((readRaceCopy.outbox && readRaceCopy.outbox.lineage.mutationId===fullReadPending.mutationId) || cloud._futureQuest.records[0].value===futureOnly._futureQuest.records[0].value,'A full read cannot erase an unknown-field edit');
  assert.equal(await page.evaluate(()=>state._futureQuest.records[0].value),futureOnly._futureQuest.records[0].value);
  if(readRaceCopy.outbox) assert.equal(await page.evaluate(()=>liveSync.pending || !!liveSync.conflict),true,'An unknown-field difference cannot falsely mark the device synced');
  // Atomic cloud-load CAS rejects a second-tab write made after capture.
  expected=await reset(page,11);const captured=await bundle(page);
  const atomicPending=await commit(page,mutate(expected,'Changed after cloud-load capture'));
  await assert.rejects(()=>page.evaluate(async({expected,captured})=>persistV24CloudLoad(expected,captured,stableCloudStringify(state)),{expected,captured}),/aborted/i);
  assert.equal((await bundle(page)).outbox.lineage.mutationId,atomicPending.mutationId);
  expected=await reset(page,3);pending=await commit(page,mutate(expected,'Cleanup failure'));
  await page.evaluate(()=>{window.__deleteOriginal=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(key){if(this.name==='outbox'){this.transaction.abort();return;}return window.__deleteOriginal.call(this,key);};});
  assert.equal((await save(page)).ok,false);assert.equal((await bundle(page)).outbox.lineage.mutationId,pending.mutationId);
  await page.evaluate(()=>{IDBObjectStore.prototype.delete=window.__deleteOriginal;});
  await page.evaluate(()=>syncLiveState({manual:true,reason:'manual'}));assert.equal((await bundle(page)).outbox,null);
  expected=await reset(page,4);const beforeAbort=await bundle(page);
  await page.evaluate(()=>{window.__putOriginal=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='accountStates'){this.transaction.abort();throw new DOMException('Synthetic abort','AbortError');}return window.__putOriginal.call(this,value);};});
  await assert.rejects(()=>commit(page,mutate(expected,'Uncommitted abort')),/Synthetic abort/);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__putOriginal;});
  assert.deepEqual((await bundle(page)).accountState,beforeAbort.accountState);
  await page.evaluate(()=>{window.__putOriginal=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value){if(this.name==='accountStates'){this.transaction.abort();throw new DOMException('Synthetic quota exhaustion','QuotaExceededError');}return window.__putOriginal.call(this,value);};});
  await assert.rejects(()=>commit(page,mutate(expected,'Unconfirmed quota write')),/Synthetic quota exhaustion/);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__putOriginal;});
  const afterQuota=await bundle(page);
  assert.deepEqual(afterQuota.accountState,beforeAbort.accountState,'Quota failure must preserve the last verified account copy');
  assert.deepEqual(afterQuota.outbox,beforeAbort.outbox,'Quota failure must preserve the last verified pending copy');
  expected=await reset(page,5);pending=await commit(page,mutate(expected,'Offline crash survives'));control.offline=true;
  const crashExpected=projection(pending.state);
  await page.evaluate(async()=>{const stale=cloneStateForSafety(state);stale.updatedAt=Date.now();stale.tasks[0].title='Stale newer-clock browser copy';setSQState(stale);await hydrateV13StateFromDeviceRecovery();});
  assert.deepEqual(projection(await page.evaluate(()=>cloneV20CloudState(state))),crashExpected,'Durable pending work must win over a stale copy with a newer clock');
  await stopChrome(true);await launch();page=await open();
  const survived=await bundle(page);assert.equal(survived.outbox.lineage.mutationId,pending.mutationId);assert.deepEqual(projection(survived.outbox.state),crashExpected);
  assert.deepEqual(await page.evaluate(()=>({tasks:state.tasks.map(t=>({id:t.id,title:t.title,date:t.date})),future:state._futureQuest})),{tasks:crashExpected.tasks,future:crashExpected.future});
  control.offline=false;
  const reconnect=await page.evaluate(async()=>{await refreshLiveSyncStatus();liveSync.conflict=null;liveSync.preview=null;return syncLiveState({manual:true,reason:'manual'});});
  if(!reconnect.ok) console.log(JSON.stringify({mode,phase:'crash-reconnect',outcome:reconnect,device:await page.evaluate(async()=>{const b=await readV13DeviceStateBundle();const diff=(a,z,p='')=>{if(stableCloudStringify(a)===stableCloudStringify(z))return [];if(!a||!z||typeof a!=='object'||typeof z!=='object')return [{path:p,local:a,pending:z}];return [...new Set([...Object.keys(a),...Object.keys(z)])].flatMap(k=>diff(a[k],z[k],p+'.'+k));};return {paired:liveSync.paired,conflict:!!liveSync.conflict,revision:liveSync.revision,mutation:pendingCloudMutation?.mutationId,durableMutation:b.outbox?.lineage?.mutationId,matches:v24CloudCopiesMatch(state,b.outbox?.state),diffs:diff(state,b.outbox?.state)};})}));
  if(!reconnect.ok)console.log(JSON.stringify({phase:'reconnect-base',cloudHash:stateHash(cloud),device:await page.evaluate(()=>({pendingBase:pendingCloudMutation?.baseHash,baseRevision:pendingCloudMutation?.baseRevision,hash:liveSync.stateHash,reason:liveSync.conflict?.reason,storageError:window.__v21StorageError,meta:getLiveSyncMeta()}))}));
  assert.equal(reconnect.ok,true);assert.deepEqual(projection(cloud),crashExpected);
  // A stale second tab cannot make the first tab's unsent draft unrecoverable.
  expected=await reset(page,6);control.offline=true;const other=await open();
  const first=await commit(page,mutate(expected,'First tab pending'));const second=await commit(other,mutate(expected,'Second tab pending'));
  const preserved=await other.evaluate(async()=>{const db=await openV13DeviceRecoveryDb();try{return await v13IdbRequest(db.transaction('recovery','readonly').objectStore('recovery').index('username').getAll(v13DurableUsername()));}finally{db.close();}});
  assert.ok(preserved.some(row=>row.protectedCopy && row.state?.v24SupersededOutbox?.lineage?.mutationId===first.mutationId),'Superseded unsent tab copy must be protected');
  assert.equal((await bundle(other)).outbox.lineage.mutationId,second.mutationId);await other.close();control.offline=false;
  // Recovery refuses an edit that arrives while its archive is being verified.
  expected=await reset(page,7);cloud=mutate(cloud,'Reviewed cloud');revision++;
  await page.evaluate(({cloud,revision,hash})=>{liveSync.preview={cloudState:cloud,revision,cloudStateHash:hash,sourceType:'live'};window.__archiveOriginal=studyQuestV21Core.archive;studyQuestV21Core.archive=async function(copies){await window.__archiveOriginal.call(this,copies);window.__archiveWaiting=true;await new Promise(resolve=>window.__archiveRelease=resolve);};window.__review=studyQuestV21Core.loadReviewedCopy().then(value=>({value}),error=>({error:error.message}));},{cloud,revision,hash:stateHash(cloud)});
  await page.waitForFunction(()=>window.__archiveWaiting);const recoveryPending=await commit(page,mutate(expected,'Edit during recovery'));
  await page.evaluate(()=>window.__archiveRelease());assert.ok((await page.evaluate(()=>window.__review)).error);assert.equal((await bundle(page)).outbox.lineage.mutationId,recoveryPending.mutationId);
  await page.evaluate(()=>{studyQuestV21Core.archive=window.__archiveOriginal;});
  const seeds=[];
  // 50 sequences per runtime = 100 reproducible sequences, each with an
  // independent intent oracle spanning all data areas and unknown fields.
  for(let index=1;index<=seedCount;index++) {
    const seed=index+(modes.length===2 && mode==='hosted'?50:0),random=seededRandom(seed);
    const nonce=()=>Math.floor(random()*0x1000000).toString(16);
    const equalClock=random()<0.5,restart=random()<0.25;
    try {
      expected=await reset(page,100+seed);
      const intentA=mutate(expected,'Seed '+seed+' first '+nonce()),a=await commit(page,intentA,1000);
      assert.deepEqual(projection(a.state),projection(intentA),'Device persistence must match independently computed intent');
      assert.equal(stateHash(a.state),stateHash({...intentA,updatedAt:1000}),'Full device hash must match the independent first-edit intent');
      control.fault='delay';await page.evaluate(()=>{window.__delayedSave=saveStateToCloud();});await waitRelease(page);
      const intentB=mutate(intentA,'Seed '+seed+' newer '+nonce()),b=await commit(page,intentB,equalClock?1000:500);
      assert.deepEqual(projection(b.state),projection(intentB));
      assert.equal(stateHash(b.state),stateHash({...intentB,updatedAt:equalClock?1000:500}),'Full device hash must match the independent newer-edit intent');
      control.release();assert.equal((await page.evaluate(()=>window.__delayedSave)).ok,true);
      assert.equal((await bundle(page)).outbox.lineage.mutationId,b.mutationId,'Old acknowledgement must keep newer identity');
      assert.deepEqual(projection((await bundle(page)).outbox.state),projection(b.state));
      assert.equal((await save(page)).ok,true);assert.deepEqual(projection(cloud),projection(b.state));assert.equal((await bundle(page)).outbox,null);
      const deleted=mutate(intentB,'Seed '+seed+' delete '+nonce());deleted.tasks.pop();const deleteClock=Math.floor(random()*1000),c=await commit(page,deleted,deleteClock,true);
      assert.deepEqual(projection(c.state),projection(deleted));
      assert.equal(stateHash(c.state),stateHash({...deleted,updatedAt:deleteClock}),'Full device hash must match the independent explicit-deletion intent');
      control.offline=true;assert.equal((await save(page)).ok,false);assert.deepEqual(projection((await bundle(page)).outbox.state),projection(c.state));
      if(restart){await page.reload();await page.waitForFunction(()=>window.studyQuestV21Core);await page.waitForTimeout(250);await page.evaluate(()=>{v16UserInteracted=true;liveSync.conflict=null;liveSync.preview=null;queueLiveCloudSave=()=>{};queueServerStateSave=()=>{};for(const id of [cloudSaveTimer,serverSaveTimer,v21UploadRetryTimer,liveSyncScheduleTimer])clearTimeout(id);});assert.deepEqual(projection((await bundle(page)).outbox.state),projection(c.state));}
      control.offline=false;await page.evaluate(()=>refreshLiveSyncStatus());control.fault='drop';assert.equal((await save(page)).ok,false);assert.deepEqual(projection(cloud),projection(c.state));
      const acceptedRevision=revision;assert.equal((await save(page)).ok,true);assert.equal(revision,acceptedRevision,'Lost reply retry must not duplicate acceptance');
      assert.deepEqual(projection(cloud),projection(c.state));assert.equal((await bundle(page)).outbox,null);
      assert.equal(versions.length,4);assert.equal(events.length,3);assert.equal(new Set(events.map(event=>event.mutationId)).size,3);
      assert.deepEqual(projection(versions[1]),projection(a.state));assert.deepEqual(projection(versions[2]),projection(b.state));assert.deepEqual(projection(versions[3]),projection(c.state));
      assert.equal(stateHash(versions[1]),stateHash({...intentA,updatedAt:1000}));assert.equal(stateHash(versions[2]),stateHash({...intentB,updatedAt:equalClock?1000:500}));assert.equal(stateHash(versions[3]),stateHash({...deleted,updatedAt:deleteClock}));
      seeds.push(seed);
    }catch(error){fs.writeFileSync(path.join(artifacts,'failing-v24-seed.json'),JSON.stringify({mode,seed,message:String(error.message)},null,2));throw error;}
  }
  results.push({runtime:mode,seededSequences:seeds.length,seeds,strictDurabilityVerified:true,invalidAcknowledgementsRejected:12,hashVerifierFailureRetained:true,lostReplyAfterCloudAdvance:true,fullReadRaceRetained:true,atomicCloudLoadRaceRetained:true,cleanupAbortRetained:true,writeAbortRejected:true,indexedDbQuotaFailureRejected:true,forcedChromeRestart:true,supersededTabCopyArchived:true,recoveryRaceRetained:true,independentFullHashOracle:true,allDataAreasVerified:true});
  await stopChrome();
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));loopback='http://127.0.0.1:'+server.address().port;
  for(const name of modes){await runMode(name);console.log(name+' v24: '+seedCount+' seeds and fault/crash tests passed.');}
  const report={ok:true,syntheticOnly:true,productionRequests:0,totalSeededSequences:100,seedGenerator:'LCG 1664525/1013904223, uint32',results};fs.writeFileSync(path.join(artifacts,'verified-save-failures.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{control.release?.();await stopChrome().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
