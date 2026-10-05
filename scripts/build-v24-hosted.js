// Derive v24 from the latest hosted v21 durability foundation, carrying v22/v23 UI.
// Laptop artifacts and all older hosted releases remain untouched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const laptop = path.resolve(root, '..');
const pub = path.join(root, 'public');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function once(s, from, to) {
  if (!s.includes(from) || s.split(from).length !== 2) throw new Error('Ambiguous or missing build anchor: ' + from.slice(0, 80));
  return s.replace(from, to);
}
const localManifest = JSON.parse(read(path.join(laptop, 'v24-version.json')));
for (const [file, expected] of Object.entries({ [localManifest.source]: localManifest.hash, ...localManifest.assets })) {
  if (sha(fs.readFileSync(path.join(laptop, file))) !== expected) throw new Error('Unreviewed laptop artifact: ' + file);
}
const base = read(path.join(pub, 'claudever21.html'));
let html = base.replaceAll('/v21-', '/v24-').replaceAll('claudever21.html','claudever24.html').replaceAll('StudyQuest v21','StudyQuest v24').replaceAll('Local v21','StudyQuest v24').replace('const STUDYQUEST_VERSION = 21', 'const STUDYQUEST_VERSION = 24');
html = html.replaceAll('/app.html?next=v20', '/app.html?next=v24').replaceAll('/app.html?next=v21', '/app.html?next=v24').replaceAll('/api/version?version=20', '/api/version?version=24').replaceAll('/api/version?version=21', '/api/version?version=24').replaceAll('/api/version?version=22', '/api/version?version=24');
html = once(html, 'if (liveSync.pending || getLiveSyncMeta().pending) queueLiveCloudSave();', 'if (liveSync.pending || getLiveSyncMeta().pending || v13DurableOutboxPending || pendingCloudMutation) queueLiveCloudSave();');
const localPage = read(path.join(laptop, 'claudever24.html'));
const initialSubtaskHelperStart = localPage.indexOf('function resetTaskInitialSubtaskField(');
const initialSubtaskHelper = localPage.slice(initialSubtaskHelperStart,localPage.indexOf('\n}',initialSubtaskHelperStart)+2);
if (!initialSubtaskHelper.startsWith('function resetTaskInitialSubtaskField(')) throw new Error('Missing task editor helper');
html = once(html,'function openCreateTask(dateStr) {',initialSubtaskHelper+'\n\nfunction openCreateTask(dateStr) {');
const inlineTitles = localPage.slice(localPage.indexOf('let v23InlineTaskTitleSession'), localPage.indexOf('function renderTaskInlineControls'));
if (!inlineTitles.startsWith('let v23InlineTaskTitleSession')) throw new Error('Missing reviewed inline task-title controls');
html = once(html, 'function renderTaskInlineControls', inlineTitles.replaceAll('v23','v24').replaceAll('V23','V24') + 'function renderTaskInlineControls');
// Port only task rendering functions, leaving hydration and persistence hosted.
for (const name of ['renderTaskList', 'renderCalendarTaskBlock', 'renderTodayTaskRow', 'renderTodayTaskWidget','openCreateTask','saveTask','editTask']) {
  const extract = source => {
    const start = source.search(new RegExp('^function ' + name + '\\(', 'm'));
    if (start < 0) throw new Error('Missing presentation function ' + name);
    const end = source.indexOf('\n}', start) + 2;
    return source.slice(start, end);
  };
  html = once(html, extract(html), extract(localPage).replaceAll('v23','v24').replaceAll('V23','V24'));
}
const modalOf = source => source.slice(source.indexOf('<div class="modal-overlay" id="taskModal">'),source.indexOf('<!-- CATEGORY MODAL -->',source.indexOf('<div class="modal-overlay" id="taskModal">')));
html = once(html,modalOf(html),modalOf(localPage).replaceAll('v23','v24').replaceAll('V23','V24'));
html = once(html, '</head>', '<link rel="stylesheet" href="/v24-interface.css">\n<link rel="stylesheet" href="/v24-date-shifts.css">\n</head>');
html = once(html, '<body>', '<body class="sq-v24">');
html = once(html, '<script src="/v24-manual-courses.js"></script>', '<script src="/v24-manual-courses.js"></script>\n<script src="/v24-subtasks.js"></script>\n<script src="/v24-interface.js"></script>');
html = once(html, 'window.StudyQuestV21Manual?.install(window.studyQuestV21Core);', 'window.StudyQuestV21Manual?.install(window.studyQuestV21Core);\nwindow.StudyQuestV24Subtasks?.install(window.studyQuestV21Core);');
html = once(html, 'window.StudyQuestV24Subtasks?.install(window.studyQuestV21Core);', 'window.StudyQuestV24Subtasks?.install(window.studyQuestV21Core);\nwindow.StudyQuestV24?.install();');
html = once(html, '</body>', '<script src="/v24-date-shifts.js"></script>\n</body>');
// The v22 page predates the final v21 equality/retry bridge. Carry the current
// production bridge forward so namespace-only edits cannot clear their outbox.
let bridge = `
STATE_COMPARISON_SECTIONS.push({ id:'v24-subtasks', label:'Subtasks & recovery' });
const v24PreviousComparisonEntries = comparisonEntriesFor;
comparisonEntriesFor = function(sectionId, source = {}) {
  const entries = v24PreviousComparisonEntries(sectionId, source);
  if (sectionId === 'v24-subtasks') for (const name of ['_studyquestV22','_studyquestV23','_studyquestSubtasks','_studyquestV24']) {
    addComparisonEntry(entries, name, 'namespace', 'Subtasks and their recovery records', source[name] || null);
  }
  return entries;
};
window.studyQuestV21Core.retryUpload = async () => {
  if (!canUseServerStorage()) return {ok:false,skipped:true};
  queueServerStateSave();
  return runLiveSyncCycle({reason:'v24-explicit-save'});
};
// Quota failures can prevent the small localStorage pending marker from being
// written. The verified IndexedDB outbox remains the authoritative retry signal.
window.addEventListener('online', () => {
  if (!v21CanRetryUpload()) return;
  liveSync.pending = true;
  runLiveSyncCycle({reason:'v24-outbox-reconnect'}).catch(error => recordAppError('v24-reconnect',error));
});
`;
html = once(html, 'window.studyQuestV18Install?.();', bridge + '\nwindow.studyQuestV18Install?.();');
const layers = {};
for (const file of ['v18-features.js', 'v19-features.js', 'v20-features.js', 'local-features.js', 'manual-courses.js']) {
  const suffix = file.startsWith('v') ? file : file;
  layers['v24-' + suffix] = read(path.join(pub, 'v22-' + suffix));
}
layers['v24-local-features.js'] = layers['v24-local-features.js'].replaceAll('Laptop v21','StudyQuest v24').replaceAll('Your existing admin connection','Your signed-in account').replaceAll('Reviewed copy saved on this laptop.','Reviewed copy saved on this device.').replaceAll('Export laptop copies','Export device copies');
let taskLayer = layers['v24-v18-features.js'];
const taskSaveStart = taskLayer.indexOf('  function saveTask() {');
const taskSaveEnd = taskLayer.indexOf('\n  function openCreateTask(',taskSaveStart);
let taskSave = taskLayer.slice(taskSaveStart,taskSaveEnd).replace('function saveTask()', 'async function saveTask()').replaceAll('StudyQuestV22Subtasks','StudyQuestV24Subtasks');
taskSave = once(taskSave, "    const duration = readDuration();", `    const subtaskMinutesRaw = String(document.getElementById('taskInitialSubtaskMinutes')?.value || '').trim();
    const subtaskMinutes = subtaskMinutesRaw === '' ? null : Number(subtaskMinutesRaw);
    if (subtaskMinutes !== null && (!initialSubtaskTitle || !Number.isSafeInteger(subtaskMinutes) || subtaskMinutes < 1 || subtaskMinutes > 1440)) {
      call('showToast','Add a subtask title and a whole duration from 1 to 1440 minutes.','#f76a6a'); return;
    }
    const duration = readDuration();`);
