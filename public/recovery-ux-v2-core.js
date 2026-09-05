(() => {
  "use strict";

  const DB_NAME = "studyquest_device_recovery_v1";

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
  }

  function storageKey(username) {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("The signed-in account could not be identified.");
    return `studyquest_v3_${normalized}`;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error("Device recovery request failed."));
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Device recovery transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Device recovery transaction was cancelled."));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB recovery is unavailable on this device."));
      // Omit the version: other app generations may already use a newer schema.
      // Existing databases are opened without upgrading or downgrading them.
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => reject(request.error || new Error("IndexedDB recovery could not be opened."));
      request.onblocked = () => reject(new Error("Another tab is using recovery storage. Close that tab and try again."));
      request.onsuccess = () => {
        const db = request.result;
        if (!["accountStates", "outbox", "recovery"].every(name => db.objectStoreNames.contains(name))) {
          db.close();
          return reject(new Error("This device's recovery storage is incomplete. Your saved copies have not been changed."));
        }
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("accountStates")) db.createObjectStore("accountStates", { keyPath:"username" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath:"username" });
        if (!db.objectStoreNames.contains("recovery")) {
          const store = db.createObjectStore("recovery", { keyPath:"id" });
          store.createIndex("username", "username", { unique:false });
        }
      };
    });
  }

  function openExistingDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return resolve(null);
      let databaseWasMissing = false;
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => databaseWasMissing && request.error?.name === "AbortError"
        ? resolve(null) : reject(request.error || new Error("IndexedDB recovery could not be opened."));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        databaseWasMissing = true;
        request.transaction.onabort = () => resolve(null);
        request.transaction.abort();
      };
    });
  }

  function gradeCount(source) {
    return source?.grades && typeof source.grades === "object" ? Object.keys(source.grades).length : 0;
  }

  function summarizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      tasks:Array.isArray(source.tasks) ? source.tasks.length : 0,
      notes:Array.isArray(source.notes) ? source.notes.length : 0,
      files:Array.isArray(source.fileLinks) ? source.fileLinks.length : 0,
      grades:gradeCount(source),
      trips:Array.isArray(source.trips) ? source.trips.length : 0,
      weeklyWeeks:Array.isArray(source.tracker?.weeks) ? source.tracker.weeks.length : 0,
      semesters:Array.isArray(source.trackerSemesters) ? source.trackerSemesters.length : 0,
      updatedAt:Number(source.updatedAt || 0),
    };
  }

  function summaryText(value) {
    const summary = summarizeState(value);
    return `${summary.tasks} tasks · ${summary.notes} notes · ${summary.files} files · ${summary.grades} grade records · ${summary.trips} trips · ${summary.weeklyWeeks} Weekly weeks · ${summary.semesters} semesters`;
  }

  function stableString(value) {
    if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function recordIdentity(record, kind, index = 0) {
    if (!record || typeof record !== "object") return `${kind}:value:${stableString(record)}`;
    for (const field of ["id", "uid", "weekId", "taskId", "rowId", "subjectId", "key"]) {
      if (record[field] !== undefined && record[field] !== null && String(record[field]).trim()) {
        return `${kind}:${field}:${String(record[field])}`;
      }
    }
    const natural = ["title", "name", "label", "subject", "dayKey", "day", "date"]
      .filter((field) => record[field] !== undefined && record[field] !== null && String(record[field]).trim())
      .map((field) => `${field}=${String(record[field]).trim()}`).join("|");
    return natural ? `${kind}:natural:${natural}` : `${kind}:index:${index}`;
  }

  function recordLabel(record, fallback) {
    if (record && typeof record === "object") {
      for (const field of ["title", "name", "label", "subject", "filename", "url"]) {
        if (record[field] !== undefined && String(record[field]).trim()) return String(record[field]).trim().slice(0, 140);
      }
    }
    return fallback;
  }

  function collectRecords(value) {
    const source = value && typeof value === "object" ? value : {};
    const records = new Map();
    const addArray = (collection, values, kind, parent = "") => {
      (Array.isArray(values) ? values : []).forEach((record, index) => {
        const identity = recordIdentity(record, kind, index);
        const id = parent ? `${parent}/${identity}` : identity;
        records.set(`${collection}/${id}`, { label:recordLabel(record, id), value:record });
      });
    };
    [
      ["tasks", "task"], ["categories", "category"], ["deletedCategories", "deleted-category"],
      ["notebooks", "notebook"], ["notes", "note"], ["fileLinks", "file"],
      ["checklistItems", "checklist-item"], ["trips", "trip"], ["travelCategories", "travel-category"],
      ["customCurricula", "curriculum"], ["sessions", "study-session"],
    ].forEach(([field, kind]) => addArray(field, source[field], kind));
    addArray("tracker.weeks", source.tracker?.weeks, "week");
    addArray("trackerSemesters", source.trackerSemesters, "semester");
    (Array.isArray(source.trackerSemesters) ? source.trackerSemesters : []).forEach((semester, index) => {
      addArray("trackerSemesters.subjects", semester?.subjects, "subject", recordIdentity(semester, "semester", index));
    });
    (Array.isArray(source.tracker?.weeks) ? source.tracker.weeks : []).forEach((week, index) => {
      addArray("tracker.weeks.rows", week?.rows, "row", recordIdentity(week, "week", index));
    });
    Object.entries(source.grades && typeof source.grades === "object" ? source.grades : {}).forEach(([gradeId, grade]) => {
      records.set(`grades/${gradeId}`, { label:recordLabel(grade, gradeId), value:grade });
      addArray("grades.scores", grade?.scores, "score", gradeId);
    });
    Object.entries(source.customSubjects && typeof source.customSubjects === "object" ? source.customSubjects : {}).forEach(([groupId, subjects]) => {
      addArray("customSubjects", subjects, "custom-subject", groupId);
    });
    return records;
  }

  function compareStates(accountBackup, deviceCopy) {
    const online = collectRecords(accountBackup);
    const device = collectRecords(deviceCopy);
    const removed = [...online.keys()].filter((key) => !device.has(key)).map((key) => ({ key, label:online.get(key).label }));
    const deviceOnly = [...device.keys()].filter((key) => !online.has(key)).map((key) => ({ key, label:device.get(key).label }));
    const changed = [...online.keys()].filter((key) => device.has(key)
      && stableString(online.get(key).value) !== stableString(device.get(key).value))
      .map((key) => ({ key, label:online.get(key).label }));
    return { removed, deviceOnly, changed, accountRecordCount:online.size, deviceRecordCount:device.size };
  }

  async function fetchAccountBackup() {
    const response = await fetch("/api/v2/state", { credentials:"same-origin", cache:"no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) throw new Error(payload.message || payload.error || "The account backup could not be loaded.");
    if (!payload.state || typeof payload.state !== "object") throw new Error("The account backup is empty or unreadable.");
    return payload;
  }

  async function readCurrentDeviceRecords(db, username) {
    const account = db.objectStoreNames.contains("accountStates")
      ? await requestResult(db.transaction("accountStates", "readonly").objectStore("accountStates").get(username)) : null;
    const outbox = db.objectStoreNames.contains("outbox")
      ? await requestResult(db.transaction("outbox", "readonly").objectStore("outbox").get(username)) : null;
    return { account, outbox };
  }

  function recoveryRecord(username, label, state, extra = {}) {
    const capturedAtMs = Date.now();
    const serialized = JSON.stringify(state);
    const random = window.crypto?.randomUUID?.() || `${capturedAtMs}-${Math.random().toString(36).slice(2)}`;
    return {
      id:`${username}:recovery-v2:${random}`,
      username,
      state:clone(state),
      label,
      updatedAt:Number(state?.updatedAt || capturedAtMs),
      capturedAtMs,
      capturedAt:new Date(capturedAtMs).toISOString(),
      stateBytes:serialized.length,
      recoveryUxVersion:2,
      ...extra,
    };
  }

  async function archiveAndLoadAccountBackup({ username:value, envelope }) {
    const username = normalizeUsername(value);
    if (!username) throw new Error("The signed-in account could not be identified.");
    if (!envelope?.state || !Number.isInteger(Number(envelope.revision)) || !String(envelope.stateHash || "")) {
      throw new Error("The account backup revision could not be verified.");
    }
    const key = storageKey(username);
    const browserRaw = localStorage.getItem(key);
    let browserState = null;
    if (browserRaw) {
      try { browserState = JSON.parse(browserRaw); }
      catch { throw new Error("This computer's browser copy is unreadable. Export it before loading another copy."); }
    }

    const db = await openDatabase();
    try {
      const previous = await readCurrentDeviceRecords(db, username);
      const archives = [];
      if (browserState) archives.push(recoveryRecord(username, "Browser copy before loading account backup", browserState));
      if (previous.account?.state) archives.push(recoveryRecord(username, "IndexedDB copy before loading account backup", previous.account.state));
      if (previous.outbox?.state) archives.push(recoveryRecord(username, "Pending upload before loading account backup", previous.outbox.state, { lineage:clone(previous.outbox.lineage || null) }));
      if (!archives.length) archives.push(recoveryRecord(username, "Empty device baseline before loading account backup", { tasks:[], updatedAt:0 }));

      const archiveTransaction = db.transaction("recovery", "readwrite");
      const archiveStore = archiveTransaction.objectStore("recovery");
      archives.forEach((record) => archiveStore.put(record));
      await transactionDone(archiveTransaction);
      for (const record of archives) {
        const verified = await requestResult(db.transaction("recovery", "readonly").objectStore("recovery").get(record.id));
        if (!verified || stableString(verified) !== stableString(record)) {
          throw new Error("The existing device copy could not be verified in recovery storage.");
        }
      }

      const cloudState = clone(envelope.state);
      const serialized = JSON.stringify(cloudState);
      const deviceTransaction = db.transaction(["accountStates", "outbox"], "readwrite");
      deviceTransaction.objectStore("accountStates").put({
        username,
        state:cloudState,
        updatedAt:Number(cloudState.updatedAt || Date.now()),
        capturedAt:new Date().toISOString(),
        stateBytes:serialized.length,
      });
      deviceTransaction.objectStore("outbox").delete(username);
      await transactionDone(deviceTransaction);

      const active = await requestResult(db.transaction("accountStates", "readonly").objectStore("accountStates").get(username));
      const pending = await requestResult(db.transaction("outbox", "readonly").objectStore("outbox").get(username));
      if (!active || stableString(active.state) !== stableString(cloudState) || pending) {
        const rollback = db.transaction(["accountStates", "outbox"], "readwrite");
        const accountStore = rollback.objectStore("accountStates");
        const outboxStore = rollback.objectStore("outbox");
        if (previous.account) accountStore.put(previous.account); else accountStore.delete(username);
        if (previous.outbox) outboxStore.put(previous.outbox); else outboxStore.delete(username);
        await transactionDone(rollback).catch(() => {});
        throw new Error("The Account backup could not be verified in IndexedDB; the previous active copy was kept.");
      }

      try {
        localStorage.setItem(key, serialized);
      } catch (error) {
        const rollback = db.transaction(["accountStates", "outbox"], "readwrite");
        const accountStore = rollback.objectStore("accountStates");
        const outboxStore = rollback.objectStore("outbox");
        if (previous.account) accountStore.put(previous.account); else accountStore.delete(username);
        if (previous.outbox) outboxStore.put(previous.outbox); else outboxStore.delete(username);
        await transactionDone(rollback).catch(() => {});
        throw new Error(`Browser storage could not be updated; the previous active copy was kept. ${error?.message || ""}`.trim());
      }
      return { state:cloudState, archivedCount:archives.length, revision:Number(envelope.revision), stateHash:String(envelope.stateHash) };
    } finally {
      db.close();
    }
  }

  window.StudyQuestRecoveryV2 = Object.freeze({
    archiveAndLoadAccountBackup,
    compareStates,
    fetchAccountBackup,
    normalizeUsername,
    openDatabase,
    openExistingDatabase,
    readCurrentDeviceRecords,
    stableString,
    storageKey,
    summarizeState,
    summaryText,
  });
})();
