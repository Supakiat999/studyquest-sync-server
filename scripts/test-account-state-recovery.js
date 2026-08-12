const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'claudever9.html'), 'utf8');
const deviceRecovery = fs.readFileSync(path.join(__dirname, '..', 'public', 'device-recovery.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${marker}`);
  const braceStart = html.indexOf('{', html.indexOf(')', start));
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = braceStart; index < html.length; index += 1) {
    const char = html[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const functions = [
  'currentStorageKey', 'cloneAccountState', 'readAuthenticatedAccountState',
  'recoveryComparableState', 'stableRecoveryString', 'accountStatesEquivalent',
  'accountStateSummary',
];

const harness = `
const STORAGE_KEY = 'studyquest_v3';
const window = { __STUDYQUEST_MULTI_ACCOUNT__:true, __STUDYQUEST_AUTH_USER__:{ username:'Anya' } };
const saved = new Map();
const localStorage = {
  getItem:key => saved.has(key) ? saved.get(key) : null,
  setItem:(key, value) => saved.set(key, String(value)),
};
function normalizeState(value) { return value; }
${functions.map(extractFunction).join('\n')}
globalThis.recoveryTest = { saved, currentStorageKey, readAuthenticatedAccountState, accountStatesEquivalent, accountStateSummary };
`;

const context = { console };
vm.runInNewContext(harness, context, { filename:'stable-account-recovery-core.js' });
const recovery = context.recoveryTest;

assert.equal(recovery.currentStorageKey(), 'studyquest_v3_anya');
const browserCopy = {
  tasks:[{ id:'task-1', title:'Anya work' }], notes:[], fileLinks:[], grades:{ math:{} }, trips:[],
  updatedAt:1000, activeTripId:'trip-1', _syncMeta:{ fields:{ example:true } },
};
recovery.saved.set('studyquest_v3_anya', JSON.stringify(browserCopy));
recovery.saved.set('studyquest_v3_locked', JSON.stringify({ tasks:[] }));
assert.equal(recovery.readAuthenticatedAccountState().tasks[0].title, 'Anya work',
  'Authenticated startup must read Anya account storage, not the locked key');

const sameUserData = structuredClone(browserCopy);
sameUserData.updatedAt = 5000;
sameUserData.activeTripId = null;
sameUserData._syncMeta = { fields:{ differentMetadata:true } };
assert.equal(recovery.accountStatesEquivalent(browserCopy, sameUserData), true,
  'UI state, timestamps, and v13 metadata must not create a false recovery conflict');

const changedUserData = structuredClone(sameUserData);
changedUserData.tasks[0].title = 'Different cloud title';
assert.equal(recovery.accountStatesEquivalent(browserCopy, changedUserData), false,
  'Real task changes must open recovery comparison');
assert.match(recovery.accountStateSummary(browserCopy), /1 tasks/);
assert.match(recovery.accountStateSummary(browserCopy), /0 Weekly weeks/);

const syncStart = html.indexOf('async function syncStateFromServer()');
const syncEnd = html.indexOf('\n// ═', syncStart);
const syncSource = html.slice(syncStart, syncEnd);
assert.ok(syncSource.indexOf('readAuthenticatedAccountState()') < syncSource.indexOf('fetch(SERVER_STATE_ENDPOINT'),
  'Authenticated browser storage must load before the cloud request');
assert.ok(syncSource.includes('openAccountStateRecovery('),
  'Different browser and cloud copies must open recovery review');
assert.ok(!syncSource.includes('await saveStateToServer({'),
  'Authenticated startup must never upload a browser copy automatically');
assert.ok(html.includes("const CLOUD_SAVE_QUIET_MS = 500;"),
  'Normal cloud saves must begin promptly after a short quiet period');
assert.ok(html.includes("const DEVICE_RECOVERY_DB = 'studyquest_device_recovery_v1';"),
  'Stable saves must retain an IndexedDB device recovery copy');
assert.ok(html.includes("'Cloud backup pending'"),
  'Offline saves must report a pending cloud backup instead of a generic save error');
assert.ok(html.includes("'Conflict - both copies preserved'"),
  'Conflicts must state that both copies are preserved');
assert.ok(html.includes("window.addEventListener('pagehide', bestEffortSaveBeforePageExit);"),
  'Closing the page must preserve a final account-scoped device copy');
assert.ok(html.includes("saveStateToServer({ keepalive:true, silent:true })"),
  'Closing the page must attempt a revision-protected final cloud backup');
assert.ok(html.includes('durableSaveQueued = { snapshot:copy, options };'),
  'Rapid edits must coalesce to the newest IndexedDB recovery copy');
assert.ok(html.includes("deviceBundle.outbox?.state\n      ? normalizeState(deviceBundle.outbox.state)"),
  'An unsent device outbox must take precedence over cache timestamps');
assert.ok(html.includes("label:'browser-copy-before-choosing-cloud'"),
  'Choosing Cloud must first preserve the browser copy in IndexedDB');
assert.ok(deviceRecovery.includes('indexedDB.open(DB_NAME);'),
  'The read-only recovery page must open the existing IndexedDB version without upgrading it');
assert.ok(deviceRecovery.includes('request.transaction.abort();'),
  'The read-only recovery page must abort database creation when no IndexedDB copy exists');
assert.ok(deviceRecovery.includes('if (db) {'),
  'A missing IndexedDB recovery database must be treated as an empty device copy');
assert.ok(!deviceRecovery.includes('indexedDB.open(DB_NAME, DB_VERSION)'),
  'The recovery page must not request an IndexedDB version change');

console.log('Stable account recovery tests passed.');
