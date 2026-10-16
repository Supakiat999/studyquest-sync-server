const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {collectDatabaseExport,encryptExport,decryptAndValidate}=require('./database-backup');
const {restoreAndVerify}=require('./restore-backup-local');
const {stateHash,serializeStateVersion}=require('../lib/state-safety');
(async()=>{
  const db=new PGlite();
  try{
    await db.exec(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/002_neon_safe_sync.sql'),'utf8'));
    const state={tasks:[{id:'task-one',title:'Preserve'}],notes:[{id:'note-one',content:'Private'}],
      fileLinks:[{id:'file-one',url:'https://example.invalid/synthetic'}],grades:{course:{score:91}},
      trips:[{id:'trip-one',name:'Preserve trip'}],tracker:{weeks:[{id:'week-one',label:'Preserve week'}]},
      _studyquestSubtasks:{records:{'task-one':{subtasks:[{id:'subtask-one',title:'Preserve subtask'}]}}},
      _futureQuest:{records:[{id:'future-one',value:'Preserve unknown fields'}]},updatedAt:1};
    const candidate={...state,tasks:[{id:'task-one',title:'Conflicting edit'}]};
    const gzip=serializeStateVersion(candidate).stateGzip;
    await db.query('insert into accounts(username,display_name,password_record,state,state_hash,state_revision) values ($1,$2,$3::jsonb,$4::jsonb,$5,$6)', ['admin','Synthetic','{}',JSON.stringify(state),stateHash(state),2]);
    await db.query('insert into accounts(username,display_name,password_record,state) values ($1,$2,$3::jsonb,$4::jsonb)', ['ordinary','Synthetic','{}',JSON.stringify({tasks:[{id:'ordinary-task',title:'Only ordinary'}]})]);
    const acceptedVersion=serializeStateVersion(state);
    await db.query('insert into state_versions(username,revision,state_gzip,state_hash,state_bytes,compressed_bytes) values ($1,$2,$3,$4,$5,$6)', ['admin',2,acceptedVersion.stateGzip,acceptedVersion.hash,acceptedVersion.stateBytes,acceptedVersion.compressedBytes]);
    await db.query('insert into state_backups(username,revision,state,reason) values ($1,$2,$3::jsonb,$4)', ['admin',2,JSON.stringify(state),'synthetic-recovery']);
    await db.query('insert into state_save_events(username,result,resulting_revision,state_hash,mutation_id) values ($1,$2,$3,$4,$5)', ['admin','accepted',2,stateHash(state),'synthetic-backup-accepted']);
    await db.query(`insert into state_conflict_copies(id,username,mutation_id,device_id,reason,base_revision,cloud_revision,cloud_hash,candidate_hash,candidate_bytes,candidate_gzip,compressed_bytes) values ($1,'admin','mutation-one','device-one','test',1,2,$2,$3,$4,$5,$6)`,[crypto.randomUUID(),stateHash(state),stateHash(candidate),Buffer.byteLength(JSON.stringify(candidate)),gzip,gzip.length]);
    const client={query:async(sql,params)=>params?.length ? db.query(sql,params):(await db.exec(sql)).at(-1)};
    const exported=await collectDatabaseExport(client);
    assert.equal(exported.counts.state_conflict_copies,1);
    const key=crypto.randomBytes(32);
    const {envelope}=encryptExport(exported,key);
    const decoded=decryptAndValidate(envelope,key);
    const report=await restoreAndVerify(decoded);
    assert.equal(report.conflictCopiesValidated,1);
    assert.equal(report.accounts.length,2);
    assert.equal(report.versionsValidated,1);
    assert.equal(report.counts.state_backups,1);
    assert.equal(report.counts.state_save_events,1);
    const missingTable=structuredClone(decoded);
    delete missingTable.tables.state_versions;
    delete missingTable.counts.state_versions;
    await assert.rejects(()=>restoreAndVerify(missingTable),/Required table/);
    const incompleteEncrypted=encryptExport(missingTable,key).envelope;
    assert.throws(()=>decryptAndValidate(incompleteEncrypted,key),/Required table/);
    const wrongCount=structuredClone(decoded);
    wrongCount.counts.accounts++;
    await assert.rejects(()=>restoreAndVerify(wrongCount),/count is invalid/);
    await assert.rejects(()=>restoreAndVerify(decoded,{expectedAccountCount:4}),/release baseline/);
    const legacy=structuredClone(decoded);
    delete legacy.tables.state_conflict_copies;
    delete legacy.counts.state_conflict_copies;
    await assert.rejects(()=>restoreAndVerify(legacy),/Required table/);
    const legacyReport=await restoreAndVerify(legacy,{allowLegacyConflictCopies:true,expectedAccountCount:2});
    assert.equal(legacyReport.conflictCopiesIncluded,false);
    const badEnvelope={...envelope,counts:{accounts:2}};
    assert.throws(()=>decryptAndValidate(badEnvelope,key),/incomplete/);
    const corrupt={...envelope,ciphertextSha256:'0'.repeat(64)};
    assert.throws(()=>decryptAndValidate(corrupt,key),/checksum/);
    const badTag={...envelope,tag:Buffer.alloc(16).toString('base64')};
    assert.throws(()=>decryptAndValidate(badTag,key));
    await db.exec('drop table state_conflict_copies');
    await assert.rejects(()=>collectDatabaseExport(client),/Required backup table is missing/);
    // Failed collection rolls back its transaction; subsequent reads remain usable.
    assert.equal((await db.query('select count(*)::int as count from accounts')).rows[0].count,2);
    console.log(JSON.stringify({ok:true,syntheticOnly:true,encryptedRoundtrip:true,tamperingRejected:true,incompleteBackupsRejected:true,legacyRequiresExplicitOptIn:true,missingSourceTableRejected:true,...report},null,2));
  }finally{await db.close();}
})().catch(error=>{console.error('Backup safety test failed:',String(error.message).split('\n')[0]);process.exitCode=1;});
