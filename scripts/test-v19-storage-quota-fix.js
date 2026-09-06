const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'public', 'recovery-ux-v2-core.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'claudever19.html'), 'utf8');
const v19Metadata = JSON.parse(fs.readFileSync(path.join(root, 'public', 'v19-version.json'), 'utf8'));

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asyncRequest(result, error = null, preserveResult = false) {
  const request = { result:preserveResult ? result : deepClone(result), error };
  queueMicrotask(() => {
    if (error) request.onerror?.();
    else request.onsuccess?.();
  });
  return request;
}

function makeDatabase(seed = {}) {
  const stores = new Map([
    ['accountStates', new Map()],
    ['outbox', new Map()],
    ['recovery', new Map()],
  ]);
  Object.entries(seed).forEach(([storeName, values]) => {
    const store = stores.get(storeName);
    (values || []).forEach(value => store.set(value.username || value.id, deepClone(value)));
  });
  const db = {
    version:3,
    stores,
    objectStoreNames:{ contains:name => stores.has(name) },
    close(){ this.closed = true; },
    transaction(names) {
      const list = Array.isArray(names) ? names : [names];
      const transaction = {
        objectStore(name) {
          assert.ok(list.includes(name), `Unexpected store ${name}`);
          const values = stores.get(name);
          assert.ok(values, `Missing store ${name}`);
          return {
            get(key){ return asyncRequest(values.get(key)); },
            put(value){
              const key = name === 'recovery' ? value.id : value.username;
              values.set(key, deepClone(value));
              return asyncRequest(value);
            },
            delete(key){ values.delete(key); return asyncRequest(undefined); },
          };
        },
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return db;
}

function makeState(count, prefix) {
  return {
    tasks:Array.from({ length:count }, (_, index) => ({ id:`${prefix}-task-${index}`, title:`${prefix} task ${index}` })),
    notes:[],
    fileLinks:[],
    grades:{},
    trips:[],
    tracker:{ weeks:[] },
    trackerSemesters:[],
    updatedAt:1_000 + count,
  };
}

async function runRecovery({ quotaError = null } = {}) {
  const username = 'admin';
  const key = 'studyquest_v3_admin';
  const browserState = makeState(2, 'browser');
  const previousState = makeState(3, 'indexed');
  const pendingState = makeState(3, 'pending');
  const cloudState = makeState(4, 'cloud');
  const serializedBrowser = JSON.stringify(browserState);
  const localValues = new Map([[key, serializedBrowser]]);
  const localStorage = {
    getItem(name){ return localValues.get(name) ?? null; },
    setItem(name, value){
      if (quotaError) throw quotaError;
      localValues.set(name, String(value));
    },
  };
  const db = makeDatabase({
    accountStates:[{ username, state:previousState, updatedAt:previousState.updatedAt }],
    outbox:[{ username, state:pendingState, updatedAt:pendingState.updatedAt, lineage:{ baseRevision:4 } }],
  });
  const fakeIndexedDB = {
    open(name, requestedVersion){
      assert.equal(name, 'studyquest_device_recovery_v1');
      assert.equal(requestedVersion, undefined, 'Recovery must not request an upgrade or downgrade');
      return asyncRequest(db, null, true);
    },
  };
  const context = {
    window:{ indexedDB:fakeIndexedDB },
    indexedDB:fakeIndexedDB,
    localStorage,
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    Map,
    Set,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    queueMicrotask,
  };
  vm.runInNewContext(coreSource, context, { filename:'recovery-ux-v2-core.js' });
  const core = context.window.StudyQuestRecoveryV2;
  const result = await core.archiveAndLoadAccountBackup({
    username,
    envelope:{ state:cloudState, revision:610, stateHash:'a'.repeat(64) },
  });
  const current = await core.readCurrentDeviceRecords(db, username);
  return { key, browserState, cloudState, localValues, db, result, current };
}

async function main() {
  const quota = await runRecovery({
    quotaError:Object.assign(new Error('Setting the value exceeded the quota'), { name:'QuotaExceededError' }),
  });
  assert.equal(quota.result.localStorageAvailable, false);
  assert.equal(quota.result.activeStorage, 'indexeddb');
  assert.deepEqual(quota.current.account.state, quota.cloudState);
  assert.equal(quota.current.account.authoritative, true);
  assert.equal(quota.current.account.storageMode, 'indexeddb-authoritative');
  assert.equal(quota.current.outbox, null);
  assert.equal(quota.localValues.get(quota.key), JSON.stringify(quota.browserState), 'Quota failure must not partially replace the browser mirror');
  assert.equal(quota.db.stores.get('recovery').size, 3, 'Browser, IndexedDB, and pending copies must be archived');

  const security = await runRecovery({
    quotaError:Object.assign(new Error('Storage is blocked'), { name:'SecurityError' }),
  });
  assert.equal(security.result.localStorageAvailable, false);
  assert.deepEqual(security.current.account.state, security.cloudState);
  assert.equal(security.current.account.authoritative, true);

  const mirror = await runRecovery();
  assert.equal(mirror.result.localStorageAvailable, true);
  assert.equal(mirror.localValues.get(mirror.key), JSON.stringify(mirror.cloudState));
  assert.deepEqual(mirror.current.account.state, mirror.cloudState);
  assert.equal(mirror.current.account.authoritative, true);
  assert.equal(mirror.current.outbox, null);

  assert.match(htmlSource, /const durableAuthoritative = !bundle\.outbox\?\.state && bundle\.accountState\?\.authoritative === true/);
  assert.match(htmlSource, /browserSaved,\s*\n\s*\}\)\.then/);
  assert.match(htmlSource, /durableSyncDeviceId/);
  assert.match(htmlSource, /async function markV13DeviceStateAuthoritative/);
  assert.match(htmlSource, /source:'v19-durable-cloud-load'/);
  assert.match(htmlSource, /source:'v19-durable-smart-merge'/);
  assert.match(htmlSource, /label:'restored-backup',[\s\S]{0,160}browserSaved/);
  assert.match(htmlSource, /browser mirror unavailable/);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public', 'claudever19.html'))).digest('hex'),
    v19Metadata.hash,
    'v19 metadata must match the tested HTML artifact',
  );

  console.log(JSON.stringify({
    ok:true,
    quotaFailure:'IndexedDB authoritative fallback preserved; browser mirror unchanged',
    securityFailure:'IndexedDB authoritative fallback preserved; browser mirror unchanged',
    successfulMirror:'verified in both stores',
    cloudWriteOnDeviceLoad:false,
    recoveryArchives:3,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
