// Shared recovery database compatibility suite.
//
// Every StudyQuest generation opens the same IndexedDB database
// (studyquest_device_recovery_v1). A generation that requests a fixed version
// cannot open a database another generation already upgraded, which is how
// Subject Track failed with VersionError. This suite extracts each generation's
// real opener from its shipped HTML and runs it against databases seeded at
// older, equal, newer and incomplete schema versions.
//
// Default mode drives the fixture with Playwright when it resolves through Node
// (an installed package or NODE_PATH). `--serve` instead serves the fixture on
// loopback so the same cases can be run by hand in any browser, including the
// LINE in-app browser on a phone or iPad. It never connects to StudyQuest, a
// real account, or an existing browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const serveOnly = process.argv.includes('--serve');
const host = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

// The database a generation must be able to open, and what its opener needs.
const generations = [
  { id:'v9', file:'claudever9.html', opener:'openDeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery'], indexed:['recovery'] },
  { id:'v13', file:'claudever13.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v14', file:'claudever14.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v15', file:'claudever15.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v16', file:'claudever16.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v19', file:'claudever19.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v20', file:'claudever20.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
  { id:'v21', file:'claudever21.html', opener:'openV13DeviceRecoveryDb', stores:['accountStates', 'outbox', 'recovery', 'diagnostics'], indexed:['recovery', 'diagnostics'] },
];

function extract(html, name, label) {
  const start = html.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, `${label}: missing ${name}`);
  const tail = html.slice(start + 1);
  const end = tail.search(/\n(?:async )?function /);
  return html.slice(start, end < 0 ? undefined : start + 1 + end);
}

const openers = generations.map(generation => {
  const html = fs.readFileSync(path.join(root, 'public', generation.file), 'utf8');
  const source = extract(html, generation.opener, generation.id);
  assert.ok(source.includes('indexedDB.open(DEVICE_RECOVERY_DB)'),
    `${generation.id} must open the shared recovery database at its existing version`);
  return `  ${generation.id}: (() => {\n${source}\n    return ${generation.opener};\n  })(),`;
}).join('\n');

