const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/claudever20.html');
const featureSource = read('public/v20-local-features.js');
const server = read('server.js');
const metadata = JSON.parse(read('public/v20-version.json'));

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Missing ${name}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `Missing body for ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

function compileInlineScripts(source, label) {
  const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim());
  assert.ok(scripts.length >= 2, `${label} must contain inline application scripts`);
  scripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), `${label} inline script ${index + 1} should compile`);
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canAccess(mode, user) {
  const source = extractFunction(server, 'canAccessV20');
  const context = { V20_ACCESS_MODE: mode, ADMIN_USERNAME: 'admin' };
  vm.runInNewContext(`${source}\nthis.canAccessV20 = canAccessV20;`, context);
  return context.canAccessV20(user);
}

function preserveOverlay(currentState, incomingState) {
  const source = extractFunction(server, 'preserveV20Overlay');
  const context = { V20_OVERLAY_KEY: 'weeklyV20', JSON };
  vm.runInNewContext(`${source}\nthis.preserveV20Overlay = preserveV20Overlay;`, context);
  return context.preserveV20Overlay(currentState, incomingState);
}

compileInlineScripts(html, 'v20');
assert.doesNotThrow(() => new Function(featureSource), 'v20 feature module should compile');

for (const marker of [
  'const STUDYQUEST_VERSION = 20',
  "const LIVE_VERSION_ENDPOINT = '/api/version?version=20'",
  'const V20_READ_ONLY_STARTUP = true',
  'window.__STUDYQUEST_V20_HOSTED__',
  'window.studyQuestV20Install?.()',
  'window.studyQuestV20AfterRender?.()',
  'window.studyQuestV20Core = {',
  'saveState: saveV20LocalState',
  '/v18-local-features.js',
  '/v19-local-features.js',
  '/v20-local-features.js',
  'function isHostedV20CloudMode()',
  'if (isHostedV20CloudMode() && options.rollback !== true) return saveState();',
  'const cloudMutation = trackedChanges.length && (isHostedAppHost() || liveSync.paired)',
  'const stillCurrent = statesEquivalent(cloneV20CloudState(state), cloneV20CloudState(snapshot));',
  'if (stillCurrent && canUseServerStorage() && shouldQueueCloud) queueServerStateSave();',
  'if (isHostedV20CloudMode() && options.rollback !== true) return saveState();',
  "const v20LocalOnly = !isHostedV20CloudMode() && segments[0] === 'tracker'",
  'if (!isHostedV20CloudMode() && snapshot?.tracker',
  'if (isHostedV20CloudMode()) return target;',
  'browser mirror unavailable',
  'authoritative:true',
]) assert.ok(html.includes(marker), `Missing v20 marker: ${marker}`);

assert.match(html, /const ACTIVE_STORAGE_KEY = AUTHENTICATED_STORAGE_USERNAME\s*\n\s*\? `\$\{STORAGE_KEY\}_\$\{AUTHENTICATED_STORAGE_USERNAME\}`/);
assert.match(html, /const V20_LOCAL_ONLY_TRACKER_KEY = 'weeklyV20'/);
assert.match(html, /persistV13DeviceState\(snapshot, \{[\s\S]*browserSaved/);
assert.match(html, /markV13DeviceStateAuthoritative\(snapshot/);
assert.match(html, /current\.state, snapshot/);
assert.match(html, /tracker\?\.\[V20_LOCAL_ONLY_TRACKER_KEY\]/);
assert.doesNotMatch(featureSource, /fetch\s*\(/, 'v20 feature module must not make network requests directly');
assert.doesNotMatch(html, /localStorage\.clear\s*\(/, 'v20 must not clear browser storage');
assert.doesNotMatch(html, /localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/, 'v20 must not remove the main save');

const noteStart = featureSource.indexOf('function writeNote');
const weeklyStart = featureSource.indexOf('// ── v20 Weekly Subject Tracking');
assert.ok(noteStart >= 0 && weeklyStart > noteStart, 'v20 note module boundaries should be present');
assert.doesNotMatch(featureSource.slice(noteStart, weeklyStart), /saveState\s*\(/, 'note persistence must not save application state');
assert.match(featureSource, /hostedCloudMode\(\)/);
assert.match(featureSource, /setSQState\?\.\(previous, \{ resetSyncBaseline:true \}\)/);
assert.match(featureSource, /saveState\(\{ rollback:true, label \}\)/);
assert.match(featureSource, /account-synced overlay|v20 account sync/);
assert.match(featureSource, /browser-local/);
assert.match(featureSource, /WEEKLY_OVERLAY_KEY = 'weeklyV20'/);
assert.match(featureSource, /WEEKLY_VIEW_STORAGE_SUFFIX = '_v20_weekly_ui'/);
assert.match(featureSource, /NOTE_STORAGE_SUFFIX = '_v20_exam_note'/);

const features = require(path.join(root, 'public/v20-local-features.js'));
assert.equal(features.WEEKLY_OVERLAY_KEY, 'weeklyV20');
assert.equal(features.NOTE_STORAGE_SUFFIX, '_v20_exam_note');
assert.equal(features.WEEKLY_VIEW_STORAGE_SUFFIX, '_v20_weekly_ui');
assert.deepEqual(features.normalizeWeeklySubjectRange({ startWeekId:'w1', endWeekId:'w2', future:'keep' }), {
  startWeekId:'w1', endWeekId:'w2', future:'keep',
});

const admin = { username:'admin' };
const ordinary = { username:'anya' };
const deviceToken = { username:'admin', sync_device_id:123 };
assert.equal(canAccess('off', admin), false);
assert.equal(canAccess('off', ordinary), false);
assert.equal(canAccess('admin', admin), true);
assert.equal(canAccess('admin', ordinary), false);
assert.equal(canAccess('all', admin), true);
assert.equal(canAccess('all', ordinary), true);
assert.equal(canAccess('all', deviceToken), false);
assert.equal(canAccess('all', null), false);

const routeStart = server.indexOf('if (url.pathname === "/v20"');
const routeEnd = server.indexOf('if (url.pathname === "/")', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'v20 route block should be present');
const route = server.slice(routeStart, routeEnd);
for (const marker of [
  'url.pathname === "/claudever20.html"',
  'if (!user || user.sync_device_id)',
  'location: "/app.html?next=v20"',
  'if (!canAccessV20(user))',
  'location: "/app.html?stable=1"',
  'authenticatedV20Html(user)',
]) assert.ok(route.includes(marker), `v20 route is missing ${marker}`);

for (const marker of [
  'const V20_HTML_PATH',
  'const V20_FEATURES_PATH',
  'const V20_VERSION_PATH',
  'const V20_ACCESS_MODE',
  'function authenticatedV20Html',
  'function canAccessV20',
  'requestedVersion === "20"',
  'v20AccessMode: V20_ACCESS_MODE',
  'url.pathname === "/v20-local-features.js"',
  'route: "/v20"',
  'aliases: ["/claudever20.html"]',
  'mainVersion: MAIN_APP_VERSION',
  'return ["15", "19"].includes(configured) ? configured : "15"',
  'where username = $1 for update',
  'preserveV20Overlay(row.state, incomingState)',
  'STATE_TOO_LARGE_AFTER_V20_OVERLAY_PRESERVATION',
  'v20OverlayPreserved:protectedV20Overlay.preserved',
]) assert.ok(server.includes(marker), `Hosted server is missing v20 marker: ${marker}`);
assert.match(server, /String\(process\.env\.STUDYQUEST_V20_ACCESS \|\| "off"\)/);
assert.match(server, /const versionPath = versionNumber === 20 \? V20_VERSION_PATH/);
assert.match(server, /source: versionNumber === 20 \? "claudever20\.html"/);

const protectedOverlay = {
  version:1,
  layouts:{ sem1:{ stages:[{ id:'lecture', label:'Lecture', order:0 }] } },
  cells:{ week1:{ row1:{ lecture:true } } },
};
const current = {
  username:'admin',
  updatedAt:78,
  tasks:[{ id:'task-admin', title:'Admin task' }],
  tracker:{ weeklyV20:protectedOverlay, legacy:'keep-current' },
};
const olderCandidate = {
  username:'admin',
  updatedAt:301,
  tasks:[{ id:'task-admin', title:'Admin task edited by older client' }],
  tracker:{ legacy:'candidate' },
};
const preserved = preserveOverlay(current, olderCandidate);
assert.equal(preserved.preserved, true, 'older candidate should preserve unfamiliar weeklyV20');
assert.deepEqual(preserved.state.tracker.weeklyV20, protectedOverlay);
assert.equal(preserved.state.tracker.legacy, 'candidate');
assert.notStrictEqual(preserved.state.tracker.weeklyV20, current.tracker.weeklyV20, 'preserved overlay must be cloned');
assert.deepEqual(current.tracker.weeklyV20, protectedOverlay, 'current overlay must not be mutated');

const explicitCandidate = clone(olderCandidate);
explicitCandidate.tracker.weeklyV20 = { version:1, layouts:{ sem1:{ stages:[] } }, cells:{} };
const explicit = preserveOverlay(current, explicitCandidate);
assert.equal(explicit.preserved, false, 'explicit weeklyV20 candidate must win');
assert.strictEqual(explicit.state, explicitCandidate);
assert.deepEqual(explicit.state.tracker.weeklyV20, explicitCandidate.tracker.weeklyV20);

const emptyCurrent = { username:'admin', updatedAt:78, tasks:[], tracker:{} };
const emptyResult = preserveOverlay(emptyCurrent, olderCandidate);
assert.equal(emptyResult.preserved, false);
assert.strictEqual(emptyResult.state, olderCandidate);

const idempotent = preserveOverlay(current, preserved.state);
assert.equal(idempotent.preserved, false, 'a candidate that carries weeklyV20 should be idempotent');
assert.strictEqual(idempotent.state, preserved.state);
assert.match(server, /select username, state, state_bytes, state_hash, state_revision, state_updated_at, updated_at/);
assert.match(server, /where username = \$1/, 'cloud state access must remain account-scoped');

assert.equal(metadata.version, 20);
assert.equal(metadata.source, 'claudever20.html');
assert.equal(metadata.route, '/v20');
assert.ok(metadata.aliases.includes('/claudever20.html'));
assert.equal(metadata.hash, sha256('public/claudever20.html'));
assert.equal(metadata.localOnly, false);
assert.equal(metadata.deployed, true);
assert.equal(metadata.authenticated, true);
assert.equal(metadata.main, false);
assert.equal(metadata.defaultAccessMode, 'off');
assert.equal(metadata.startupReadOnly, true);
assert.equal(metadata.accessMode, 'off');

for (const yaml of ['render.yaml', 'render-neon-free.yaml']) {
  const content = read(yaml);
  assert.match(content, /key:\s*STUDYQUEST_V20_ACCESS\s*\r?\n\s*value:\s*["']?off["']?/);
  assert.match(content, /key:\s*STUDYQUEST_MAIN_VERSION\s*\r?\n\s*value:\s*["']?15["']?/);
}

const v19Hash = sha256('public/claudever19.html');
const v19Metadata = JSON.parse(read('public/v19-version.json'));
assert.equal(v19Metadata.hash, v19Hash, `v19 metadata hash does not match HTML: ${v19Hash}`);
for (const [file, expected] of Object.entries({
  'public/claudever9.html': 'f9feb74a9aea159d4432449f79da7b9c0dd7509122a4cf64a1600382ecc60e13',
  'public/claudever13.html': 'c6b8073bcecca777c7ae0acf2d4948d208b6925965d6e6396166a4e1c14b645f',
  'public/claudever14.html': '4dccb2a1fbd9023a1047f7197d900e7baf5e822fb6f62ec2862eb84bfeceab8d',
  'public/claudever15.html': 'c99b6c9ed4f47d01e7d5fe1d74dc7a76b39a926a3901a13cf7081836385031e3',
  'public/claudever16.html': '7354ebba898364bd457472927029c77ae69081257d9a48ba6f1ec0e118cf5011',
})) assert.equal(sha256(file), expected, `${file} changed during v20 rollout`);

console.log(JSON.stringify({
  ok:true,
  v20Sha256:metadata.hash,
  route:metadata.route,
  access:metadata.authenticated ? 'authenticated' : 'not-authenticated',
  defaultAccessMode:metadata.defaultAccessMode,
  v19Sha256:v19Hash,
  weeklyOverlay:'hosted-account-sync-with-older-client-preservation',
}, null, 2));
