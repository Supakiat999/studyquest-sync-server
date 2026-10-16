// Recovery rehearsal only: no network client and no production database URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { decryptAndValidate, validateDatabaseExport, TABLE_ORDERS } = require('./database-backup');
const { stateHash, stateManifest, deserializeStateVersion } = require('../lib/state-safety');
const tableOrders = TABLE_ORDERS;
const stable = value => {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return {encoding:'base64',data:Buffer.from(value).toString('base64')};
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
};
async function restoreAndVerify(exported, options = {}) {
  validateDatabaseExport(exported, options);
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/002_neon_safe_sync.sql'),'utf8'));
    await db.exec('begin');
    for (const [table,order] of Object.entries(tableOrders)) {
      const rows = exported.tables[table];
      if (!rows) continue; // Only the explicitly allowed legacy conflict table may be absent.
      const info = await db.query('select column_name, udt_name from information_schema.columns where table_schema=$1 and table_name=$2',['public',table]);
      const types = Object.fromEntries(info.rows.map(row=>[row.column_name,row.udt_name]));
      for (const row of rows) {
        const columns = Object.keys(row);
        assert.ok(columns.every(column=>Object.hasOwn(types,column)),`Unknown restored column in ${table}`);
        const values = columns.map(column=>{
          const value=row[column];
          if(value?.encoding === 'base64') return Buffer.from(value.data,'base64');
          return types[column] === 'jsonb' && value !== null ? JSON.stringify(value) : value;
        });
        await db.query(`insert into ${table} (${columns.map(column=>`"${column}"`).join(',')}) values (${columns.map((column,i)=>`$${i+1}::${types[column]}`).join(',')})`,values);
      }
      const restored = (await db.query(`select * from ${table} order by ${order}`)).rows;
      // node-postgres returns int8 as strings; PGlite returns safe int8 numbers.
      const normalizeRows = list => list.map(row=>Object.fromEntries(Object.entries(row).map(([column,value])=>[column,
        types[column] === 'int8' && value !== null ? String(value) : stable(value)])));
      assert.deepEqual(stable(normalizeRows(restored)),stable(normalizeRows(rows)),`Every row and column must match the export: ${table}`);
      if (['state_backups','state_versions','state_save_events'].includes(table)) {
        await db.query(`select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}),1), exists(select 1 from ${table}))`);
      }
    }
    await db.exec('commit');
    const accounts=(await db.query('select * from accounts order by username')).rows;
    const accountChecks=accounts.map((account,index)=>{
      const source=exported.tables.accounts[index];
      assert.equal(stateHash(account.state),stateHash(source.state),'Account state hashes must match export');
      assert.deepEqual(Object.keys(stateManifest(account.state || {}).records).sort(),Object.keys(stateManifest(source.state || {}).records).sort(),'All record identifiers must match export');
      return {account:index+1,stateHash:stateHash(account.state),recordIdentifiers:Object.keys(stateManifest(account.state || {}).records).length,hashMatchesExport:true,recordIdsMatchExport:true};
    });
    const versions=(await db.query('select state_gzip,state_hash from state_versions')).rows;
    for(const row of versions) assert.equal(stateHash(deserializeStateVersion(Buffer.from(row.state_gzip))),row.state_hash,'Saved revision content hash must match');
    const copies=(await db.query('select candidate_gzip,candidate_hash from state_conflict_copies')).rows;
    for(const row of copies) assert.equal(stateHash(deserializeStateVersion(Buffer.from(row.candidate_gzip))),row.candidate_hash,'Conflict copy content hash must match');
    return {ok:true,engine:'isolated PGlite PostgreSQL',networkRequests:0,counts:exported.counts,accounts:accountChecks,versionsValidated:versions.length,conflictCopiesValidated:copies.length,conflictCopiesIncluded:Object.hasOwn(exported.tables,'state_conflict_copies'),allExportedRowsMatch:true};
  } finally { await db.close(); }
}
module.exports={restoreAndVerify,stable};
if(require.main===module) (async()=>{
  const filename=process.argv[2];
  if(!filename)throw new Error('Supply an encrypted .sqbackup path');
  const args=process.argv.slice(3);
  const expectedFlag=args.find(arg=>arg.startsWith('--expected-accounts='));
  const options={allowLegacyConflictCopies:args.includes('--allow-legacy')};
  if(expectedFlag) {
    options.expectedAccountCount=Number(expectedFlag.split('=')[1]);
    if(!Number.isSafeInteger(options.expectedAccountCount) || options.expectedAccountCount < 1) throw new Error('Expected account count must be a positive integer.');
  }
  const exported=decryptAndValidate(JSON.parse(fs.readFileSync(filename,'utf8')),undefined,options);
  const report=await restoreAndVerify(exported,options);
  const reportPath=args.find(arg=>!arg.startsWith('--'));
  if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error('Local restore failed:',String(error.message).split('\n')[0]);process.exitCode=1;});
