const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { preserveSubtaskNamespaces } = require('../lib/v24-safety');
const { stateRecordDiff } = require('../lib/state-safety');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const manifest = JSON.parse(read('public/v24-version.json'));
for (const [file, hash] of Object.entries({ 'claudever24.html':manifest.hash, ...manifest.assets })) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'public',file))).digest('hex'),hash,file);
const html = read('public/claudever24.html');
assert.doesNotMatch(html, /location\.(replace|assign)[^\n]*127\.0\.0\.1/);
assert.match(html, /const STUDYQUEST_VERSION = 24/);
assert.match(html, /compact-interface.css/);
assert.doesNotMatch(html, /body class="sq-v24"|src="\/v24-interface.js"/);
// Regenerating v24 from an older base must not silently remove the safety patch.
assert.match(html, /V24_VERIFIED_SAVE_BEGIN/);
assert.doesNotMatch(html, /clearV13DeviceOutboxThrough\(/);
const source = read('server.js');
const access = source.slice(source.indexOf('function canAccessV24'),source.indexOf('function authenticatedV24Html'));
for (const mode of ['off','canary','all','invalid']) {
  const check = vm.runInNewContext(access + '\ncanAccessV24', {V24_ACCESS_MODE:mode === 'invalid' ? 'off' : mode,ADMIN_USERNAME:'admin',V24_CANARY_USERS:new Set(['qa'])});
  assert.equal(check(null),false);
  assert.equal(check({username:'admin',sync_device_id:'token'}),false);
  assert.equal(check({username:'qa'}),['canary','all'].includes(mode));
  assert.equal(check({username:'ordinary'}),mode === 'all');
}
const collection = {schemaVersion:1,subtasks:{schemaVersion:1,revision:1,records:{occurrence:{parentTaskId:'a',subtasks:[{id:'s',title:'Keep'}]}},trash:[]}};
const current = {_studyquestSubtasks:collection,_studyquestV23:collection,tasks:[{id:'a'}]};
const incoming = {tasks:[{id:'a',title:'Edited by old client'}]};
const saved = preserveSubtaskNamespaces(current,incoming);
assert.equal(saved.preserved,true);
assert.deepEqual(saved.state._studyquestSubtasks,collection);
assert.equal(incoming._studyquestSubtasks,undefined);
assert.ok(stateRecordDiff(current,{...current,_studyquestSubtasks:{...collection,subtasks:{...collection.subtasks,records:{}}}}).removed.length > 0,'subtask removal must be visible to the server');
console.log('v24 artifact hashes, access matrix, and older-client namespace/removal protection passed.');
