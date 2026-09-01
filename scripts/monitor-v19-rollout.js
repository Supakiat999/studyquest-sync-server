const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = String(process.env.STUDYQUEST_LIVE_ORIGIN || 'https://studyquest-sync-server.onrender.com').replace(/\/$/, '');
const EXPECTED_V19_HASH = String(process.env.STUDYQUEST_EXPECTED_V19_HASH || '').toLowerCase();
const EXPECTED_V15_HASH = String(process.env.STUDYQUEST_EXPECTED_V15_HASH || '').toLowerCase();
const EXPECTED_ACCESS = String(process.env.STUDYQUEST_EXPECTED_V19_ACCESS || 'off');
const EXPECTED_MAIN = String(process.env.STUDYQUEST_EXPECTED_MAIN_VERSION || '15');

async function readJson(url) {
  const response = await fetch(url, { headers:{ accept:'application/json' }, signal:AbortSignal.timeout(75_000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status:response.status, ok:response.ok, body };
}

async function readRedirect(url) {
  const response = await fetch(url, { redirect:'manual', signal:AbortSignal.timeout(75_000) });
  return { status:response.status, location:response.headers.get('location') || '' };
}

function validateSnapshot(snapshot) {
  const failures = [];
  if (snapshot.renderStatus.status !== 200 || snapshot.renderStatus.body?.status?.indicator !== 'none') failures.push('Render is not fully operational.');
  if (snapshot.renderIncidents.status !== 200 || (snapshot.renderIncidents.body?.incidents || []).length) failures.push('Render has an unresolved incident.');
  if (!snapshot.health.ok || snapshot.health.body?.ok !== true || snapshot.health.body?.db !== 'postgres') failures.push('StudyQuest health or PostgreSQL check failed.');
  if (snapshot.health.body?.v19AccessMode !== EXPECTED_ACCESS) failures.push(`Expected v19 access ${EXPECTED_ACCESS}, received ${snapshot.health.body?.v19AccessMode ?? 'missing'}.`);
  if (String(snapshot.health.body?.mainVersion || '') !== EXPECTED_MAIN) failures.push(`Expected main version ${EXPECTED_MAIN}, received ${snapshot.health.body?.mainVersion ?? 'missing'}.`);
  if (!snapshot.v19.ok || snapshot.v19.body?.version !== 19) failures.push('The live v19 version endpoint is unavailable or incorrect.');
  if (EXPECTED_V19_HASH && String(snapshot.v19.body?.hash || '').toLowerCase() !== EXPECTED_V19_HASH) failures.push('The live v19 hash does not match the tested artifact.');
  if (EXPECTED_V15_HASH && String(snapshot.v15.body?.hash || '').toLowerCase() !== EXPECTED_V15_HASH) failures.push('The protected v15 hash changed.');
  if (snapshot.root.status !== 302 || !snapshot.root.location.includes('/app.html')) failures.push('Logged-out root routing is not protected.');
  if (snapshot.v15Route.status !== 302 || !snapshot.v15Route.location.includes('/app.html')) failures.push('Logged-out v15 routing is not protected.');
  if (snapshot.v19Route.status !== 302 || !snapshot.v19Route.location.includes('/app.html')) failures.push('Logged-out v19 routing is not protected.');
  return failures;
}

async function collectSnapshot() {
  const [renderStatus, renderIncidents, health, v19, v15, root, v15Route, v19Route] = await Promise.all([
    readJson('https://status.render.com/api/v2/status.json'),
    readJson('https://status.render.com/api/v2/incidents/unresolved.json'),
    readJson(`${ORIGIN}/api/health`),
    readJson(`${ORIGIN}/api/version?version=19`),
    readJson(`${ORIGIN}/api/version?version=15`),
    readRedirect(`${ORIGIN}/`),
    readRedirect(`${ORIGIN}/v15`),
    readRedirect(`${ORIGIN}/v19`),
  ]);
  const snapshot = { checkedAt:new Date().toISOString(), origin:ORIGIN, renderStatus, renderIncidents, health, v19, v15, root, v15Route, v19Route };
  const failures = validateSnapshot(snapshot);
  return { ok:failures.length === 0, readOnly:true, failures, snapshot };
}

async function main() {
  const result = await collectSnapshot();
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.STUDYQUEST_ROLLOUT_MONITOR_FILE) {
    const resolved = path.resolve(process.env.STUDYQUEST_ROLLOUT_MONITOR_FILE);
    fs.mkdirSync(path.dirname(resolved), { recursive:true });
    fs.writeFileSync(resolved, serialized, { flag:'wx', mode:0o600 });
  }
  process.stdout.write(serialized);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(`StudyQuest v19 live monitor failed: ${error.message || error}`);
  process.exit(1);
});

module.exports = { validateSnapshot };