taskSave = once(taskSave, "    call('saveState');", `    setEditingTaskId(subtaskParentTask?.id || existingId);
    try { await root.studyQuestV21Core.save(); }
    catch(error) { call('showToast','Task save needs attention. Your entered values are kept.','#f76a6a'); return; }
    if (initialSubtaskTitle && subtaskParentTask) {
      const added = await root.StudyQuestV24Subtasks.addFromTaskEditor(subtaskParentTask,initialSubtaskTitle,subtaskMinutes);
      if (!added) { call('showToast','Task is kept. The first subtask needs attention; its entered values are kept.','#f76a6a'); return; }
    }`);
// The new awaited commit above replaces the inherited v22 fire-and-forget hook.
taskSave = taskSave.slice(0,taskSave.indexOf("    if (initialSubtaskTitle && subtaskParentTask) {",taskSave.indexOf("    restoreAgendaContext(context);"))) + '  }\n';
layers['v24-v18-features.js'] = taskLayer.slice(0,taskSaveStart)+taskSave+taskLayer.slice(taskSaveEnd);
for (const file of ['interface.js', 'interface.css', 'subtasks.js']) {
  layers['v24-' + file] = read(path.join(laptop, 'v23-' + file)).replaceAll('v23', 'v24').replaceAll('V23', 'V24');
}
layers['v24-interface.css'] += '\n' + localPage.slice(localPage.indexOf('  .v23-task-title-inline,'),localPage.indexOf('  .task-drag-handle',localPage.indexOf('  .v23-task-title-inline,'))).replaceAll('v23','v24');
layers['v24-subtasks.js'] = once(layers['v24-subtasks.js'], '    loadUiPrefs();', `    root.StudyQuestV24SubtaskStore?.watch?.(() => {
      if (pending || editState || !key) return;
      Promise.resolve(root.StudyQuestV24SubtaskStore.read(key)).then(stored => {
        const next = normalizeRecord(stored);
        if (JSON.stringify(next) !== JSON.stringify(record)) { record=next; ready=true; error=''; enhance(); }
      }).catch(cause => { error=String(cause.message || cause); enhance(); });
    });
    loadUiPrefs();`);
