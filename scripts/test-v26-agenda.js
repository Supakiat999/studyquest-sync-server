// Disposable Chrome profiles and synthetic HTTP accounts only. No production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {stateHash,stateRecordDiff}=require('../lib/state-safety');
const hostedRoot=path.resolve(__dirname,'..'),root=path.resolve(hostedRoot,'..'),pub=path.join(hostedRoot,'public');
const modes=process.argv.includes('--hosted-only')?['hosted']:['local','hosted'];
const seedCount=modes.length===1?100:50;
const artifacts=fs.existsSync(path.join(root,'safety-v26-2026-10-14'))?path.join(root,'safety-v26-2026-10-14'):path.join(hostedRoot,'.test-artifacts');
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
  if(url.pathname==='/v26')filename='claudever26.html';
  if(!/^[\w.-]+\.(html|js|json|css)$/.test(filename)){res.writeHead(404);res.end();return;}
  const file=path.join(base,filename);if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  let body=fs.readFileSync(file,'utf8');
  if(filename==='claudever26.html' && mode==='hosted')body=body.replace('</head>','<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__={username:"qa-safety"};window.__STUDYQUEST_SAFE_SYNC_V2__=true;window.__STUDYQUEST_V20_HOSTED__=true;window.__STUDYQUEST_V21_HOSTED__=true;window.__STUDYQUEST_V24_HOSTED__=true;</script></head>');
  if(mode==='local' && filename==='claudever26.html')body=body.replace('</head>','<link rel="stylesheet" href="/studyquest-device-date-shifts.css?v=4"></head>').replace('</body>','<script src="/studyquest-device-date-shifts.js?v=3"></script></body>');
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
  const page=await context.newPage();await page.goto(origin+(mode==='hosted'?'/v26':'/claudever26.html'));
  await page.waitForFunction(()=>window.studyQuestV21Core);assert.equal(await page.evaluate(()=>STUDYQUEST_VERSION),26);assert.equal(await page.evaluate(()=>!!window.StudyQuestV26Agenda),true);await page.waitForTimeout(250);
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

