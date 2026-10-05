// Test-only PostgreSQL runtime. Never loaded by production npm start.
const { PGlite } = require('@electric-sql/pglite');
const Module = require('node:module');
const original = Module._load;
const db = new PGlite();
class Pool {
  on() {}
  async query(text, params) { const result = params?.length ? await db.query(text, params) : (await db.exec(text)).at(-1); return {...result,rowCount:result.affectedRows ?? result.rows.length}; }
  async connect() { return {query:this.query.bind(this),release(){}}; }
  async end() { await db.close(); }
}
Module._load = function(name, parent, main) { return name === 'pg' ? {Pool} : original.call(this,name,parent,main); };