// Use one page-owned durable outbox for notes, courses, tasks, and subtasks.
// The laptop v23 account adapter has a separate network queue and is not used.
let account = read(path.join(pub, 'v22-account-sync.js')).replaceAll('V22', 'V24').replaceAll('v22', 'v24');
account = once(account, "  const clone = value => JSON.parse(JSON.stringify(value));", `  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
`);
for (const name of ['subtaskPortion','accountPortion']) {
  const start = account.indexOf('  function ' + name + '(');
  const end = account.indexOf('\n  }',start) + 4;
  const body = account.slice(start,end);
  account = once(account,body,body.replace('JSON.stringify(', 'canonical('));
}
account = once(account, "const V24_NAMESPACE = '_studyquestV24';", "const V24_NAMESPACE = '_studyquestSubtasks';");
account = once(account, 'const readV24Namespace = () => normalizeV24Namespace(core.getState()?.[V24_NAMESPACE]);', `const readV24Namespace = () => {
    const state = core.getState();
    return normalizeV24Namespace(state?.[V24_NAMESPACE] || state?._studyquestV23 || state?._studyquestV22);
  };`);
account = once(account, 'const current = normalizeV24Namespace(state[V24_NAMESPACE]);', 'const current = readV24Namespace();');
account = once(account, '        ...current.subtasks,\n        schemaVersion: SUBTASK_SCHEMA_VERSION,', '        ...current.subtasks,\n        ...clone(next),\n        schemaVersion: SUBTASK_SCHEMA_VERSION,');
// Preserve v23 archive/migration metadata and compare it as part of each save.
account = once(account, '      trash: record?.trash || [],', '      trash: record?.trash || [],\n      importArchive: record?.importArchive || [],\n      syncArchive: record?.syncArchive || [],\n      migrationHistory: record?.migrationHistory || [],');
account = once(account, '    hosted: true,\n    read(key)', '    hosted: true,\n    getStatus() { const status = saveStatus(); return { kind:status.kind === "saved" ? "synced" : status.kind === "error" ? "error" : "offline", message:status.label }; },\n    read(key)');
layers['v24-account-sync.js'] = account;
layers['v24-date-shifts.css'] = read(path.join(laptop, 'studyquest-device-date-shifts.css'));
let dates = read(path.join(laptop, 'studyquest-device-date-shifts.js'));
dates = once(dates, '  function saveCanonicalState() {', '  async function saveCanonicalState() {');
dates = once(dates, "      return { ok: true, result: root.saveState() };", `      const bridge = root.studyQuestV21Core;
      if (!bridge || root.document?.documentElement.classList.contains('studyquest-account-loading')) return { ok:false, reason:'account-loading' };
      await bridge.save();
      const pending = bridge.hostedSync?.();
      if (pending?.cloudMode && !pending.acknowledged) {
        try { await bridge.retryUpload?.(); } catch {}
      }
      return { ok:true, acknowledged:bridge.hostedSync?.().acknowledged === true };`);
