const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  additiveIncidentRecovery,
  recoverMissingRecords,
  deserializeStateVersion,
  massDeletionRisk,
  serializeStateVersion,
  stableStringify,
  stateHash,
  stateRecordDiff,
  stateSummary,
  unapprovedRemovals,
} = require("../lib/state-safety");

const unorderedLeft = { beta: [2, { z: true, a: "x" }], alpha: 1 };
const unorderedRight = { alpha: 1, beta: [2, { a: "x", z: true }] };
assert.equal(stableStringify(unorderedLeft), stableStringify(unorderedRight));
assert.equal(stateHash(unorderedLeft), stateHash(unorderedRight));

const prepared = serializeStateVersion(unorderedLeft);
assert.deepEqual(deserializeStateVersion(prepared.stateGzip), unorderedLeft);
assert.equal(prepared.stateBytes, Buffer.byteLength(JSON.stringify(unorderedLeft)));
assert.ok(prepared.compressedBytes > 0);

const current = {
  tasks: [
    { id: "shared", title: "Shared task, currently edited", date: "2026-08-14" },
    { id: "current", title: "Current-only task" },
  ],
  tracker: { weeks: [{ id: "week-shared", label: "Current week label" }] },
  trackerSemesters: [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }, { id: "s5" }, { id: "s6" }],
  notes: [{ id: "note-current", text: "Keep me" }],
};
const backup = {
  tasks: [
    { id: "shared", title: "Older shared title", date: "2026-08-12" },
    { id: "missing-1", title: "Recovered task one" },
    { id: "missing-2", title: "Recovered task two" },
  ],
  tracker: {
    weeks: [
      { id: "week-shared", label: "Older week label" },
      { id: "week-missing-1", label: "Recovered week one" },
      { id: "week-missing-2", label: "Recovered week two" },
    ],
  },
  trackerSemesters: [{ id: "old-semester" }],
  notes: [{ id: "old-note", text: "Must not replace current notes" }],
};
const before = JSON.stringify(current);
const recovered = additiveIncidentRecovery(current, backup);
assert.equal(JSON.stringify(current), before, "recovery must not mutate the current state");
assert.equal(recovered.addedTasks.length, 2);
assert.equal(recovered.addedWeeks.length, 2);
assert.equal(recovered.state.tasks.length, 4);
assert.equal(recovered.state.tracker.weeks.length, 3);
assert.equal(recovered.state.trackerSemesters.length, 6);
assert.equal(recovered.state.tasks[0].title, "Shared task, currently edited");
assert.equal(recovered.state.tracker.weeks[0].label, "Current week label");
assert.deepEqual(recovered.state.notes, current.notes);
assert.deepEqual(stateSummary(recovered.state), {
  tasks: 4,
  notes: 1,
  files: 0,
  checklist: 0,
  grades: 0,
  trips: 0,
  weeklyWeeks: 3,
  weeklySemesters: 6,
});

const repeated = additiveIncidentRecovery(recovered.state, backup);
assert.equal(repeated.addedTasks.length, 0);
assert.equal(repeated.addedWeeks.length, 0);
assert.deepEqual(repeated.state, recovered.state, "recovery must be idempotent");

const completeState = {
  tasks: Array.from({ length: 89 }, (_, index) => ({ id:`task-${index + 1}`, title:`Task ${index + 1}` })),
  notes:[{ id:"note-1", title:"Current note" }],
  fileLinks:[{ id:"file-1", title:"File" }],
  checklistItems:[{ id:"check-1", title:"Checklist" }],
  trips:[{ id:"trip-uk", name:"UK" }],
  tracker:{ weeks:Array.from({ length:4 }, (_, index) => ({ id:`week-${index + 1}`, label:`Week ${index + 1}`, rows:[{ id:`row-${index + 1}`, subject:"Subject" }] })) },
  trackerSemesters:Array.from({ length:4 }, (_, index) => ({ id:`semester-${index + 1}`, subjects:[{ id:`subject-${index + 1}`, subject:"Course" }] })),
  grades:{ math:{ id:"math", name:"Math", scores:[{ id:"score-1", earned:9, possible:10 }] } },
};
const staleState = structuredClone(completeState);
staleState.tasks = staleState.tasks.slice(0, 78);
staleState.trips = [];
staleState.tracker.weeks = [];
const destructive = unapprovedRemovals(completeState, staleState, null);
assert.equal(destructive.unapproved.filter(item => item.collection === "tasks").length, 11,
  "the exact 89-to-78 stale task drop must be detected");
