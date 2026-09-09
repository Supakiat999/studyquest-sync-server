// Read-only verification of a deployed StudyQuest service for the v21 launch.
//
// Makes only GET requests, signs in to nothing, and never sends account data.
// Use it after each deploy and again after flipping the default.
//
//   node scripts/verify-v21-deployment.js https://your-service.example.com
//
// Exit code 0 means every check passed. Anything else means do not proceed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const baseUrl = String(process.argv[2] || process.env.STUDYQUEST_BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('Usage: node scripts/verify-v21-deployment.js <https://your-service>');
  process.exitCode = 1;
  return;
}
if (!/^https?:\/\//.test(baseUrl)) {
  console.error('The service URL must start with http:// or https://');
  process.exitCode = 1;
  return;
}

const expected = {
  pageHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public', 'claudever21.html'))).digest('hex'),
  metadata: JSON.parse(fs.readFileSync(path.join(root, 'public', 'v21-version.json'), 'utf8')),
};

async function get(pathname, { redirect = 'manual' } = {}) {
  const response = await fetch(baseUrl + pathname, { redirect, headers: { 'cache-control': 'no-store' } });
  const body = await response.text();
  return { status: response.status, location: response.headers.get('location'), contentType: response.headers.get('content-type') || '', body };
}

const results = [];
const check = (name, detail) => results.push({ name, detail });

(async () => {
  // 1. the service and its database are healthy, and report the expected modes.
  const health = await get('/api/health');
  assert.equal(health.status, 200, `/api/health returned ${health.status}`);
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.ok, true, 'the service reported an unhealthy status');
  assert.equal(healthBody.db, 'postgres', 'the database is not reporting healthy');
  assert.ok(['off', 'canary', 'all'].includes(healthBody.v21AccessMode), `unexpected v21 access mode: ${healthBody.v21AccessMode}`);
  assert.equal(healthBody.v21AccountNamespace, '_studyquestV21', 'the deployed build is missing the v21 account namespace');
  check('service and database healthy', { v21AccessMode: healthBody.v21AccessMode, mainVersion: healthBody.mainVersion, v21CanaryUsers: healthBody.v21CanaryUsers });

  // 2. the deployed page is exactly the build in this checkout.
  const version = await get('/api/version?version=21');
  assert.equal(version.status, 200, `/api/version?version=21 returned ${version.status}`);
  const versionBody = JSON.parse(version.body);
  assert.equal(versionBody.version, 21, 'the version endpoint does not report v21');
  assert.equal(versionBody.hash, expected.pageHash, 'the deployed page hash does not match this checkout — the deploy is stale or mixed');
  assert.equal(versionBody.hash, expected.metadata.hash, 'the deployed hash does not match v21-version.json');
  assert.equal(versionBody.accessMode, healthBody.v21AccessMode, 'the version and health endpoints disagree on the access mode');
  check('deployed page matches this build', { hash: versionBody.hash, route: versionBody.route, main: versionBody.main });

  // 3. v21 requires a session, and never sends anyone to a laptop address.
  for (const route of ['/v21', '/claudever21.html']) {
    const response = await get(route);
    assert.ok([301, 302, 303, 307, 308].includes(response.status), `${route} must require a session, got ${response.status}`);
    assert.ok(response.location, `${route} must redirect a signed-out visitor`);
    assert.doesNotMatch(response.location, /127\.0\.0\.1|localhost/, `${route} must never redirect to a laptop address`);
    assert.match(response.location, /^\/app\.html/, `${route} must send a signed-out visitor to the app login`);
  }
  check('v21 routes require authentication', { routes: ['/v21', '/claudever21.html'] });

  // 4. the feature layers the page depends on are actually being served.
  for (const asset of ['/v21-local-features.js', '/v21-account-sync.js', '/v21-manual-courses.js', '/v21-v18-features.js', '/v21-v19-features.js', '/v21-v20-features.js']) {
    const response = await get(asset, { redirect: 'follow' });
    assert.equal(response.status, 200, `${asset} is not being served (${response.status})`);
    assert.match(response.contentType, /javascript/, `${asset} is not served as JavaScript`);
    const localHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public', asset.slice(1)))).digest('hex');
    const servedHash = crypto.createHash('sha256').update(response.body).digest('hex');
    assert.equal(servedHash, localHash, `${asset} differs from this checkout — the deploy is stale or mixed`);
  }
  check('feature layers served and matching', { assets: 6 });

  // 5. the previous default stays reachable as a fallback.
  const stable = await get('/app.html', { redirect: 'follow' });
  assert.equal(stable.status, 200, `the stable app must stay reachable, got ${stable.status}`);
  check('previous default still reachable', { route: '/app.html' });

  // 6. the account state API still refuses an unauthenticated read.
  const state = await get('/api/v2/state');
  assert.ok([401, 403].includes(state.status), `/api/v2/state must refuse an unauthenticated read, got ${state.status}`);
  check('account state API refuses anonymous access', { status: state.status });

  console.log(JSON.stringify({
    ok: true,
    service: baseUrl,
    v21AccessMode: healthBody.v21AccessMode,
    mainVersion: healthBody.mainVersion,
    v21Main: versionBody.main === true,
    deployedHash: versionBody.hash,
    checks: results,
  }, null, 2));
})().catch(error => {
  console.error('VERIFICATION FAILED — do not proceed with the launch step.');
  console.error(error.message || error);
  process.exitCode = 1;
});
