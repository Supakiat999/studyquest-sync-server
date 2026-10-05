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
const hostedOrigin = 'https://studyquest-v24-qa.onrender.com';
const child = spawn(process.execPath,['--require',path.join(__dirname,'v24-isolated-db.cjs'),'server.js'],{cwd:root,env:{...process.env,PORT:'32424',DATABASE_URL:'postgresql://qa:qa@127.0.0.1/v24_isolated',STUDYQUEST_ADMIN_PASSWORD:password,STUDYQUEST_INVITE_CODE:invite,STUDYQUEST_V24_ACCESS:'all',STUDYQUEST_MAIN_VERSION:'24',STUDYQUEST_V15_ACCESS:'all',STUDYQUEST_SAFE_SYNC_MODE:'all',NODE_ENV:'test'}});
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
  assert.equal((await request('/v24')).status,302);
  const login = await request('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});
  assert.equal(login.status,200,JSON.stringify(login.body));
  const cookie = login.cookie;
  const seed = {tasks:[{id:'seed-a',title:'Retain task',date:'2026-10-05',done:false,createdAt:1,catId:'cat'}],categories:[{id:'cat',name:'Study'}],notes:[{id:'note-a',title:'Retain note',content:'Keep'}],tracker:{weeks:[]},trackerSemesters:[],_studyquestV22:{schemaVersion:1,subtasks:{schemaVersion:1,revision:1,records:{'task:seed-a':{parentTaskId:'seed-a',subtasks:[{id:'legacy-s',title:'Legacy subtask',checked:false,order:0,createdAt:1,updatedAt:1}]}},trash:[]}}};
  let baseline = (await request('/api/v2/state',{},cookie)).body;
  seed.tasks.push({id:'multi',title:'Multi-day',date:'2026-09-30',endDate:'2026-10-02'},
    {id:'recurring-a',title:'Occurrence A',date:'2026-10-01',recurrence:'weekly',recurrenceId:'series'},
    {id:'recurring-b',title:'Occurrence B',date:'2026-10-08',recurrence:'weekly',recurrenceId:'series'});
  const save = (state,base=baseline) => request('/api/v2/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,baseRevision:base.revision,baseHash:base.stateHash,mutationId:crypto.randomUUID(),deviceId:'v24-isolated-test'})},cookie);
  const seeded = await save(seed); assert.equal(seeded.status,200,JSON.stringify(seeded.body));
  baseline = (await request('/api/v2/state',{},cookie)).body;
  const stale = await save({...seed,tasks:[]},{...baseline,stateHash:'a'.repeat(64)});
  assert.notEqual(stale.status,200,'wrong hash must not replace account');
  const destructive = await save({...seed,tasks:[]});
  assert.notEqual(destructive.status,200,'missing tasks require explicit deletion evidence');
  assert.equal((await request('/api/v2/state',{},cookie)).body.state.tasks.length,4);
  const pageHtml = await request('/v24',{},cookie); assert.equal(pageHtml.status,200);
  assert.ok(pageHtml.body.includes('STUDYQUEST_VERSION = 24'));
  assert.ok((await request('/',{},cookie)).body.includes('STUDYQUEST_VERSION = 24'));
  assert.ok((await request('/app.html',{},cookie)).body.includes('!next'));
  assert.ok(!(await request('/app.html?stable=1',{},cookie)).body.includes('if (!user.legacy && !wantsStable && !next)') || (await request('/app.html?stable=1',{},cookie)).body.includes('!wantsStable'));
  browser = await chromium.launch({headless:true});
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
  await page.goto(hostedOrigin+'/v24');await page.waitForTimeout(1800);
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
  console.log('Actual PostgreSQL/server v24: read-only startup, stale hash and deletion rejection, durable dates/subtasks, old-client preservation, quota fallback, offline retry and responsive layouts passed.');
}
fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
main().catch(e=>{console.error(e);if(logs.includes('server_startup_failed'))console.error(logs);process.exitCode=1;}).finally(async()=>{await browser?.close();child.kill();});
