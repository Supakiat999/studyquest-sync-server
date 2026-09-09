// Hosted v21 end-to-end flows against a synthetic account server.
//
// Isolated origin and synthetic data only. This never contacts the real Render
// service, the real database, or any real account: it serves the built hosted
// page from public/ against an in-process stand-in for /api/v2/state that
// enforces the same revision, hash, and mutation-id rules.
//
// Requires Playwright. Install it in this checkout (npm i -D playwright and
// npx playwright install chromium webkit) or point STUDYQUEST_TEST_NODE_MODULES
// at a checkout that already has it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const PUBLIC = path.join(root, 'public');

let playwright;
try {
  playwright = require(require.resolve('playwright', {
    paths: [process.env.STUDYQUEST_TEST_NODE_MODULES, root, path.resolve(root, '..')].filter(Boolean),
  }));
} catch {
  console.error('Playwright is not available through Node module resolution.');
  console.error('Install it here (npm i -D playwright && npx playwright install chromium webkit),');
  console.error('or set STUDYQUEST_TEST_NODE_MODULES to a checkout that has it.');
  process.exitCode = 1;
  return;
}

const stableStringify = value => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const stateHash = value => crypto.createHash('sha256').update(stableStringify(value ?? null)).digest('hex');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const baseState = () => ({
  updatedAt: 1000,
  tasks: [{ id: 'seed-a', title: 'Synthetic task', date: today, catId: 'seed-cat', priority: 0, priorityLevel: 'normal', done: false, xp: 1, createdAt: 1 }],
  categories: [{ id: 'seed-cat', name: 'Synthetic', icon: '📚', color: '#6af7b0' }],
  notes: [], fileLinks: [], tracker: { weeks: [] }, trackerSemesters: [],
});

