// Hosted v21 release gate.
//
// Covers the launch requirements that can be verified without a database or a
// browser: routing and access control, version metadata, the account namespace
// and its preservation against older clients, manual-course records in the
// deletion checks, and the client rules that keep hosted pages off localhost.
// Browser behaviour is covered by test-v21-hosted-flows.js.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const server = read('server.js');
const html = read('public/claudever21.html');
const metadata = JSON.parse(read('public/v21-version.json'));
const baseline = JSON.parse(read('v21-hosted-baseline.json'));
const accountSync = require(path.join(root, 'public', 'v21-account-sync.js'));
const stateSafety = require(path.join(root, 'lib', 'state-safety.js'));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Missing ${name}`);
  const open = source.indexOf('{', start);
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

function runServerFunction(name, context) {
  const sandbox = { JSON, ...context };
  vm.runInNewContext(`${extractFunction(server, name)}\nthis.fn = ${name};`, sandbox);
  return sandbox.fn;
}

// ── 1. generated artifacts match their recorded build ────────────────────
assert.equal(metadata.version, 21, 'metadata must declare v21');
assert.equal(metadata.hosted, true, 'hosted metadata must be marked hosted');
assert.equal(metadata.localOnly, false, 'the hosted build is not laptop-only');
assert.equal(metadata.authenticated, true, 'hosted v21 is authenticated');
assert.equal(metadata.hash, sha256(html), 'v21-version.json hash must match the built page');
assert.equal(baseline.outputs['claudever21.html'], sha256(html), 'baseline must match the built page');
for (const [name, expected] of Object.entries(baseline.outputs)) {
  assert.equal(sha256(read(path.posix.join('public', name))), expected, `Generated artifact changed outside the build: ${name}`);
}
assert.equal(baseline.base['public/claudever20.html'], sha256(read('public/claudever20.html')), 'hosted v20 base changed since the v21 build');

// ── 2. the page compiles and is wired for hosted use ─────────────────────
let inlineScripts = 0;
for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  inlineScripts += 1;
  assert.doesNotThrow(() => new Function(match[1]), `inline script ${inlineScripts} must compile`);
}
assert.ok(inlineScripts >= 2, 'the hosted page must contain its inline application scripts');
for (const file of ['v21-local-features.js', 'v21-manual-courses.js', 'v21-account-sync.js', 'v21-v18-features.js', 'v21-v19-features.js', 'v21-v20-features.js']) {
  assert.doesNotThrow(() => new Function(read(path.posix.join('public', file))), `${file} must compile`);
}
assert.match(html, /const STUDYQUEST_VERSION = 21/, 'the page must report v21');
assert.match(html, /LIVE_VERSION_ENDPOINT = '\/api\/version\?version=21'/, 'hosted metadata must come from the authenticated API');
assert.doesNotMatch(html, /v21 is laptop-only/, 'the hosted page must not carry the laptop-only guard');
assert.doesNotMatch(html, /127\.0\.0\.1:3000\/claudever/, 'a hosted page must never point a user at a laptop address');
assert.doesNotMatch(html, /location\.(?:replace|assign|href\s*=)[^\n]*127\.0\.0\.1/, 'a hosted page must never navigate to localhost');

// The account-sync layer has to load and install before the manual-course
// layer, otherwise that layer opens device storage instead of the account.
const scriptOrder = [...html.matchAll(/<script src="(\/v21-[^"]+)"/g)].map(match => match[1]);
// Exercise the actual static route block, not only files or mocked browser assets.
const assetRouteStart = server.indexOf('    if ([\n      "/v21-local-features.js"');
assert.ok(assetRouteStart >= 0, 'v21 needs explicit static asset routes');
const assetRouteEnd = server.indexOf('    if (url.pathname === "/safe-sync.js")', assetRouteStart);
const assetRouteSource = server.slice(assetRouteStart, assetRouteEnd);
for (const pathname of [...scriptOrder, '/server.js', '/v21-unknown.js']) {
  let served = null;
  vm.runInNewContext(`(function () { ${assetRouteSource} })()`, {
    url: { pathname }, req: {}, res: {}, fs, path, ROOT: root,
    send: (_req, _res, status, body, headers) => { served = { status, body, headers }; },
  });
  if (!scriptOrder.includes(pathname)) {
    assert.equal(served, null, 'the static route must not expose unlisted files');
    continue;
  }
  assert.equal(served?.status, 200, `${pathname} must be served`);
  assert.match(served.headers['content-type'], /javascript/);
  assert.equal(sha256(served.body), sha256(read(`public${pathname}`)), `${pathname} must serve the exact file`);
}
assert.ok(scriptOrder.indexOf('/v21-account-sync.js') < scriptOrder.indexOf('/v21-manual-courses.js'), 'account sync must load before manual courses');
assert.match(html, /StudyQuestV21AccountSync\?\.install\(window\.studyQuestV21Core\);\s*\n\s*window\.StudyQuestV21Manual\?\.install/, 'account sync must install before manual courses');
assert.match(html, /studyQuestV21Core\.hostedSync/, 'the hosted bridge must expose sync state');
assert.match(html, /studyQuestV21Core\.retryUpload/, 'the hosted bridge must expose the retry entry point');
assert.match(html, /window.location.href = '\/app.html\?next=v21'/, 'an expired v21 session must return to v21 after login');
const loginHtml = runServerFunction('v21LoginHtml', {})(read('public/claudever9.html'));
assert.match(loginHtml, /if \(!user.legacy && next === "v21"\) \{ window.location.replace\("\/v21"\); return; \}/, 'v21 login must preserve its requested destination');
assert.ok(server.includes('if (url.searchParams.get("next") === "v21") stableHtml = v21LoginHtml(stableHtml);'), 'older login responses must remain unchanged');

// ── 3. access control ────────────────────────────────────────────────────
const canAccessV21 = mode => (user, canary = []) => runServerFunction('canAccessV21', {
  V21_ACCESS_MODE: mode,
  ADMIN_USERNAME: 'admin',
  V21_CANARY_USERS: new Set(canary),
})(user);

const admin = { username: 'admin' };
const member = { username: 'anya' };
const outsider = { username: 'someone' };
const deviceCredential = { username: 'anya', sync_device_id: 'device-1' };

assert.equal(canAccessV21('off')(admin), false, 'off must close for admin too');
assert.equal(canAccessV21('off')(member, ['anya']), false, 'off must close for allowlisted users');
assert.equal(canAccessV21('canary')(admin), true, 'canary includes admin');
assert.equal(canAccessV21('canary')(member, ['anya']), true, 'canary includes the allowlist');
assert.equal(canAccessV21('canary')(outsider, ['anya']), false, 'canary excludes everyone else');
assert.equal(canAccessV21('canary')(member, []), false, 'an empty allowlist admits only admin');
assert.equal(canAccessV21('all')(outsider), true, 'all admits every account');
assert.equal(canAccessV21('all')(deviceCredential), false, 'a device sync credential is never a user session');
assert.equal(canAccessV21('all')(null), false, 'a signed-out request has no access');

for (const marker of [
  'String(process.env.STUDYQUEST_V21_ACCESS || "off")',
  '["off", "canary", "all"].includes(configured) ? configured : "off"',
  'String(process.env.STUDYQUEST_V21_CANARY_USERS || "")',
  'return ["15", "19", "21"].includes(configured) ? configured : "15"',
  'url.pathname === "/v21" || url.pathname === "/claudever21.html"',
  'MAIN_APP_VERSION === "21" && canAccessV21(user)',
  'window.__STUDYQUEST_V21_HOSTED__=true',
  'v21AccessMode: V21_ACCESS_MODE',
  'versionNumber === 21 ? V21_VERSION_PATH',
]) assert.ok(server.includes(marker), `Hosted server is missing a v21 marker: ${marker}`);

// The v21 route must require a session, then the access gate, and must send a
// refused user to the stable app rather than to a laptop address.
const routeStart = server.indexOf('if (url.pathname === "/v21" || url.pathname === "/claudever21.html")');
const route = server.slice(routeStart, routeStart + 900);
assert.ok(route.includes('if (!user || user.sync_device_id)'), 'the v21 route must require a user session');
assert.ok(route.includes('location: "/app.html?next=v21"'), 'a signed-out visitor must be sent to login');
assert.ok(route.includes('if (!canAccessV21(user))'), 'the v21 route must be fail-closed');
assert.ok(route.includes('location: "/app.html?stable=1"'), 'a refused account must keep the stable app');
assert.ok(route.includes('authenticatedV21Html(user)'), 'the v21 route must serve the authenticated page');
assert.doesNotMatch(route, /127\.0\.0\.1/, 'the v21 route must never redirect to localhost');

// Older routes must survive as fallbacks.
for (const fallback of ['url.pathname === "/v19"', 'url.pathname === "/v20"', 'url.pathname === "/v16"', 'canAccessV15(user)']) {
  assert.ok(server.includes(fallback), `Existing version route must remain available: ${fallback}`);
}

// ── 4. account namespace preservation ────────────────────────────────────
const preserveV21Namespace = runServerFunction('preserveV21Namespace', { V21_NAMESPACE_KEY: '_studyquestV21' });
const stored = { _studyquestV21: { schemaVersion: 1, manual: { revision: 4, courses: [{ id: 'c1' }] } }, tasks: [] };

const fromOldClient = preserveV21Namespace(stored, { tasks: [{ id: 't1' }] });
assert.equal(fromOldClient.preserved, true, 'an omitted namespace must be preserved');
assert.deepEqual(fromOldClient.state._studyquestV21, stored._studyquestV21, 'the stored namespace must survive unchanged');
assert.deepEqual(fromOldClient.state.tasks, [{ id: 't1' }], 'the rest of the incoming state must be untouched');

const fromV21Client = preserveV21Namespace(stored, { tasks: [], _studyquestV21: { schemaVersion: 1, manual: { revision: 5, courses: [] } } });
assert.equal(fromV21Client.preserved, false, 'a v21 client owns its own namespace');
assert.equal(fromV21Client.state._studyquestV21.manual.revision, 5, 'an explicit namespace write must win');

const explicitNull = preserveV21Namespace(stored, { _studyquestV21: null });
assert.equal(explicitNull.preserved, false, 'an explicit null is a deliberate write, not an omission');

const noStoredNamespace = preserveV21Namespace({ tasks: [] }, { tasks: [] });
assert.equal(noStoredNamespace.preserved, false, 'there is nothing to preserve for an account without v21 data');

// Preservation must run inside the save transaction, after the v20 overlay.
assert.match(server, /const protectedV21Namespace = preserveV21Namespace\(row\.state, protectedV20Overlay\.state\)/, 'namespace preservation must chain after the v20 overlay');
assert.match(server, /if \(protectedV20Overlay\.preserved \|\| protectedV21Namespace\.preserved\)/, 'either preservation must trigger re-serialisation');
assert.ok(server.includes('STATE_TOO_LARGE_AFTER_V21_NAMESPACE_PRESERVATION'), 'an oversized preserved state must be auditable');

// No new SQL schema is introduced by this release.
assert.doesNotMatch(read('schema.sql'), /_studyquestV21|studyquest_v21/i, 'v21 must not add SQL schema');

// ── 5. manual courses take part in the safety checks ─────────────────────
const withCourses = {
  _studyquestV21: {
    manual: {
      courses: [{ id: 'c1', name: 'IDT 4', rows: [{ id: 'r1', name: 'Lecture 1' }], columns: [{ id: 'k1', name: 'Read' }] }],
    },
  },
};
const withoutCourses = { _studyquestV21: { manual: { courses: [] } } };
const diff = stateSafety.stateRecordDiff(withCourses, withoutCourses);
const removedCollections = diff.removed.map(record => record.collection);
assert.ok(removedCollections.includes('_studyquestV21.manual.courses'), 'a removed course must be detected');
assert.ok(removedCollections.includes('_studyquestV21.manual.courses.rows'), 'a removed lecture must be detected');
assert.ok(removedCollections.includes('_studyquestV21.manual.courses.columns'), 'a removed column must be detected');
assert.equal(stateSafety.stateRecordDiff(withCourses, withCourses).removed.length, 0, 'an unchanged course set removes nothing');

// A course carried through an unrelated edit must not look like a deletion.
const unrelatedEdit = JSON.parse(JSON.stringify(withCourses));
unrelatedEdit.tasks = [{ id: 't1', title: 'New' }];
assert.equal(stateSafety.stateRecordDiff(withCourses, unrelatedEdit).removed.length, 0, 'adding a task must not flag course removal');

// ── 6. the account namespace contract ────────────────────────────────────
const blank = accountSync.blankNamespace();
assert.equal(blank.schemaVersion, 1, 'the namespace must carry a schema version');
assert.deepEqual(blank.manual.courses, [], 'a new account starts with no manual courses');
assert.equal(blank.subjectTrack.enabled, false, 'Subject Track is off until it is enabled');

const future = accountSync.normalizeNamespace({ schemaVersion: 9, unknownFutureField: { keep: true }, manual: { revision: 2, courses: [{ id: 'c' }] } });
assert.deepEqual(future.unknownFutureField, { keep: true }, 'unknown fields from a newer client must be preserved');
assert.equal(future.schemaVersion, 9, 'a newer schema version must not be downgraded');
assert.equal(future.manual.revision, 2, 'a valid revision must survive normalising');

for (const junk of [null, 'text', 42, []]) {
  assert.deepEqual(accountSync.normalizeNamespace(junk), blank, 'unusable namespace data must fall back to a blank namespace');
}
assert.equal(accountSync.normalizeNamespace({ manual: { revision: -1 } }).manual.revision, 0, 'a negative revision must be rejected');
assert.equal(accountSync.normalizeNamespace({ note: { text: 5 } }).note.text, '', 'a non-string note must not be trusted');
assert.equal(accountSync.normalizeNamespace({ subjectTrack: { enabled: 'yes' } }).subjectTrack.enabled, false, 'only a real boolean enables Subject Track');

// The compare-and-swap key must cover the account half and ignore the
// device-local view, so a second tab's navigation never blocks a save.
const recordA = { revision: 1, courses: [{ id: 'c' }], settings: { subjectEnabled: false, view: 'week' } };
const recordB = { revision: 1, courses: [{ id: 'c' }], settings: { subjectEnabled: false, view: 'manual' } };
const recordC = { revision: 2, courses: [{ id: 'c' }], settings: { subjectEnabled: false, view: 'week' } };
assert.equal(accountSync.accountPortion(recordA), accountSync.accountPortion(recordB), 'the device-local view must not take part in the compare-and-swap');
assert.notEqual(accountSync.accountPortion(recordA), accountSync.accountPortion(recordC), 'a revision change must break the compare-and-swap');
assert.equal(accountSync.TEXT_DEBOUNCE_MS, 500, 'text edits must settle after 500 ms');

// The layer itself must reach the network only through the page's save flow.
const accountSyncSource = read('public/v21-account-sync.js');
assert.doesNotMatch(accountSyncSource, /\bfetch\s*\(|\bXMLHttpRequest\b|navigator\.sendBeacon/, 'the account-sync layer must not perform its own requests');
assert.doesNotMatch(read('public/v21-manual-courses.js'), /\bfetch\s*\(|\bXMLHttpRequest\b/, 'the manual-course layer must not perform its own requests');

// ── 7. recovery is one screen ────────────────────────────────────────────
const features = read('public/v21-local-features.js');
assert.doesNotMatch(features, /recoveryStep/, 'the step wizard must be gone');
assert.doesNotMatch(features, /v21RecoveryNext|v21RecoveryBack|v21RecoveryConfirm/, 'Next, Back, and the confirmation checkbox must be gone');
assert.match(features, /id="v21RecoveryApply"/, 'one Apply button must remain');
assert.match(features, /id="v21RecoveryExport"/, 'Download copies must remain');
assert.match(features, /id="v21RecoveryLater"/, 'Decide later must remain');
assert.match(features, /recoveryApplyLabel/, 'the Apply button must say what it will do');
assert.match(features, /function recoveryBlockReason/, 'unresolved choices must block Apply with a stated reason');
assert.match(features, /role="radiogroup"/, 'the choice must be reachable by keyboard as a group');

// ── 8. bounded autosave history, protected archives excluded ─────────────
assert.match(html, /const DEVICE_RECOVERY_COPY_LIMIT = 20/, 'ordinary history must stay bounded at 20 copies');
assert.match(html, /retainedBytes \+ rowBytes > 40 \* 1024 \* 1024/, 'the existing 40 MB per-account budget must be kept');
assert.match(html, /rows\.filter\(row => row && row\.protectedCopy !== true\)/, 'protected archives must be excluded from routine cleanup');
assert.match(html, /protectedCopy:protectedCopy === true/, 'a recovery snapshot must be able to mark itself protected');
assert.match(html, /'Before v21 reviewed recovery', \{ protectedCopy:true \}/, 'the recovery archive must be protected from cleanup');
assert.doesNotMatch(html, /async function pruneV13DeviceRecoveryCopies\(\) \{ return;/, 'history pruning must not be disabled outright');

console.log(JSON.stringify({
  ok: true,
  v21Sha256: sha256(html),
  route: '/v21',
  aliases: ['/claudever21.html'],
  access: 'authenticated',
  defaultAccessMode: 'off',
  accessModes: ['off', 'canary', 'all'],
  mainVersionSupported: ['15', '19', '21'],
  accountNamespace: '_studyquestV21',
  recovery: 'single-screen',
}, null, 2));
