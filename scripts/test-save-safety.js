const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  additiveIncidentRecovery,
  deserializeStateVersion,
  serializeStateVersion,
  stableStringify,
  stateHash,
  stateSummary,
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
assert.ok(server.includes('d.username = $2'), "Paired server tokens must be restricted to admin");
assert.ok(server.includes('handleAnyaIncidentRecovery'), "Verified additive incident recovery route is missing");
assert.ok(!recoveryPage.includes('/api/v2/state') && !recoveryPage.includes('/api/state'),
  "Device recovery must not load or write cloud state");
assert.ok(!recoveryPage.includes('localStorage.setItem') && !recoveryPage.includes('indexedDB.deleteDatabase'),
  "Device recovery must not mutate browser storage");
assert.ok(v13.includes("function buildBulkSelectedSmartMerge("),
  "Bulk merge choices must resolve fields revealed by earlier choices");
assert.ok(v13.includes("for (let pass = 0; pass < 25; pass += 1)"),
  "Bulk merge selection must iterate to a stable reviewed result");

console.log("Save-safety helpers passed.");
