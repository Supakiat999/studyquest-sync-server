/* v22 hosted account sync.
   Keeps the v21 manual-course, quick-note, and Subject Track records in their
   existing `_studyquestV21` account namespace and adds v22 subtasks in the
   additive `_studyquestV22` namespace. Every write goes through the page's
   existing durable save flow: device commit first, verified readback, then
   the revision and mutation protected upload. This file performs no network
   calls of its own and defines no new endpoints.

   Device-local and deliberately NOT synced: the tracker view selection and
   expanded-panel state. Those are navigation preferences, not records. */
(function (root) {
  'use strict';

  const NAMESPACE = '_studyquestV21';
  const V22_NAMESPACE = '_studyquestV22';
  const SCHEMA_VERSION = 1;
  const MANUAL_VERSION = 1;
  const SUBTASK_SCHEMA_VERSION = 1;
  const MAX_SUBTASK_TITLE_LENGTH = 240;
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
  let commitQueue = Promise.resolve();

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

  function blankSubtaskCollection() {
    return { schemaVersion: SUBTASK_SCHEMA_VERSION, revision: 0, records: {}, trash: [], updatedAt: null };
  }

  function normalizeSubtaskItem(source, index = 0) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid v22 subtask item.');
    const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : '';
    const title = typeof source.title === 'string' ? source.title.trim().slice(0, MAX_SUBTASK_TITLE_LENGTH) : '';
    if (!id || !title) throw new Error('Invalid v22 subtask item.');
    return {
      ...source,
      id,
      title,
      checked: source.checked === true,
      order: Number.isSafeInteger(source.order) ? source.order : index,
      createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
      updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
    };
  }

  function normalizeSubtaskCollection(raw) {
    if (raw === undefined || raw === null) return blankSubtaskCollection();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Number(raw.schemaVersion || SUBTASK_SCHEMA_VERSION) !== SUBTASK_SCHEMA_VERSION
        || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)
        || !Array.isArray(raw.trash)) {
      throw new Error('The account contains invalid v22 subtask data. Nothing was replaced.');
    }
    const next = { ...raw, schemaVersion: SUBTASK_SCHEMA_VERSION, revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0, records: {}, trash: [], updatedAt: raw.updatedAt || null };
    const ids = new Set();
    for (const [occurrenceKey, source] of Object.entries(raw.records)) {
      if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.parentTaskId !== 'string' || !Array.isArray(source.subtasks)) {
        throw new Error('The account contains an invalid v22 subtask record. Nothing was replaced.');
      }
      const subtasks = source.subtasks.map((item, index) => normalizeSubtaskItem(item, index));
      subtasks.forEach(item => { if (ids.has(item.id)) throw new Error('The account contains duplicate v22 subtask IDs. Nothing was replaced.'); ids.add(item.id); });
      next.records[occurrenceKey] = { ...source, parentTaskId: source.parentTaskId, subtasks, updatedAt: source.updatedAt || null };
    }
    next.trash = raw.trash.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || typeof item.kind !== 'string' || typeof item.occurrenceKey !== 'string' || !Array.isArray(item.subtasks)) {
        throw new Error('The account contains invalid v22 subtask recovery data. Nothing was replaced.');
      }
      const subtasks = item.subtasks.map((subtask, index) => normalizeSubtaskItem(subtask, index));
      subtasks.forEach(subtask => { if (ids.has(subtask.id)) throw new Error('The account contains duplicate v22 recovery subtask IDs. Nothing was replaced.'); ids.add(subtask.id); });
      return { ...item, id: item.id, kind: item.kind === 'subtask' ? 'subtask' : 'parent', occurrenceKey: item.occurrenceKey, parentTaskId: String(item.parentTaskId || ''), parentTask: item.parentTask && typeof item.parentTask === 'object' ? clone(item.parentTask) : null, subtasks, deletedAt: item.deletedAt || new Date().toISOString() };
    });
    return next;
  }

  function blankV22Namespace() {
    return { schemaVersion: 1, subtasks: blankSubtaskCollection(), migration: null };
  }

  function normalizeV22Namespace(raw) {
    if (raw === undefined || raw === null) return blankV22Namespace();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The account contains invalid v22 data. Nothing was replaced.');
    return {
      ...raw,
      schemaVersion: Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion > 0 ? raw.schemaVersion : 1,
      subtasks: normalizeSubtaskCollection(raw.subtasks),
      migration: raw.migration && typeof raw.migration === 'object' && !Array.isArray(raw.migration) ? clone(raw.migration) : null,
    };
  }

  const readNamespace = () => normalizeNamespace(core.getState()?.[NAMESPACE]);
  const readV22Namespace = () => normalizeV22Namespace(core.getState()?.[V22_NAMESPACE]);

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

  function toSubtaskRecord(key, namespace) {
    return { key, ...clone(namespace.subtasks) };
  }

  function subtaskPortion(record) {
    return JSON.stringify({
      revision: Number(record?.revision || 0),
      records: record?.records || {},
      trash: record?.trash || [],
    });
  }

  function applySubtasksToState(next) {
    const state = clone(core.getState());
    const current = normalizeV22Namespace(state[V22_NAMESPACE]);
    state[V22_NAMESPACE] = {
      ...current,
      schemaVersion: 1,
      subtasks: {
        ...current.subtasks,
        schemaVersion: SUBTASK_SCHEMA_VERSION,
        revision: next.revision,
        records: clone(next.records),
        trash: clone(next.trash),
        updatedAt: next.updatedAt || new Date().toISOString(),
      },
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
  // verified readback before the caller is told the save succeeded. The queue
  // is shared by manual courses, the note, and subtasks so two namespaces can
  // never race by replacing each other's newest full-state snapshot.
  function queueCommit(work) {
    const run = commitQueue.then(work);
    commitQueue = run.catch(() => {});
    return run;
  }

  async function commit(mutate, readback = 'v21') {
    return queueCommit(async () => {
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
        return readback === 'v22' ? readV22Namespace() : readNamespace();
      } catch (error) {
        statusError = error.message || String(error);
        throw error;
      } finally {
        savingCount -= 1;
        publish();
      }
    });
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

  // -- v22 subtask store injected into the laptop feature layer ------------
  // The feature layer still performs its own shape validation and UI-level
  // compare-and-swap. This adapter supplies the account-backed record and
  // keeps the v22 namespace independent from v21 manual-course data.
  const subtaskStore = {
    hosted: true,
    read(key) {
      return toSubtaskRecord(key, readV22Namespace());
    },
    async write(expected, next) {
      if (core.getStatus().storageError) throw new Error('Resolve device recovery before editing.');
      const current = toSubtaskRecord(expected.key, readV22Namespace());
      if (subtaskPortion(current) !== subtaskPortion(expected)) {
        fail('Another device changed these subtasks. Reload saved subtasks before editing; your earlier data was kept.');
      }
      if (subtaskPortion(current) === subtaskPortion(next)) return current;
      const saved = await commit(() => applySubtasksToState(next), 'v22');
      const verified = toSubtaskRecord(expected.key, saved);
      if (subtaskPortion(verified) !== subtaskPortion(next)) {
        fail('Save readback changed. Reload saved subtasks to verify the latest copy.');
      }
      return verified;
    },
    statusText(view) {
      if (!view.ready) return 'Opening your account subtasks...';
      if (view.pending) return 'Saving subtasks...';
      const status = saveStatus();
      if (status.kind === 'error') return status.label;
      if (!view.record || !view.record.revision) return 'Subtasks are saved to your account and do not change parent task completion or XP.';
      return status.label + ' · subtasks do not change parent task completion or XP.';
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

  // -- reviewed laptop import (admin only) -------------------------------
  // A hosted page cannot read the laptop's IndexedDB directly. The owner must
  // export a v22 recovery bundle, choose it here, review additive differences,
  // and explicitly approve the merge. Account records win on every conflict;
  // the selected file is never deleted or modified.
  const importState = { bundle: null, preview: null, fingerprint: '', busy: false, message: '' };

  function isAdmin() {
    return String(root.__STUDYQUEST_AUTH_USER__?.username || '').trim().toLowerCase() === 'admin';
  }

  function candidateParts(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Choose a valid StudyQuest v22 JSON export.');
    const runtime = bundle.runtime && typeof bundle.runtime === 'object' && !Array.isArray(bundle.runtime)
      ? bundle.runtime
      : bundle.state && typeof bundle.state === 'object' && !Array.isArray(bundle.state) ? bundle.state : bundle;
    const rawV21 = runtime._studyquestV21 || bundle._studyquestV21 || {};
    const v21 = normalizeNamespace(rawV21);
    const manualRecord = bundle.manualCourses?.manualCourses && typeof bundle.manualCourses.manualCourses === 'object'
      ? bundle.manualCourses.manualCourses
      : bundle.manualCourses && typeof bundle.manualCourses === 'object' && Array.isArray(bundle.manualCourses.courses)
        ? bundle.manualCourses
        : v21.manual;
    const manualCourses = Array.isArray(manualRecord?.courses) ? clone(manualRecord.courses) : [];
    const rawV22 = runtime[V22_NAMESPACE] || bundle[V22_NAMESPACE] || {};
    const v22 = normalizeV22Namespace(rawV22);
    const subtaskRecord = bundle.subtasks?.subtasks && typeof bundle.subtasks.subtasks === 'object'
      ? bundle.subtasks.subtasks
      : bundle.subtasks && typeof bundle.subtasks === 'object' && bundle.subtasks.records ? bundle.subtasks : v22.subtasks;
    const subtasks = normalizeSubtaskCollection(subtaskRecord);
    return {
      v21,
      manualCourses,
      note: { text: v21.note.text, updatedAt: v21.note.updatedAt },
      subjectTrack: { enabled: v21.subjectTrack.enabled },
      subtasks,
      source: { capturedAt: bundle.capturedAt || null, format: bundle.format || null },
    };
  }

  function stateFingerprint() {
    return JSON.stringify(core.getState());
  }

  function importPreview(parts) {
    const currentV21 = readNamespace();
    const currentV22 = readV22Namespace();
    const currentCourseIds = new Set(currentV21.manual.courses.map(course => String(course.id || '')));
    const candidateCourses = parts.manualCourses.filter(course => course && typeof course.id === 'string' && course.id && typeof course.name === 'string' && course.name.trim());
    const courseAdditions = candidateCourses.filter(course => !currentCourseIds.has(course.id));
    const courseConflicts = candidateCourses.filter(course => currentCourseIds.has(course.id));
    const accountV21HasContent = currentV21.manual.courses.length > 0 || !!currentV21.note.text || currentV21.subjectTrack.enabled === true || !!currentV21.migration;
    const noteAction = !accountV21HasContent && parts.note.text ? 'add' : parts.note.text && currentV21.note.text ? 'keep-account' : parts.note.text ? 'account-empty' : 'none';
    const subjectAction = !accountV21HasContent && parts.subjectTrack.enabled ? 'add' : parts.subjectTrack.enabled && currentV21.subjectTrack.enabled ? 'keep-account' : parts.subjectTrack.enabled ? 'account-empty' : 'none';
    const currentOccurrenceKeys = new Set(Object.keys(currentV22.subtasks.records || {}));
    const currentSubtaskIds = new Set();
    Object.values(currentV22.subtasks.records || {}).forEach(record => (record.subtasks || []).forEach(item => currentSubtaskIds.add(String(item.id))));
    (currentV22.subtasks.trash || []).forEach(item => (item.subtasks || []).forEach(subtask => currentSubtaskIds.add(String(subtask.id))));
    const subtaskAdditions = [];
    const subtaskConflicts = [];
    Object.entries(parts.subtasks.records || {}).forEach(([occurrenceKey, occurrence]) => {
      const hasIdConflict = (occurrence.subtasks || []).some(item => currentSubtaskIds.has(String(item.id)));
      if (currentOccurrenceKeys.has(occurrenceKey) || hasIdConflict) subtaskConflicts.push(occurrenceKey);
      else subtaskAdditions.push(occurrenceKey);
    });
    const currentTrashIds = new Set((currentV22.subtasks.trash || []).map(item => String(item.id)));
    const trashAdditions = (parts.subtasks.trash || []).filter(item => !currentTrashIds.has(String(item.id)));
    return {
      courseAdditions,
      courseConflicts,
      noteAction,
      subjectAction,
      subtaskAdditions,
      subtaskConflicts,
      trashAdditions,
      candidateCourseCount: candidateCourses.length,
      candidateOccurrenceCount: Object.keys(parts.subtasks.records || {}).length,
      candidateTrashCount: parts.subtasks.trash.length,
      fingerprint: stateFingerprint(),
    };
  }

  function importPreviewText(preview) {
    if (!preview) return 'Choose a laptop export to see a read-only difference preview.';
    const note = preview.noteAction === 'add' ? 'quick note will be added' : preview.noteAction === 'keep-account' ? 'account quick note wins' : preview.noteAction === 'account-empty' ? 'account quick note is empty; no automatic overwrite' : 'no quick-note change';
    const subject = preview.subjectAction === 'add' ? 'Subject Track setting will be added' : preview.subjectAction === 'keep-account' ? 'account Subject Track setting wins' : 'no Subject Track change';
    return `Add ${preview.courseAdditions.length} manual course(s) and ${preview.subtaskAdditions.length} subtask occurrence(s); ${preview.trashAdditions.length} trash item(s) can be archived. ${preview.courseConflicts.length} course conflict(s) and ${preview.subtaskConflicts.length} subtask conflict(s) stay with the account. ${note}; ${subject}.`;
  }

  function renderImportPanel() {
    if (!isAdmin() || !root.document) return;
    const help = root.document.getElementById('v21Help');
    if (!help) return;
    let panel = root.document.getElementById('v22LaptopImport');
    if (!panel) {
      panel = root.document.createElement('section');
      panel.id = 'v22LaptopImport';
      panel.className = 'v22-account-import';
      help.appendChild(panel);
      panel.addEventListener('change', event => {
        if (event.target?.id !== 'v22LaptopImportFile') return;
        const file = event.target.files?.[0];
        if (!file) return;
        void loadImportFile(file);
      });
      panel.addEventListener('click', event => {
        const action = event.target?.closest?.('[data-v22-import-action]')?.dataset.v22ImportAction;
        if (action === 'apply') void applyReviewedImport();
        if (action === 'clear') { importState.bundle = null; importState.preview = null; importState.fingerprint = ''; importState.message = 'The selected candidate was cleared. The account is unchanged.'; renderImportPanel(); }
      });
    }
    const preview = importState.preview;
    const canApply = !!preview && !importState.busy;
    panel.innerHTML = `<details><summary>Admin: review laptop v22 additions</summary><p>Choose the exported laptop bundle to preview only. Nothing is uploaded or merged until you approve it. Existing account records win conflicts, and the laptop file stays untouched.</p><label class="v22-import-file-label">Laptop v22 export<input id="v22LaptopImportFile" type="file" accept="application/json,.json"></label><div class="v22-import-preview" role="status">${esc(importState.message || importPreviewText(preview))}</div>${preview ? `<div class="v22-import-counts">Courses: ${preview.candidateCourseCount} candidate · ${preview.courseAdditions.length} additive · ${preview.courseConflicts.length} account-wins<br>Subtasks: ${preview.candidateOccurrenceCount} candidate occurrence(s) · ${preview.subtaskAdditions.length} additive · ${preview.subtaskConflicts.length} account-wins<br>Trash: ${preview.candidateTrashCount} candidate · ${preview.trashAdditions.length} archived</div>` : ''}<div class="v22-import-actions">${actionButton('noop', 'Selected file is previewed', '', true)}<button type="button" class="btn btn-primary" data-v22-import-action="apply" ${canApply ? '' : 'disabled'}>Approve additive import</button><button type="button" class="btn btn-ghost" data-v22-import-action="clear" ${preview ? '' : 'disabled'}>Clear candidate</button></div></details>`;
  }

  async function loadImportFile(file) {
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('The export is larger than 8 MB. Use a focused v22 recovery export.');
      const parsed = JSON.parse(await file.text());
      const parts = candidateParts(parsed);
      importState.bundle = { parsed: clone(parsed), parts };
      importState.preview = importPreview(parts);
      importState.fingerprint = importState.preview.fingerprint;
      importState.message = `Read-only preview for ${file.name}. ${importPreviewText(importState.preview)}`;
    } catch (cause) {
      importState.bundle = null;
      importState.preview = null;
      importState.fingerprint = '';
      importState.message = `Import not ready: ${String(cause?.message || cause)} Nothing changed.`;
    }
    renderImportPanel();
  }

  function mergeReviewedImport(parts) {
    const next = clone(core.getState());
    const currentV21 = normalizeNamespace(next[NAMESPACE]);
    const currentV22 = normalizeV22Namespace(next[V22_NAMESPACE]);
    const accountV21WasEmpty = currentV21.manual.courses.length === 0 && !currentV21.note.text && currentV21.subjectTrack.enabled !== true && !currentV21.migration;
    const courseIds = new Set(currentV21.manual.courses.map(course => String(course.id || '')));
    const additions = parts.manualCourses.filter(course => course && typeof course.id === 'string' && course.id && !courseIds.has(course.id));
    if (additions.length) {
      currentV21.manual = { ...currentV21.manual, revision: currentV21.manual.revision + 1, courses: [...currentV21.manual.courses, ...clone(additions)], savedAt: new Date().toISOString() };
    }
    // A completely empty account can receive the laptop's note and Subject
    // Track default as part of this explicit owner-reviewed import. If the
    // account already has v21 content, its values remain authoritative.
    if (accountV21WasEmpty && parts.note.text) currentV21.note = clone(parts.note);
    if (accountV21WasEmpty && parts.subjectTrack.enabled) currentV21.subjectTrack = clone(parts.subjectTrack);
    currentV21.migration = { ...(currentV21.migration || {}), v22LaptopImport: { at: new Date().toISOString(), addedCourses: additions.length } };
    next[NAMESPACE] = currentV21;
    const occurrenceKeys = new Set(Object.keys(currentV22.subtasks.records || {}));
    const ids = new Set();
    Object.values(currentV22.subtasks.records || {}).forEach(record => (record.subtasks || []).forEach(item => ids.add(String(item.id))));
    (currentV22.subtasks.trash || []).forEach(item => (item.subtasks || []).forEach(subtask => ids.add(String(subtask.id))));
    let addedOccurrences = 0;
    for (const [occurrenceKey, occurrence] of Object.entries(parts.subtasks.records || {})) {
      if (occurrenceKeys.has(occurrenceKey) || (occurrence.subtasks || []).some(item => ids.has(String(item.id)))) continue;
      currentV22.subtasks.records[occurrenceKey] = clone(occurrence);
      (occurrence.subtasks || []).forEach(item => ids.add(String(item.id)));
      addedOccurrences++;
    }
    const trashIds = new Set((currentV22.subtasks.trash || []).map(item => String(item.id)));
    const trashAdditions = (parts.subtasks.trash || []).filter(item => !trashIds.has(String(item.id)));
    currentV22.subtasks.trash.push(...clone(trashAdditions));
    if (addedOccurrences || trashAdditions.length) {
      currentV22.subtasks.revision += 1;
      currentV22.subtasks.updatedAt = new Date().toISOString();
    }
    next[V22_NAMESPACE] = currentV22;
    return next;
  }

  async function applyReviewedImport() {
    if (!isAdmin() || !importState.bundle || !importState.preview || importState.busy) return;
    if (stateFingerprint() !== importState.fingerprint) {
      importState.message = 'The account changed while this was being reviewed. Reload the candidate and preview again; nothing was changed.';
      importState.preview = null;
      renderImportPanel();
      return;
    }
    if (!root.confirm?.('Create a verified recovery backup, then add only non-conflicting laptop v22 records? Account records win conflicts and the laptop file remains unchanged.')) return;
    importState.busy = true;
    renderImportPanel();
    try {
      const backup = await core.snapshots();
      await core.archive(backup);
      if (typeof core.persistRecoveryOnly === 'function' && await core.persistRecoveryOnly({ v22LaptopImportCandidate: importState.bundle.parsed }, 'Before v22 laptop import candidate') !== true) {
        throw new Error('The additional import backup could not be verified; nothing was applied.');
      }
      const parsed = importState.bundle.parsed;
      await commit(() => {
        if (stateFingerprint() !== importState.fingerprint) throw new Error('The account changed during backup. Both copies remain intact; preview again.');
        return mergeReviewedImport(candidateParts(parsed));
      });
      root.StudyQuestV21Manual?.reload?.();
      root.StudyQuestV22Subtasks?.reload?.();
      core.render?.();
      importState.message = 'Reviewed additive import completed. Account records won conflicts; backups remain available.';
      importState.bundle = null;
      importState.preview = null;
      importState.fingerprint = '';
    } catch (cause) {
      importState.message = `Import stopped safely: ${String(cause?.message || cause)} Existing account and laptop copies remain preserved.`;
    } finally {
      importState.busy = false;
      renderImportPanel();
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
    root.StudyQuestV22SubtaskStore = subtaskStore;

    const style = root.document.createElement('style');
    style.textContent = '#v21SyncStatus{margin-top:8px;font-size:12px;line-height:1.6;color:var(--text-muted)}'
      + '#v21SyncStatus[data-kind=error]{color:var(--red,#f76a6a)}'
      + '.v22-account-import{margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:10px;background:rgba(124,106,247,.045)}'
      + '.v22-account-import p,.v22-import-preview,.v22-import-counts{font-size:11px;line-height:1.55;color:var(--text-muted);overflow-wrap:anywhere}'
      + '.v22-import-file-label{display:grid;gap:5px;font-size:11px}.v22-import-file-label input{max-width:100%;color:var(--text-muted)}'
      + '.v22-import-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.v22-import-actions .btn{white-space:normal;height:auto;min-height:30px}'
      + '.v22-import-preview{margin-top:8px;color:var(--text)}.v22-import-counts{margin-top:6px}';
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
    renderImportPanel();
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
    subtaskStore,
    NAMESPACE,
    V22_NAMESPACE,
    SCHEMA_VERSION,
    SUBTASK_SCHEMA_VERSION,
    TEXT_DEBOUNCE_MS,
    reviewLaptopImport: () => renderImportPanel(),
    applyReviewedImport,
  };
  api.commitState = (mutate, readback = 'v21') => commit(mutate, readback);
  root.StudyQuestV21AccountSync = api;
  root.StudyQuestV22AccountSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
