// Behaviour of the v21 account store, driven against a stubbed page bridge.
//
// Covers the save rules that do not need a browser: durable-commit ordering,
// compare-and-swap against another device, verified readback, refusal to write
// while device storage is unhealthy, device-local view isolation, quick-note
// debouncing, and the one-time legacy import guards.
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// ── minimal page environment ─────────────────────────────────────────────
const timers = [];
const localStore = new Map();
const listeners = new Map();

globalThis.localStorage = {
  getItem: key => (localStore.has(key) ? localStore.get(key) : null),
  setItem: (key, value) => localStore.set(key, String(value)),
  removeItem: key => localStore.delete(key),
};
globalThis.document = {
  visibilityState: 'visible',
  activeElement: null,
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, dataset: {}, style: {}, appendChild() {} }),
  getElementById: () => null,
  addEventListener: (name, handler) => listeners.set(name, handler),
};
globalThis.addEventListener = (name, handler) => listeners.set(name, handler);
globalThis.setTimeout = (fn, ms) => { const entry = { fn, ms, cancelled: false }; timers.push(entry); return entry; };
globalThis.clearTimeout = entry => { if (entry) entry.cancelled = true; };
const runTimers = () => { const pending = timers.splice(0); return Promise.all(pending.filter(t => !t.cancelled).map(t => t.fn())); };

const accountSync = require(path.join(root, 'public', 'v21-account-sync.js'));

// ── stub bridge over the page's durable save flow ────────────────────────
const events = [];
let accountState = { tasks: [], notes: [] };
let storageError = '';
let saveResult = 'ok';
let onSave = null;

const core = {
  getState: () => accountState,
  setState(next) { events.push('setState'); accountState = JSON.parse(JSON.stringify(next)); },
  async save() {
    events.push('save');
    if (onSave) await onSave();
    if (saveResult === 'device-failure') throw new Error('Device save could not be confirmed');
    if (saveResult === 'drop-write') accountState = JSON.parse(JSON.stringify(beforeLastWrite));
  },
  getStatus: () => ({ paired: true, pending: false, conflict: false, revision: 3, message: '', storageError }),
  hostedSync: () => ({ cloudMode: true, pending: false, lastSuccessAt: '2026-09-08T03:00:00.000Z' }),
  storageKey: () => 'studyquest_v3_anya',
  accountKey: () => 'anya',
  render() {},
  archive: async () => { events.push('archive'); },
  snapshots: async () => ({ format: 'stub' }),
};

let beforeLastWrite = null;
accountSync.install(core);
const store = accountSync.store;
const KEY = 'studyquest_v3_anya:anya';

const course = (id, name) => ({ id, name, showDates: false, columns: [{ id: id + '-k', name: 'Read' }], rows: [] });
const next = (record, courses) => ({ ...record, revision: record.revision + 1, courses, savedAt: new Date().toISOString() });

