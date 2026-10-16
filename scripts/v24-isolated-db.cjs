// Test-only PostgreSQL runtime. Never loaded by production npm start.
const { PGlite } = require('@electric-sql/pglite');
const Module = require('node:module');
const original = Module._load;
if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL !== 'postgresql://qa:qa@127.0.0.1/v24_isolated') {
  throw new Error('Isolated PostgreSQL adapter requires the synthetic test environment.');
}
const db = new PGlite();
let failNextQuery = null;
process.on('message', async message => {
  if (!message?.testControl) return;
  try {
    let result;
    if (message.command === 'fail-next') { failNextQuery = message.needle; result = {armed:true}; }
    else if (message.command === 'inspect') {
      result = {};
      for (const table of ['accounts','state_versions','state_save_events','state_conflict_copies']) {
        result[table] = (await db.query(`select * from ${table} order by ${table==='accounts'?'username':'created_at'}`)).rows;
      }
    } else throw new Error('Unknown isolated database control');
    process.send?.({testControl:true,id:message.id,result});
  } catch (error) { process.send?.({testControl:true,id:message.id,error:String(error.message)}); }
});
class Pool {
  on() {}
  async query(text, params) { const result = params?.length ? await db.query(text, params) : (await db.exec(text)).at(-1); return {...result,rowCount:result.rows.length || result.affectedRows || 0}; }
  async connect() { return {query:async (text,params)=>{
    if (failNextQuery && text.toLowerCase().includes(failNextQuery)) {
      failNextQuery=null;
      throw new Error('Injected synthetic transaction failure');
    }
    return this.query(text,params);
  },release(){}}; }
  async end() { await db.close(); }
}
Module._load = function(name, parent, main) { return name === 'pg' ? {Pool} : original.call(this,name,parent,main); };
