// Synthetic regression for cross-version exit writes. All HTTP is fixture-only.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const continuity=fs.readFileSync(path.join(__dirname,'test-v25-continuity.js'),'utf8');
let source=continuity.slice(0,continuity.indexOf('source+=`'));
source+=String.raw`
source+=\`
const results=[];
const full=page=>page.evaluate(()=>cloneV20CloudState(state));
const recoveries=page=>page.evaluate(async()=>{const db=await openV13DeviceRecoveryDb();try{return await v13IdbRequest(db.transaction('recovery','readonly').objectStore('recovery').index('username').getAll(v13DurableUsername()));}finally{db.close();}});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));loopback='http://127.0.0.1:'+server.address().port;
 for(const runtime of ['local','hosted'])for(const olderVersion of [24,25])for(const olderPending of [true,false]){
  mode=runtime;fixtureUsername='qa-safety';activeVersion=olderVersion;origin=runtime==='local'?loopback:'https://studyquest-exit-fixture.onrender.com';
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-exit-synthetic-'));await launch();
  const old=await open();const initial=await reset(old,41);control.offline=true;
  const first=await commit(old,mutate(initial,'Older tab copy'),1000);
  if(!olderPending)await old.evaluate(()=>{pendingCloudMutation=null;v13DurableOutboxPending=false;liveSync.pending=false;setLiveSyncMeta({pending:false});});
  activeVersion=olderVersion===24?25:24;let current=await open();
  const newer=await commit(current,mutate(first.state,'Newer edit must stay active'),500);
  const before=await bundle(current),mirror=await current.evaluate(()=>localStorage.getItem(ACTIVE_STORAGE_KEY));
  const count=control.requests.filter(r=>r.method==='POST').length;
  // Explicitly finish the old tab's exit handler. No browser timing lottery.
  await old.evaluate(async()=>{await preserveV13StateBeforeExit();if(v13DurableSaveDrainPromise)await v13DurableSaveDrainPromise;});
  await old.waitForTimeout(200);
  const after=await bundle(current),copies=await recoveries(current);
  const checks={outboxMutation:after.outbox?.lineage?.mutationId===newer.mutationId,
   fullOutboxHash:stateHash(after.outbox?.state)===stateHash(newer.state),
   accountStateUnchanged:stateHash(after.accountState?.state)===stateHash(before.accountState?.state),
   browserMirrorUnchanged:await current.evaluate(()=>localStorage.getItem(ACTIVE_STORAGE_KEY))===mirror,
   noExitUpload:control.requests.filter(r=>r.method==='POST').length===count,
   staleCopyRecoverable:copies.some(r=>stateHash(r.state)===stateHash(first.state)||stateHash(r.state?.v24SupersededOutbox?.state)===stateHash(first.state)),
   newerCopyRecoverable:copies.some(r=>stateHash(r.state)===stateHash(newer.state)||stateHash(r.state?.v24SupersededOutbox?.state)===stateHash(newer.state))};
  if(!process.argv.includes('--baseline')){
   const failure=await old.evaluate(async()=>{
    const persist=persistV13RecoveryOnly,logger=recordAppError;let reported=false;
    persistV13RecoveryOnly=async()=>{throw new DOMException('Synthetic exit storage abort','AbortError');};
    recordAppError=(tag)=>{reported=tag==='page-exit-save';};
    try{await preserveV13StateBeforeExit();return reported;}finally{persistV13RecoveryOnly=persist;recordAppError=logger;}
   });
   checks.exitStorageFailureReported=failure;
   checks.exitStorageFailureKeepsPending=stateHash((await bundle(current)).outbox?.state)===stateHash(newer.state);
  }
  await old.close();await current.waitForTimeout(100);await stopChrome();await launch();current=await open();
  const reopened=await bundle(current);checks.restartMutation=reopened.outbox?.lineage?.mutationId===newer.mutationId;
  checks.restartFullHash=stateHash(reopened.outbox?.state)===stateHash(newer.state)&&stateHash(await full(current))===stateHash(newer.state);
  results.push({runtime,olderVersion,olderPending,checks,ok:Object.values(checks).every(Boolean)});
  console.log(JSON.stringify({runtime,olderVersion,olderPending,ok:results.at(-1).ok}));
  await stopChrome();
 }
 if(!process.argv.includes('--baseline'))for(const runtime of ['local','hosted'])for(const olderVersion of [24,25]){
  mode=runtime;fixtureUsername='qa-safety';activeVersion=olderVersion;origin=runtime==='local'?loopback:'https://studyquest-exit-fixture.onrender.com';
  profile=fs.mkdtempSync(path.join(os.tmpdir(),'studyquest-exit-accepted-'));await launch();const old=await open();
  const initial=await reset(old,52);control.offline=true;const first=await commit(old,mutate(initial,'Older unaccepted edit'),1000);
  activeVersion=olderVersion===24?25:24;const current=await open();
  // Pause the new edit's durable write while the stale tab exits. Exit must not
  // cancel that queue; timer ownership also stays with the existing save path.
  await current.evaluate(()=>{const original=persistV13DeviceState;window.__releaseEdit=null;persistV13DeviceState=async(...args)=>{await new Promise(resolve=>{window.__releaseEdit=resolve;});persistV13DeviceState=original;return original(...args);};});
  const committing=commit(current,mutate(first.state,'Newer durable edit during stale exit'),1000);
  await current.waitForFunction(()=>!!window.__releaseEdit);
  await old.evaluate(async()=>{window.__exitTimers=[false,false];cloudSaveTimer=setTimeout(()=>{window.__exitTimers[0]=true;},30);serverSaveTimer=setTimeout(()=>{window.__exitTimers[1]=true;},30);await preserveV13StateBeforeExit();});
  await current.evaluate(()=>window.__releaseEdit());const newer=await committing;
  await old.waitForTimeout(80);assert.deepEqual(await old.evaluate(()=>window.__exitTimers),[true,true],'Exit must not cancel pending save timers');
  assert.equal((await bundle(current)).outbox.lineage.mutationId,newer.mutationId);
  control.offline=false;await current.evaluate(()=>refreshLiveSyncStatus());assert.equal((await save(current)).ok,true);
  const accepted=await bundle(current);assert.equal(accepted.outbox,null);assert.equal(stateHash(cloud),stateHash(newer.state));
  // A stale pending tab cannot resurrect an outbox after verified acceptance.
  await old.evaluate(()=>preserveV13StateBeforeExit());await old.close();
  const after=await bundle(current);assert.equal(after.outbox,null);assert.deepEqual(after.accountState,accepted.accountState);
  assert.equal(stateHash(await full(current)),stateHash(newer.state));
  const copies=await recoveries(current);assert.ok(copies.some(r=>stateHash(r.state)===stateHash(first.state)));
  results.push({runtime,olderVersion,queuedEditSurvivesExit:true,pendingTimersContinue:true,acceptedEditNotResurrected:true,ok:true});
  console.log(JSON.stringify(results.at(-1)));await stopChrome();
 }
 const report={ok:results.every(r=>r.ok),syntheticOnly:true,results};
 const directory=process.env.STUDYQUEST_DISPLAY_OUTPUT||artifacts;
 fs.writeFileSync(path.join(directory,process.argv.includes('--baseline')?'exit-safety-baseline.json':'exit-safety.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));assert.equal(report.ok,true,'An older tab must never replace the active pending copy or browser mirror');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{control.release?.();await stopChrome().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
\`;
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=module.paths;compiled._compile(source,__filename);
`;
// Unescape only the nested template delimiters, leaving harness source intact.
source=source.replaceAll('\\`','`');
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=module.paths;compiled._compile(source,__filename);
