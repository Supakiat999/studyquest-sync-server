const assert = require('node:assert/strict');
const { validateSnapshot } = require('./monitor-v19-rollout');
const { compareAccounts } = require('./audit-v19-rollout');

process.env.STUDYQUEST_EXPECTED_V19_ACCESS = 'off';
process.env.STUDYQUEST_EXPECTED_MAIN_VERSION = '15';

const redirect = { status:302, location:'/app.html?stable=1' };
const healthy = {
  renderStatus:{ status:200, body:{ status:{ indicator:'none' } } },
  renderIncidents:{ status:200, body:{ incidents:[] } },
  health:{ ok:true, body:{ ok:true, db:'postgres', v19AccessMode:'off', mainVersion:'15' } },
  v19:{ ok:true, body:{ version:19, hash:'v19' } },
  v15:{ ok:true, body:{ version:15, hash:'v15' } },
  root:redirect, v15Route:redirect, v19Route:redirect,
};
assert.deepEqual(validateSnapshot(healthy), []);
assert.ok(validateSnapshot({ ...healthy, health:{ ok:true, body:{ ...healthy.health.body, mainVersion:'19' } } }).length > 0);

const previous = [{ username:'anya', revision:10, summary:{ tasks:5, notes:2 } }];
assert.deepEqual(compareAccounts(previous, [{ username:'anya', revision:11, summary:{ tasks:6, notes:2 } }]), []);
assert.ok(compareAccounts(previous, [{ username:'anya', revision:11, summary:{ tasks:4, notes:2 } }]).some((item) => item.includes('tasks decreased')));
assert.ok(compareAccounts(previous, []).some((item) => item.includes('account is missing')));

console.log('v19 rollout monitor and account-baseline comparison tests passed.');
