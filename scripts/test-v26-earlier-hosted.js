// Reuse the isolated hosted browser/save harness; every record below is synthetic.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
let source=fs.readFileSync(path.join(__dirname,'test-v26-agenda.js'),'utf8');
source=source.slice(0,source.indexOf('(async()=>{await new Promise(r=>server.listen'));
source+=`
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));loopback='http://127.0.0.1:'+server.address().port;
 mode='hosted';origin='https://studyquest-v26-actions.onrender.com';profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-v26-actions-'));await launch();const page=await open();await page.setViewportSize({width:1920,height:1600});await page.bringToFront();await reset(page,71);
 const seeded=await page.evaluate(async()=>{
  const seed=cloneStateForSafety(state),now=today(),previous=studyQuestAddLogicalDays(now,-4),cat=seed.categories?.[0]?.id||'';
  seed.tasks=[{id:'earlier-multi',title:'Earlier multi-day task',date:previous,endDate:studyQuestAddLogicalDays(previous,2),done:false,catId:cat,notes:'Preserve note',durationMinutes:90},
   {id:'earlier-repeat',title:'Earlier repeating task',date:previous,recurrence:'weekly',recurrenceId:'synthetic-series',recurrenceRootDate:previous,done:false,catId:cat},
   {id:'next-repeat',title:'Next repeating occurrence',date:studyQuestAddLogicalDays(previous,7),recurrence:'weekly',recurrenceId:'synthetic-series',recurrenceRootDate:previous,done:false,catId:cat},
   {id:'today-target',title:'Today task',date:now,done:false,catId:cat}];
  seed._studyquestSubtasks={schemaVersion:1,records:{'earlier-multi':{subtasks:[{id:'kept-subtask',title:'Preserved subtask',checked:true}]}}};
  setSQState(seed,{resetSyncBaseline:true});renderAll();pendingCloudMutation=null;v13DurableOutboxPending=false;
  confirmedCloudState=cloneV20CloudState(state);liveSync.revision=1;liveSync.stateHash=await verifiedCloudStateHash(confirmedCloudState);setLiveSyncMeta({revision:1,stateHash:liveSync.stateHash,pending:false});
  await queueV13DeviceStatePersistence(state,{pending:false,label:'synthetic-action-seed'});writeV13BrowserState(state);return cloneV20CloudState(state);
 });cloud=structuredClone(seeded);disk=structuredClone(seeded);control.offline=true;
 await page.waitForTimeout(300);if(await page.locator('#v21RecoveryLater').isVisible())await page.locator('#v21RecoveryLater').click();
 const before=await page.evaluate(()=>cloneV20CloudState(state));
 const row=()=>page.locator('.v26-earlier-task[data-task-id="earlier-multi"]');
 assert.equal(await row().getAttribute('draggable'),'true');assert.equal(await row().locator('.v26-earlier-action').count(),3);
 await row().getByRole('button',{name:'Edit task: Earlier multi-day task',exact:true}).click();assert.equal(await page.locator('#taskName').inputValue(),'Earlier multi-day task');await page.getByRole('button',{name:'Close task editor',exact:true}).click();
 await row().getByRole('button',{name:'Assign date: Earlier multi-day task',exact:true}).click();assert.equal(await page.locator('#taskDate').inputValue(),before.tasks[0].date);await page.getByRole('button',{name:'Close task editor',exact:true}).click();
 await row().getByRole('button',{name:'Delete task: Earlier multi-day task',exact:true}).click();assert.equal(await page.locator('#appConfirmModal.open').count(),1);await page.locator('#appConfirmCancelBtn').click();assert.deepEqual(await page.evaluate(()=>cloneV20CloudState(state)),before,'Opening/canceling actions must preserve complete account state');
 const target=await page.evaluate(()=>today());
 await page.evaluate(()=>{window.__dragTrace=[];for(const type of ['dragstart','drop','dragend'])document.addEventListener(type,e=>window.__dragTrace.push({type,target:e.target.className,id:e.target.dataset?.taskId}),true);});
 await row().locator('.v26-earlier-drag').dragTo(page.locator('.date-bin[data-date="'+target+'"] .bin-header'));
 console.log(JSON.stringify({afterDrag:await page.evaluate(()=>({trace:window.__dragTrace,task:state.tasks.find(t=>t.id==='earlier-multi'),toast:document.getElementById('toastContainer')?.textContent}))}));
 await page.waitForFunction(date=>state.tasks.find(t=>t.id==='earlier-multi').date===date,target,{timeout:5000});
 const moved=await page.evaluate(()=>cloneV20CloudState(state));
 assert.equal(moved.tasks[0].endDate,await page.evaluate(date=>studyQuestAddLogicalDays(date,2),target));
 assert.deepEqual({...moved.tasks[0],date:before.tasks[0].date,endDate:before.tasks[0].endDate},before.tasks[0]);
 assert.deepEqual(moved.tasks.slice(1),before.tasks.slice(1));assert.deepEqual(moved._studyquestSubtasks,before._studyquestSubtasks);
 await page.evaluate(async()=>{if(v13DurableSaveDrainPromise)await v13DurableSaveDrainPromise;});const durable=await bundle(page);assert.ok(durable.outbox);assert.equal(durable.outbox.state.tasks[0].date,target);
 control.offline=false;const savedMove=await save(page);assert.equal(savedMove.ok,true,JSON.stringify(savedMove));assert.equal(cloud.tasks[0].date,target);
 await page.evaluate(()=>restoreLastUndo());await page.locator('#appConfirmActionBtn').click();assert.deepEqual(await page.evaluate(()=>state.tasks),before.tasks,'Undo must restore original dates and every task');
 await page.evaluate(async()=>{if(v13DurableSaveDrainPromise)await v13DurableSaveDrainPromise;});const undoSave=await save(page);assert.equal(undoSave.ok,true,JSON.stringify(undoSave));assert.deepEqual(cloud.tasks,before.tasks);
 control.offline=true;
 const repeatRow=page.locator('.v26-earlier-task[data-task-id="earlier-repeat"]');await repeatRow.locator('.v26-earlier-drag').dragTo(page.locator('.date-bin[data-date="'+target+'"] .bin-header'));await page.waitForFunction(date=>state.tasks.find(t=>t.id==='earlier-repeat').date===date,target);
 const repeatAfter=await page.evaluate(()=>state.tasks);assert.deepEqual(repeatAfter.find(t=>t.id==='next-repeat'),before.tasks.find(t=>t.id==='next-repeat'));
 assert.equal(repeatAfter.find(t=>t.id==='earlier-repeat').recurrenceId,'synthetic-series');
 const result={ok:true,syntheticOnly:true,editAssignCancelReadOnly:true,deleteConfirmationRetained:true,nativeDragVerified:true,multiDayPreserved:true,subtasksPreserved:true,durableOutboxVerified:true,cloudSaveVerified:true,undoAndCloudSaveVerified:true,recurringOccurrenceIsolated:true};
 fs.writeFileSync(path.join(artifacts,'v26-earlier-hosted.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{control.release?.();await stopChrome().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));});
`;
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=module.paths;compiled._compile(source,__filename);
