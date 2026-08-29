const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const server = read('server.js');
const v13 = read('public/claudever13.html');
const v14 = read('public/claudever14.html');
const v15 = read('public/claudever15.html');
const stable = read('public/claudever9.html');
const v14Version = JSON.parse(read('public/v14-version.json'));
const v15Version = JSON.parse(read('public/v15-version.json'));
const renderYaml = read('render.yaml');
const renderNeonYaml = read('render-neon-free.yaml');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function parseInlineScripts(html, label) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim());
  assert(scripts.length >= 2, `${label} must contain inline application scripts`);
  scripts.forEach((script, index) => {
    try { new Function(script); } catch (error) { throw new Error(`${label} inline script ${index + 1}: ${error.message}`); }
  });
}

parseInlineScripts(v15, 'v15');

for (const marker of [
  'const STUDYQUEST_VERSION = 15',
  "file: 'claudever15.html'",
  "const STORAGE_KEY = 'studyquest_v3'",
  'const TASK_PROGRESS_VALUES = [0, 25, 50, 75]',
  'const TASK_ALL_PROGRESS_VALUES = TASK_PROGRESS_VALUES',
  'function parseTaskDurationMinutes',
  'function renderTaskInlineControls',
  'task-inline-controls',
  'task-duration-inline',
  'task-progress-buttons',
  'task-progress-complete',
  'setTaskProgress',
  'toggleDone',
  "const LIVE_VERSION_ENDPOINT = '/api/version?version=15'",
  'weeklyV14',
  "source:'v15-smart-merge'",
  'function mergeRelevantStatesEquivalent',
  'function rebaseSmartMergePreview',
  'function reviewPendingLiveSyncConflict',
  'Sync review needed — both copies are safe',
]) assert(v15.includes(marker), `Missing v15 marker: ${marker}`);