assert.equal(destructive.unapproved.filter(item => item.collection === "trips").length, 1);
assert.equal(destructive.unapproved.filter(item => item.collection === "tracker.weeks").length, 4);

const intentionalTaskDelete = structuredClone(completeState);
intentionalTaskDelete.tasks = intentionalTaskDelete.tasks.slice(1);
const taskRemoval = stateRecordDiff(completeState, intentionalTaskDelete).removed.find(item => item.collection === "tasks");
assert.ok(taskRemoval);
assert.equal(unapprovedRemovals(completeState, intentionalTaskDelete, {
  deletes:[{ key:taskRemoval.key }],
}).unapproved.length, 0, "an explicitly manifested user deletion must be accepted");

const completeManifest = require("../lib/state-safety").stateManifest(completeState);
const oneDeleteManifest = require("../lib/state-safety").stateManifest(intentionalTaskDelete);
assert.equal(massDeletionRisk(completeManifest, oneDeleteManifest).risky, false,
  "one deliberate deletion must not be quarantined as a mass deletion");

const catastrophicState = structuredClone(completeState);
catastrophicState.tasks = catastrophicState.tasks.slice(0, 10);
catastrophicState.tracker.weeks = [];
const catastrophicRisk = massDeletionRisk(
  completeManifest,
  require("../lib/state-safety").stateManifest(catastrophicState)
);
assert.equal(catastrophicRisk.risky, true,
  "a broad deletion must be quarantined even when the client declares every removal");
assert.ok(catastrophicRisk.removedCount >= 20);

const broadRecoveryCurrent = structuredClone(staleState);
broadRecoveryCurrent.notes = [];
broadRecoveryCurrent.fileLinks = [];
broadRecoveryCurrent.checklistItems = [];
broadRecoveryCurrent.grades = {};
const broadRecovery = recoverMissingRecords(broadRecoveryCurrent, completeState);
assert.equal(broadRecovery.summary.tasks, 89);
assert.equal(broadRecovery.summary.notes, 1);
assert.equal(broadRecovery.summary.files, 1);
assert.equal(broadRecovery.summary.checklist, 1);
assert.equal(broadRecovery.summary.grades, 1);
assert.equal(broadRecovery.summary.trips, 1);
assert.equal(broadRecovery.summary.weeklyWeeks, 4);
assert.equal(broadRecovery.summary.weeklySemesters, 4);
assert.ok(broadRecovery.additions.length >= 20);
assert.deepEqual(recoverMissingRecords(broadRecovery.state, completeState).state, broadRecovery.state,
  "missing-item recovery must be idempotent across all protected collections");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "schema.sql"), "utf8");
const recoveryPage = fs.readFileSync(path.join(root, "public", "device-recovery.js"), "utf8");
const v13 = fs.readFileSync(path.join(root, "public", "claudever13.html"), "utf8");
for (const marker of ["state_versions", "state_save_events", "pre_incident_recovery"]) {
  assert.ok(schema.includes(marker) || server.includes(marker), `Missing save-safety marker: ${marker}`);
}
assert.ok(server.includes('error: "VERSIONED_STATE_REQUIRED"'), "Unversioned writes must be disabled");
assert.ok(server.includes('result: "conflicted"'), "Conflicted saves must be audited");
assert.ok(server.includes('result: "oversized"'), "Oversized saves must be audited");
assert.ok(server.includes('"DESTRUCTIVE_CHANGE_REVIEW_REQUIRED"'),
  "Unexplained destructive saves must be blocked by the server");