const plan = JSON.stringify(generations.map(({ id, stores, indexed }) => ({ id, stores, indexed })));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>StudyQuest recovery database compatibility</title>
<style>
  body { margin:0; padding:16px; font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#16060f; color:#f7e9f2; }
  h1 { font-size:19px; margin:0 0 4px; }
  p { margin:0 0 16px; color:#d3a9c4; }
  #summary { font-weight:600; padding:12px 14px; border-radius:10px; margin-bottom:14px; }
  .pass { background:#123524; color:#6af7b0; }
  .fail { background:#3a1020; color:#ff9db4; }
  ol { margin:0; padding-left:22px; }
  li { margin-bottom:6px; }
  li.fail { color:#ff9db4; }
  code { font-family:ui-monospace, Menlo, Consolas, monospace; font-size:13px; }
</style></head><body>
<h1>StudyQuest recovery database compatibility</h1>
<p>Runs every app generation's real recovery-storage opener against older, newer
and incomplete databases. Uses this page's own storage only.</p>
<div id="summary">Running…</div>
<ol id="results"></ol>
<script>
const DEVICE_RECOVERY_DB = 'studyquest_device_recovery_v1';
const openers = {
${openers}
};
const plan = ${plan};
window.openers = openers;

function request(value) {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('IndexedDB request failed'));
  });
}

function removeDatabase() {
  return new Promise((resolve, reject) => {
    const attempt = indexedDB.deleteDatabase(DEVICE_RECOVERY_DB);
    attempt.onsuccess = () => resolve();
    attempt.onblocked = () => resolve();
    attempt.onerror = () => reject(attempt.error || new Error('Could not reset the fixture database'));
  });
}

// Recreates what an older or newer generation left on a real device.
function seed({ version, stores, indexes = stores, unknownStore = true }) {
  return new Promise((resolve, reject) => {
    const attempt = indexedDB.open(DEVICE_RECOVERY_DB, version);
    attempt.onupgradeneeded = () => {
      const db = attempt.result;
      const created = unknownStore ? stores.concat(['futureStore']) : stores;
      for (const name of created) {
        const keyPath = ['accountStates', 'outbox'].includes(name) ? 'username' : 'id';
        const store = db.createObjectStore(name, { keyPath });
        if (indexes.includes(name) && !['accountStates', 'outbox'].includes(name)) {
          store.createIndex('username', 'username', { unique:false });
        }
        store.put(keyPath === 'username'
          ? { username:'another-member', state:{ tasks:[{ id:'kept', title:'Another account task' }] } }
          : { id:'seeded-row', username:'another-member', label:'seeded' });
      }
    };
    attempt.onsuccess = () => { attempt.result.close(); resolve(); };
    attempt.onerror = () => reject(attempt.error || new Error('Could not seed the fixture database'));
  });
}

async function inspect(db) {
  const report = { version:db.version, stores:[...db.objectStoreNames], rows:{} };
  for (const name of report.stores) {
    report.rows[name] = await request(db.transaction(name, 'readonly').objectStore(name).getAll());
  }
  return report;
}

// Every seeded row must survive an open, including rows another account or a
// newer generation wrote into stores this generation does not know about.
function assertPreserved(report, seeded) {
  for (const name of seeded) {
    if (!report.stores.includes(name)) throw new Error('Store ' + name + ' disappeared');
    if (!report.rows[name].length) throw new Error('Store ' + name + ' lost its rows');
  }
  if (!report.stores.includes('futureStore')) throw new Error('An unknown newer store was dropped');
}

async function openWith(id) {
  const db = await openers[id]();
  try { return await inspect(db); } finally { db.close(); }
}

function buildCases() {
  const cases = [];
  const complete = ['accountStates', 'outbox', 'recovery', 'diagnostics'];
  for (const generation of plan) {
    cases.push({
      name: generation.id + ': new device, no database yet',
      run: async () => {
        const report = await openWith(generation.id);
        for (const name of generation.stores) {
          if (!report.stores.includes(name)) throw new Error('Missing store ' + name);
        }
      },
    });
    // Version 3 is what v15/v16 (the main version) leave behind, and version 7
    // stands in for any future generation.
    for (const version of [1, 2, 3, 7]) {
      cases.push({
        name: generation.id + ': database already at version ' + version,
        run: async () => {
          await seed({ version, stores:complete });
          const report = await openWith(generation.id);
          if (report.version < version) throw new Error('Database was downgraded to ' + report.version);
          assertPreserved(report, complete);
        },
      });
    }
    cases.push({
      name: generation.id + ': newer database missing a required store',
      run: async () => {
        await seed({ version:3, stores:['accountStates', 'outbox', 'recovery'] });
        const report = await openWith(generation.id);
        for (const name of generation.stores) {
          if (!report.stores.includes(name)) throw new Error('Missing store ' + name);
        }
        assertPreserved(report, ['accountStates', 'outbox', 'recovery']);
      },
    });
    cases.push({
      name: generation.id + ': newer database missing the username index',
      run: async () => {
        await seed({ version:3, stores:complete, indexes:[] });
        const report = await openWith(generation.id);
        assertPreserved(report, complete);
        const db = await openers[generation.id]();
        try {
          for (const name of generation.indexed) {
            if (!db.transaction(name, 'readonly').objectStore(name).indexNames.contains('username')) {
              throw new Error('Missing username index on ' + name);
            }
          }
        } finally { db.close(); }
      },
    });
  }
  // The reported failure: the main version leaves the database at 3, then the
  // user opens v20 and enables Subject Track.
  cases.push({
    name: 'main version then v20 Subject Track (the reported failure)',
    run: async () => {
      await seed({ version:3, stores:complete });
      await openWith('v15');
      const report = await openWith('v20');
      assertPreserved(report, complete);
    },
  });
  cases.push({
    name: 'every generation opened in turn on one device',
    run: async () => {
      for (const generation of plan) await openWith(generation.id);
      for (const generation of [...plan].reverse()) {
        const report = await openWith(generation.id);
        if (!report.stores.includes('recovery')) throw new Error('Recovery store lost during the sequence');
      }
    },
  });
  return cases;
}

window.runAll = async () => {
  const results = [];
  for (const testCase of buildCases()) {
    await removeDatabase();
    try {
      await testCase.run();
      results.push({ name:testCase.name, ok:true });
    } catch (error) {
      results.push({ name:testCase.name, ok:false, error:String(error && error.message || error) });
    }
  }
  await removeDatabase();
  return results;
};

window.renderAll = async () => {
  const results = await window.runAll();
  const failed = results.filter(result => !result.ok);
  const list = document.getElementById('results');
  list.innerHTML = results.map(result => '<li class="' + (result.ok ? 'pass' : 'fail') + '">'
    + result.name + (result.ok ? ' — passed' : ' — FAILED: <code>' + result.error + '</code>') + '</li>').join('');
  const summary = document.getElementById('summary');
  summary.className = failed.length ? 'fail' : 'pass';
  summary.textContent = failed.length
    ? failed.length + ' of ' + results.length + ' cases failed'
    : 'All ' + results.length + ' cases passed';
  return results;
};

window.ready = window.renderAll();
</script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
  res.end(fixture);
});

server.listen(serveOnly ? 4173 : 0, host, async () => {
  const port = server.address().port;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
  if (serveOnly) {
    console.log(`Recovery database compatibility fixture: ${url}`);
    if (host === '0.0.0.0') {
      for (const entries of Object.values(require('node:os').networkInterfaces())) {
        for (const entry of entries || []) {
          if (entry.family === 'IPv4' && !entry.internal) console.log(`  on this network: http://${entry.address}:${port}/`);
        }
      }
    }
    console.log('Open it in any browser, including LINE, to run the cases there. Press Ctrl+C to stop.');
    return;
  }
  let playwright;
  try { playwright = require('playwright'); }
  catch (error) {
    server.close();
    console.error('Playwright is not available through Node module resolution.');
    console.error(`Install it, or run "node ${path.relative(process.cwd(), __filename)} --serve" and open the fixture in a browser.`);
    process.exit(1);
  }
  const engine = process.env.BROWSER_ENGINE === 'webkit' ? playwright.webkit : playwright.chromium;
  const browser = await engine.launch(process.env.BROWSER_ENGINE === 'webkit' ? {}
    : { channel:process.env.BROWSER_CHANNEL || 'chrome' });
  let failures = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    const results = await page.evaluate(() => window.ready);
    failures = results.filter(result => !result.ok);
    for (const result of results) {
      console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : ` — ${result.error}`}`);
    }
    console.log(`${results.length - failures.length}/${results.length} recovery database compatibility cases passed.`);
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) process.exit(1);
});
