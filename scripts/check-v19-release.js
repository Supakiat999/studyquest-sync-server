const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('public/claudever19.html');
const loginHtml = read('public/claudever9.html');
const v18Features = read('public/v18-local-features.js');
const v19Features = read('public/v19-local-features.js');
const server = read('server.js');
const metadata = JSON.parse(read('public/v19-version.json'));

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

compileInlineScripts(html, 'v19');
for (const [label, source] of [['v18 feature module', v18Features], ['v19 feature module', v19Features]]) {
  try { new Function(source); } catch (error) { throw new Error(`${label}: ${error.message}`); }
}

for (const marker of [
  'const STUDYQUEST_VERSION = 19',
  "const LIVE_VERSION_ENDPOINT = '/api/version?version=19'",
  'const V19_READ_ONLY_STARTUP = true',
  'window.studyQuestV18Install?.()',
  'window.studyQuestV19Install?.()',
  'Hosted v19',
  '/v18-local-features.js',
  '/v19-local-features.js',
  "const V18_ADMIN_CRITERIA_ENDPOINT = '/api/v18/admin-course-criteria'",
]) assert(html.includes(marker), `Missing v19 marker: ${marker}`);

assert(!/localStorage\.clear\s*\(/.test(html + v18Features + v19Features), 'v19 must not clear browser storage');
assert(!/localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/.test(html), 'v19 must not remove the main save');
assert(html.includes('if (isV16StartupReadOnly()) return { ok: false, skipped: true };'), 'v19 cloud save must remain read-only on startup');

for (const marker of [
  'const V19_HTML_PATH',
  'const V18_FEATURES_PATH',
  'const V19_FEATURES_PATH',
  'const V19_VERSION_PATH',
  'const V19_ACCESS_MODE',
  'function authenticatedV19Html',
  'function canAccessV19',
  'url.pathname === "/v19"',
  'url.pathname === "/claudever19.html"',
  'url.pathname === "/v19-local-features.js"',
  'requestedVersion === "19"',
  'v19AccessMode',
  'mainVersion: MAIN_APP_VERSION',
  'MAIN_APP_VERSION === "19" && canAccessV19(user)',
  'url.pathname === "/api/v18/admin-course-criteria"',
]) assert(server.includes(marker), `Hosted server is missing v19 marker: ${marker}`);

const protectedHashes = {
  // v20 adds only the authenticated login return target; the v13 publisher
  // route and all v13 release behavior remain unchanged.
  'public/claudever9.html': '608edff6db0962c0028014553236482bdd1fcfbc09f45b5994bb750dafd53f5b',
  'public/claudever13.html': 'c4135e474acf0bf605dfd527a27db08711bfef286e1909e94527018f9cbe0746',
  'public/claudever14.html': '6e780a482c05e41202d769408937c805eeafb408b6166c77b0a9c6e5b7558241',
  'public/claudever15.html': 'ef73bd01892bdbf0c8047637ad2aee54dec1cf0004bbb678619021f332dcc577',
  'public/claudever16.html': '411e0efc5058f4f6ec89fbf89871cc22f5930124b6f3483bb07a18c437b85e74',
};
for (const [file, expected] of Object.entries(protectedHashes)) assert(sha256(file) === expected, `${file} changed`);

const v19Hash = sha256('public/claudever19.html');
assert(metadata.version === 19 && metadata.source === 'claudever19.html', 'v19 metadata is invalid');
assert(metadata.hash === v19Hash, `v19 metadata hash does not match HTML: ${v19Hash}`);
assert(metadata.route === '/v19' && metadata.aliases.includes('/claudever19.html'), 'v19 route metadata is invalid');
assert(metadata.authenticated === true && metadata.localOnly === false && metadata.defaultAccessMode === 'off', 'v19 access metadata is invalid');
assert(metadata.main === false && metadata.startupReadOnly === true, 'v19 safety metadata is invalid');
assert(loginHtml.includes('next === "v20"') && loginHtml.includes('window.location.replace("/v20")'), 'v20 login return target is missing');

for (const yaml of ['render.yaml', 'render-neon-free.yaml']) {
  const content = read(yaml);
  const setting = /key:\s*STUDYQUEST_V19_ACCESS\s*\r?\n\s*value:\s*["']?off["']?/;
  assert(setting.test(content), `${yaml} must default v19 access to off`);
  const mainSetting = /key:\s*STUDYQUEST_MAIN_VERSION\s*\r?\n\s*value:\s*["']?15["']?/;
  assert(mainSetting.test(content), `${yaml} must default the main route to v15`);
}

console.log(JSON.stringify({ ok:true, v19Sha256:v19Hash, route:'/v19', access:'authenticated', defaultAccessMode:'off' }, null, 2));