(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));loopback='http://127.0.0.1:'+server.address().port;
 const reports=[];
 for(const runtime of modes){
  mode=runtime;origin=mode==='hosted'?'https://studyquest-v26-ui.onrender.com':loopback;profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-v26-ui-'));await launch();const page=await open();await reset(page,41);
  await page.evaluate(()=>{const now=today();const seed=cloneStateForSafety(state);seed.tasks=[{id:'older',title:'Earlier unfinished',date:studyQuestAddLogicalDays(now,-2),done:false},{id:'done',title:'Completed earlier',date:studyQuestAddLogicalDays(now,-1),done:true},{id:'nodate',title:'No deadline',date:'',done:false},{id:'today',title:'Today',date:now,done:false},{id:'far',title:'Far future',date:'9999-12-31',done:false},{id:'repeat',title:'Repeating saved task',date:studyQuestAddLogicalDays(now,2),recurrence:'weekly',done:false}];for(let n=0;n<80;n++)seed.tasks.push({id:'future-'+n,title:'Future '+n,date:studyQuestAddLogicalDays(now,n+1),done:false});setSQState(seed,{resetSyncBaseline:true});renderAll();});
  await page.evaluate(()=>{const now=today();state.tasks.push({id:'skipped-past',title:'Skipped series occurrence',date:studyQuestAddLogicalDays(now,-4),done:false,_studyquestV16Series:{skipped:true}},{id:'superseded-past',title:'Superseded series occurrence',date:studyQuestAddLogicalDays(now,-3),done:false,_studyquestV16Series:{superseded:true}},{id:'suppressed-past',title:'Deleted series occurrence',date:studyQuestAddLogicalDays(now,-2),done:false,_studyquestV18Deletion:{suppressed:true}});renderAll();});
  cloud=await page.evaluate(()=>cloneV20CloudState(state));disk=structuredClone(cloud);control.offline=true;
  await page.waitForTimeout(300);if(await page.locator('#v21RecoveryLater').isVisible())await page.locator('#v21RecoveryLater').click();const baseline=await page.evaluate(()=>JSON.stringify(state));const writes=control.requests.filter(x=>x.method==='POST').length;
  console.log(JSON.stringify({runtime,viewDiagnostics:await page.evaluate(()=>({suppressionInstalled:typeof window.studyQuestV16IsSuppressedTask,sharedOverdueCount:getTodayFilterCount('overdue'),sidebar:document.getElementById('v26Earlier').querySelector('summary').textContent,suppressed:state.tasks.filter(t=>t.id.endsWith('-past')).map(t=>({id:t.id,predicate:taskMatchesFilter(t,'overdue'),suppressed:window.studyQuestV16IsSuppressedTask?.(t)}))}))}));
  assert.equal(await page.locator('#v26EarlierList button').count(),1);assert.equal(await page.locator('#v26EarlierList').innerText().then(x=>x.includes('Completed earlier')),false);
  assert.equal(await page.locator('#v26EarlierList button').count(),await page.evaluate(()=>getTodayFilterCount('overdue')),'Sidebar and existing overdue count must use the complete shared predicate');
  await page.locator('#v26EarlierList button').click();assert.equal(await page.locator('#taskModal').isVisible(),true);await page.getByRole('button',{name:'Close task editor',exact:true}).click();assert.equal(await page.evaluate(()=>JSON.stringify(state)),baseline,'Opening the existing editor must not change tasks');
  await page.getByRole('button',{name:'1 day',exact:true}).click();assert.ok((await page.locator('#v26AgendaInfo').innerText()).length>0);
  await page.getByRole('button',{name:'2 days',exact:true}).click();
  await page.bringToFront();await page.waitForFunction(()=>{const rows=[...document.querySelectorAll('.task-item[data-id]')];return rows.length>0&&rows.every(row=>row.querySelector('.sq-date-shift-inline-row'));});
  await page.getByLabel('Custom days ahead',{exact:true}).fill('0');await page.getByRole('button',{name:'Apply days',exact:true}).click();assert.equal(await page.getByLabel('Custom days ahead',{exact:true}).evaluate(el=>el.validity.valid),false);
  await page.getByLabel('Custom days ahead',{exact:true}).fill('5');await page.getByRole('button',{name:'Apply days',exact:true}).click();assert.equal(await page.evaluate(()=>StudyQuestV26Agenda.getDays(state.tasks,today()).length),8);
  await page.getByRole('button',{name:'Date range',exact:true}).click();await page.getByLabel('Agenda start date',{exact:true}).fill('2024-02-28');await page.getByLabel('Agenda end date',{exact:true}).fill('2024-03-01');await page.getByRole('button',{name:'Apply range',exact:true}).click();assert.deepEqual(await page.evaluate(()=>StudyQuestV26Agenda.getDays(state.tasks,today())),['2024-02-28','2024-02-29','2024-03-01']);assert.equal(await page.locator('#v26PastControls button').first().isDisabled(),true);
  await page.getByRole('button',{name:'All saved future tasks',exact:true}).click();assert.equal(await page.locator('#binsContainer .v26-task-link').count(),50);await page.getByRole('button',{name:/Show 50 more/}).click();assert.ok((await page.locator('#binsContainer').innerText()).includes('Far future'));
  assert.equal(await page.evaluate(()=>JSON.stringify(state)),baseline,'View interactions must preserve complete state');assert.equal(control.requests.filter(x=>x.method==='POST').length,writes,'View interactions must not save');
  const widths=[];for(const width of [390,768,1440]){await page.setViewportSize({width,height:900});widths.push({width,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});}assert.ok(widths.every(x=>!x.overflow),'Agenda must fit mobile/tablet/desktop');
  await page.getByRole('button',{name:'Days ahead',exact:true}).focus();await page.keyboard.press('Space');await page.screenshot({path:path.join(artifacts,'v26-'+runtime+'-agenda.png'),fullPage:false});await page.getByRole('button',{name:'All saved future tasks',exact:true}).click();
  await page.reload();await page.waitForFunction(()=>window.studyQuestV21Core);assert.equal(await page.locator('[data-mode="all"]').getAttribute('aria-pressed'),'true','Device preference survives reload');
  reports.push({runtime,allSavedPaging:true,farFuture:true,leapDay:true,noStateMutations:true,noSaveRequests:true,widths});await stopChrome();
 }
 console.log(JSON.stringify({ok:true,reports}));await new Promise(r=>server.close(r));
})().catch(async e=>{console.error(e);await stopChrome().catch(()=>{});server.close();process.exitCode=1;});
