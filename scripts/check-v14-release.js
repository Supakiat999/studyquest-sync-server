const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const safety = fs.readFileSync(path.join(root, 'lib', 'state-safety.js'), 'utf8');
const v13Path = path.join(root, 'public', 'claudever13.html');
const v14Path = path.join(root, 'public', 'claudever14.html');
const v14VersionPath = path.join(root, 'public', 'v14-version.json');
const v13 = fs.readFileSync(v13Path, 'utf8');
const v14 = fs.readFileSync(v14Path, 'utf8');
const stable = fs.readFileSync(path.join(root, 'public', 'claudever9.html'), 'utf8');
const version = JSON.parse(fs.readFileSync(v14VersionPath, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const inlineScripts = [...v14.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).filter(script => script.trim());
assert(inlineScripts.length >= 2, 'v14 must contain inline application scripts');
inlineScripts.forEach((script, index) => {
  try { new Function(script); } catch (error) { throw new Error(`v14 inline script ${index + 1}: ${error.message}`); }
});

for (const marker of [
  'const STUDYQUEST_VERSION = 14',
  "file: 'claudever14.html'",
  'weeklyV14',
  'Weekly columns:',
  'Latest 5 changes',
  "source:'v14-smart-merge'",
  'Approve Merge',
]) assert(v14.includes(marker), `Missing v14 marker: ${marker}`);

assert(!/localStorage\.clear\s*\(/.test(v14), 'v14 must not clear browser storage');
assert(!/localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/.test(v14), 'v14 must not remove the main save');
assert(v14.includes("const STORAGE_KEY = 'studyquest_v3'"), 'The shared storage key changed');

assert(server.includes('const V14_HTML_PATH'), 'Server is missing the v14 HTML path');
assert(server.includes('function authenticatedV14Html'), 'Server is missing authenticated v14 bootstrap');
assert(server.includes('url.pathname === "/v14"'), 'Server is missing the /v14 route');
assert(server.includes('const V14_ACCESS_MODE'), 'Server is missing the v14 access switch');
assert(server.includes('function canAccessV14'), 'Server is missing the v14 account access check');
assert(server.includes('url.searchParams.get("version") === "14"'), 'Version API does not select v14');
assert(server.includes('stateActivitySummary'), 'Server does not expose activity summaries');
assert(safety.includes('function stateActivitySummary'), 'State safety activity summary is missing');
assert(stable.includes('next === "v14"') && stable.includes('window.location.replace("/v14")'), 'Stable login does not return a signed-in user to v14 when explicitly requested');
assert(stable.includes('id="v14TryHeaderButton"') && stable.includes('openV14BetaModal'), 'Stable app is missing the Try v14 button');
assert(stable.includes('v13BetaHeaderButton') && stable.includes('data-studyquest-account="admin"'), 'Stable app no longer protects the admin-only v13 button');

const v14RouteStart = server.indexOf('if (url.pathname === "/v14"');
const v14RouteEnd = server.indexOf('if (url.pathname === "/device-recovery"', v14RouteStart);
const v14Route = v14RouteStart >= 0 && v14RouteEnd > v14RouteStart ? server.slice(v14RouteStart, v14RouteEnd) : '';
assert(v14Route.includes('if (!user || user.sync_device_id)'), 'v14 must reject unauthenticated and device-token requests');
assert(v14Route.includes('if (!canAccessV14(user))'), 'v14 must use the access switch');
assert(!v14Route.includes('user.username !== ADMIN_USERNAME'), 'v14 route must not be hard-coded admin-only');
assert(v14.includes('function isAdminAccount'), 'v14 is missing its admin-only control helper');
assert(v14.includes('Only the admin laptop can create pairing codes.'), 'v14 pairing controls are not protected for ordinary users');
assert(v14.includes("if (!isHostedAppHost() || !isAdminAccount()) return ''"), 'v14 admin recovery controls are not hidden for ordinary users');

assert(sha256(v13Path) === '9667d4c65548327c25ced9f161edea902e398f94b59941e27c3b576b37dab4e7', 'Hosted v13 changed');
const v14Hash = sha256(v14Path);
assert(version.version === 14 && version.source === 'claudever14.html', 'v14 version metadata is invalid');
assert(version.hash === v14Hash, `v14 version hash does not match HTML: ${v14Hash}`);
assert(version.route === '/v14' && version.adminOnly === false && version.access === 'authenticated', 'v14 route metadata is invalid');

console.log(JSON.stringify({ ok: true, v13Sha256: sha256(v13Path), v14Sha256: v14Hash, route: '/v14', access: 'authenticated', adminOnly: false }, null, 2));
