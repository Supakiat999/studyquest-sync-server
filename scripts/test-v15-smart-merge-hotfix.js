const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { statesEqualIgnoringRootUpdatedAt } = require('../lib/state-safety');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'claudever15.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

function loadFunctions(source, names, setup = '', context = {}) {
  const code = [setup, ...names.map(name => extractFunction(source, name))]
    .concat(names.map(name => `this.${name} = ${name};`)).join('\n');
  vm.runInNewContext(code, context);
  return context;
}

const anyaCloud = {
  tasks:Array.from({ length:62 }, (_, index) => ({ id:`task-${index}`, title:`Task ${index}`, done:false })),
  notes:Array.from({ length:6 }, (_, index) => ({ id:`note-${index}`, title:`Note ${index}` })),
  files:[{ id:'file-1', name:'safe.pdf' }],
  updatedAt:100,
};
const timestampOnly = structuredClone(anyaCloud);
timestampOnly.updatedAt = 200;
assert.equal(statesEqualIgnoringRootUpdatedAt(anyaCloud, timestampOnly), true);
assert.equal(statesEqualIgnoringRootUpdatedAt(anyaCloud, { ...timestampOnly, tasks:timestampOnly.tasks.slice(0, 61) }), false);
const nestedTimestampChange = structuredClone(timestampOnly);
nestedTimestampChange.tasks[0].updatedAt = 200;
assert.equal(statesEqualIgnoringRootUpdatedAt(anyaCloud, nestedTimestampChange), false);

const mergeContext = loadFunctions(html, [
  'syncPathSegments',
  'syncPathJoin',
  'syncCanonicalValue',
  'syncValueString',
  'syncValuesEqual',
  'isSyncUiOnlyPath',
  'mergeRelevantStateValue',
  'mergeRelevantStatesEquivalent',
  'shouldOpenLiveSyncConflictModal',
], `const SYNC_UI_ONLY_ROOTS = new Set([
  'updatedAt', 'checklistFilter', 'calendarView', 'calendarDate', 'activeTripId',
  'travelSubtab', 'travelItineraryView', 'travelCalendarAxis', 'travelPlaceFilter',
  'travelPlaceSearch', 'activeTravelPlaceId', 'activeTravelDayId',
  'activeTravelActivityId', 'activeSemTracker', 'activeCurriculumId',
  'activeSemesterByCurriculum',
]);`);

const mergeLocal = structuredClone(anyaCloud);
mergeLocal.updatedAt = 300;
mergeLocal.calendarView = 'week';
mergeLocal._syncMeta = { seq:99 };
assert.equal(mergeContext.mergeRelevantStatesEquivalent(anyaCloud, mergeLocal), true);
mergeLocal.tasks[0].title = 'Real task change';
assert.equal(mergeContext.mergeRelevantStatesEquivalent(anyaCloud, mergeLocal), false);
assert.equal(mergeContext.shouldOpenLiveSyncConflictModal({ reason:'scheduled-preview' }), false);
assert.equal(mergeContext.shouldOpenLiveSyncConflictModal({ reason:'server-conflict' }), false);
assert.equal(mergeContext.shouldOpenLiveSyncConflictModal({ reason:'manual-review' }), true);
assert.equal(mergeContext.shouldOpenLiveSyncConflictModal({ reason:'scheduled-preview' }, true), true);

const browserCopy = structuredClone(anyaCloud);
const cloudCopy = structuredClone(anyaCloud);
for (let index = 0; index < 53; index += 1) cloudCopy.tasks[index].title = `Older cloud task ${index}`;
const decisionsFor = (localState, cloudState, selections = {}) => {
  const decisions = localState.tasks.flatMap((task, index) => task.title === cloudState.tasks[index].title ? [] : [{
    path:`tasks/@${task.id}/title`,
    selected:selections[`tasks/@${task.id}/title`] || 'local',
    recommended:'local',
  }]);
  return {
    different:decisions.length > 0,
    unresolved:0,
    decisions,
    selections:Object.fromEntries(decisions.map(decision => [decision.path, decision.selected])),
    mergedState:structuredClone(localState),
  };
};
const rebaseContext = {
  cloneStateForSafety:structuredClone,
  normalizeState:structuredClone,
  defaultState:() => ({ tasks:[] }),
  buildStateComparison:() => ({ different:true, comparedAt:'now' }),
  buildSmartMerge:decisionsFor,
};
loadFunctions(html, ['rebaseSmartMergePreview'], '', rebaseContext);
const originalMerge = decisionsFor(browserCopy, cloudCopy);
assert.equal(originalMerge.decisions.length, 53, 'Anya-shaped fixture must have 53 reliable local decisions');
const preview = {
  localState:browserCopy,
  cloudState:cloudCopy,
  revision:272,
  selections:originalMerge.selections,
  smartMerge:originalMerge,
};
const timestampBumpedCloud = structuredClone(cloudCopy);
timestampBumpedCloud.updatedAt = 999;
rebaseContext.rebaseSmartMergePreview(preview, browserCopy, timestampBumpedCloud, {
  revision:273,
  stateHash:'a'.repeat(64),
  updatedAt:'2026-08-21T09:00:00Z',
});
assert.equal(preview.revision, 273);
assert.equal(preview.smartMerge.decisions.length, 53);
assert.equal(Object.values(preview.selections).every(value => value === 'local'), true);
assert.equal(preview.localState.tasks.length, 62);
assert.equal(preview.cloudState.notes.length, 6);

const postponeSource = extractFunction(html, 'postponeLiveSyncReview');
assert.match(postponeSource, /closeModal\('liveSyncConflictModal'\)/);
assert.doesNotMatch(postponeSource, /liveSync\.conflict\s*=\s*null/);
assert.match(extractFunction(html, 'reviewPendingLiveSyncConflict'), /await compareChromeAndLive\(\)/);

const applySource = extractFunction(html, 'applySmartMerge');
assert.match(applySource, /mergeRelevantStatesEquivalent\(latestCloudState, preview\.cloudState/);
assert.match(applySource, /mergeRelevantStatesEquivalent\(state, preview\.localState/);
assert.match(applySource, /rebaseSmartMergePreview\(preview, state, latestCloudState/);
assert.doesNotMatch(applySource, /latestRevision !== Number\(preview\.revision/);
assert.match(applySource, /\{ forceOpen:true \}/);

assert.match(html, /id="syncReviewBanner"/);
assert.match(html, /onclick="reviewPendingLiveSyncConflict\(\)"/);
assert.match(html, /Sync review needed — both copies are safe/);
assert.doesNotMatch(html, /localStorage\.clear\s*\(/);
assert.doesNotMatch(html, /localStorage\.removeItem\(\s*STORAGE_KEY\s*\)/);

const noChangeStart = server.indexOf('const rootTimestampOnlyMatch');
const noChangeEnd = server.indexOf('const destructive = unapprovedManifestRemovals', noChangeStart);
const noChangeBranch = server.slice(noChangeStart, noChangeEnd);
assert.ok(noChangeStart >= 0 && noChangeEnd > noChangeStart);
assert.match(noChangeBranch, /currentManifest\.contentHash === incomingManifest\.contentHash/);
assert.match(noChangeBranch, /Ignored root updatedAt-only save/);
assert.match(noChangeBranch, /ignoredVolatileOnly:true/);
assert.match(noChangeBranch, /stateHash:currentHash/);
assert.doesNotMatch(noChangeBranch, /update accounts/i);
assert.doesNotMatch(noChangeBranch, /insertStateVersion/);

console.log('v15 smart-merge hotfix, non-blocking review, 53-decision rebase, and timestamp no-op tests passed.');
