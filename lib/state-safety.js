const crypto = require("node:crypto");
const zlib = require("node:zlib");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateHash(state) {
  return crypto.createHash("sha256").update(stableStringify(state ?? null)).digest("hex");
}

function serializeStateVersion(state) {
  const serialized = JSON.stringify(state ?? null);
  const stateBytes = Buffer.byteLength(serialized, "utf8");
  const stateGzip = zlib.gzipSync(Buffer.from(serialized, "utf8"), { level: 6 });
  return {
    serialized,
    stateBytes,
    stateGzip,
    compressedBytes: stateGzip.length,
    hash: stateHash(state),
  };
}

function deserializeStateVersion(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
}

function stateSummary(value) {
  const state = value && typeof value === "object" ? value : {};
  const tracker = state.tracker && typeof state.tracker === "object" ? state.tracker : {};
  return {
    tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
    notes: Array.isArray(state.notes) ? state.notes.length : 0,
    files: Array.isArray(state.fileLinks) ? state.fileLinks.length : 0,
    checklist: Array.isArray(state.checklistItems) ? state.checklistItems.length : 0,
    grades: state.grades && typeof state.grades === "object" ? Object.keys(state.grades).length : 0,
    trips: Array.isArray(state.trips) ? state.trips.length : 0,
    weeklyWeeks: Array.isArray(tracker.weeks) ? tracker.weeks.length : 0,
    weeklySemesters: Array.isArray(state.trackerSemesters) ? state.trackerSemesters.length : 0,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordIdentity(record, kind, index) {
  if (!record || typeof record !== "object") return `${kind}:value:${stableStringify(record)}`;
  for (const field of ["id", "uid", "weekId", "taskId", "key"]) {
    if (record[field] !== undefined && record[field] !== null && String(record[field]).trim()) {
      return `${kind}:${field}:${String(record[field])}`;
    }
  }
  return `${kind}:legacy:${index}:${stateHash(record)}`;
}

function addMissingRecords(currentRecords, backupRecords, kind) {
  const current = Array.isArray(currentRecords) ? currentRecords : [];
  const backup = Array.isArray(backupRecords) ? backupRecords : [];
  const known = new Set(current.map((record, index) => recordIdentity(record, kind, index)));
  const added = [];
  for (let index = 0; index < backup.length; index += 1) {
    const record = backup[index];
    const identity = recordIdentity(record, kind, index);
    if (!known.has(identity)) {
      added.push(clone(record));
      known.add(identity);
    }
  }
  return { records: [...clone(current), ...added], added };
}

function additiveIncidentRecovery(currentState, backupState) {
  const current = clone(currentState && typeof currentState === "object" ? currentState : {});
  const backup = backupState && typeof backupState === "object" ? backupState : {};
  const tasks = addMissingRecords(current.tasks, backup.tasks, "task");
  const currentTracker = current.tracker && typeof current.tracker === "object" ? current.tracker : {};
  const backupTracker = backup.tracker && typeof backup.tracker === "object" ? backup.tracker : {};
  const weeks = addMissingRecords(currentTracker.weeks, backupTracker.weeks, "week");

  current.tasks = tasks.records;
  current.tracker = { ...currentTracker, weeks: weeks.records };
  return {
    state: current,
    addedTasks: tasks.added,
    addedWeeks: weeks.added,
    summary: stateSummary(current),
  };
}

module.exports = {
  additiveIncidentRecovery,
  deserializeStateVersion,
  serializeStateVersion,
  stableStringify,
  stateHash,
  stateSummary,
};