assert.ok(server.includes("massDeletionRisk(currentManifest, incomingManifest)"),
  "Declared mass deletions must also be quarantined for explicit recovery review");
assert.ok(server.includes('"BASE_HASH_MISMATCH"'),
  "Revision equality must be backed by a state hash");
assert.ok(server.includes("if (duplicateRevision !== currentRevision)"),
  "A retried mutation must detect when Saved Online advanced after its original acceptance");
assert.ok(server.includes("requiresRefresh:true"),
  "An accepted retry acknowledgement must request a safe refresh when cloud advanced");
assert.ok(server.includes("handleRecoveryVersionRecoverMissing"),
  "Every account needs additive missing-item recovery");
assert.ok(server.includes("recovered.state.updatedAt = Date.now();"),
  "Recovered missing items must receive a fresh device-visible update time");
assert.ok(server.includes('d.username = $2'), "Paired server tokens must be restricted to admin");
assert.ok(server.includes('handleAnyaIncidentRecovery'), "Verified additive incident recovery route is missing");
assert.ok(!recoveryPage.includes('/api/v2/state') && !recoveryPage.includes('/api/state'),
  "Recovery must not bypass the dedicated recovery endpoints with a whole-state write");
assert.ok(!recoveryPage.includes('localStorage.setItem') && !recoveryPage.includes('indexedDB.deleteDatabase'),
  "Device recovery must not mutate browser storage");
assert.ok(v13.includes("function buildBulkSelectedSmartMerge("),
  "Bulk merge choices must resolve fields revealed by earlier choices");
assert.ok(v13.includes("for (let pass = 0; pass < 25; pass += 1)"),
  "Bulk merge selection must iterate to a stable reviewed result");
assert.ok(v13.includes("const DEVICE_RECOVERY_DB = 'studyquest_device_recovery_v1';"),
  "v13 must keep an IndexedDB device recovery copy");
assert.ok(v13.includes("const CLOUD_SAVE_QUIET_MS = 500;"),
  "v13 edits must start cloud backup promptly");
assert.ok(v13.includes("window.addEventListener('pagehide', preserveV13StateBeforeExit);"),
  "v13 must preserve a final device copy when the page closes");
assert.ok(v13.includes("StudyQuest localStorage is full; IndexedDB recovery remains active"),
  "A full localStorage quota must fall back to IndexedDB instead of losing the edit");
assert.ok(v13.includes("const lineageMatches = lineage"),
  "A pending v13 outbox must prove its revision and hash lineage before upload");
assert.ok(v13.includes("reason:'outbox-lineage-review'"),
  "An outbox without trusted lineage must require comparison instead of auto-uploading");
assert.ok(v13.includes("persistV13RecoveryOnly"),
  "Large v13 safety histories must move to IndexedDB");
assert.ok(!/let state = loadState\(\);\s*initializeSyncTracking\(\);/.test(v13),
  "v13 migrations must not initialize upload tracking before account sources load");
assert.ok(v13.includes("ensureWeeklyTrackerData({ persist:false });"),
  "Startup Weekly migration must stay in memory until account loading is complete");
assert.ok(v13.includes("syncStateFromServer().finally(finishV13AccountBootstrap)"),
  "Hosted v13 must finish account loading before enabling edits");
assert.ok(server.includes('document.documentElement.classList.add("studyquest-account-loading")'),
  "Hosted v13 must block editing while account sources load");
assert.ok(v13.includes("const latest = bundle.outbox?.state || candidates[0]?.state;"),
  "An unsent v13 outbox must outrank cache timestamps during recovery");

console.log("Save-safety helpers passed.");
