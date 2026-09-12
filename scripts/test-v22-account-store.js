const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'v22-account-sync.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeContext(username = 'admin') {
  let state = {
    tasks: [{ id: 'task-1', title: 'Parent' }],
    _studyquestV21: {
      schemaVersion: 1,
      manual: { version: 1, revision: 0, courses: [], savedAt: null },
      note: { text: '', updatedAt: 0 },
      subjectTrack: { enabled: false },
    },
    _studyquestV22: {
      schemaVersion: 1,
      subtasks: { schemaVersion: 1, revision: 0, records: {}, trash: [], updatedAt: null },
    },
  };
  const storage = new Map();
  const document = {
    activeElement: null,
    head: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return { appendChild() {}, addEventListener() {}, setAttribute() {} }; },
    addEventListener() {},
  };
  const context = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    Set,
    Map,
    Number,
    String,
    Object,
    Array,
    Error,
    RegExp,
    setTimeout,
    clearTimeout,
    document,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    __STUDYQUEST_AUTH_USER__: { username },
    showToast() {},
    confirm: () => true,
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'v22-account-sync.js' });
  const api = context.StudyQuestV22AccountSync;
  let saveCount = 0;
  const core = {
    getState: () => state,
    getStatus: () => ({ storageError: '', conflict: false }),
    setState: next => { state = next; },
    save: async () => { saveCount += 1; },
    hostedSync: () => ({ cloudMode: false, pending: false, acknowledged: false }),
    retryUpload: () => {},
    storageKey: () => `studyquest_v3_${username}`,
    accountKey: () => username,
  };
  api.install(core);
  return { api, getState: () => state, getSaveCount: () => saveCount };
}

(async () => {
  const first = makeContext('admin');
  const manualExpected = first.api.store.read('manual-key');
  const manualNext = clone(manualExpected);
  manualNext.revision = 1;
  manualNext.courses = [{ id: 'course-1', name: 'IDT 4', rows: [], columns: [] }];
  await first.api.store.write(manualExpected, manualNext);
  assert.equal(first.getState()._studyquestV21.manual.courses[0].name, 'IDT 4');
  assert.equal(first.getState()._studyquestV22.subtasks.revision, 0);

  const subtaskExpected = first.api.subtaskStore.read('subtask-key');
  const subtaskNext = clone(subtaskExpected);
  subtaskNext.revision = 1;
  subtaskNext.records['task:task-1'] = {
    parentTaskId: 'task-1',
    subtasks: [{ id: 'sub-1', title: 'Read chapter', checked: true, order: 0, createdAt: 1, updatedAt: 1 }],
    updatedAt: new Date().toISOString(),
  };
  await first.api.subtaskStore.write(subtaskExpected, subtaskNext);
  assert.equal(first.getState()._studyquestV22.subtasks.records['task:task-1'].subtasks[0].checked, true);
  assert.equal(first.getState()._studyquestV21.manual.courses[0].id, 'course-1');

  await assert.rejects(
    first.api.subtaskStore.write(subtaskExpected, subtaskNext),
    /Another device changed these subtasks/
  );
  assert.equal(first.getSaveCount(), 2);

  const second = makeContext('qa-account');
  assert.deepEqual(second.getState()._studyquestV21.manual.courses, []);
  assert.deepEqual(second.getState()._studyquestV22.subtasks.records, {});
  assert.notDeepEqual(first.getState()._studyquestV21.manual.courses, second.getState()._studyquestV21.manual.courses);
  console.log('v22 account-backed manual-course/subtask isolation, serialization, readback, and stale-write checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
