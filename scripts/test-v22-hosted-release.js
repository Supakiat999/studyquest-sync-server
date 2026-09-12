const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stateRecordDiff } = require('../lib/state-safety');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const server = read('server.js');
const manifest = JSON.parse(read('public/v22-version.json'));

assert.match(server, /STUDYQUEST_V22_ACCESS/);
assert.match(server, /STUDYQUEST_V22_CANARY_USERS/);
assert.match(server, /url\.pathname === "\/v22"/);
assert.match(server, /url\.pathname === "\/claudever22\.html"/);
assert.match(server, /url\.pathname === "\/v22-version\.json"/);
assert.match(server, /preserveV22Namespace/);
assert.match(server, /V22_NAMESPACE_KEY = "_studyquestV22"/);
assert.match(server, /requestedVersion === "22"/);
assert.match(server, /v22AccessMode/);
assert.match(server, /location: "\/app\.html\?next=v22"/);
assert.match(server, /MAIN_APP_VERSION === "21"/);
assert.match(server, /return \["15", "19", "21"\]\.includes/);

const html = read('public/claudever22.html');
assert.doesNotMatch(html, /location\.replace\(['"]http:\/\/127\.0\.0\.1:3000/);
for (const asset of [
  'v22-v18-features.js', 'v22-v19-features.js', 'v22-v20-features.js',
  'v22-local-features.js', 'v22-account-sync.js', 'v22-manual-courses.js', 'v22-subtasks.js',
]) assert.match(html, new RegExp(`/` + asset.replace(/[.]/g, '\\.') ));
assert.match(html, /StudyQuestV22AccountSync\?\.install/);

for (const [asset, expected] of Object.entries(manifest.assets)) {
  assert.equal(sha256(`public/${asset}`), expected, `${asset} hash`);
}
assert.equal(sha256('public/claudever22.html'), manifest.hash, 'v22 page hash');
assert.equal(manifest.route, '/v22');
assert.deepEqual(manifest.aliases, ['/claudever22.html']);
assert.equal(manifest.hosted, true);
assert.equal(manifest.authenticated, true);
assert.equal(manifest.main, false);

const current = {
  tasks: [{ id: 'task-1', title: 'Parent' }],
  _studyquestV22: {
    schemaVersion: 1,
    subtasks: {
      schemaVersion: 1,
      revision: 2,
      records: {
        'task:task-1': {
          parentTaskId: 'task-1',
          subtasks: [{ id: 'sub-1', title: 'Read', checked: false }],
        },
      },
      trash: [],
    },
  },
};
const olderClient = { tasks: [{ id: 'task-1', title: 'Parent' }] };
const diff = stateRecordDiff(current, olderClient);
assert.ok(diff.removed.some(record => record.key.startsWith('_studyquestV22.subtasks.records')));
assert.ok(diff.removed.some(record => record.key.includes('v22-subtask')));

for (const yaml of ['render.yaml', 'render-neon-free.yaml']) {
  const text = read(yaml);
  assert.match(text, /STUDYQUEST_V22_ACCESS/);
  assert.match(text, /STUDYQUEST_V22_CANARY_USERS/);
  assert.match(text, /STUDYQUEST_MAIN_VERSION[\s\S]*value: "15"/);
}

console.log('v22 hosted route, access gate, namespace preservation, manifest, and focused safety checks passed.');