assert(!v15.includes('task-control-strip'), 'v15 must not render the old full-width task control strip');
assert(!v15.includes('renderTaskControlStrip'), 'v15 must not retain the old task control renderer');
assert(!/localStorage\.clear\s*\(/.test(v15), 'v15 must not clear browser storage');
assert(!/localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/.test(v15), 'v15 must not remove the main save');
assert(v15.includes('Number.isSafeInteger(value)'), 'v15 duration validation must enforce safe integers');
assert(v15.includes("if (next === 100) {\n    toggleDone(taskId);"), 'v15 100% progress must use the existing completion path');
assert(v15.indexOf('task-duration-inline') < v15.indexOf('task-progress-buttons'), 'v15 duration must render before progress buttons');
assert(v15.indexOf('task-progress-buttons') < v15.indexOf('task-progress-complete'), 'v15 completion tick must render after progress buttons');
assert(v15.includes('progressBeforeDone'), 'v15 must preserve the previous progress before completion');
assert(!v15.includes('TASK_LEGACY_PROGRESS_VALUES'), 'v15 must not keep a legacy-only 50% path');
assert(!v15.includes('taskHasLegacyProgress'), 'v15 must render 50% through the normal progress controls');
assert(v15.includes('const active = done ? value === 100 : progress === value;'), 'v15 must mark a stored 50% task as active');
const startupSyncStart = v15.indexOf('async function syncStateFromServer');
const startupSyncEnd = v15.indexOf('function retryPendingServerSync', startupSyncStart);
const startupSync = startupSyncStart >= 0 && startupSyncEnd > startupSyncStart ? v15.slice(startupSyncStart, startupSyncEnd) : '';
assert(startupSync && !startupSync.includes('saveState()'), 'opening v15 must not directly save or increment the cloud revision');
assert(!startupSync.includes('{ forceOpen:true }'), 'startup cloud differences must not open a blocking merge modal');
assert(server.includes('statesEqualIgnoringRootUpdatedAt'), 'Server must ignore root updatedAt-only saves without creating revisions');
assert(server.includes('Ignored root updatedAt-only save'), 'Timestamp-only no-op saves must remain auditable');

assert(server.includes('const V15_HTML_PATH'), 'Server is missing the v15 HTML path');
assert(server.includes('const V15_VERSION_PATH'), 'Server is missing the v15 metadata path');
assert(server.includes('const V15_ACCESS_MODE'), 'Server is missing the v15 access switch');
assert(server.includes('process.env.STUDYQUEST_V15_ACCESS || "off"'), 'v15 access must default to off');
assert(server.includes('["off", "admin", "all"].includes(configured) ? configured : "off"'), 'v15 access must support a fail-closed all-user promotion');
assert(server.includes('function authenticatedV15Html'), 'Server is missing authenticated v15 bootstrap');
assert(server.includes('function canAccessV15'), 'Server is missing the v15 account access check');
assert(server.includes('url.pathname === "/v15"'), 'Server is missing the /v15 route');
assert(server.includes('url.pathname === "/claudever15.html"'), 'Server is missing the /claudever15.html route');
assert(server.includes('requestedVersion === "15"'), 'Version API does not select v15');
assert(server.includes('V15_ACCESS_MODE'), 'Server does not expose v15 access state');
assert(server.includes('"v15-smart-merge"'), 'Server does not approve the v15 merge recovery source');

const v15RouteStart = server.indexOf('if (url.pathname === "/v15"');
const v15RouteEnd = server.indexOf('if (url.pathname === "/device-recovery"', v15RouteStart);
const v15Route = v15RouteStart >= 0 && v15RouteEnd > v15RouteStart ? server.slice(v15RouteStart, v15RouteEnd) : '';
assert(v15Route.includes('if (!user || user.sync_device_id)'), 'v15 must reject unauthenticated and device-token requests');
assert(v15Route.includes('if (!canAccessV15(user))'), 'v15 must use the authenticated access switch');

const rootRouteStart = server.indexOf('if (url.pathname === "/")');
const rootRouteEnd = server.indexOf('if (url.pathname === "/device-recovery"', rootRouteStart);
const rootRoute = rootRouteStart >= 0 && rootRouteEnd > rootRouteStart ? server.slice(rootRouteStart, rootRouteEnd) : '';
assert(rootRoute.includes('if (!user || user.sync_device_id)'), 'Main root must reject unauthenticated and device-token requests');
assert(rootRoute.includes('location: "/app.html?next=v15-main"'), 'Main root must use the stable login flow');
assert(rootRoute.includes('if (!canAccessV15(user))'), 'Main root must use the fail-closed v15 access switch');
assert(rootRoute.includes('location: "/app.html?stable=1"'), 'Main root must retain the stable fallback');
assert(rootRoute.includes('authenticatedV15Html(user)'), 'Main root must serve authenticated v15 HTML');
assert(!server.includes('url.pathname === "/" || url.pathname === "/app.html"'), 'Stable static route must not bypass the authenticated v15 root');

assert(stable.includes('next === "v15-main"') && stable.includes('window.location.replace("/")'), 'Stable login must return authenticated users to the clean root');
assert(stable.includes('next === "v15"') && stable.includes('window.location.replace("/v15")'), 'Stable login must retain the v15 alias');
assert(!stable.includes('v15TryHeaderButton') && !stable.includes('openV15'), 'Stable app must not expose a v15 button');
assert(renderYaml.includes('key: STUDYQUEST_V15_ACCESS') && renderYaml.includes('value: "off"'), 'Render config must default v15 access to off');
assert(renderNeonYaml.includes('key: STUDYQUEST_V15_ACCESS') && renderNeonYaml.includes('value: "off"'), 'Neon Render config must default v15 access to off');

assert(sha256('public/claudever13.html') === 'c6b8073bcecca777c7ae0acf2d4948d208b6925965d6e6396166a4e1c14b645f', 'Hosted v13 changed');
const v14Hash = sha256('public/claudever14.html');
assert(v14Hash === '4dccb2a1fbd9023a1047f7197d900e7baf5e822fb6f62ec2862eb84bfeceab8d', 'Hosted v14 changed');
assert(v14Version.version === 14 && v14Version.source === 'claudever14.html' && v14Version.hash === v14Hash, 'Hosted v14 metadata or hash changed');
const v15Hash = sha256('public/claudever15.html');
assert(v15Version.version === 15 && v15Version.source === 'claudever15.html', 'v15 version metadata is invalid');
assert(v15Version.hash === v15Hash, `v15 version hash does not match HTML: ${v15Hash}`);
assert(v15Version.route === '/' && Array.isArray(v15Version.aliases) && v15Version.aliases.includes('/v15') && v15Version.aliases.includes('/claudever15.html'), 'v15 main route metadata is invalid');
assert(v15Version.main === true && v15Version.adminOnly === false && v15Version.access === 'authenticated' && v15Version.accessMode === 'all' && v15Version.defaultAccessMode === 'off', 'v15 access metadata is invalid');

console.log(JSON.stringify({
  ok: true,
  v13Sha256: sha256('public/claudever13.html'),
  v14Sha256: v14Hash,
  v15Sha256: v15Hash,
  route: '/',
  aliases: v15Version.aliases,
  access: 'authenticated',
  adminOnly: false,
  defaultAccessMode: 'off',
}, null, 2));