async function main() {
// ── 1. a first write commits, then verifies ──────────────────────────────
let record = store.read(KEY);
assert.equal(record.revision, 0, 'a new account starts at revision 0');
assert.deepEqual(record.courses, [], 'a new account has no courses');
assert.equal(record.settings.view, 'week', 'the default view is By week');

events.length = 0;
beforeLastWrite = accountState;
let saved = await store.write(record, next(record, [course('c1', 'IDT 4')]));
assert.deepEqual(events, ['setState', 'save'], 'state must be committed before the save is awaited');
assert.equal(saved.revision, 1, 'the revision must advance');
assert.equal(accountState._studyquestV21.manual.courses[0].name, 'IDT 4', 'the course must land in the account namespace');
assert.equal(accountState._studyquestV21.schemaVersion, 1, 'the namespace must carry its schema version');
assert.deepEqual(accountState.tasks, [], 'unrelated account data must be untouched');

// ── 2. another device's change blocks a stale write ──────────────────────
const stale = saved;
accountState = JSON.parse(JSON.stringify(accountState));
accountState._studyquestV21.manual = { version: 1, revision: 7, courses: [course('c9', 'From another device')], savedAt: null };

await assert.rejects(
  () => store.write(stale, next(stale, [course('c1', 'IDT 4'), course('c2', 'Renamed here')])),
  /Another device changed these courses/,
  'a stale compare-and-swap must be refused'
);
assert.equal(accountState._studyquestV21.manual.courses[0].name, 'From another device', 'the other device\'s copy must be left alone');
assert.equal(accountState._studyquestV21.manual.revision, 7, 'a refused write must not advance the revision');

// ── 3. a save that does not survive readback is reported, not claimed ────
record = store.read(KEY);
beforeLastWrite = JSON.parse(JSON.stringify(accountState));
saveResult = 'drop-write';
await assert.rejects(
  () => store.write(record, next(record, [course('c9', 'From another device'), course('c3', 'Added')])),
  /Save readback changed/,
  'a write that does not read back must fail loudly'
);
saveResult = 'ok';
assert.equal(accountSync.saveStatus().kind, 'error', 'a failed readback must show Needs attention');
assert.match(accountSync.saveStatus().label, /Needs attention/, 'the status must name the problem');

// ── 4. a failed device save is surfaced and does not claim success ───────
record = store.read(KEY);
saveResult = 'device-failure';
await assert.rejects(() => store.write(record, next(record, [])), /Device save could not be confirmed/, 'a device failure must reach the caller');
saveResult = 'ok';

// ── 5. editing is refused while device storage needs recovery ────────────
storageError = 'Device recovery unavailable';
record = store.read(KEY);
await assert.rejects(() => store.write(record, next(record, [])), /Resolve device recovery before editing/, 'a broken device store must block writes');
assert.equal(accountSync.saveStatus().kind, 'error', 'a storage error must show Needs attention');
storageError = '';

// ── 6. the view is device-local and never blocks a save ──────────────────
record = store.read(KEY);
const beforeNamespace = JSON.stringify(accountState._studyquestV21);
const viewOnly = { ...record, settings: { ...record.settings, view: 'manual' } };
events.length = 0;
// A same-account write that only moves the view must still pass compare-and-swap.
saved = await store.write(record, { ...viewOnly, revision: record.revision + 1, courses: record.courses });
assert.deepEqual(events, [], 'view-only navigation must not call the account save flow');
assert.equal(JSON.stringify(accountState._studyquestV21), beforeNamespace, 'view-only navigation must not advance the account revision');
assert.equal(store.read(KEY).settings.view, 'manual', 'the view must persist on this device');
assert.doesNotMatch(JSON.stringify(accountState._studyquestV21), /"view"/, 'the view must never enter the account namespace');
assert.equal(JSON.parse(beforeNamespace).manual.courses.length, JSON.parse(JSON.stringify(accountState._studyquestV21)).manual.courses.length, 'a view change must not alter courses');

// ── 7. Subject Track is a functional, account-synced setting ─────────────
record = store.read(KEY);
saved = await store.write(record, { ...record, revision: record.revision + 1, settings: { ...record.settings, subjectEnabled: true } });
assert.equal(accountState._studyquestV21.subjectTrack.enabled, true, 'Subject Track must be stored on the account');
assert.equal(store.read(KEY).settings.subjectEnabled, true, 'Subject Track must read back from the account');

// ── 8. the quick note settles after the debounce, once ───────────────────
const noteInput = { id: 'v20ExamNoteInput', value: 'Bring the lab notebook' };
globalThis.document.getElementById = id => (id === 'v20ExamNoteInput' ? noteInput : null);
const inputHandler = listeners.get('input');
assert.ok(inputHandler, 'the layer must listen for text input');

events.length = 0;
inputHandler({ target: noteInput });
noteInput.value = 'Bring the lab notebook and a pen';
inputHandler({ target: noteInput });
assert.equal(events.length, 0, 'a text edit must not save on every keystroke');
assert.equal(accountSync.saveStatus().kind, 'saving', 'a pending text edit must read as Saving');
await runTimers();
assert.equal(accountState._studyquestV21.note.text, 'Bring the lab notebook and a pen', 'the settled note must reach the account');
assert.equal(events.filter(name => name === 'save').length, 1, 'a settled text edit must save exactly once');

// A note still in flight must be flushed when the field is left.
noteInput.value = 'Final answer';
inputHandler({ target: noteInput });
await accountSync.flushNote();
assert.equal(accountState._studyquestV21.note.text, 'Final answer', 'leaving the field must flush the pending text');
await runTimers();
assert.equal(accountState._studyquestV21.note.text, 'Final answer', 'a flushed note must not be re-saved by the stale timer');

// ── 9. the legacy import is explicit, backed up, and runs once ───────────
globalThis.StudyQuestV21Manual = { snapshot: async () => ({ manualCourses: { courses: [course('legacy', 'From this laptop')], settings: { subjectEnabled: true } } }) };
accountState = { tasks: [], _studyquestV21: accountSync.blankNamespace() };

events.length = 0;
await accountSync.importLegacyDeviceCourses();
assert.equal(events[0], 'archive', 'a verified backup must be taken before any import');
assert.ok(events.includes('save'), 'the import must go through the durable save flow');
assert.equal(accountState._studyquestV21.manual.courses[0].name, 'From this laptop', 'the legacy courses must arrive');
assert.equal(accountState._studyquestV21.subjectTrack.enabled, true, 'the legacy Subject Track setting must come with them');
assert.equal(accountState._studyquestV21.migration.manualCourses.courses, 1, 'completion must be recorded to prevent a duplicate import');

await assert.rejects(() => accountSync.importLegacyDeviceCourses(), /already brought online/, 'a completed import must not run twice');

accountState = { tasks: [], _studyquestV21: { ...accountSync.blankNamespace(), manual: { version: 1, revision: 2, courses: [course('x', 'Already here')], savedAt: null } } };
await assert.rejects(() => accountSync.importLegacyDeviceCourses(), /already has manual courses/, 'an account with courses must not be overwritten by an import');

globalThis.StudyQuestV21Manual = { snapshot: async () => ({ manualCourses: { courses: [] } }) };
accountState = { tasks: [], _studyquestV21: accountSync.blankNamespace() };
await assert.rejects(() => accountSync.importLegacyDeviceCourses(), /No saved courses were found/, 'an empty device must not produce an empty import');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'durable commit ordering',
    'cross-device compare-and-swap',
    'verified readback',
    'device-failure reporting',
    'storage-error blocking',
    'device-local view isolation',
    'account-synced Subject Track',
    'debounced quick note with flush',
    'one-time guarded legacy import',
  ],
}, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
