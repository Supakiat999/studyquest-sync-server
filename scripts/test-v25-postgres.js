// Actual server routes/save guards against a fresh in-memory PostgreSQL engine.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const root = path.resolve(__dirname,'..');
const password = crypto.randomBytes(24).toString('hex');
const invite = crypto.randomBytes(24).toString('hex');
const origin = 'http://127.0.0.1:32424';
const hostedOrigin = 'https://studyquest-v25-qa.onrender.com';
const child = spawn(process.execPath,['--require',path.join(__dirname,'v24-isolated-db.cjs'),'server.js'],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:'32424',DATABASE_URL:'postgresql://qa:qa@127.0.0.1/v24_isolated',STUDYQUEST_ADMIN_PASSWORD:password,STUDYQUEST_INVITE_CODE:invite,STUDYQUEST_V24_ACCESS:'all',STUDYQUEST_V25_ACCESS:'all',STUDYQUEST_MAIN_VERSION:'15',STUDYQUEST_V15_ACCESS:'all',STUDYQUEST_SAFE_SYNC_MODE:'all',NODE_ENV:'test'}});
function databaseControl(command,needle) {
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{child.off('message',receive);reject(new Error('Isolated database control timed out'));},10000);
    const receive=message=>{if(message?.id!==id)return;clearTimeout(timer);child.off('message',receive);message.error?reject(new Error(message.error)):resolve(message.result);};
    child.on('message',receive);child.send({testControl:true,id,command,needle});
  });
}
let logs = '';
child.stdout.on('data', chunk => {logs += chunk;});
child.stderr.on('data', chunk => {logs += chunk;});
let browser;
async function request(url, options = {}, cookie) {
  const headers = {...options.headers,origin,...(cookie ? {cookie} : {})};
  const res = await fetch(origin+url,{...options,headers,redirect:'manual'});
  const text = await res.text(); let body; try {body=JSON.parse(text);} catch {body=text;}
  return {status:res.status,body,cookie:res.headers.get('set-cookie')?.split(';')[0],location:res.headers.get('location')};
}
async function main() {
  for (let i=0;i<80;i++) {try {if((await request('/api/health')).status===200)break;}catch{} if(child.exitCode !== null)throw new Error(logs);await new Promise(resolve=>setTimeout(resolve,500));}
  assert.equal((await request('/v25')).status,302);
  const login = await request('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});
  assert.equal(login.status,200,JSON.stringify(login.body));
  const cookie = login.cookie;
  const seed = {tasks:[{id:'seed-a',title:'Retain task',date:'2026-10-05',done:false,createdAt:1,catId:'cat',notes:'Private task note'}],categories:[{id:'cat',name:'Study'}],notes:[{id:'note-a',title:'Retain note',content:'Keep'}],tracker:{weeks:[]},trackerSemesters:[],_studyquestV22:{schemaVersion:1,subtasks:{schemaVersion:1,revision:1,records:{'task:seed-a':{parentTaskId:'seed-a',subtasks:[{id:'legacy-s',title:'Legacy subtask',checked:false,order:0,createdAt:1,updatedAt:1}]}},trash:[]}}};
  let baseline = (await request('/api/v2/state',{},cookie)).body;
  seed.tasks.push({id:'multi',title:'Multi-day',date:'2026-09-30',endDate:'2026-10-02'},
    {id:'recurring-a',title:'Occurrence A',date:'2026-10-01',recurrence:'weekly',recurrenceId:'series'},
    {id:'recurring-b',title:'Occurrence B',date:'2026-10-08',recurrence:'weekly',recurrenceId:'series'});
  const save = (state,base=baseline) => request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,baseRevision:base.revision,baseHash:base.stateHash,mutationId:crypto.randomUUID(),deviceId:'v24-isolated-test'})},cookie);
  const seeded = await save(seed); assert.equal(seeded.status,200,JSON.stringify(seeded.body));
  baseline = (await request('/api/v2/state',{},cookie)).body;
  assert.equal((await request('/api/v2/tasks/snapshot')).status,401,'anonymous task snapshots must be denied');
  assert.equal((await request('/api/v2/tasks/snapshot',{},cookie)).status,401,'browser sessions must not use the Worker endpoint');
  const pairCode=await request('/api/admin/pairing-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceName:'Synthetic LINE Worker'})},cookie);
  assert.equal(pairCode.status,200,JSON.stringify(pairCode.body));
  const paired=await request('/api/sync/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:pairCode.body.code,deviceName:'Synthetic LINE Worker'})});
  assert.equal(paired.status,200,JSON.stringify(paired.body));
  const taskSnapshot=await request('/api/v2/tasks/snapshot',{headers:{authorization:`Bearer ${paired.body.token}`}});
  assert.equal(taskSnapshot.status,200,JSON.stringify(taskSnapshot.body));
  const digestTaskFields=['id','title','catId','date','time','done','recurrence','recurrenceRootDate','endDate','priorityLevel'];
  assert.deepEqual(taskSnapshot.body.tasks,seed.tasks.map(task=>Object.fromEntries(digestTaskFields.filter(field=>Object.hasOwn(task,field)).map(field=>[field,task[field]]))));
  assert.deepEqual(taskSnapshot.body.categories,seed.categories);
  assert.equal(Object.hasOwn(taskSnapshot.body,'notes'),false,'notes must never leave through the task endpoint');
  assert.equal(JSON.stringify(taskSnapshot.body).includes('Private task note'),false,'task notes must not leave through the task endpoint');
  const ordinary=await request('/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ordinary-qa',password:crypto.randomBytes(20).toString('hex'),inviteCode:invite})});
  assert.equal(ordinary.status,201,JSON.stringify(ordinary.body));
  assert.equal((await request('/api/v2/tasks/snapshot',{},ordinary.cookie)).status,401,'ordinary users cannot read the admin task endpoint');
  const ordinaryState=await request('/api/v2/state',{},ordinary.cookie);
  assert.equal(ordinaryState.status,200);
  assert.equal(ordinaryState.body.state,null,'ordinary users must not receive admin state');
  const stale = await save({...seed,tasks:[]},{...baseline,stateHash:'a'.repeat(64)});
  assert.notEqual(stale.status,200,'wrong hash must not replace account');
  const destructive = await save({...seed,tasks:[]});
  assert.notEqual(destructive.status,200,'missing tasks require explicit deletion evidence');
  assert.equal((await request('/api/v2/state',{},cookie)).body.state.tasks.length,4);
  const pageHtml = await request('/v25',{},cookie); assert.equal(pageHtml.status,200);
  assert.ok(pageHtml.body.includes('STUDYQUEST_VERSION = 25'));
  assert.ok((await request('/',{},cookie)).body.includes('STUDYQUEST_VERSION = 15'));
  assert.equal((await request('/app.html',{},cookie)).body.includes('next === "v25"'),false,'Default login remains unchanged');
  assert.ok(!(await request('/app.html?stable=1',{},cookie)).body.includes('if (!user.legacy && !wantsStable && !next)') || (await request('/app.html?stable=1',{},cookie)).body.includes('!wantsStable'));
  browser = await chromium.launch({headless:true,...(process.env.STUDYQUEST_TEST_CHROME ? {executablePath:process.env.STUDYQUEST_TEST_CHROME} : {})});
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  let offline=false;
  await context.route('**/*',async route=>{
    const u = new URL(route.request().url());
    if(u.origin!==hostedOrigin)return route.abort();
    if(offline && u.pathname.startsWith('/api/'))return route.abort();
    const response = await fetch(origin+u.pathname+u.search,{method:route.request().method(),headers:{cookie,origin,'content-type':route.request().headers()['content-type'] || 'application/json'},body:route.request().postDataBuffer() || undefined,redirect:'manual'});
    await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type') || 'text/plain'},body:Buffer.from(await response.arrayBuffer())});
  });
  const page = await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(hostedOrigin+'/v25');await page.waitForTimeout(1800);
  assert.equal(await page.locator('#v13ModeLabel').textContent(),'Hosted v25');
  if(await page.locator('#v21RecoveryModal.open').count()) {await page.locator('[data-v21-choice="copy"]').click();await page.locator('#v21RecoveryApply').click();await page.waitForTimeout(1500);}
  assert.equal((await request('/api/v2/state',{},cookie)).body.revision,baseline.revision,'read-only startup must not upload');
  await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('multi',1));
  await page.waitForTimeout(1200);
  let dates=(await request('/api/v2/state',{},cookie)).body.state.tasks;
  assert.equal(dates.find(t=>t.id==='multi').date,'2026-10-01');
  assert.equal(dates.find(t=>t.id==='multi').endDate,'2026-10-03');
  page.on('dialog',dialog=>dialog.accept());
  await page.evaluate(()=>restoreLastUndo());
  await page.locator('#appConfirmActionBtn').click();await page.waitForTimeout(2000);
  dates=(await request('/api/v2/state',{},cookie)).body.state.tasks;
  assert.equal(dates.find(t=>t.id==='multi').date,'2026-09-30',JSON.stringify(await page.evaluate(()=>({runtime:window.SQ_State.tasks.find(t=>t.id==='multi'),sync:window.studyQuestV21Core.hostedSync(),undo:getUndoHistory().map(s=>({label:s.label,date:s.state.tasks.find(t=>t.id==='multi')?.date}))}))));
  await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('recurring-a',1));
  await page.waitForTimeout(1200);
  dates=(await request('/api/v2/state',{},cookie)).body.state.tasks;
  assert.equal(dates.find(t=>t.id==='recurring-a').date,'2026-10-02');
  assert.equal(dates.find(t=>t.id==='recurring-b').date,'2026-10-08');
  assert.equal(dates.find(t=>t.id==='recurring-a').recurrenceId,'series');
  await page.getByRole('button',{name:'+ New Task',exact:true}).click();
  await page.locator('#taskModal.open').waitFor();
  await page.locator('#taskName').fill('QA editor-created task');
  await page.locator('#taskInitialSubtask').fill('QA first subtask');
  await page.locator('#taskInitialSubtaskMinutes').fill('15');
  await page.locator('#taskModal button[onclick="saveTask()"] ').click();
  await page.waitForTimeout(2500);
  const editorSaved=(await request('/api/v2/state',{},cookie)).body;
  assert.ok(editorSaved.state.tasks.some(t=>t.title==='QA editor-created task'));
  assert.ok(JSON.stringify(editorSaved.state._studyquestSubtasks || {}).includes('QA first subtask'),JSON.stringify(await page.evaluate(()=>({record:window.StudyQuestV24Subtasks.getRecord(),status:window.StudyQuestV24SubtaskStore.getStatus(),sync:window.studyQuestV21Core.hostedSync(),toasts:document.querySelector('#toastContainer').textContent}))));
  assert.equal(await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('seed-a',1).then(r=>r.ok)),true);
  await page.waitForTimeout(1800);
  let account=(await request('/api/v2/state',{},cookie)).body;
  assert.equal(account.state.tasks[0].date,'2026-10-06');assert.equal(account.state.notes[0].title,'Retain note');
  const added = await page.evaluate(()=>window.StudyQuestV24Subtasks.addFromTaskEditor(window.SQ_State.tasks[0],'New hosted subtask',20));
  assert.equal(added,true,await page.locator('body').innerText());
  await page.waitForTimeout(1800);
  account=(await request('/api/v2/state',{},cookie)).body;
  assert.ok(JSON.stringify(account.state._studyquestSubtasks).includes('New hosted subtask'));
  assert.deepEqual(account.state._studyquestV22,seed._studyquestV22);
  const oldClient=JSON.parse(JSON.stringify(account.state));delete oldClient._studyquestSubtasks;oldClient.tasks[0].title='Old client edit';
  const oldSave=await save(oldClient,account);assert.equal(oldSave.status,200,JSON.stringify(oldSave.body));
  assert.ok((await request('/api/v2/state',{},cookie)).body.state._studyquestSubtasks);
  // A quota failure must use verified IndexedDB instead of losing the new date.
  await page.reload();await page.waitForTimeout(2000);
  if(await page.locator('#v21RecoveryModal.open').count()) {await page.locator('[data-v21-choice="copy"]').click();await page.locator('#v21RecoveryApply').click();await page.waitForTimeout(1200);}
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('studyquest_v3'))throw new DOMException('quota','QuotaExceededError');return original.call(this,key,value);};});
  const shifted=await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('seed-a',1));assert.equal(shifted.ok,true);
  await page.waitForTimeout(1800);assert.equal((await request('/api/v2/state',{},cookie)).body.state.tasks[0].date,'2026-10-07');
  const savedRevision=(await request('/api/v2/state',{},cookie)).body.revision;
  offline=true;assert.equal((await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('seed-a',1))).ok,true);
  assert.equal((await request('/api/v2/state',{},cookie)).body.revision,savedRevision);
  offline=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(3500);
  assert.equal((await request('/api/v2/state',{},cookie)).body.state.tasks[0].date,'2026-10-08',JSON.stringify(await page.evaluate(()=>({sync:window.studyQuestV21Core.hostedSync(),status:window.studyQuestV21Core.getStatus(),date:window.SQ_State.tasks[0].date}))));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(root,'.test-artifacts','v24-desktop.png')});
  for(const width of [520,390]) {await page.setViewportSize({width,height:900});await page.waitForTimeout(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<80);}
  // With both durable stores unavailable, reject the action and never POST.
  const beforeFailure=(await request('/api/v2/state',{},cookie)).body;
  await page.evaluate(()=>{indexedDB.open=()=>{throw new DOMException('IndexedDB unavailable','UnknownError');};});
  const failed=await page.evaluate(()=>window.StudyQuestDeviceDateShifts.moveByDay('seed-a',1));
  assert.equal(failed.ok,false,'unverified durable persistence must block date success');
  await page.waitForTimeout(1500);
  const afterFailure=(await request('/api/v2/state',{},cookie)).body;
  assert.equal(afterFailure.revision,beforeFailure.revision);
  assert.equal(afterFailure.stateHash,beforeFailure.stateHash);
  assert.equal(await page.evaluate(()=>window.SQ_State.tasks[0].date),'2026-10-08');
  // Reproduce the original 89 -> 78 incident with a newer marker and a full
  // browser store. This account and database are synthetic and isolated.
  const incident={updatedAt:1000,tasks:Array.from({length:89},(_,i)=>({id:`incident-task-${i}`,title:`Synthetic ${i}`,date:'2026-10-08',done:false,createdAt:i+1})),
    notes:[{id:'incident-note',title:'Keep'}],trips:[{id:'incident-trip',name:'Keep'}],tracker:{weeks:Array.from({length:4},(_,i)=>({id:`incident-week-${i}`,label:`Week ${i}`,rows:[]}))},trackerSemesters:[]};
  const ordinaryBase=(await request('/api/v2/state',{},ordinary.cookie)).body;
  const incidentSave=await request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:incident,baseRevision:ordinaryBase.revision,baseHash:ordinaryBase.stateHash,mutationId:crypto.randomUUID(),deviceId:'incident-seed'})},ordinary.cookie);
  assert.equal(incidentSave.status,200);
  const incidentBase=(await request('/api/v2/state',{},ordinary.cookie)).body;
  const staleIncident={...incident,tasks:incident.tasks.slice(0,78),trips:[],tracker:{weeks:[]}};
  const staleHash=require('../lib/state-safety').stateHash(staleIncident);
  const incidentContext=await browser.newContext();
  const incidentRequests=[];
  await incidentContext.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==hostedOrigin)return route.abort();
    incidentRequests.push({path:u.pathname,method:route.request().method()});
    const response=await fetch(origin+u.pathname+u.search,{method:route.request().method(),headers:{cookie:ordinary.cookie,origin,'content-type':'application/json'},body:route.request().postDataBuffer()||undefined,redirect:'manual'});
    await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')||'text/plain'},body:Buffer.from(await response.arrayBuffer())});
  });
  await incidentContext.addInitScript(({stale,revision,hash})=>{
    localStorage.setItem('studyquest_v3_ordinary-qa',JSON.stringify(stale));
    localStorage.setItem('studyquest_v3_ordinary-qa_live_sync_meta',JSON.stringify({revision,stateHash:hash,pending:true}));
    const chunk='x'.repeat(65536);let filled=false;
    try{for(let i=0;i<200;i++)localStorage.setItem(`synthetic-quota-${i}`,chunk);}catch(error){filled=error.name==='QuotaExceededError';}
    window.__quotaActuallyFilled=filled;
  },{stale:staleIncident,revision:incidentBase.revision,hash:staleHash});
  const incidentPage=await incidentContext.newPage();
  await incidentPage.goto(hostedOrigin+'/v25');await incidentPage.waitForTimeout(1800);
  assert.equal(await incidentPage.evaluate(()=>window.__quotaActuallyFilled),true,'Browser storage must actually reach quota');
  await incidentPage.reload();await incidentPage.waitForTimeout(1800);
  const attempt=await incidentPage.evaluate(async({stale,revision,hash})=>{
    v16UserInteracted=true;liveSync.conflict=null;liveSync.preview=null;
    setSQState(normalizeState(stale));liveSync.revision=revision;liveSync.stateHash=hash;
    return saveStateToCloud({lineageOverride:{baseRevision:revision,baseHash:hash,mutationId:crypto.randomUUID(),deviceId:'incident-restart'}});
  },{stale:staleIncident,revision:incidentBase.revision,hash:staleHash});
  assert.notEqual(attempt.ok,true,'Stale state must never receive a save success');
  const guarded=(await request('/api/v2/state',{},ordinary.cookie)).body;
  assert.equal(guarded.stateHash,incidentBase.stateHash);
  assert.deepEqual(guarded.state.tasks.map(task=>task.id),incident.tasks.map(task=>task.id));
  assert.equal(guarded.state.trips.length,1);assert.equal(guarded.state.tracker.weeks.length,4);
  const removalAttempt=await request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:staleIncident,baseRevision:guarded.revision,baseHash:guarded.stateHash,mutationId:crypto.randomUUID(),deviceId:'incident-correct-hash'})},ordinary.cookie);
  assert.equal(removalAttempt.status,409,'Deletion protection must also reject stale truncation with a correct hash');
  const ordinaryMeta=(await request('/api/v2/state/meta',{},ordinary.cookie)).body;
  assert.equal(ordinaryMeta.stateHash,incidentBase.stateHash);
  assert.notEqual(ordinaryMeta.stateHash,afterFailure.stateHash,'Metadata must remain account scoped');
  await incidentContext.close();
  const deviceSave=(next,base,device,changeSet)=>request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:next,baseRevision:base.revision,baseHash:base.stateHash,mutationId:crypto.randomUUID(),deviceId:device,changeSet})},ordinary.cookie);
  const editedIncident=structuredClone(guarded.state);editedIncident.tasks[0].title='Device A edit';
  assert.equal((await deviceSave(editedIncident,guarded,'device-a')).status,200);
  const losingEdit=structuredClone(guarded.state);losingEdit.tasks[1].title='Device B pending edit';
  const concurrent=await deviceSave(losingEdit,guarded,'device-b');
  assert.equal(concurrent.status,409,'Stale second-device edits must be refused');
  assert.equal(concurrent.body.copiesPreserved,true,'The refused device candidate must be escrowed');
  const deleteBase=(await request('/api/v2/state',{},ordinary.cookie)).body;
  const deletedIncident=structuredClone(deleteBase.state);deletedIncident.tasks.shift();
  const removal=require('../lib/state-safety').stateRecordDiff(deleteBase.state,deletedIncident).removed.find(row=>row.collection==='tasks');
  assert.equal((await deviceSave(deletedIncident,deleteBase,'device-a-delete',{deletes:[{key:removal.key}]})).status,200);
  const editDeleted=structuredClone(deleteBase.state);editDeleted.tasks[0].title='Edited while other device deleted';
  const editDeleteConflict=await deviceSave(editDeleted,deleteBase,'device-b-edit');
  assert.equal(editDeleteConflict.status,409);assert.equal(editDeleteConflict.body.copiesPreserved,true);
  const finalOrdinary=(await request('/api/v2/state',{},ordinary.cookie)).body;
  assert.equal(finalOrdinary.state.tasks.length,88);assert.equal(finalOrdinary.state.tasks.some(task=>task.id===incident.tasks[0].id),false);
  assert.equal((await request('/api/v2/state',{},cookie)).body.stateHash,afterFailure.stateHash,'Ordinary device conflicts must not touch admin');
  // Prove transaction failures cannot leave a changed account without its
  // immutable version or acceptance event. Injection lives only in this adapter.
  for (const needle of ['insert into state_versions','insert into state_save_events']) {
    const before=await databaseControl('inspect');
    const base=(await request('/api/v2/state',{},ordinary.cookie)).body;
    const next=structuredClone(base.state);next.notes[0].title='Must roll back';
    await databaseControl('fail-next',needle);
    assert.equal((await deviceSave(next,base,'transaction-failure')).status,500);
    const after=await databaseControl('inspect');
    assert.deepEqual(after.accounts,before.accounts,'Every account column must roll back');
    assert.deepEqual(after.state_versions,before.state_versions,'Immutable versions must roll back');
    assert.equal(after.state_save_events.filter(row=>row.result==='accepted').length,before.state_save_events.filter(row=>row.result==='accepted').length,'No acceptance event may survive a failed transaction');
  }
  const replayBase=(await request('/api/v2/state',{},ordinary.cookie)).body;
  const replayState=structuredClone(replayBase.state);replayState.notes[0].title='Accepted once despite lost reply';
  const replayBody={state:replayState,baseRevision:replayBase.revision,baseHash:replayBase.stateHash,mutationId:crypto.randomUUID(),deviceId:'lost-reply'};
  const replay=()=>request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(replayBody)},ordinary.cookie);
  const accepted=await replay();assert.equal(accepted.status,200);
  const repeat=await replay();assert.equal(repeat.body.idempotent,true);assert.equal(repeat.body.revision,accepted.body.revision);
  const advanced=(await request('/api/v2/state',{},ordinary.cookie)).body;
  const other=structuredClone(advanced.state);other.notes[0].title='Newer device edit';assert.equal((await deviceSave(other,advanced,'device-after-lost-reply')).status,200);
  const late=await replay();assert.equal(late.body.requiresRefresh,true);assert.equal(late.body.revision,accepted.body.revision);assert.equal(late.body.currentRevision,advanced.revision+1);
  assert.equal((await request('/api/v2/state',{},ordinary.cookie)).body.state.notes[0].title,'Newer device edit');
  console.log('Transaction atomicity and idempotent lost-reply retry passed, including newer cloud edits before replay.');
  console.log('Actual PostgreSQL/server v24: read-only startup, stale hash and deletion rejection, durable dates/subtasks, old-client preservation, quota fallback, offline retry and responsive layouts passed.');
  console.log('Original incident replay passed: actual full storage, stale 78-task copy, newer revision marker, restart and attempted upload retain all 89 cloud tasks, trip and four weeks.');
  console.log('Two-device edit and edit-versus-delete conflicts retain cloud state, escrow pending copies and isolate ordinary/admin accounts.');
}
fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
main().catch(e=>{console.error(e);if(logs.includes('server_startup_failed'))console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();child.kill();});
