const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/claudever16.html');
const features = read('public/v16-local-features.js');
const server = read('server.js');
const stable = read('public/claudever9.html');
const metadata = JSON.parse(read('public/v16-version.json'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
}

function compileInlineScripts(source, label) {
  const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim());
  assert(scripts.length >= 2, `${label} must contain inline application scripts`);
  scripts.forEach((script, index) => {
    try { new Function(script); } catch (error) { throw new Error(`${label} inline script ${index + 1}: ${error.message}`); }
  });
}

compileInlineScripts(html, 'v16');
try { new Function(features); } catch (error) { throw new Error(`v16 feature module: ${error.message}`); }

for (const marker of [
  'const STUDYQUEST_VERSION = 16',
  "file: 'claudever16.html'",
  "const STORAGE_KEY = 'studyquest_v3'",
  "const LIVE_VERSION_ENDPOINT = '/api/version?version=16'",
  'const V16_READ_ONLY_STARTUP = true',
  'window.studyQuestV16Install?.()',
  'const TASK_XP_PRESETS = [1, 2, 5, 10, 25, 50, 100, 200]',
  'let v16UserInteracted = false',
  '.v16-week-boundary',
  'dt.getDay() === 1 && lastRenderedDate',
  "divider.setAttribute('aria-hidden', 'true')",
  'Hosted v16',
]) assert(html.includes(marker), `Missing v16 marker: ${marker}`);

assert(!/localStorage\.clear\s*\(/.test(html), 'v16 must not clear browser storage');
assert(!/localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/.test(html), 'v16 must not remove the main save');
assert(!html.includes('Local-only v16'), 'hosted v16 must not advertise a local-only release');
assert(html.includes('if (isV16StartupReadOnly()) return { ok: false, skipped: true };'), 'v16 cloud save must remain read-only on startup');
assert(features.includes('function softDeleteSeries'), 'v16 recurrence safety helpers are missing');
assert(features.includes('function durationFromTimes'), 'v16 duration helpers are missing');

for (const marker of [
  'const V16_HTML_PATH',
  'const V16_FEATURES_PATH',
  'const V16_VERSION_PATH',
  'const V16_ACCESS_MODE',
  'function authenticatedV16Html',
  'function canAccessV16',
  'url.pathname === "/v16"',
  'url.pathname === "/claudever16.html"',
  'url.pathname === "/v16-local-features.js"',
  'requestedVersion === "16"',
  'V16_ACCESS_MODE',
  'v16AccessMode',
]) assert(server.includes(marker), `Hosted server is missing v16 marker: ${marker}`);

const v16RouteStart = server.indexOf('if (url.pathname === "/v16"');
const v16RouteEnd = server.indexOf('if (url.pathname === "/")', v16RouteStart);
const v16Route = v16RouteStart >= 0 && v16RouteEnd > v16RouteStart ? server.slice(v16RouteStart, v16RouteEnd) : '';
assert(v16Route.includes('if (!user || user.sync_device_id)'), 'v16 must reject logged-out and device-token requests');
assert(v16Route.includes('if (!canAccessV16(user))'), 'v16 must use the access switch');
assert(v16Route.includes('authenticatedV16Html(user)'), 'v16 must use authenticated account bootstrap');

assert(stable.includes('next === "v16"') && stable.includes('window.location.replace("/v16")'), 'stable login must return signed-in users to v16');

const v13Hash = sha256('public/claudever13.html');
const v14Hash = sha256('public/claudever14.html');
const v15Hash = sha256('public/claudever15.html');
const v16Hash = sha256('public/claudever16.html');
assert(v13Hash === '9667d4c65548327c25ced9f161edea902e398f94b59941e27c3b576b37dab4e7', 'Hosted v13 changed');
assert(v14Hash === '9a4e7d2547db64d315f556dbc0b7ef061bb5ee0262f0413157cc1b7abad8ff62', 'Hosted v14 changed');
assert(v15Hash === '4e0f98d9b08ed24639c1e8862f02a2d8bd478d0b98dab7fb05ba7c0c604bbc52', 'Hosted v15 changed');
assert(metadata.version === 16 && metadata.source === 'claudever16.html', 'v16 version metadata is invalid');
assert(metadata.hash === v16Hash, `v16 version metadata hash does not match HTML: ${v16Hash}`);
assert(metadata.route === '/v16' && metadata.aliases.includes('/claudever16.html'), 'v16 route metadata is invalid');
assert(metadata.access === 'authenticated' && metadata.localOnly === false && metadata.defaultAccessMode === 'off', 'v16 access metadata is invalid');

for (const yaml of ['render.yaml', 'render-neon-free.yaml']) {
  const content = read(yaml);
  assert(content.includes('key: STUDYQUEST_V16_ACCESS') && content.includes('value: "off"'), `${yaml} must default v16 access to off`);
}

console.log(JSON.stringify({
  ok: true,
  v13Sha256: v13Hash,
  v14Sha256: v14Hash,
  v15Sha256: v15Hash,
  v16Sha256: v16Hash,
  route: '/v16',
  aliases: metadata.aliases,
  access: 'authenticated',
  defaultAccessMode: 'off',
}, null, 2));
