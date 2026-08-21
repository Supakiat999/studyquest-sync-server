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

function statesEqualIgnoringRootUpdatedAt(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  const leftCopy = { ...left };
  const rightCopy = { ...right };
  delete leftCopy.updatedAt;
  delete rightCopy.updatedAt;
  return stableStringify(leftCopy) === stableStringify(rightCopy);
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

function weeklyLayoutSummary(value) {
  const state = value && typeof value === "object" ? value : {};
  const overlay = state.tracker && typeof state.tracker === "object"
    ? state.tracker.weeklyV14
    : null;
  const layouts = overlay && typeof overlay.layouts === "object" && !Array.isArray(overlay.layouts)
    ? Object.values(overlay.layouts)
    : [];
  const columns = layouts.flatMap((layout) => Array.isArray(layout?.columns) ? layout.columns : []);
  return {
    enabled: !!overlay,
    semesters: layouts.length,
    total: columns.length,
    visible: columns.filter((column) => column?.archived !== true).length,
    archived: columns.filter((column) => column?.archived === true).length,
  };
}

function taskForHistoryPath(state, path) {
  const match = String(path || "").match(/^tasks\/(?:%40|@)([^/]+)/);
  if (!match) return null;
  let id = match[1];
  try { id = decodeURIComponent(id); } catch {}
  return (Array.isArray(state?.tasks) ? state.tasks : []).find((task) =>
    [task?.id, task?._syncId, task?.uid].some((value) => value !== undefined && String(value) === id)
  ) || null;
}

function stateActivitySummary(value, limit = 5) {
  const state = value && typeof value === "object" ? value : {};
  const history = Array.isArray(state?._syncMeta?.history) ? state._syncMeta.history : [];
  const ordered = [...history]
    .filter((entry) => entry && typeof entry === "object" && entry.at)
    .sort((left, right) => {
      const timeDelta = Date.parse(right.at) - Date.parse(left.at);
      return Number.isFinite(timeDelta) && timeDelta !== 0
        ? timeDelta
        : Number(right.seq || 0) - Number(left.seq || 0);
    });
  const allChanges = ordered.map((entry) => {
    const task = taskForHistoryPath(state, entry.path);
    const path = String(entry.path || "");
    const isTask = path.startsWith("tasks/");
    const label = task && entry.kind === "add-record"
      ? `Task added: ${String(task.title || task.name || "Untitled task").slice(0, 160)}`
      : task && isTask
        ? `Task updated: ${String(task.title || task.name || "Untitled task").slice(0, 160)}`
        : String(entry.label || (path.startsWith("tracker/weeklyV14") ? "Weekly customization changed" : "Saved data changed")).slice(0, 200);
    return {
      kind: String(entry.kind || "field").slice(0, 40),
      path: path.slice(0, 240),
      label,
      before: String(entry.before ?? "").slice(0, 160),
      after: String(entry.after ?? "").slice(0, 160),
      at: entry.at,
      seq: Number(entry.seq || 0),
      clockVerified: entry.clockVerified === true,
    };
  });
  const changes = allChanges.slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  const latestTaskAdded = allChanges.find((entry) => entry.kind === "add-record" && /^tasks\/(?:%40|@)/.test(entry.path)) || null;
  return {
    historyAvailable: changes.length > 0,
    latestUpdatedAt: state.updatedAt || null,
    latestChanges: changes,
    latestTaskAdded,
    weekly: weeklyLayoutSummary(state),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordIdentity(record, kind, index = 0) {
  if (!record || typeof record !== "object") return `${kind}:value:${stableStringify(record)}`;
  for (const field of ["id", "uid", "weekId", "taskId", "rowId", "subjectId", "key"]) {
    if (record[field] !== undefined && record[field] !== null && String(record[field]).trim()) {
      return `${kind}:${field}:${String(record[field])}`;
    }
  }
  const naturalFields = ["title", "name", "label", "subject", "dayKey", "day", "date"];
  const natural = naturalFields
    .filter((field) => record[field] !== undefined && record[field] !== null && String(record[field]).trim())
    .map((field) => `${field}=${String(record[field]).trim()}`)
    .join("|");
  if (natural) return `${kind}:natural:${natural}`;
  return `${kind}:legacy:${index}:${stateHash(record)}`;
}

function recordLabel(record, fallback) {
  if (record && typeof record === "object") {
    for (const field of ["title", "name", "label", "subject", "filename", "url"]) {
      if (record[field] !== undefined && String(record[field]).trim()) return String(record[field]).trim().slice(0, 160);
    }
  }
  return fallback;
}

const TOP_LEVEL_ARRAYS = [
  ["tasks", "task"],
  ["categories", "category"],
  ["deletedCategories", "deleted-category"],
  ["notebooks", "notebook"],
  ["notes", "note"],
  ["fileLinks", "file"],
  ["checklistItems", "checklist-item"],
  ["trips", "trip"],
  ["travelCategories", "travel-category"],
  ["customCurricula", "curriculum"],
  ["sessions", "study-session"],
];

function collectArrayRecords(target, collection, records, kind, parentId = "") {
  const source = Array.isArray(records) ? records : [];
  source.forEach((record, index) => {
    const identity = recordIdentity(record, kind, index);
    const id = parentId ? `${parentId}/${identity}` : identity;
    const key = `${collection}/${id}`;
    target.set(key, {
      collection,
      id,
      key,
      label: recordLabel(record, id),
      value: record,
    });
  });
}

function collectStateRecords(stateValue) {
  const state = stateValue && typeof stateValue === "object" ? stateValue : {};
  const records = new Map();
  TOP_LEVEL_ARRAYS.forEach(([field, kind]) => collectArrayRecords(records, field, state[field], kind));
  collectArrayRecords(records, "tracker.weeks", state.tracker?.weeks, "week");
  collectArrayRecords(records, "trackerSemesters", state.trackerSemesters, "semester");

  const semesters = Array.isArray(state.trackerSemesters) ? state.trackerSemesters : [];
  semesters.forEach((semester, semesterIndex) => {
    const semesterId = recordIdentity(semester, "semester", semesterIndex);
    collectArrayRecords(records, "trackerSemesters.subjects", semester?.subjects, "subject", semesterId);
  });

  const weeks = Array.isArray(state.tracker?.weeks) ? state.tracker.weeks : [];
  weeks.forEach((week, weekIndex) => {
    const weekId = recordIdentity(week, "week", weekIndex);
    collectArrayRecords(records, "tracker.weeks.rows", week?.rows, "row", weekId);
  });

  const grades = state.grades && typeof state.grades === "object" ? state.grades : {};
  Object.entries(grades).forEach(([gradeId, grade]) => {
    const id = String(gradeId);
    const key = `grades/${id}`;
    records.set(key, { collection: "grades", id, key, label: recordLabel(grade, id), value: grade });
    collectArrayRecords(records, "grades.scores", grade?.scores, "score", id);
  });

  const customSubjects = state.customSubjects && typeof state.customSubjects === "object" ? state.customSubjects : {};
  Object.entries(customSubjects).forEach(([groupId, subjects]) => {
    collectArrayRecords(records, "customSubjects", subjects, "custom-subject", String(groupId));
  });
  return records;
}

function stateRecordDiff(currentState, incomingState) {
  const current = collectStateRecords(currentState);
  const incoming = collectStateRecords(incomingState);
  const removed = [];
  const added = [];
  current.forEach((record, key) => {
    if (!incoming.has(key)) removed.push({ ...record, value: undefined });
  });
  incoming.forEach((record, key) => {
    if (!current.has(key)) added.push({ ...record, value: undefined });
  });
  const byCollection = {};
  removed.forEach((record) => {
    byCollection[record.collection] ||= { removed: 0, added: 0 };
    byCollection[record.collection].removed += 1;
  });
  added.forEach((record) => {
    byCollection[record.collection] ||= { removed: 0, added: 0 };
    byCollection[record.collection].added += 1;
  });
  return { removed, added, byCollection };
}

function normalizeDeletionManifest(changeSet) {
  const values = Array.isArray(changeSet?.deletes) ? changeSet.deletes : [];
  return new Set(values.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    return entry.key || (entry.collection && entry.id ? `${entry.collection}/${entry.id}` : "");
  }).filter(Boolean));
}

function unapprovedRemovals(currentState, incomingState, changeSet) {
  const difference = stateRecordDiff(currentState, incomingState);
  const approved = normalizeDeletionManifest(changeSet);
  return {
    ...difference,
    unapproved: difference.removed.filter((record) => !approved.has(record.key)),
  };
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

function mergeMissingArray(currentRecords, sourceRecords, kind, collection, additions) {
  const current = Array.isArray(currentRecords) ? clone(currentRecords) : [];
  const source = Array.isArray(sourceRecords) ? sourceRecords : [];
  const known = new Set(current.map((record, index) => recordIdentity(record, kind, index)));
  source.forEach((record, index) => {
    const identity = recordIdentity(record, kind, index);
    if (known.has(identity)) return;
    current.push(clone(record));
    known.add(identity);
    additions.push({
      collection,
      id: identity,
      key: `${collection}/${identity}`,
      label: recordLabel(record, identity),
    });
  });
  return current;
}

function recoverMissingRecords(currentState, earlierState) {
  const current = clone(currentState && typeof currentState === "object" ? currentState : {});
  const earlier = earlierState && typeof earlierState === "object" ? earlierState : {};
  const additions = [];

  TOP_LEVEL_ARRAYS.forEach(([field, kind]) => {
    current[field] = mergeMissingArray(current[field], earlier[field], kind, field, additions);
  });

  current.tracker = current.tracker && typeof current.tracker === "object" ? current.tracker : {};
  const earlierTracker = earlier.tracker && typeof earlier.tracker === "object" ? earlier.tracker : {};
  current.tracker.weeks = mergeMissingArray(current.tracker.weeks, earlierTracker.weeks, "week", "tracker.weeks", additions);
  current.trackerSemesters = mergeMissingArray(current.trackerSemesters, earlier.trackerSemesters, "semester", "trackerSemesters", additions);

  const currentSemesters = new Map((current.trackerSemesters || []).map((semester, index) => [recordIdentity(semester, "semester", index), semester]));
  (Array.isArray(earlier.trackerSemesters) ? earlier.trackerSemesters : []).forEach((semester, index) => {
    const semesterId = recordIdentity(semester, "semester", index);
    const target = currentSemesters.get(semesterId);
    if (!target) return;
    target.subjects = mergeMissingArray(
      target.subjects,
      semester?.subjects,
      "subject",
      `trackerSemesters.subjects/${semesterId}`,
      additions
    );
  });

  const currentWeeks = new Map((current.tracker.weeks || []).map((week, index) => [recordIdentity(week, "week", index), week]));
  (Array.isArray(earlierTracker.weeks) ? earlierTracker.weeks : []).forEach((week, index) => {
    const weekId = recordIdentity(week, "week", index);
    const target = currentWeeks.get(weekId);
    if (!target) return;
    target.rows = mergeMissingArray(target.rows, week?.rows, "row", `tracker.weeks.rows/${weekId}`, additions);
  });

  current.grades = current.grades && typeof current.grades === "object" ? current.grades : {};
  const earlierGrades = earlier.grades && typeof earlier.grades === "object" ? earlier.grades : {};
  Object.entries(earlierGrades).forEach(([gradeId, grade]) => {
    if (!Object.prototype.hasOwnProperty.call(current.grades, gradeId)) {
      current.grades[gradeId] = clone(grade);
      additions.push({ collection: "grades", id: gradeId, key: `grades/${gradeId}`, label: recordLabel(grade, gradeId) });
      return;
    }
    current.grades[gradeId].scores = mergeMissingArray(
      current.grades[gradeId]?.scores,
      grade?.scores,
      "score",
      `grades.scores/${gradeId}`,
      additions
    );
  });

  current.customSubjects = current.customSubjects && typeof current.customSubjects === "object" ? current.customSubjects : {};
  const earlierCustomSubjects = earlier.customSubjects && typeof earlier.customSubjects === "object" ? earlier.customSubjects : {};
  Object.entries(earlierCustomSubjects).forEach(([groupId, subjects]) => {
    current.customSubjects[groupId] = mergeMissingArray(
      current.customSubjects[groupId],
      subjects,
      "custom-subject",
      `customSubjects/${groupId}`,
      additions
    );
  });

  return {
    state: current,
    additions,
    unchanged: additions.length === 0,
    summary: stateSummary(current),
  };
}

module.exports = {
  additiveIncidentRecovery,
  collectStateRecords,
  deserializeStateVersion,
  recoverMissingRecords,
  recordIdentity,
  serializeStateVersion,
  stableStringify,
  stateHash,
  statesEqualIgnoringRootUpdatedAt,
  stateRecordDiff,
  stateSummary,
  stateActivitySummary,
  weeklyLayoutSummary,
  unapprovedRemovals,
};
