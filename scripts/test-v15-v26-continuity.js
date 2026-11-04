// Actual older/newer hosted pages against one isolated PostgreSQL-backed account.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),fixture=require('./v26-fixture.cjs');
let running,browser;
(async()=>{
 running=await fixture({STUDYQUEST_V26_ACCESS:'all',STUDYQUEST_MAIN_VERSION:'15'});
 const hosted='https://studyquest-v15-v26-continuity.onrender.com';
 const seed={tasks:[{id:'kept-task',title:'Original task',date:'2026-11-04',done:false,createdAt:1,catId:'study',notes:'Keep task notes',xp:10}],categories:[{id:'study',name:'Study',icon:'📚',color:'#7c6af7'}],notes:[{id:'kept-note',title:'Preserved note',content:'Keep'}],fileLinks:[{id:'kept-file',name:'Preserved file',url:'https://example.invalid/synthetic'}],tracker:{weeks:[],programConfigured:true},trackerSemesters:[],_studyquestSubtasks:{schemaVersion:1,records:{'kept-task':{subtasks:[{id:'kept-sub',title:'Preserved subtask',checked:true}]}}},_futureQuest:{records:[{id:'future-field',value:'Keep unknown namespace'}]},updatedAt:1000};
 let meta=(await running.request('/api/v2/state',{},running.admin)).body;
 const seeded=await running.post('/api/v2/state',{state:seed,baseRevision:meta.revision,baseHash:meta.stateHash,mutationId:crypto.randomUUID(),deviceId:'synthetic-continuity'},running.admin);assert.equal(seeded.status,200,JSON.stringify(seeded.body));
 meta=(await running.request('/api/v2/state',{},running.admin)).body;
 browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext();let offline=false;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==hosted)return route.abort();if(offline&&url.pathname.startsWith('/api/'))return route.abort();
  const response=await running.request(url.pathname+url.search,{method:request.method(),headers:{'content-type':request.headers()['content-type']||'application/json'},body:request.postDataBuffer()||undefined},running.admin);
  await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')||'text/plain','cache-control':'no-store',...(response.location?{location:response.location}:{})},body:typeof response.body==='string'?response.body:JSON.stringify(response.body)});
 });
 // A synthetic browser-local mirror, seeded once; subsequent version changes use real persistence.
 await context.addInitScript(value=>{if(!localStorage.getItem('studyquest_v3_admin'))localStorage.setItem('studyquest_v3_admin',JSON.stringify(value));},seed);
 const page=await context.newPage();await page.goto(hosted+'/v15');await page.waitForFunction(()=>typeof STUDYQUEST_VERSION!=='undefined'&&STUDYQUEST_VERSION===15&&state.tasks.some(t=>t.id==='kept-task'));
 const completeSeed=await page.evaluate(value=>({...cloneStateForSafety(state),...value}),seed);
 const completed=await running.post('/api/v2/state',{state:completeSeed,baseRevision:meta.revision,baseHash:meta.stateHash,mutationId:crypto.randomUUID(),deviceId:'synthetic-continuity'},running.admin);assert.equal(completed.status,200,JSON.stringify(completed.body));
 meta=(await running.request('/api/v2/state',{},running.admin)).body;
 await page.evaluate(async value=>{await applyCloudState(value.state,value.revision,value.updatedAt,'Synthetic initial cloud load');confirmedCloudState=cloneStateForSafety(state);liveSync.stateHash=value.stateHash;},meta);
 assert.equal((await running.request('/api/v2/state',{},running.admin)).body.stateHash,meta.stateHash,'Opening v15 must not change cloud state');
 offline=true;await page.evaluate(()=>editTask('kept-task'));await page.locator('#taskName').fill('Pending edit made in v15');await page.locator('#taskModal button[onclick="saveTask()"] ').click();
 await page.evaluate(async()=>{if(v13DurableSaveDrainPromise)await v13DurableSaveDrainPromise;});
 const v15Tasks=await page.evaluate(()=>JSON.parse(JSON.stringify(state.tasks)));assert.equal(v15Tasks[0].title,'Pending edit made in v15');
 await page.goto(hosted+'/v26');await page.waitForFunction(()=>window.studyQuestV21Core&&state.tasks.some(t=>t.title==='Pending edit made in v15'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(JSON.stringify(state.tasks))),v15Tasks);
 assert.deepEqual(await page.evaluate(()=>state._studyquestSubtasks),seed._studyquestSubtasks);assert.deepEqual(await page.evaluate(()=>state._futureQuest),seed._futureQuest);
 await page.goto(hosted+'/v15');await page.waitForFunction(()=>typeof STUDYQUEST_VERSION!=='undefined'&&STUDYQUEST_VERSION===15&&state.tasks.some(t=>t.title==='Pending edit made in v15'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(JSON.stringify(state.tasks))),v15Tasks);
 assert.deepEqual(await page.evaluate(()=>state._studyquestSubtasks),seed._studyquestSubtasks);assert.deepEqual(await page.evaluate(()=>state._futureQuest),seed._futureQuest);
 assert.equal((await running.request('/api/v2/state',{},running.admin)).body.stateHash,meta.stateHash,'Offline version transitions must not overwrite cloud');
 offline=false;await page.evaluate(()=>refreshLiveSyncStatus());const saved=await page.evaluate(()=>saveStateToCloud());assert.equal(saved.ok,true,JSON.stringify(saved));
 const final=(await running.request('/api/v2/state',{},running.admin)).body;assert.equal(final.state.tasks[0].title,'Pending edit made in v15');assert.deepEqual(final.state._studyquestSubtasks,seed._studyquestSubtasks);assert.deepEqual(final.state._futureQuest,seed._futureQuest);
 assert.equal(final.state.notes[0].id,'kept-note');assert.equal(final.state.fileLinks[0].id,'kept-file');
 const result={ok:true,syntheticOnly:true,v15ToV26ToV15:true,pendingEditPreserved:true,subtasksPreserved:true,unknownNamespacePreserved:true,cloudUnchangedWhileOffline:true,retrySaved:true};
 fs.mkdirSync(path.join(__dirname,'../.test-artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.test-artifacts/v15-v26-continuity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await running?.close();});
