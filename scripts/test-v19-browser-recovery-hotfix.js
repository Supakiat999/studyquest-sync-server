const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'claudever19.html'), 'utf8');
assert.match(html, /indexedDB\.open\(DEVICE_RECOVERY_DB\)/, 'v19 must accept existing newer recovery schemas');
assert.doesNotMatch(html, /indexedDB\.open\(DEVICE_RECOVERY_DB,/, 'v19 must not downgrade recovery storage');
assert.match(html, /<details class="smart-merge-details"><summary>Show copy counts, dates, and selection totals<\/summary>/);

function extractFunction(source, name) {
  const candidates = [`function ${name}`, `async function ${name}`];
  const starts = candidates.map(marker => source.indexOf(marker)).filter(index => index >= 0);
  assert.ok(starts.length, `Missing ${name}`);
  const start = Math.min(...starts);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

for (const marker of [
  '<script src="/recovery-ux-v2-core.js"></script>',
  'Load account backup on this computer',
  "This computer's saved copy",
  'Account backup',
  'Advanced recovery choices',
  'Download both copies + reviewed merge',
]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

const helperSource = [
  extractFunction(html, 'selectedSmartMergeChoice'),
  extractFunction(html, 'smartMergeUsesOnly'),
].join('\n');
const helperContext = {};
vm.runInNewContext(`${helperSource}\nthis.smartMergeUsesOnly = smartMergeUsesOnly;`, helperContext);
const preview = {
  selections:{ a:'cloud', b:'cloud' },
  smartMerge:{ unresolved:0, decisions:[{ path:'a', selected:'local' }, { path:'b', recommended:'cloud' }] },
};
assert.equal(helperContext.smartMergeUsesOnly(preview, 'cloud'), true);
preview.selections.b = 'local';
assert.equal(helperContext.smartMergeUsesOnly(preview, 'cloud'), false);
preview.selections.b = 'cloud';
preview.smartMerge.unresolved = 1;
assert.equal(helperContext.smartMergeUsesOnly(preview, 'cloud'), false);

const loadSource = extractFunction(html, 'loadReviewedAccountBackupOnThisComputer');
assert.doesNotMatch(loadSource, /method\s*:\s*['"]POST['"]/i, 'Device-only load must never POST');
assert.doesNotMatch(loadSource, /saveStateToCloud\s*\(/, 'Device-only load must never save the account backup');
assert.match(loadSource, /archiveAndLoadAccountBackup/);
assert.match(loadSource, /pendingCloudMutation\s*=\s*null/);
assert.match(loadSource, /v13DurableOutboxPending\s*=\s*false/);

const applySource = extractFunction(html, 'applySmartMerge');
const localLoadIndex = applySource.indexOf("smartMergeUsesOnly(preview, 'cloud')");
const cloudSaveIndex = applySource.indexOf('saveStateToCloud({');
assert.ok(localLoadIndex >= 0, 'Cloud-only merge must have a device-load branch');
assert.ok(cloudSaveIndex > localLoadIndex, 'Device-only branch must run before any cloud-save path');
assert.match(applySource.slice(localLoadIndex, cloudSaveIndex), /loadReviewedAccountBackupOnThisComputer/);

const resolveSource = extractFunction(html, 'resolveLiveSyncConflict');
assert.match(resolveSource, /chooseEveryMergeField\(choice\)/);
assert.match(resolveSource, /await applySmartMerge\(\)/);
const advancedSource = extractFunction(html, 'prepareLiveSyncConflictChoice');
assert.doesNotMatch(advancedSource, /applySmartMerge\s*\(/, 'Advanced computer-copy selection must not immediately write');

assert.doesNotMatch(html, /onclick="resolveLiveSyncConflict\('local'\)"/, 'Computer-to-account replacement must not be a one-click action');

console.log(JSON.stringify({
  ok:true,
  behavior:'archive-first device-only account-backup load',
  cloudWriteOnAccountBackupLoad:false,
  staleComputerReplacementOneClick:false,
}, null, 2));