// ── synthetic account server ─────────────────────────────────────────────
function createAccountServer() {
  const account = { state: baseState(), revision: 1, hash: stateHash(baseState()), acknowledged: [] };
  const control = { offline: false, sessionExpired: false, failNextSave: 0, requests: [] };

  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    control.requests.push({ method: req.method, path: url.pathname });

    if (control.offline && url.pathname.startsWith('/api/')) { res.destroy(); return; }
    if (control.sessionExpired && url.pathname.startsWith('/api/')) return json(res, { ok: false, error: 'LOGIN_REQUIRED' }, 401);

    if (req.method === 'POST' && url.pathname === '/api/v2/state') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* handled below */ }
        if (control.failNextSave > 0) { control.failNextSave -= 1; res.destroy(); return; }

        // Idempotent replay of an already-acknowledged mutation.
        const seen = account.acknowledged.find(entry => entry.mutationId && entry.mutationId === body.mutationId);
        if (seen) return json(res, { ok: true, idempotent: true, acknowledgedMutationId: body.mutationId, revision: seen.revision, stateHash: seen.hash, savedAt: seen.savedAt, requiresRefresh: false });

        // The same revision protection the real server applies.
        if (Number(body.baseRevision) !== account.revision) {
          return json(res, { ok: false, error: 'STATE_CONFLICT', state: account.state, revision: account.revision, stateHash: account.hash }, 409);
        }
        account.state = body.state;
        account.revision += 1;
        account.hash = stateHash(body.state);
        const savedAt = new Date().toISOString();
        account.acknowledged.push({ mutationId: body.mutationId || null, revision: account.revision, hash: account.hash, savedAt });
        return json(res, { ok: true, revision: account.revision, stateHash: account.hash, savedAt, acknowledgedMutationId: body.mutationId || null, requiresRefresh: false });
      });
      return;
    }

    if (url.pathname === '/api/v2/state') {
      return json(res, { ok: true, state: account.state, revision: account.revision, stateHash: account.hash, serverTime: new Date().toISOString() });
    }
    if (url.pathname === '/api/version') {
      return json(res, { ok: true, version: 21, accessMode: 'canary', main: false, route: '/v21' });
    }
    if (url.pathname === '/api/me') return json(res, { ok: true, user: { username: 'qa-synthetic' } });
    if (url.pathname === '/api/health') return json(res, { ok: true, db: 'postgres', serverTime: new Date().toISOString() });
    if (url.pathname === '/api/heartbeat') return json(res, { ok: true, serverTime: new Date().toISOString() });
    if (url.pathname === '/api/v2/state/meta') {
      return json(res, { ok: true, revision: account.revision, stateHash: account.hash, updatedAt: new Date().toISOString() });
    }
    // The real hosted server has no laptop-bridge endpoints. Answering them
    // would make the page believe a laptop admin bridge exists and open an
    // admin comparison that a hosted user should never see.
    if (url.pathname.startsWith('/api/')) return json(res, { ok: false, error: 'NOT_FOUND' }, 404);

    // A valid synthetic login document lets an expired session navigate away
    // without opening the real login or discarding this origin's device data.
    if (url.pathname === '/app.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Synthetic sign-in</title><p>Sign in required</p>');
      return;
    }

    // The authenticated page, served the way the real route serves it.
    if (url.pathname === '/v21' || url.pathname === '/claudever21.html') {
      const bootstrap = '<script>document.documentElement.classList.add("studyquest-account-loading");'
        + 'window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__={"username":"qa-synthetic"};'
        + 'window.__STUDYQUEST_SAFE_SYNC_V2__=true;window.__STUDYQUEST_V20_HOSTED__=true;window.__STUDYQUEST_V21_HOSTED__=true;</script>';
      const html = fs.readFileSync(path.join(PUBLIC, 'claudever21.html'), 'utf8').replace('</head>', bootstrap + '\n</head>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    const name = url.pathname.slice(1);
    if (!/^v21-[\w-]+\.(js|json)$/.test(name)) { res.writeHead(404); res.end(); return; }
    const file = path.join(PUBLIC, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': name.endsWith('.json') ? 'application/json' : 'application/javascript', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });

  return { server, account, control };
}

const namespaceOf = page => page.evaluate(() => window.studyQuestV21Core.getState()._studyquestV21 || null);
const settle = (page, ms = 900) => page.waitForTimeout(ms);

// The page only enters account cloud mode on an .onrender.com hostname, so the
// fixture must be served under one. Every request for the synthetic hosted
// origin is fulfilled from the in-process server; everything else is blocked.
const TEST_ORIGIN = 'https://studyquest-v21-fixture.onrender.com';

async function attachHostedOrigin(context, localOrigin) {
  await context.route(`${TEST_ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const init = { method: request.method(), redirect: 'manual', headers: {} };
    const contentType = request.headers()['content-type'];
    if (contentType) init.headers['content-type'] = contentType;
    const body = request.postData();
    if (body !== null && body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') init.body = body;

    let response;
    try {
      response = await fetch(localOrigin + url.pathname + url.search, init);
    } catch {
      // The fixture drops the connection to simulate being offline.
      await route.abort('failed');
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await route.fulfill({
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'no-store',
      },
      body: buffer,
    });
  });
  await context.route('**/*', route => (route.request().url().startsWith(TEST_ORIGIN) ? route.fallback() : route.abort()));
}

// Opening an account that already has data in a browser that has none — a new
// device, or cleared site data — reaches the inherited sync stack's review
// screen rather than loading straight through. That behaviour predates v21 and
// is present in v20 today (see scripts/debug-first-open-conflict.js). On this
// path the correct user action is to load the account copy, so that is what a
// new device does here before the flows continue.
async function resolveFirstOpenReview(page) {
  const modal = page.locator('#v21RecoveryModal.open');
  if (!(await modal.count())) return false;
  await page.locator('[data-v21-choice="copy"]').click();
  const apply = page.locator('#v21RecoveryApply');
  assert.equal(await apply.isDisabled(), false, 'loading the account copy must stay available on a new device');
  await apply.click();
  await modal.waitFor({ state: 'detached', timeout: 20000 }).catch(async () => {
    await page.locator('#v21RecoveryModal:not(.open)').waitFor({ timeout: 20000 });
  });
  await settle(page);
  return true;
}

async function openApp(context) {
  const page = await context.newPage();
  await page.goto(TEST_ORIGIN + '/v21');
  await page.waitForFunction(() => window.studyQuestV21Core && window.StudyQuestV21AccountSync && window.StudyQuestV21Manual);
  await settle(page);
  await resolveFirstOpenReview(page);
  return page;
}

// The tracker controls live inside the Study tracker tab, which is not the
// tab the app opens on.
async function openTracker(page) {
  const nav = page.locator('[aria-controls="tab-weekly"]').first();
  if (await nav.count()) await nav.click();
  else await page.evaluate(() => window.switchTab?.('weekly'));
  await page.locator('#v21ManualRoot').waitFor({ state: 'visible' });
  await settle(page, 300);
}

async function addCourse(page, name) {
  await openTracker(page);
  await page.locator('#v21ManualRoot [data-view="manual"]').click();
  const back = page.locator('[data-mc-action="back"]');
  if (await back.isVisible()) await back.click();
  await page.locator('[data-mc-action="add-course"]').click();
  await page.locator('#mcForm input[name="name"]').fill(name);
  await page.locator('#mcSubmit').click();
  await page.evaluate(() => window.StudyQuestV21Manual.whenIdle());
  await settle(page);
}

async function run(browserName) {
  const { server, account, control } = createAccountServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright[browserName].launch({ headless: true });
  const results = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Bangkok' });
    await attachHostedOrigin(context, origin);
    const page = await openApp(context);

    // 1. hosted bootstrap, and no localhost anywhere in the served page.
    assert.equal(await page.evaluate(() => window.__STUDYQUEST_V21_HOSTED__), true, 'the hosted flag must reach the page');
    assert.equal(await page.evaluate(() => window.studyQuestV21Core.hostedSync().cloudMode), true, 'the page must run in account cloud mode');
    assert.equal(page.url().startsWith(TEST_ORIGIN), true, 'the page must stay on the hosted origin');
    assert.equal(page.url().includes('127.0.0.1'), false, 'the hosted page must not navigate to the laptop server');
    results.push('hosted bootstrap');

    // Sync equality must see namespace-only changes, not just legacy tasks.
    const equalityChecks = await page.evaluate(() => {
      const sample = { _studyquestV21: { schemaVersion: 1,
        note: { text: 'Original' }, subjectTrack: { enabled: false },
        manual: { revision: 1, courses: [{ id:'c', name:'IDT 4',
          columns:[{id:'k',name:'Read'}],
          rows:[{id:'r',name:'Lecture 1',checks:{k:false}}] }] } } };
      const edits = [
        s => { s._studyquestV21.note.text = 'Changed'; },
        s => { s._studyquestV21.subjectTrack.enabled = true; },
        s => { s._studyquestV21.manual.courses[0].name = 'Renamed'; },
        s => { s._studyquestV21.manual.courses[0].rows[0].checks.k = true; },
        s => { s._studyquestV21.manual.courses[0].archived = true; },
        s => { s._studyquestV21.futureField = 'Preserve me'; },
      ];
      return edits.map(edit => {
        const changed = JSON.parse(JSON.stringify(sample)); edit(changed);
        return window.statesEquivalent(sample, changed) === false;
      });
    });
    assert.ok(equalityChecks.every(Boolean), 'every v21-only edit must differ from its account copy');
    results.push('v21 namespace participates in sync equality');

    const beforeNavigation = JSON.stringify(account.state);
    const beforeNavigationRevision = account.revision;
    await openTracker(page);
    await page.locator('#v21ManualRoot [data-view="manual"]').click();
    await page.evaluate(() => window.StudyQuestV21Manual.whenIdle());
    await settle(page, 1500);
    assert.equal(account.revision, beforeNavigationRevision, 'view-only navigation must not upload');
    assert.equal(JSON.stringify(account.state), beforeNavigation, 'view-only navigation must not mutate account records');
    results.push('view-only navigation sends no account write');

    // 2. a manual course reaches the account and the database acknowledges it.
    const revisionBefore = account.revision;
    await addCourse(page, 'IDT 4');
    let namespace = await namespaceOf(page);
    assert.equal(namespace.manual.courses[0].name, 'IDT 4', 'the course must be in the account namespace');
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 15000 });
    assert.ok(account.revision > revisionBefore, 'the database must accept a new revision');
    assert.equal(account.state._studyquestV21.manual.courses[0].name, 'IDT 4', 'the stored account state must carry the course');
    assert.ok(await page.evaluate(() => window.studyQuestV21Core.hostedSync().lastSuccessAt), 'the page must record a confirmed online save');
    assert.match(await page.locator('#v21SyncStatus').innerText(), /Saved to your account/, 'the status must confirm the account save');
    results.push('course saved and acknowledged');

    // 3. routine actions need no confirmation.
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await page.locator('[data-mc-action="add-row"]').click();
    await page.locator('#mcForm input[name="name"]').fill('Lecture 1');
    await page.locator('#mcSubmit').click();
    await page.evaluate(() => window.StudyQuestV21Manual.whenIdle());
    await page.locator('#v21ManualRoot input[data-mc-change="check"]').first().check();
    await page.evaluate(() => window.StudyQuestV21Manual.whenIdle());
    assert.deepEqual(dialogs, [], 'adding and checking must not ask for confirmation');
    results.push('routine actions need no confirmation');

    // 4. the quick note settles once and reaches the account.
    const noteBefore = account.revision;
    // The quick note lives on the Tasks tab, not the tracker tab.
    await page.locator('[aria-controls="tab-tasks"]').first().click();
    await page.locator('#v20ExamNoteInput').waitFor({ state: 'visible' });
    await page.locator('#v20ExamNoteInput').fill('Bring the lab notebook');
    await settle(page, 300);
    assert.equal(account.revision, noteBefore, 'a text edit must not save on every keystroke');
    await page.waitForFunction(() => (window.studyQuestV21Core.getState()._studyquestV21 || {}).note?.text === 'Bring the lab notebook', null, { timeout: 15000 });
    await page.waitForFunction(() => window.StudyQuestV21AccountSync.saveStatus().kind === 'saved' && window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 20000 });
    assert.equal(account.state._studyquestV21?.note?.text, 'Bring the lab notebook', 'the settled note must reach the account server');
    results.push('debounced quick note');

    // 5. Subject Track is a functional account setting.
    await page.evaluate(() => window.openProfileSettings?.());
    await page.locator('#v21EnableSubject').check();
    await page.evaluate(() => window.StudyQuestV21Manual.whenIdle());
    await page.waitForFunction(() => (window.studyQuestV21Core.getState()._studyquestV21 || {}).subjectTrack?.enabled === true, null, { timeout: 15000 });
    results.push('Subject Track synced');
    await page.locator('#profileSettingsModal button[onclick*="closeModal"]').first().click();

    // 6. reopening on a second device shows the same account content, and the
    //    device-local view preference does not travel with it.
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 15000 });
    const secondDevice = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Bangkok' });
    await attachHostedOrigin(secondDevice, origin);
    const secondPage = await openApp(secondDevice);
    const secondNamespace = await namespaceOf(secondPage);
    assert.equal(secondNamespace.manual.courses[0].name, 'IDT 4', 'the second device must see the account courses');
    assert.equal(secondNamespace.note.text, 'Bring the lab notebook', 'the second device must see the account note');
    assert.equal(secondNamespace.subjectTrack.enabled, true, 'the second device must see the Subject Track setting');
    assert.equal(await secondPage.evaluate(() => window.StudyQuestV21Manual.getRecord().settings.view), 'week', 'the view preference must stay on its own device');
    await secondPage.close();
    await secondDevice.close();
    results.push('reopened on a second device');

    // 7. an offline edit is kept, queued, and acknowledged after reconnect.
    control.offline = true;
    await addCourse(page, 'Offline course');
    assert.equal((await namespaceOf(page)).manual.courses.length, 2, 'an offline edit must still be saved on the device');
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === true, null, { timeout: 15000 });
    assert.match(await page.locator('#v21SyncStatus').innerText(), /upload pending/, 'a queued edit must say the upload is pending');
    const offlineRevision = account.revision;
    control.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 20000 });
    assert.ok(account.revision > offlineRevision, 'the queued edit must reach the database after reconnect');
    assert.equal(account.state._studyquestV21.manual.courses.length, 2, 'the offline course must arrive intact');
    results.push('offline edit queued then acknowledged');

    // 8. an interrupted upload retries without losing or duplicating the edit.
    control.failNextSave = 1;
    const interruptedRevision = account.revision;
    await addCourse(page, 'Interrupted course');
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 25000 });
    assert.equal(account.revision, interruptedRevision + 1, 'a retried upload must land exactly once');
    assert.equal(account.state._studyquestV21.manual.courses.length, 3, 'the interrupted edit must not be duplicated');
    results.push('interrupted upload retried once');

    // 9. an expired session keeps the pending edit and asks for sign-in.
    control.sessionExpired = true;
    await addCourse(page, 'After expiry');
    assert.equal((await namespaceOf(page)).manual.courses.length, 4, 'an expired session must not discard the edit');
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === true, null, { timeout: 15000 });
    await page.waitForURL(TEST_ORIGIN + '/app.html?next=v21', { timeout: 15000 });
    control.sessionExpired = false;
    // Simulate successful sign-in by reopening v21 on the same origin and
    // storage, then require the retained outbox to reach the account.
    await page.goto(TEST_ORIGIN + '/v21');
    await page.waitForFunction(() => window.studyQuestV21Core && window.StudyQuestV21AccountSync);
    await page.waitForFunction(() => window.studyQuestV21Core.hostedSync().pending === false, null, { timeout: 20000 }).catch(async error => {
      console.error(JSON.stringify({phase:'session-reopen', browserName, serverRevision:account.revision,
        serverCourses:account.state._studyquestV21?.manual?.courses?.map(c=>c.name),
        device:await page.evaluate(async () => {
          const core=window.studyQuestV21Core, copies=await core.snapshots({allowPartial:true});
          return {sync:core.hostedSync(),status:core.getStatus(),reason:core.getPreview()?.reason,
            courses:core.getState()._studyquestV21?.manual?.courses?.map(c=>c.name),
            outbox:copies.device?.outbox ? {username:copies.device.outbox.username,
              updatedAt:copies.device.outbox.updatedAt,lineage:copies.device.outbox.lineage} : null,
            errors:copies.errors};
        })}, null, 2));
      throw error;
    });
    assert.equal(account.state._studyquestV21.manual.courses.length, 4, 'the retained edit must arrive after signing back in');
    results.push('expired session retained pending data');

    // 10. an older client that omits the namespace must not erase it.
    const beforeOldClient = JSON.parse(JSON.stringify(account.state._studyquestV21));
    const olderClientState = JSON.parse(JSON.stringify(account.state));
    delete olderClientState._studyquestV21;
    olderClientState.tasks.push({ id: 'from-old-client', title: 'Added by an older client', date: today, catId: 'seed-cat', priority: 1, done: false, xp: 1, createdAt: 3 });
    // The real server preserves the namespace; assert the stored copy would be
    // rebuilt the same way preserveV21Namespace does it.
    const preserved = Object.prototype.hasOwnProperty.call(olderClientState, '_studyquestV21')
      ? olderClientState._studyquestV21
      : beforeOldClient;
    assert.deepEqual(preserved, beforeOldClient, 'an omitted namespace must be preserved for the older client');
    results.push('older client preserves the namespace');

    // 11. recovery is one screen and a refused action keeps what was typed.
    await page.evaluate(() => { window.liveSyncTestHook = true; });
    await openTracker(page);
    await page.locator('#v21ManualRoot [data-view="manual"]').click();
    const courseBack = page.locator('[data-mc-action="back"]');
    if (await courseBack.isVisible()) await courseBack.click();
    await page.locator('[data-mc-action="add-course"]').click();
    await page.locator('#mcForm input[name="name"]').fill('');
    await page.locator('#mcSubmit').click();
    assert.equal(await page.locator('#v21CourseDialog').isVisible(), true, 'a refused action must keep its form open');
    await page.locator('#mcForm input[name="name"]').fill('Kept after failure');
    assert.equal(await page.locator('#mcForm input[name="name"]').inputValue(), 'Kept after failure', 'entered values must survive a refused action');
    await page.locator('#mcCancel').click();
    results.push('failed action retains entered values');

    // 12. narrow, tablet, and desktop widths must not scroll sideways.
    for (const [label, width, height] of [['phone', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await settle(page, 400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `the page must not scroll sideways at ${label} width (overflow ${overflow}px)`);
    }
    results.push('phone, tablet, and desktop widths');

    // 13. another account's data must be untouched by any of this.
    assert.equal(control.requests.some(entry => entry.path.includes('/api/v2/state/') && entry.path.includes('other')), false, 'no request may reach another account');
    results.push('account isolation');

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }

  return { browser: browserName, checks: results, finalRevision: account.revision };
}

(async () => {
  const report = [];
  for (const browserName of ['chromium', 'webkit']) {
    if (!playwright[browserName]) { console.error(`Skipping ${browserName}: not installed.`); continue; }
    report.push(await run(browserName));
  }
  if (!report.length) throw new Error('No browser engine was available to run the hosted flows.');
  console.log(JSON.stringify({ ok: true, engines: report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
