/* v21 hosted account sync.
   Moves manual courses, the quick note, and the functional Subject Track
   setting out of device-only storage and into the account state namespace
   `_studyquestV21`. Every write goes through the page's existing durable
   save flow: device commit first, verified readback, then the revision and
   mutation protected upload. This file performs no network calls of its own
   and defines no new endpoints.

   Device-local and deliberately NOT synced: the tracker view selection and
   expanded-panel state. Those are navigation preferences, not records. */
(function (root) {
  'use strict';

  const NAMESPACE = '_studyquestV21';
  const SCHEMA_VERSION = 1;
  const MANUAL_VERSION = 1;
  const VIEW_SUFFIX = '_v21_tracker_view';
  const TEXT_DEBOUNCE_MS = 500;
  const VIEWS = ['week', 'subject', 'manual'];

  const clone = value => JSON.parse(JSON.stringify(value));
  const text = value => (typeof value === 'string' ? value : '');
  const stamp = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

  let core = null;
  let installed = false;
  const listeners = [];
  let notePending = false;
  let noteTimer = null;
  let statusError = '';
  let savingCount = 0;

  // -- namespace --------------------------------------------------------
  function blankNamespace() {
    return {
      schemaVersion: SCHEMA_VERSION,
      manual: { version: MANUAL_VERSION, revision: 0, courses: [], savedAt: null },
      note: { text: '', updatedAt: 0 },
      subjectTrack: { enabled: false },
      migration: null,
    };
  }

  // Unknown future keys are preserved so a newer client never loses them here.
  function normalizeNamespace(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankNamespace();
    const manual = raw.manual && typeof raw.manual === 'object' && !Array.isArray(raw.manual) ? raw.manual : {};
    const note = raw.note && typeof raw.note === 'object' && !Array.isArray(raw.note) ? raw.note : {};
    const subject = raw.subjectTrack && typeof raw.subjectTrack === 'object' && !Array.isArray(raw.subjectTrack) ? raw.subjectTrack : {};
    return {
      ...raw,
      schemaVersion: Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion > 0 ? raw.schemaVersion : SCHEMA_VERSION,
      manual: {
        version: MANUAL_VERSION,
        revision: Number.isSafeInteger(manual.revision) && manual.revision >= 0 ? manual.revision : 0,
        courses: Array.isArray(manual.courses) ? manual.courses : [],
        savedAt: typeof manual.savedAt === 'string' ? manual.savedAt : null,
      },
      note: { text: text(note.text), updatedAt: stamp(note.updatedAt) },
      subjectTrack: { enabled: subject.enabled === true },
      migration: raw.migration && typeof raw.migration === 'object' && !Array.isArray(raw.migration) ? raw.migration : null,
    };
  }

  const readNamespace = () => normalizeNamespace(core.getState()?.[NAMESPACE]);

  // -- device-local navigation preference --------------------------------
  function viewKey() {
    return core.storageKey() + VIEW_SUFFIX;
  }

  function readView() {
    try {
      const parsed = JSON.parse(root.localStorage.getItem(viewKey()) || 'null');
      return VIEWS.includes(parsed && parsed.view) ? parsed.view : 'week';
    } catch { return 'week'; }
  }

  function writeView(view) {
    if (!VIEWS.includes(view)) return;
    try { root.localStorage.setItem(viewKey(), JSON.stringify({ view })); } catch { /* preference only */ }
  }

  // -- record shape the manual-courses layer expects ----------------------
  function toRecord(key, namespace) {
    return {
      key,
      version: MANUAL_VERSION,
      revision: namespace.manual.revision,
      savedAt: namespace.manual.savedAt,
      courses: clone(namespace.manual.courses),
      settings: { subjectEnabled: namespace.subjectTrack.enabled, view: readView() },
    };
  }

  // Only the account-owned half takes part in the compare-and-swap. The view
  // is device-local, so another tab's view choice never blocks a save.
  function accountPortion(record) {
    return JSON.stringify({
      revision: (record && record.revision) || 0,
      courses: (record && record.courses) || [],
      subjectEnabled: !!(record && record.settings && record.settings.subjectEnabled === true),
    });
  }

  function applyToState(next) {
    const state = clone(core.getState());
    const current = normalizeNamespace(state[NAMESPACE]);
    state[NAMESPACE] = {
      ...current,
      schemaVersion: SCHEMA_VERSION,
      manual: {
        version: MANUAL_VERSION,
        revision: next.revision,
        courses: clone(next.courses),
        savedAt: next.savedAt || new Date().toISOString(),
      },
      subjectTrack: { enabled: next.settings.subjectEnabled === true },
    };
    return state;
  }

  // Any refusal or unverified save leaves the status at Needs attention, so a
  // write that did not stick is never presented as saved.
  function fail(message) {
    statusError = message;
    publish();
    throw new Error(message);
  }

  // One durable commit: device snapshot and pending upload together, then a
  // verified readback before the caller is told the save succeeded.
  async function commit(mutate) {
    if (core.getStatus().storageError) throw new Error('Resolve device recovery before editing.');
    savingCount += 1;
    publish();
    try {
      core.setState(mutate());
      await core.save();
      // The device commit is durable at this point. Schedule the upload through
      // the page's existing capped-backoff scheduler: a namespace edit on its
      // own does not always start one, and an edit that is only on the device
      // must never be left waiting for some later unrelated save to carry it.
      const sync = typeof core.hostedSync === 'function' ? core.hostedSync() : null;
      if (sync && sync.cloudMode && !sync.acknowledged && typeof core.retryUpload === 'function') {
        core.retryUpload();
      }
      statusError = '';
      return readNamespace();
    } catch (error) {
      statusError = error.message || String(error);
      throw error;
    } finally {
      savingCount -= 1;
      publish();
    }
  }

  // -- manual-course store injected into the shared layer -----------------
  const manualStore = {
    read(key) {
      return toRecord(key, readNamespace());
    },
    async write(expected, next) {
      if (core.getStatus().storageError) throw new Error('Resolve device recovery before editing.');
      const current = toRecord(expected.key, readNamespace());
      if (accountPortion(current) !== accountPortion(expected)) {
        fail('Another device changed these courses. Reload saved courses before editing; your earlier data was kept.');
      }
      writeView(next.settings.view);
      // Navigation is device-local. The shared UI increments its candidate
      // revision for every action, but changing only the view must not create
      // an account revision, outbox entry, or upload.
      if (JSON.stringify(current.courses) === JSON.stringify(next.courses)
          && current.settings.subjectEnabled === next.settings.subjectEnabled) {
        return toRecord(expected.key, readNamespace());
      }
      const saved = await commit(() => applyToState(next));
      const verified = toRecord(expected.key, saved);
      if (accountPortion(verified) !== accountPortion(next)) {
        fail('Save readback changed. Reload saved courses to verify the latest copy.');
      }
      return verified;
    },
    statusText(view) {
      if (!view.ready) return 'Opening your saved courses...';
      if (view.pending) return 'Saving...';
      const status = saveStatus();
      if (status.kind === 'error') return status.label;
      if (!view.record || !view.record.revision) return 'Your courses are saved to your account and open on any signed-in device.';
      return status.label;
    },
    watch(callback) {
      listeners.push(callback);
    },
  };

  // -- save status --------------------------------------------------------
  function saveStatus() {
    const status = core.getStatus();
    const sync = typeof core.hostedSync === 'function' ? core.hostedSync() : null;
    if (status.storageError) return { kind: 'error', label: 'Needs attention - ' + status.storageError };
    if (statusError) return { kind: 'error', label: 'Needs attention - ' + statusError };
    if (status.conflict) return { kind: 'error', label: 'Needs attention - review your saved copies' };
    if (savingCount > 0 || notePending) return { kind: 'saving', label: 'Saving...' };
    if (sync && sync.pending) return { kind: 'pending', label: 'Saved on this device - upload pending' };
    // Only the acknowledged account copy earns "Saved to your account". An
    // earlier successful sync says nothing about the edit on screen now.
    if (sync && sync.acknowledged) return { kind: 'saved', label: 'Saved to your account' };
    return { kind: 'pending', label: 'Saved on this device - upload pending' };
  }

  function lastOnlineSaveText() {
    const sync = typeof core.hostedSync === 'function' ? core.hostedSync() : null;
    if (!sync || !sync.lastSuccessAt) return 'No confirmed online save yet on this device.';
    const formatted = typeof root.formatRecoveryDate === 'function'
      ? root.formatRecoveryDate(sync.lastSuccessAt)
      : new Date(sync.lastSuccessAt).toLocaleString();
    return 'Last confirmed online save: ' + formatted;
  }

  function renderStatus() {
    const host = root.document && root.document.getElementById('v21Help');
    if (!host) return;
    let panel = root.document.getElementById('v21SyncStatus');
    if (!panel) {
      panel = root.document.createElement('div');
      panel.id = 'v21SyncStatus';
      panel.setAttribute('role', 'status');
      host.appendChild(panel);
    }
    const status = saveStatus();
    panel.dataset.kind = status.kind;
    panel.textContent = status.label + ' . ' + lastOnlineSaveText();
  }

  function publish() {
    renderStatus();
    for (const callback of listeners) {
      try { callback(); } catch { /* listener only */ }
    }
  }

  // -- quick note ---------------------------------------------------------
  // The v20 browser key stays as a device cache; the account copy is
  // authoritative and wins whenever it is newer.
  function noteInput() {
    return (root.document && root.document.getElementById('v20ExamNoteInput')) || null;
  }

  function cacheNote(value, updatedAt) {
    const v20 = root.StudyQuestV20;
    if (v20 && typeof v20.writeNote === 'function') v20.writeNote(value, core.storageKey(), updatedAt);
  }

  function cachedNote() {
    const v20 = root.StudyQuestV20;
    if (!v20 || typeof v20.readNote !== 'function' || typeof v20.noteStorageKey !== 'function') return { text: '', updatedAt: 0 };
    let raw = null;
    try { raw = root.localStorage.getItem(v20.noteStorageKey(core.storageKey())); } catch { raw = null; }
    const normalized = typeof v20.normalizeNote === 'function' ? v20.normalizeNote(raw) : null;
    return normalized || { text: '', updatedAt: 0 };
  }

  function hydrateNote() {
    const namespace = readNamespace();
    if (namespace.note.updatedAt <= stamp(cachedNote().updatedAt)) return;
    cacheNote(namespace.note.text, namespace.note.updatedAt);
    const input = noteInput();
    if (input && input.value !== namespace.note.text && root.document.activeElement !== input) {
      input.value = namespace.note.text;
    }
  }

  function saveNote(value) {
    const updatedAt = Date.now();
    cacheNote(value, updatedAt);
    return commit(() => {
      const state = clone(core.getState());
      const current = normalizeNamespace(state[NAMESPACE]);
      state[NAMESPACE] = { ...current, schemaVersion: SCHEMA_VERSION, note: { text: text(value), updatedAt } };
      return state;
    });
  }

  function flushNote() {
    if (!notePending) return Promise.resolve();
    root.clearTimeout(noteTimer);
    noteTimer = null;
    notePending = false;
    const input = noteInput();
    if (!input) return Promise.resolve();
    return saveNote(input.value).catch(() => { /* the status line already shows the failure */ });
  }

  function queueNote(value) {
    notePending = true;
    publish();
    root.clearTimeout(noteTimer);
    noteTimer = root.setTimeout(() => {
      notePending = false;
      noteTimer = null;
      saveNote(value).catch(() => {});
    }, TEXT_DEBOUNCE_MS);
  }

  // -- one-time legacy device import --------------------------------------
  // Explicit, owner-confirmed, and only after a verified backup.
  async function importLegacyDeviceCourses() {
    const namespace = readNamespace();
    if (namespace.migration && namespace.migration.manualCourses) {
      throw new Error('These courses were already brought online. Nothing was imported again.');
    }
    if (namespace.manual.courses.length) {
      throw new Error('This account already has manual courses. Review them before importing another copy.');
    }
    const manual = root.StudyQuestV21Manual;
    const legacy = manual && typeof manual.snapshot === 'function' ? await manual.snapshot() : null;
    const courses = legacy && legacy.manualCourses && legacy.manualCourses.courses;
    if (!Array.isArray(courses) || !courses.length) throw new Error('No saved courses were found on this device.');
    await core.archive(await core.snapshots());
    return commit(() => {
      const state = clone(core.getState());
      const current = normalizeNamespace(state[NAMESPACE]);
      if (current.manual.courses.length) throw new Error('This account gained courses during the backup. Nothing was imported.');
      state[NAMESPACE] = {
        ...current,
        schemaVersion: SCHEMA_VERSION,
        manual: {
          version: MANUAL_VERSION,
          revision: current.manual.revision + 1,
          courses: clone(courses),
          savedAt: new Date().toISOString(),
        },
        subjectTrack: { enabled: !!(legacy.manualCourses.settings && legacy.manualCourses.settings.subjectEnabled === true) },
        migration: {
          ...(current.migration || {}),
          manualCourses: { at: new Date().toISOString(), source: 'device-indexeddb', courses: courses.length },
        },
      };
      return state;
    });
  }

  function install(bridge) {
    if (installed || !root.document) return;
    installed = true;
    core = bridge;
    root.StudyQuestV21ManualStore = manualStore;

    const style = root.document.createElement('style');
    style.textContent = '#v21SyncStatus{margin-top:8px;font-size:12px;line-height:1.6;color:var(--text-muted)}'
      + '#v21SyncStatus[data-kind=error]{color:var(--red,#f76a6a)}';
    root.document.head.appendChild(style);

    root.document.addEventListener('input', event => {
      if (event.target && event.target.id === 'v20ExamNoteInput') queueNote(event.target.value);
    });
    root.document.addEventListener('focusout', event => {
      if (event.target && event.target.id === 'v20ExamNoteInput') flushNote();
    });
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.visibilityState === 'hidden') flushNote();
    });
    root.addEventListener('pagehide', () => { flushNote(); });

    // Re-read after any state change the page renders, so a completed upload
    // or an incoming account copy shows without a manual refresh.
    for (const name of ['renderAll', 'setSaveStatus', 'studyQuestV20AfterRender']) {
      const original = root[name];
      if (typeof original !== 'function') continue;
      root[name] = function (...args) {
        const result = original.apply(this, args);
        hydrateNote();
        publish();
        return result;
      };
    }
    hydrateNote();
    publish();
  }

  const api = {
    install,
    importLegacyDeviceCourses,
    flushNote,
    saveStatus,
    normalizeNamespace,
    blankNamespace,
    accountPortion,
    toRecord,
    readNamespace: () => readNamespace(),
    store: manualStore,
    NAMESPACE,
    SCHEMA_VERSION,
    TEXT_DEBOUNCE_MS,
  };
  root.StudyQuestV21AccountSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
