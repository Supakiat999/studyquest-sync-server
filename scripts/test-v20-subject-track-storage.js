// Real browser regression suite. Uses a fresh browser context per case and an
// isolated loopback fixture; it never connects to StudyQuest or a real account.
// NODE_PATH may point to an existing Playwright installation. BROWSER_CHANNEL
// defaults to chrome; BROWSER_ENGINE=webkit uses installed Playwright WebKit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const html = baseline ? execFileSync('git', ['show', 'd17cca8b3cae53c2dc932cb93a8969674a1f07c5:public/claudever20.html'], { cwd:root, encoding:'utf8', maxBuffer:8 * 1024 * 1024 })
  : fs.readFileSync(path.join(root, 'public/claudever20.html'), 'utf8');
function extract(name) {
  const start = html.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing ${name}`);
  const tail = html.slice(start + 1);
  const end = tail.search(/\n(?:async )?function /);
  return html.slice(start, end < 0 ? undefined : start + 1 + end);
}
const helpers = ['openV13DeviceRecoveryDb', 'v13IdbRequest', 'v13IdbTransactionDone',
  'pruneV13DeviceRecoveryCopies', 'persistV13RecoveryOnly', 'persistV13DeviceState', 'readV13DeviceStateBundle'].map(extract).join('\n');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[0]).join('\n');
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body>
<script>
const DEVICE_RECOVERY_DB = 'studyquest_device_recovery_v1';
const DEVICE_RECOVERY_DB_VERSION = 2;
const DEVICE_RECOVERY_COPY_LIMIT = 20;
let v13DurableOutboxPending = false;
let durableSyncDeviceId = '';
window.__STUDYQUEST_ACTIVE_STORAGE_KEY__ = 'studyquest_v3_member';
const v13DurableUsername = () => window.__STUDYQUEST_ACTIVE_STORAGE_KEY__.replace('studyquest_v3_', '');
const isV16StartupReadOnly = () => false;
const cloneStateForSafety = source => JSON.parse(JSON.stringify(source));
const syncUtf8Bytes = value => new TextEncoder().encode(value).length;
const getSyncDeviceId = () => 'sq_fixture_device_1234';
${helpers}
window.SQ_State = {
  tasks:[{id:'shared-id', title:'Member task', progress:50}], notes:[{id:'note1', content:'Keep'}],
  grades:{course1:{score:88}}, fileLinks:[{id:'f1',url:'https://example.invalid/file'}], totalXP:120,
  trackerSemesters:[{id:'sem1',name:'Year 3 Semester 1',subjects:[{id:'s1',name:'Math'}]}],
  tracker:{weeks:[{id:'week1',semId:'sem1',rows:[{id:'row1',subjectId:'s1',topic:'Algebra',done:true}]}]}, activeSemTracker:'sem1'
};
window.originalState = structuredClone(SQ_State);
window.saveCalls = 0;
window.backupCalls = 0;
window.savePromise = null;
window.failMirror = false;
window.studyQuestV20Core = {
  makeSafetySnapshot:(label,source) => ({label,state:structuredClone(source)}),
  persistRecoveryOnly:async (...args) => { backupCalls++; return persistV13RecoveryOnly(...args); },
  setSQState:next => { window.SQ_State = next; }, syncSQStateReference:() => {}, markUserInteracted:() => {},
  pushAutoBackup:() => {}, persistDeviceState:persistV13DeviceState,
  saveState:() => {
    saveCalls++;
    savePromise = persistV13DeviceState(SQ_State, {pending:true,browserSaved:!failMirror}).then(result => {
      if (!failMirror) localStorage.setItem(__STUDYQUEST_ACTIVE_STORAGE_KEY__, JSON.stringify(SQ_State));
      return result;
    });
  },
  durableSaveDrain:() => savePromise,
  getSaveMeta:() => ({localStorageAvailable:!failMirror})
};
window.openModal = id => document.getElementById(id).classList.add('open');
window.closeModal = id => document.getElementById(id).classList.remove('open');
window.showToast = message => { window.lastToast = message; };
window.recordAppError = () => {};
window.prepare = async () => {
  StudyQuestV20.openSubjectTrackingPrompt('subject');
  await StudyQuestV20.addCustomStage('sem1', 'Read');
};
window.dump = async () => {
  const db = await openV13DeviceRecoveryDb();
  try {
    const result = {version:db.version};
    for (const name of db.objectStoreNames) result[name] = await v13IdbRequest(db.transaction(name).objectStore(name).getAll());
    return result;
  } finally { db.close(); }
};
window.seed = async (version, incomplete = false) => {
  const request = indexedDB.open(DEVICE_RECOVERY_DB, version);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of ['accountStates','outbox','recovery','diagnostics','futureStore']) {
      if (incomplete && name === 'diagnostics') continue;
      const store = db.createObjectStore(name, {keyPath:['accountStates','outbox'].includes(name) ? 'username' : 'id'});
      if (['recovery','diagnostics'].includes(name) && !incomplete) store.createIndex('username','username',{unique:false});
      store.put(['accountStates','outbox'].includes(name)
        ? {username:'another-member',state:{tasks:[{id:'shared-id',title:'Other account'}]}}
        : {id:'keep-'+name,username:'another-member',state:{keep:true}});
    }
  };
  const db = await v13IdbRequest(request);
  db.close();
};
</script><script src="/features.js"></script><script>studyQuestV20Install();</script></body></html>`;

(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({method:req.method,path:req.url});
    res.setHeader('Content-Type', req.url === '/features.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/features.js' ? fs.readFileSync(path.join(root,'public/v20-local-features.js')) : fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.BROWSER_ENGINE || 'chromium';
  let browser;
  let passed = 0;
  try {
    browser = await playwright[engine].launch({headless:true, ...(engine === 'chromium' ? {channel:process.env.BROWSER_CHANNEL || 'chrome'} : {})});
    async function run(name, test, viewport = {width:1100,height:830}) {
      const context = await browser.newContext({viewport});
      await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      const page = await context.newPage();
      try {
        await page.goto(origin);
        await test(page, context);
        console.log('PASS', name);
        passed++;
      } finally { await context.close(); }
    }
    if (baseline) {
      await run('reproduces reported VersionError on released v20', async page => {
        const result = await page.evaluate(async () => {
          await seed(3); await prepare();
          const attempt = await StudyQuestV20.enableSubjectTracking();
          return {attempt,saveCalls,backupCalls,state:SQ_State,original:originalState};
        });
        assert.equal(result.attempt.ok,false);
        assert.match(result.attempt.error,/version/i);
        assert.equal(result.saveCalls,0);
        assert.deepEqual(result.state,result.original);
      });
      return;
    }
    for (const version of [0,1,2,3,7]) {
      await run(`v${version || 'new'} database: backup, enable, edit, offline reload, account isolation`, async (page,context) => {
        const result = await page.evaluate(async version => {
          if (version) await seed(version);
          const before = await dump();
          await prepare();
          const first = StudyQuestV20.enableSubjectTracking();
          const second = StudyQuestV20.enableSubjectTracking();
          const busy = document.querySelector('[data-v20-weekly-action="activate"]').disabled;
          const attempts = await Promise.all([first,second]);
          const stageId = SQ_State.tracker.weeklyV20.layouts.sem1.stages[0].id;
          const toggled = await StudyQuestV20.toggleSubjectStage('week1','row1',stageId);
          return {before,after:await dump(),attempts,busy,toggled,stageId,state:SQ_State,original:originalState,saveCalls,backupCalls};
        },version);
        assert.ok(result.attempts.every(value => value.ok));
        assert.equal(result.busy,true);
        assert.equal(result.backupCalls,1);
        assert.equal(result.saveCalls,2);
        assert.equal(result.toggled,true);
        assert.equal(result.after.version,version || 1);
        const original = structuredClone(result.state); delete original.tracker.weeklyV20;
        assert.deepEqual(original,result.original);
        for (const name of ['accountStates','outbox','recovery','diagnostics','futureStore']) {
          if (result.before[name]) assert.deepEqual(result.after[name].filter(row => row.username === 'another-member'), result.before[name]);
        }
        const backup = result.after.recovery.find(row => row.label === 'Before enabling v20 Subject Track');
        assert.deepEqual(backup.state,result.original);
        assert.deepEqual(result.after.outbox.find(row => row.username === 'member').state,result.state);
        await page.reload();
        await context.setOffline(true);
        const reopened = await page.evaluate(async () => {
          const bundle = await readV13DeviceStateBundle();
          SQ_State = bundle.accountState.state;
          return {state:SQ_State,outbox:bundle.outbox};
        });
        assert.deepEqual(reopened.state,result.state);
        assert.deepEqual(reopened.outbox.state,result.state);
      });
    }
    await run('old incomplete schema: additive repair and concurrent opens', async page => {
      const result = await page.evaluate(async () => {
        await seed(1,true);
        const databases = await Promise.all([openV13DeviceRecoveryDb(),openV13DeviceRecoveryDb()]);
        databases.forEach(db => db.close());
        await prepare();
        return {attempt:await StudyQuestV20.enableSubjectTracking(),data:await dump()};
      });
      assert.equal(result.attempt.ok,true);
      assert.equal(result.data.version,2);
      assert.equal(result.data.futureStore[0].state.keep,true);
      assert.equal(result.data.recovery.find(row => row.id === 'keep-recovery').state.keep,true);
    });
    await run('blocked upgrade fails promptly, aborts late upgrade, then retries safely', async page => {
      const result = await page.evaluate(async () => {
        await seed(2,true);
        const held = await v13IdbRequest(indexedDB.open(DEVICE_RECOVERY_DB));
        await prepare();
        const failure = await StudyQuestV20.enableSubjectTracking();
        const draft = document.querySelector('[data-v20-weekly-action="rename-stage"]').value;
        const retryEnabled = !document.querySelector('[data-v20-weekly-action="activate"]').disabled;
        const unchanged = JSON.stringify(SQ_State) === JSON.stringify(originalState) && saveCalls === 0;
        held.close();
        // Opening without a version queues behind the abandoned upgrade.
        const db = await v13IdbRequest(indexedDB.open(DEVICE_RECOVERY_DB));
        const versionAfterFailure = db.version; db.close();
        const retry = await StudyQuestV20.enableSubjectTracking();
        return {failure,draft,retryEnabled,unchanged,versionAfterFailure,retry};
      });
      assert.equal(result.failure.ok,false);
      assert.match(result.failure.error,/other StudyQuest tabs/);
      assert.equal(result.draft,'Read');
      assert.equal(result.retryEnabled,true);
      assert.equal(result.unchanged,true);
      assert.equal(result.versionAfterFailure,2);
      assert.equal(result.retry.ok,true);
    });
    for (const mode of ['denied','quota','abort','readback','unavailable','timeout']) {
      await run(`${mode}: no activation or active-copy write; useful message and retry`, async page => {
        const result = await page.evaluate(async mode => {
          await seed(3); await prepare();
          const originalOpen = indexedDB.open;
          const originalIdbDescriptor = Object.getOwnPropertyDescriptor(window,'indexedDB');
          const originalPut = IDBObjectStore.prototype.put;
          const originalTimer = window.setTimeout;
          if (mode === 'denied') indexedDB.open = () => { throw new DOMException('Denied','SecurityError'); };
          if (mode === 'timeout') {
            indexedDB.open = () => ({});
            window.setTimeout = (callback,ms) => originalTimer(callback,ms === 10000 ? 5 : ms);
          }
          if (mode === 'unavailable') Object.defineProperty(window,'indexedDB',{configurable:true,value:null});
          if (['quota','abort','readback'].includes(mode)) IDBObjectStore.prototype.put = function(value) {
            if (this.name === 'recovery') {
              if (mode === 'quota') throw new DOMException('Full','QuotaExceededError');
              if (mode === 'readback') return this.get(value.id);
              this.transaction.abort();
            }
            return originalPut.call(this,value);
          };
          const attempt = await StudyQuestV20.enableSubjectTracking();
          const message = document.getElementById('v20WeeklyStageManagerStatus').textContent;
          if (mode === 'unavailable') Object.defineProperty(window,'indexedDB',originalIdbDescriptor);
          indexedDB.open = originalOpen;
          IDBObjectStore.prototype.put = originalPut;
          window.setTimeout = originalTimer;
          return {attempt,message,saveCalls,state:SQ_State,original:originalState,data:await dump()};
        },mode);
        assert.equal(result.attempt.ok,false);
        assert.equal(result.saveCalls,0);
        assert.deepEqual(result.state,result.original);
        assert.ok(!result.data.accountStates.some(row => row.username === 'member'));
        assert.match(result.message,/still off/);
        if (mode === 'readback') assert.match(result.message,/could not be verified/);
        if (mode === 'denied') assert.match(result.message,/website storage allowed/);
        if (mode === 'quota') assert.match(result.message,/Keep your StudyQuest website data/);
      });
    }
    for (const change of ['edit','account']) {
      await run(`${change} during backup: preserve latest state and pending setup`, async page => {
        const result = await page.evaluate(async change => {
          await prepare();
          studyQuestV20Core.persistRecoveryOnly = async (...args) => {
            await persistV13RecoveryOnly(...args);
            if (change === 'edit') SQ_State.tasks.push({id:'new-edit',title:'Unsaved concurrent edit'});
            else __STUDYQUEST_ACTIVE_STORAGE_KEY__ = 'studyquest_v3_other';
            return true;
          };
          const attempt = await StudyQuestV20.enableSubjectTracking();
          return {attempt,saveCalls,state:SQ_State};
        },change);
        assert.equal(result.attempt.ok,false);
        assert.match(result.attempt.error,/data changed/);
        assert.equal(result.saveCalls,0);
        assert.equal(result.state.tracker.weeklyV20,undefined);
        if (change === 'edit') assert.equal(result.state.tasks.at(-1).id,'new-edit');
      });
    }
    await run('full browser mirror: durable recovery copy and outbox still work', async page => {
      const result = await page.evaluate(async () => {
        failMirror = true; await prepare();
        const attempt = await StudyQuestV20.enableSubjectTracking();
        return {attempt,data:await dump()};
      });
      assert.equal(result.attempt.ok,true);
      assert.equal(result.data.accountStates[0].authoritative,true);
      assert.equal(result.data.outbox[0].state.tracker.weeklyV20.enabled,true);
    });
    await run('connections yield to another tab upgrading the database', async page => {
      const version = await page.evaluate(async () => {
        const first = await openV13DeviceRecoveryDb();
        const second = await v13IdbRequest(indexedDB.open(DEVICE_RECOVERY_DB,first.version + 1));
        const version = second.version; second.close(); return version;
      });
      assert.equal(version,2);
    });
    for (const width of [390,820,1100]) {
      await run(`setup usable at ${width}px; cancel does not save`, async page => {
        await page.evaluate(() => prepare());
        await page.locator('#v20WeeklyStageManagerModal').evaluate(modal => { modal.style.display = 'flex'; });
        const button = page.locator('[data-v20-weekly-action="activate"]');
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 850);
        const dimensions = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth,view:innerWidth}));
        assert.ok(dimensions.scroll <= dimensions.view + 1);
        if (process.env.TEST_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR,{recursive:true});
          await page.screenshot({path:path.join(process.env.TEST_SCREENSHOT_DIR,`v20-setup-${width}.png`)});
        }
        await page.locator('[data-v20-weekly-action="cancel-setup"]').click();
        assert.deepEqual(await page.evaluate(() => ({saveCalls,backupCalls})),{saveCalls:0,backupCalls:0});
      },{width,height:850});
    }
    assert.ok(requests.every(request => request.method === 'GET'));
    console.log(JSON.stringify({ok:true,engine,cases:passed,liveAccountWrites:0}));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