dates = once(dates, '  function migrateLegacyOverridesToCanonical() {', '  async function migrateLegacyOverridesToCanonical() {');
dates = dates.replaceAll('const saved = saveCanonicalState();', 'const saved = await saveCanonicalState();');
dates = once(dates, '  function moveByDay(taskId, delta) {', '  async function moveByDay(taskId, delta) {');
dates = once(dates, "    showToast(`${verb}: ${task.title || 'Task'} → ${destination.label} · Saved`, '#6af7b0');", "    const acknowledged = root.studyQuestV21Core?.hostedSync?.().acknowledged === true;\n    showToast(`${verb}: ${task.title || 'Task'} → ${destination.label} · ${acknowledged ? 'Saved to account' : 'Saved on this device · cloud backup pending'}`, acknowledged ? '#6af7b0' : '#f7c06a');");
dates = once(dates, '    const legacyMigration = migrateLegacyOverridesToCanonical();', '    const legacyMigration = { ok:true }; // Hosted startup never converts or saves legacy overlays.');
// Serialize clicks so rapid moves cannot mutate an earlier in-flight snapshot.
dates = once(dates, '  function handleClick(event) {', '  let moveQueue = Promise.resolve();\n  function handleClick(event) {');
dates = once(dates, '    else moveByDay(id, Number(target.dataset.sqDeviceDateShift));', '    else { const delta = Number(target.dataset.sqDeviceDateShift); moveQueue = moveQueue.then(() => moveByDay(id, delta)).catch(() => showToast("Date save needs attention. Your recovery copies are kept.", "#f76a6a")); }');
// No import occurs on startup. A deliberate review retains the exact old copy.
dates = once(dates, '    snapshot = readSnapshot();\n    const changes = [];', `    snapshot = readSnapshot();
    if (Object.keys(snapshot.overrides).length) {
      const preview = Object.entries(snapshot.overrides).map(([id, value]) => ({ id, current:findTask(id)?.date, proposed:value.date }));
      root.studyQuestV21Core?.download?.({ format:'studyquest-v24-date-import-preview', legacy:snapshot, preview });
      if (!root.confirm('Review the downloaded date comparison. Apply these legacy date moves to this account? Existing recovery copies will be kept.')) return { ok:false, reason:'cancelled', migrated:0 };
      const backedUp = await root.studyQuestV20Core?.persistRecoveryOnly?.({ state:root.SQ_State, legacyDateMoves:snapshot }, 'Before reviewed v24 date import');
      if (backedUp !== true) return { ok:false, reason:'backup-unverified', migrated:0 };
    }
    const changes = [];`);
// IndexedDB is authoritative; localStorage readback cannot determine durability.
dates = once(dates, '      if (!saved.ok || !canonicalDatesPersisted(changes)) {', '      if (!saved.ok) {');
layers['v24-date-shifts.js'] = dates;
for (const [file, content] of Object.entries(layers)) fs.writeFileSync(path.join(pub, file), content);
fs.writeFileSync(path.join(pub, 'claudever24.html'), html);
const manifest = { version:24, name:'StudyQuest v24 — Persistent task date shifting', source:'claudever24.html', route:'/v24', aliases:['/claudever24.html'], hash:sha(html), assets:Object.fromEntries(Object.entries(layers).map(([file, value]) => [file,sha(value)])), localOnly:false, hosted:true, authenticated:true, deployed:false, main:false, startupReadOnly:true, accessMode:'server-controlled', baseHash:sha(base), dataModel:'existing-account-state-with-preserved-subtask-namespaces', releasedAt:new Date().toISOString() };
fs.writeFileSync(path.join(pub, 'v24-version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok:true, hash:manifest.hash, assets:Object.keys(layers).length }));
