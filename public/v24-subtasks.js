(function installStudyQuestV24Subtasks(root) {
  'use strict';

  // Active v24 edits use the neutral shared collection. The old v24 database
  // remains a read-only migration/recovery source.
  const DB = 'studyquest-subtasks';
  const DB_VERSION = 3;
  const V22_DB = 'studyquest-v22-subtasks';
  const V22_DB_VERSION = 1;
  const SCHEMA_VERSION = 1;
  const MAX_TITLE_LENGTH = 240;
  const MAX_ESTIMATE_MINUTES = 1440;
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const uid = () => root.crypto?.randomUUID?.() || `v24st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const byId = id => root.document?.getElementById(id);
  const copyTask = task => task && typeof task === 'object' ? clone(task) : null;

  let core;
  let installed = false;
  let ready = false;
  let pending = 0;
  let error = '';
  let warning = '';
  let record = null;
  let key = '';
  let queue = Promise.resolve();
  let channel = null;
  let enhancing = false;
  let editState = null;
  let estimateDrafts = {};
  let estimateErrors = {};
  let importState = { fileName: '', preview: null, message: '' };
  let accountImportState = { fileName: '', preview: null, message: '' };
  let v22Migration = { phase: 'checking', candidate: null, preview: null, sourceFingerprint: '', message: '' };
  let v22MigrationBusy = false;
  let deletionWatch = null;
  let uiPrefs = { expanded: {} };

  function blank(collectionKey = key) {
    return {
      schemaVersion: SCHEMA_VERSION,
      key: collectionKey,
      revision: 0,
      records: {},
      trash: [],
      importArchive: [],
      syncArchive: [],
      migrationHistory: [],
      updatedAt: null,
      lastMutationId: null,
    };
  }

  function estimateMinutes(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ESTIMATE_MINUTES) {
      throw new Error(`Subtask duration must be a whole number from 1 to ${MAX_ESTIMATE_MINUTES} minutes.`);
    }
    return number;
  }

  function normalizeSubtask(source, index = 0) {
    const item = source && typeof source === 'object' ? source : {};
    const title = String(item.title || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) throw new Error('A subtask title cannot be empty.');
    const normalized = {
      id: typeof item.id === 'string' && item.id ? item.id : uid(),
      title,
      checked: item.checked === true,
      order: Number.isSafeInteger(item.order) ? item.order : index,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
    };
    const duration = estimateMinutes(item.estimateMinutes);
    if (duration !== null) normalized.estimateMinutes = duration;
    return normalized;
  }

  function normalizeImportArchive(source) {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id ||
        typeof source.occurrenceKey !== 'string' || !source.occurrenceKey ||
        !source.candidateRecord || typeof source.candidateRecord !== 'object' ||
        !Array.isArray(source.candidateRecord.subtasks)) {
      throw new Error('Invalid v24 archived import candidate.');
    }
    const candidateSubtasks = source.candidateRecord.subtasks.map((item, index) => normalizeSubtask(item, index));
    const candidateIds = new Set();
    candidateSubtasks.forEach(item => {
      if (candidateIds.has(item.id)) throw new Error('Duplicate subtask ID in archived v24 import candidate.');
      candidateIds.add(item.id);
    });
    return {
      id: source.id,
      sourceVersion: 22,
      occurrenceKey: source.occurrenceKey,
      parentTaskId: String(source.parentTaskId || source.candidateRecord.parentTaskId || ''),
      candidateRecord: {
        parentTaskId: String(source.candidateRecord.parentTaskId || source.parentTaskId || ''),
        subtasks: candidateSubtasks,
        updatedAt: source.candidateRecord.updatedAt || null,
      },
      reason: String(source.reason || 'Conflict archived for review.').slice(0, 500),
      archivedAt: source.archivedAt || new Date().toISOString(),
    };
  }

  function normalizeSyncArchive(source) {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id) {
      throw new Error('Invalid v24 account conflict archive.');
    }
    return {
      id: source.id,
      kind: 'sync-conflict',
      source: String(source.source || 'laptop-v24').slice(0, 80),
      occurrenceKey: String(source.occurrenceKey || '*'),
      parentTaskId: String(source.parentTaskId || ''),
      candidateRecord: source.candidateRecord && typeof source.candidateRecord === 'object' ? clone(source.candidateRecord) : null,
      serverRecord: source.serverRecord && typeof source.serverRecord === 'object' ? clone(source.serverRecord) : null,
      baseRevision: Number.isSafeInteger(Number(source.baseRevision)) ? Number(source.baseRevision) : 0,
      reason: String(source.reason || 'Account conflict archived for review.').slice(0, 500),
      archivedAt: source.archivedAt || new Date().toISOString(),
    };
  }

  function normalizeMigrationHistory(source) {
    if (!Array.isArray(source)) return [];
    return source.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
      .slice(0, 24)
      .map(item => ({
        id: item.id,
        sourceVersion: Number.isSafeInteger(Number(item.sourceVersion)) ? Number(item.sourceVersion) : 22,
        sourceKey: String(item.sourceKey || '').slice(0, 240),
        sourceRevision: Number.isSafeInteger(Number(item.sourceRevision)) ? Number(item.sourceRevision) : 0,
        sourceFingerprint: String(item.sourceFingerprint || '').slice(0, 80),
        occurrenceCount: Number.isSafeInteger(Number(item.occurrenceCount)) ? Number(item.occurrenceCount) : 0,
        subtaskCount: Number.isSafeInteger(Number(item.subtaskCount)) ? Number(item.subtaskCount) : 0,
        trashCount: Number.isSafeInteger(Number(item.trashCount)) ? Number(item.trashCount) : 0,
        outcome: String(item.outcome || 'applied').slice(0, 40),
        appliedAt: item.appliedAt || new Date().toISOString(),
      }));
  }

  function normalizeRecord(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.key !== 'string' ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.records || typeof value.records !== 'object' || Array.isArray(value.records) ||
        !Array.isArray(value.trash)) {
      throw new Error('Unrecognized v24 subtask data. Export your laptop copy and retry; nothing was replaced.');
    }
    const next = blank(value.key);
    next.revision = value.revision;
    next.updatedAt = value.updatedAt || null;
    const ids = new Set();
    for (const [occurrenceKey, source] of Object.entries(value.records)) {
      if (!source || typeof source !== 'object' || typeof source.parentTaskId !== 'string' || !Array.isArray(source.subtasks)) {
        throw new Error('Invalid v24 subtask record.');
      }
      const subtasks = source.subtasks.map((item, index) => normalizeSubtask(item, index));
      for (const item of subtasks) {
        if (ids.has(item.id)) throw new Error('Duplicate v24 subtask id.');
        ids.add(item.id);
      }
      next.records[occurrenceKey] = {
        parentTaskId: source.parentTaskId,
        subtasks,
        updatedAt: source.updatedAt || null,
      };
    }
    next.trash = value.trash.map(item => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id ||
          typeof item.kind !== 'string' || typeof item.occurrenceKey !== 'string' || !Array.isArray(item.subtasks)) {
        throw new Error('Invalid v24 subtask recovery item.');
      }
      return {
        id: item.id,
        kind: item.kind === 'subtask' ? 'subtask' : 'parent',
        occurrenceKey: item.occurrenceKey,
        parentTaskId: String(item.parentTaskId || ''),
        parentTask: item.parentTask && typeof item.parentTask === 'object' ? clone(item.parentTask) : null,
        subtasks: item.subtasks.map((subtask, index) => normalizeSubtask(subtask, index)),
        deletedAt: item.deletedAt || new Date().toISOString(),
      };
    });
    next.importArchive = Array.isArray(value.importArchive)
      ? value.importArchive.map(normalizeImportArchive)
      : [];
    next.syncArchive = Array.isArray(value.syncArchive)
      ? value.syncArchive.map(normalizeSyncArchive)
      : [];
    next.migrationHistory = normalizeMigrationHistory(value.migrationHistory);
    next.lastMutationId = typeof value.lastMutationId === 'string' ? value.lastMutationId : null;
    return next;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('v24 subtask storage request failed.'));
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = cause => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(cause);
      };
      const timer = setTimeout(() => fail(new Error('v24 subtask storage did not respond. Close other StudyQuest tabs and retry.')), 8000);
      let request;
      try {
        request = root.indexedDB.open(DB, DB_VERSION);
      } catch (cause) {
        fail(new Error('Laptop storage is unavailable for v24 subtasks. Your existing tasks are unchanged.'));
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { autoIncrement: true });
        if (!db.objectStoreNames.contains('accountOutbox')) db.createObjectStore('accountOutbox', { keyPath: 'key' });
      };
      request.onerror = () => fail(request.error || new Error('Laptop storage could not be opened for v24 subtasks.'));
      request.onblocked = () => fail(new Error('v24 subtask storage is blocked by another tab. Close it and retry.'));
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  async function readV22LocalRecord() {
    if (!root.indexedDB || typeof root.indexedDB.databases !== 'function') {
      return { unavailable: true, reason: 'This browser cannot inspect the older laptop subtask store automatically.' };
    }
    const databases = await root.indexedDB.databases();
    if (!databases.some(item => item?.name === V22_DB)) return null;
    const db = await new Promise((resolve, reject) => {
      let request;
      try { request = root.indexedDB.open(V22_DB, V22_DB_VERSION); }
      catch (cause) { reject(cause); return; }
      request.onerror = () => reject(request.error || new Error('The v22 subtask store could not be opened for read-only inspection.'));
      request.onupgradeneeded = () => {
        request.transaction?.abort();
        reject(new Error('The v22 subtask store needs an unexpected upgrade; no migration was attempted.'));
      };
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (!db.objectStoreNames.contains('workspaces')) return null;
      const stored = await requestResult(db.transaction('workspaces', 'readonly').objectStore('workspaces').get(`${core.storageKey()}:${core.accountKey()}:v22-subtasks:v${SCHEMA_VERSION}`));
      if (!stored) return null;
      return parseV22Import({ subtasks: stored });
    } finally {
      db.close();
    }
  }

  async function readRecord(collectionKey) {
    const injected = root.StudyQuestV24SubtaskStore;
    if (injected && typeof injected.read === 'function') {
      return normalizeRecord(await injected.read(collectionKey));
    }
    const db = await openDb();
    try {
      const stored = await requestResult(db.transaction('workspaces', 'readonly').objectStore('workspaces').get(collectionKey));
      return normalizeRecord(stored || blank(collectionKey));
    } finally {
      db.close();
    }
  }

  async function writeRecord(expected, next) {
    const validated = normalizeRecord(next);
    const injected = root.StudyQuestV24SubtaskStore;
    if (injected && typeof injected.write === 'function') {
      return normalizeRecord(await injected.write(expected, validated));
    }
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['workspaces', 'history'], 'readwrite');
        const workspaces = transaction.objectStore('workspaces');
        let reason;
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(reason || transaction.error || new Error('v24 subtask save failed.'));
        transaction.onerror = () => {};
        const currentRequest = workspaces.get(expected.key);
        currentRequest.onsuccess = () => {
          try {
            const current = normalizeRecord(currentRequest.result || blank(expected.key));
            if (JSON.stringify(current) !== JSON.stringify(expected)) {
              throw new Error('Another tab changed these subtasks. Reload saved subtasks before editing; your earlier data was kept.');
            }
            transaction.objectStore('history').add({ key: expected.key, capturedAt: new Date().toISOString(), record: clone(current) });
            workspaces.put(validated);
          } catch (cause) {
            reason = cause;
            transaction.abort();
          }
        };
      });
      const verified = await requestResult(db.transaction('workspaces', 'readonly').objectStore('workspaces').get(validated.key));
      if (JSON.stringify(verified) !== JSON.stringify(validated)) {
        throw new Error('v24 subtask save readback changed. Reload saved subtasks to verify the latest copy.');
      }
      return verified;
    } finally {
      db.close();
    }
  }

  function occurrenceKey(task) {
    const id = String(task?.id || '');
    if (task?.recurrence === 'weekly' || task?.recurrenceId) {
      const series = String(task.recurrenceId || task.recurrenceRootDate || id);
      return `weekly:${series}:${String(task.date || id)}`;
    }
    return `task:${id}`;
  }

  function hashKey(value) {
    let hash = 2166136261;
    for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(36);
  }

  function currentTask(taskId) {
    return (core?.getState?.().tasks || []).find(task => String(task.id) === String(taskId)) || null;
  }

  function taskRecord(task) {
    const k = occurrenceKey(task);
    return record?.records?.[k] || { parentTaskId: String(task?.id || ''), subtasks: [] };
  }

  function orderedItems(source) {
    return [...(source?.subtasks || [])].sort((a, b) => Number(a.order) - Number(b.order) || Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  }

  function expandedFor(k, variant) {
    if (Object.prototype.hasOwnProperty.call(uiPrefs.expanded || {}, k)) return uiPrefs.expanded[k] === true;
    return variant !== 'calendar';
  }

  function rememberExpanded(k, expanded) {
    uiPrefs.expanded = { ...(uiPrefs.expanded || {}), [k]: !!expanded };
    try {
      root.localStorage.setItem(`${key}:ui`, JSON.stringify(uiPrefs));
    } catch {
      warning = 'Subtask progress is saved, but this laptop could not remember the expand/collapse preference.';
    }
  }

  function loadUiPrefs() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(`${key}:ui`) || '{}');
      uiPrefs = saved && typeof saved === 'object' && saved.expanded && typeof saved.expanded === 'object'
        ? { expanded: saved.expanded }
        : { expanded: {} };
    } catch {
      uiPrefs = { expanded: {} };
    }
  }

  function statusText() {
    const injected = root.StudyQuestV24SubtaskStore;
    const sharedLocal = injected?.mode === 'shared-local';
    if (error) return error;
    if (!ready) return sharedLocal ? 'Opening shared laptop subtasks…' : injected ? 'Opening your account subtasks…' : 'Opening laptop-only subtask storage…';
    if (pending) return sharedLocal ? 'Saving subtasks on the shared laptop copy…' : injected ? 'Saving subtasks…' : 'Saving subtasks on this laptop…';
    if (warning) return warning;
    if (injected && typeof injected.statusText === 'function') return injected.statusText({ ready, pending, record, error, warning });
    return record?.revision ? 'Saved on this laptop · subtasks never change cloud task records.' : 'Subtasks stay on this laptop and do not award separate XP.';
  }

  function storageLabel() {
    return root.StudyQuestV24SubtaskStore?.mode === 'shared-local' ? 'the shared laptop copy' : root.StudyQuestV24SubtaskStore ? 'your account' : 'this laptop';
  }

  function actionButton(action, label, attrs = '', disabled = false) {
    return `<button type="button" class="btn btn-ghost btn-sm" data-v24-action="${action}" ${attrs} ${disabled ? 'disabled' : ''}>${label}</button>`;
  }

  function itemDraftKey(occurrence, itemId) { return `${occurrence}::${itemId}`; }

  function renderSubtaskRow(item, k, total, variant) {
    const editing = editState?.key === k && editState?.id === item.id;
    const position = orderedItems(record?.records?.[k]).findIndex(entry => entry.id === item.id);
    const disabled = !ready || !!error || !!pending;
    const draftKey = itemDraftKey(k, item.id);
    const hasEstimateDraft = Object.prototype.hasOwnProperty.call(estimateDrafts, draftKey);
    const estimateValue = hasEstimateDraft ? estimateDrafts[draftKey] : (item.estimateMinutes ?? '');
    const estimateError = estimateErrors[draftKey] || '';
    const titleMarkup = editing
      ? `<input class="v24-subtask-edit-input" data-v24-action="title-input" data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" maxlength="${MAX_TITLE_LENGTH}" value="${esc(editState?.draft ?? item.title)}" aria-label="Edit subtask title for ${esc(item.title)}">`
      : `<button type="button" class="v24-subtask-title" data-v24-action="title-start" data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" title="Click to edit subtask title" aria-label="Edit subtask title ${esc(item.title)}" ${disabled ? 'disabled' : ''}>${esc(item.title)}</button>`;
    return `<li class="v24-subtask-row ${item.checked ? 'is-checked' : ''}" data-v24-subtask-id="${esc(item.id)}">
      <input type="checkbox" data-v24-action="check" data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" ${item.checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(item.title)} · subtask">
      <div class="v24-subtask-title-wrap">${titleMarkup}</div>
      <label class="v24-subtask-estimate task-duration-inline" title="Independent subtask duration estimate">
        <span class="task-duration-icon" aria-hidden="true">⏱</span>
        <input class="task-duration-input" type="number" data-v24-action="estimate-input" data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" min="1" max="${MAX_ESTIMATE_MINUTES}" step="1" inputmode="numeric" value="${esc(estimateValue)}" placeholder="—" aria-label="Subtask duration estimate in whole minutes" aria-invalid="${estimateError ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>
        <span class="task-duration-suffix">min</span>
        ${estimateError ? `<span class="v24-subtask-estimate-error" role="alert">${esc(estimateError)}</span>` : ''}
      </label>
      <div class="v24-subtask-row-actions" role="group" aria-label="Subtask actions">
        ${editing ? '' : actionButton('move', '↑', `data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" data-v24-direction="-1" aria-label="Move subtask up"`, disabled || position <= 0)}
        ${editing ? '' : actionButton('move', '↓', `data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" data-v24-direction="1" aria-label="Move subtask down"`, disabled || position < 0 || position >= total - 1)}
        ${editing ? '' : actionButton('remove', '×', `data-v24-record="${esc(k)}" data-v24-id="${esc(item.id)}" aria-label="Move subtask to trash"`, disabled)}
      </div>
    </li>`;
  }

  function renderSubtaskHost(task, variant = 'inline', options = {}) {
    const k = occurrenceKey(task);
    const stored = taskRecord(task);
    const items = orderedItems(stored);
    if (!items.length && !options.allowEmpty) return '';
    const done = items.filter(item => item.checked).length;
    const expanded = expandedFor(k, variant);
    const panelId = `v24-subtask-panel-${hashKey(k)}`;
    const disabled = !ready || !!error || !!pending;
    const listMarkup = `<ul class="v24-subtask-list" aria-label="Subtasks for ${esc(task.title || 'task')}">${items.map(item => renderSubtaskRow(item, k, items.length, variant)).join('')}</ul>`;
    return `<section class="v24-subtask-host v24-subtask-${variant}" data-v24-subtask-host data-v24-record="${esc(k)}" data-v24-parent="${esc(task.id)}">
      <div class="v24-subtask-head">
        <button type="button" class="v24-subtask-toggle" data-v24-action="toggle" data-v24-record="${esc(k)}" aria-expanded="${expanded}" aria-controls="${panelId}">
          <span aria-hidden="true">${expanded ? '▾' : '▸'}</span><strong>Subtasks</strong><span class="v24-subtask-count">${done}/${items.length}</span>
        </button>
        <span class="v24-subtask-independent">Independent from task completion</span>
      </div>
      <div id="${panelId}" class="v24-subtask-body" ${expanded ? '' : 'hidden'}>
        ${error ? `<div class="v24-subtask-status" data-error="true" role="alert">${esc(error)} ${actionButton('reload', 'Reload saved subtasks')}</div>` : ready ? (items.length ? listMarkup : '<div class="v24-subtask-empty">No subtasks yet. Add the first one below.</div>') : `<div class="v24-subtask-status" role="status">Opening ${storageLabel()} subtasks…</div>`}
        ${ready && !error ? `<div class="v24-subtask-add"><span aria-hidden="true">＋</span><input type="text" data-v24-action="add-input" data-v24-record="${esc(k)}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Add subtask · press Enter" aria-label="Add subtask for ${esc(task.title || 'task')}" ${disabled ? 'disabled' : ''}></div>` : ''}
      </div>
    </section>`;
  }

  function mountHost(target, task, variant) {
    if (!target || !task) return;
    let host = Array.from(target.children).find(child => child.matches?.('.v24-subtask-host'));
    if (!host) {
      host = root.document.createElement('div');
      target.appendChild(host);
    }
    host.outerHTML = renderSubtaskHost(task, variant);
  }

  function findTask(id) {
    return (core?.getState?.().tasks || []).find(task => String(task.id) === String(id)) || null;
  }

  function taskForView(task, view) {
    if (!task || !view?.dataset) return task;
    const data = view.dataset;
    if (!data.v24SubtaskDate && !data.v24SubtaskRecurrence && !data.v24SubtaskRecurrenceId) return task;
    return {
      ...task,
      date: data.v24SubtaskDate || task.date || '',
      recurrence: data.v24SubtaskRecurrence || task.recurrence || 'none',
      recurrenceId: data.v24SubtaskRecurrenceId || task.recurrenceId || '',
    };
  }

  function decorateTaskViews() {
    const tasks = core?.getState?.().tasks || [];
    const taskById = new Map(tasks.map(task => [String(task.id), task]));
    root.document.querySelectorAll('.task-item[data-id]').forEach(row => {
      const task = taskById.get(String(row.dataset.id));
      mountHost(row.querySelector('.task-info'), taskForView(task, row), 'inline');
    });
    root.document.querySelectorAll('.unscheduled-item[data-id]').forEach(row => {
      const task = taskById.get(String(row.dataset.id));
      mountHost(row.querySelector('.unscheduled-info'), taskForView(task, row), 'unscheduled');
    });
   root.document.querySelectorAll('[data-v24-subtask-parent]').forEach(block => {
      if (block.id === 'focusTaskBody') return;
      const task = taskById.get(String(block.dataset.v24SubtaskParent));
      const target = block.children?.[1] || block;
     mountHost(target, taskForView(task, block), block.classList.contains('calendar-task-block') ? 'calendar' : 'today');
   });
    const focusBody = byId('focusTaskBody');
    const focusTask = focusBody?.dataset.v24SubtaskParent ? taskForView(taskById.get(String(focusBody.dataset.v24SubtaskParent)), focusBody) : null;
    if (focusBody && focusTask) mountHost(focusBody, focusTask, 'focus');
  }

  function renderV22MigrationPanel() {
    if (v22Migration.phase === 'none') return '';
    if (v22Migration.phase === 'checking') {
      return '<section class="v24-subtask-migration" role="status"><strong>Checking for saved v22 subtasks…</strong><p>This is read-only. No v22 data is changed.</p></section>';
    }
    if (v22Migration.phase === 'error') {
      return `<section class="v24-subtask-migration is-error" role="alert"><strong>Could not inspect the v22 subtask copy</strong><p>${esc(v22Migration.message)} Your v22 data was not changed. You can still use the reviewed v22 export below in Backup &amp; recovery.</p></section>`;
    }
    const preview = v22Migration.preview;
    if (!preview) return '';
    const counts = `${preview.candidateOccurrenceCount} occurrence(s) · ${preview.candidateSubtaskCount} active subtask(s) · ${preview.candidateTrashCount} trash item(s)`;
    const conflicts = preview.conflicts.length + preview.trashConflicts.length;
    const actionDisabled = v22Migration.phase !== 'ready' || pending > 0 || !!error;
    if (v22Migration.phase === 'applied') {
      return `<section class="v24-subtask-migration is-complete" role="status"><strong>v22 subtasks are available in v24</strong><p>${esc(counts)} were reviewed and copied. v22 remains unchanged. Future subtask edits should be made in v24 so your account copy stays consistent across devices.</p><div class="v24-subtask-migration-meta">${esc(v22Migration.message)}</div></section>`;
    }
    return `<section class="v24-subtask-migration" id="v24V22Migration" aria-labelledby="v24V22MigrationTitle"><div class="v24-subtask-migration-heading"><div><h3 id="v24V22MigrationTitle">Saved v22 subtasks found</h3><p>Review this read-only preview before copying. v22 stays untouched, and v24 becomes the source of truth after migration.</p></div><span class="v24-subtask-migration-badge">SAFE COPY</span></div><div class="v24-subtask-migration-counts"><span>${esc(counts)}</span><span>${preview.additions.length} ready</span><span>${conflicts} conflict(s) archived</span><span>${preview.orphans.length} orphan(s) archived</span></div><p class="v24-subtask-migration-note">A verified backup of both collections will be created immediately before applying. If storage, recovery, or stale-revision checks fail, nothing is applied.</p>${v22Migration.message ? `<div class="v24-subtask-status" data-error="true" role="alert">${esc(v22Migration.message)}</div>` : ''}<div class="v24-subtask-recovery-actions">${actionButton('v22-migrate-apply', 'Back up and copy into v24', '', actionDisabled)}<span class="v24-subtask-migration-hint">Conflicting v22 records remain recoverable; no parent tasks are created.</span></div></section>`;
  }

  function parseV22Import(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('Choose a valid StudyQuest v22 subtask export.');
    let raw = bundle.subtasks;
    if (raw && typeof raw === 'object' && raw.subtasks && typeof raw.subtasks === 'object' && raw.subtasks.records) raw = raw.subtasks;
    if (!raw || typeof raw !== 'object' || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records) || !Array.isArray(raw.trash)) {
      throw new Error('This file does not contain a valid v22 subtask collection.');
    }
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      key,
      sourceKey: String(raw.key || ''),
      sourceRevision: Number.isSafeInteger(Number(raw.revision)) ? Number(raw.revision) : 0,
      revision: 0,
      records: {},
      trash: [],
      importArchive: [],
      updatedAt: raw.updatedAt || null,
    };
    const ids = new Set();
    for (const [occurrenceKey, source] of Object.entries(raw.records)) {
      if (!source || typeof source !== 'object' || typeof source.parentTaskId !== 'string' || !Array.isArray(source.subtasks)) {
        throw new Error('The v22 export contains an invalid subtask record.');
      }
      const subtasks = source.subtasks.map((item, index) => normalizeSubtask({ ...item, estimateMinutes: undefined }, index));
      subtasks.forEach(item => {
        if (ids.has(item.id)) throw new Error('The v22 export contains duplicate subtask IDs.');
        ids.add(item.id);
      });
      candidate.records[occurrenceKey] = { parentTaskId: source.parentTaskId, subtasks, updatedAt: source.updatedAt || null };
    }
    for (const source of raw.trash) {
      if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id ||
          typeof source.occurrenceKey !== 'string' || !Array.isArray(source.subtasks)) {
        throw new Error('The v22 export contains invalid recovery trash.');
      }
      const subtasks = source.subtasks.map((item, index) => normalizeSubtask({ ...item, estimateMinutes: undefined }, index));
      subtasks.forEach(item => {
        if (ids.has(item.id)) throw new Error('The v22 export contains duplicate recovery subtask IDs.');
        ids.add(item.id);
      });
      candidate.trash.push({
        id: source.id,
        kind: source.kind === 'subtask' ? 'subtask' : 'parent',
        occurrenceKey: source.occurrenceKey,
        parentTaskId: String(source.parentTaskId || ''),
        parentTask: source.parentTask && typeof source.parentTask === 'object' ? clone(source.parentTask) : null,
        subtasks,
        deletedAt: source.deletedAt || new Date().toISOString(),
      });
    }
    return candidate;
  }

  function currentSubtaskIds() {
    const ids = new Set();
    Object.values(record?.records || {}).forEach(source => (source.subtasks || []).forEach(item => ids.add(String(item.id))));
    (record?.trash || []).forEach(source => (source.subtasks || []).forEach(item => ids.add(String(item.id))));
    return ids;
  }

  function migrationFingerprint(candidate) {
    return hashKey(JSON.stringify({
      sourceKey: candidate?.sourceKey || '',
      sourceRevision: Number(candidate?.sourceRevision || 0),
      records: candidate?.records || {},
      trash: candidate?.trash || [],
    }));
  }

  function previewV22Import(candidate) {
    const tasks = new Map((core?.getState?.().tasks || []).map(task => [String(task.id), task]));
    const ids = currentSubtaskIds();
    const existingOccurrences = new Set(Object.keys(record?.records || {}));
    const trashIds = new Set((record?.trash || []).map(item => String(item.id)));
    const additions = [];
    const conflicts = [];
    const orphans = [];
    for (const [occurrenceKey, source] of Object.entries(candidate.records)) {
      const candidateRecord = { occurrenceKey, source };
      if (!tasks.has(String(source.parentTaskId))) {
        orphans.push({ ...candidateRecord, reason: 'Parent task is not present in the current workspace.' });
      } else if (existingOccurrences.has(occurrenceKey) || source.subtasks.some(item => ids.has(String(item.id)))) {
        conflicts.push({ ...candidateRecord, reason: existingOccurrences.has(occurrenceKey) ? 'The occurrence already exists in v24.' : 'A subtask ID already exists in v24.' });
      } else {
        additions.push(candidateRecord);
      }
    }
    const trashAdditions = [];
    const trashConflicts = [];
    candidate.trash.forEach(source => {
      if (trashIds.has(String(source.id)) || source.subtasks.some(item => ids.has(String(item.id)))) {
        trashConflicts.push({ source, reason: 'A recovery item or subtask ID already exists in v24.' });
      } else {
        trashAdditions.push(source);
      }
    });
    return {
      baseRevision: Number(record?.revision || 0),
      candidate,
      additions,
      conflicts,
      orphans,
      trashAdditions,
      trashConflicts,
      candidateOccurrenceCount: Object.keys(candidate.records).length,
      candidateSubtaskCount: Object.values(candidate.records).reduce((sum, source) => sum + source.subtasks.length, 0),
      candidateTrashCount: candidate.trash.length,
      sourceKey: String(candidate.sourceKey || ''),
      sourceRevision: Number(candidate.sourceRevision || 0),
      sourceFingerprint: migrationFingerprint(candidate),
    };
  }

  function importPreviewText(preview) {
    if (!preview) return importState.message || 'Choose a v22 subtask export to see a read-only preview. Nothing is imported automatically.';
    return `${preview.candidateOccurrenceCount} occurrence(s) · ${preview.candidateSubtaskCount} active subtask(s) · ${preview.candidateTrashCount} trash item(s) · ${preview.additions.length} ready · ${preview.conflicts.length + preview.trashConflicts.length} conflict(s) · ${preview.orphans.length} orphan(s).`;
  }

  async function readV22Import(file) {
    importState = { fileName: file?.name || '', preview: null, message: '' };
    if (!file) { enhance(); return; }
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('The v22 export is larger than 8 MB. Choose a focused subtask export.');
      const bundle = JSON.parse(await file.text());
      importState.preview = previewV22Import(parseV22Import(bundle));
    } catch (cause) {
      importState.message = String(cause?.message || cause);
    }
    enhance();
  }

  function migrationAlreadyApplied(fingerprint) {
    return (record?.migrationHistory || []).some(item => item.sourceVersion === 22 && item.sourceFingerprint === fingerprint);
  }

  async function scanV22Migration() {
    if (!ready || !record) return;
    v22Migration = { phase: 'checking', candidate: null, preview: null, sourceFingerprint: '', message: '' };
    try {
      const candidate = await readV22LocalRecord();
      if (!candidate) {
        v22Migration = { phase: 'none', candidate: null, preview: null, sourceFingerprint: '', message: '' };
      } else if (candidate.unavailable) {
        v22Migration = { phase: 'error', candidate: null, preview: null, sourceFingerprint: '', message: candidate.reason };
      } else {
        const fingerprint = migrationFingerprint(candidate);
        const preview = previewV22Import(candidate);
        v22Migration = migrationAlreadyApplied(fingerprint)
          ? { phase: 'applied', candidate, preview, sourceFingerprint: fingerprint, message: 'This v22 snapshot is already recorded as imported into v24.' }
          : { phase: 'ready', candidate, preview, sourceFingerprint: fingerprint, message: '' };
      }
    } catch (cause) {
      v22Migration = { phase: 'error', candidate: null, preview: null, sourceFingerprint: '', message: String(cause?.message || cause) };
    }
    enhance();
  }

  async function readV24AccountImport(file) {
    accountImportState = { fileName: file?.name || '', preview: null, message: '' };
    const store = root.StudyQuestV24SubtaskStore;
    if (!store?.previewLocalImport) {
      accountImportState.message = 'Account import is available only in the hosted signed-in v24 experience.';
      enhance();
      return;
    }
    if (!file) { enhance(); return; }
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('The v24 export is larger than 8 MB. Choose a focused subtask export.');
      accountImportState.preview = store.previewLocalImport(JSON.parse(await file.text()));
    } catch (cause) {
      accountImportState.message = String(cause?.message || cause);
    }
    enhance();
  }

  function escapeSelector(value) {
    return root.CSS?.escape
      ? root.CSS.escape(String(value))
      : String(value).replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character);
  }

  function focusTitleInput(occurrence, itemId) {
    const selector = `[data-v24-action="title-input"][data-v24-record="${escapeSelector(occurrence)}"][data-v24-id="${escapeSelector(itemId)}"]`;
    const input = root.document.querySelector(selector);
    input?.focus();
    input?.select?.();
  }

  function focusEstimateInput(occurrence, itemId) {
    const selector = `[data-v24-action="estimate-input"][data-v24-record="${escapeSelector(occurrence)}"][data-v24-id="${escapeSelector(itemId)}"]`;
    root.document.querySelector(selector)?.focus();
  }

  function startTitleEdit(occurrence, itemId) {
    const item = record?.records?.[occurrence]?.subtasks?.find(candidate => candidate.id === itemId);
    if (!item || !ready || error || pending) return;
    editState = { key: occurrence, id: itemId, draft: item.title };
    enhance();
    setTimeout(() => focusTitleInput(occurrence, itemId), 0);
  }

  async function commitTitleInput(target) {
    const occurrence = target.dataset.v24Record;
    const itemId = target.dataset.v24Id;
    const title = String(target.value || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) {
      target.setCustomValidity('Enter a subtask title.');
      target.reportValidity?.();
      return false;
    }
    target.setCustomValidity('');
    const current = record?.records?.[occurrence]?.subtasks?.find(item => item.id === itemId);
    if (!current) {
      editState = null;
      enhance();
      return false;
    }
    if (current.title === title) {
      editState = null;
      enhance();
      return true;
    }
    try {
      await save(next => mutateRecord(next, occurrence, current.parentTaskId, entry => {
        const item = entry.subtasks.find(candidate => candidate.id === itemId);
        if (!item) return false;
        item.title = title;
        return 'keep-empty';
      }), 'Subtask renamed');
      editState = null;
      enhance();
      return true;
    } catch (cause) {
      error = String(cause?.message || cause);
      enhance();
      return false;
    }
  }

  async function commitEstimateInput(target) {
    const occurrence = target.dataset.v24Record;
    const itemId = target.dataset.v24Id;
    const draftKey = itemDraftKey(occurrence, itemId);
    const raw = String(target.value ?? '').trim();
    let duration;
    try {
      duration = estimateMinutes(raw);
      target.setCustomValidity('');
      delete estimateErrors[draftKey];
    } catch (cause) {
      estimateDrafts[draftKey] = raw;
      estimateErrors[draftKey] = String(cause?.message || cause);
      target.setCustomValidity(estimateErrors[draftKey]);
      enhance();
      return false;
    }
    const current = record?.records?.[occurrence]?.subtasks?.find(item => item.id === itemId);
    if (!current) return false;
    const existing = current.estimateMinutes ?? null;
    if (existing === duration) {
      delete estimateDrafts[draftKey];
      delete estimateErrors[draftKey];
      return true;
    }
    try {
      await save(next => mutateRecord(next, occurrence, current.parentTaskId, entry => {
        const item = entry.subtasks.find(candidate => candidate.id === itemId);
        if (!item) return false;
        if (duration === null) delete item.estimateMinutes;
        else item.estimateMinutes = duration;
        return 'keep-empty';
      }), 'Subtask duration updated');
      delete estimateDrafts[draftKey];
      delete estimateErrors[draftKey];
      enhance();
      return true;
    } catch (cause) {
      error = String(cause?.message || cause);
      enhance();
      return false;
    }
  }

  function archiveImportCandidate(next, occurrenceKey, source, reason) {
    next.importArchive.push({
      id: uid(),
      sourceVersion: 22,
      occurrenceKey,
      parentTaskId: String(source.parentTaskId || ''),
      candidateRecord: {
        parentTaskId: String(source.parentTaskId || ''),
        subtasks: clone(source.subtasks || []),
        updatedAt: source.updatedAt || null,
      },
      reason,
      archivedAt: new Date().toISOString(),
    });
  }

  async function verifiedBackupBeforeImport() {
    if (typeof core?.persistRecoveryOnly !== 'function') throw new Error('Device recovery is unavailable. Nothing was imported.');
    core.markUserInteracted?.();
    const verified = await core.persistRecoveryOnly({ v24Subtasks: clone(record) }, 'Before reviewed v22 subtask import');
    if (verified !== true) throw new Error('Recovery backup verification failed. Nothing was imported.');
  }

  async function verifiedBackupBeforeV22Migration(candidate, preview) {
    if (typeof core?.persistRecoveryOnly !== 'function') throw new Error('Device recovery is unavailable. Nothing was migrated.');
    core.markUserInteracted?.();
    const verified = await core.persistRecoveryOnly({
      v22Subtasks: {
        format: 'studyquest-v22-subtasks-recovery-copy',
        sourceKey: String(candidate.sourceKey || ''),
        sourceRevision: Number(candidate.sourceRevision || 0),
        sourceFingerprint: preview.sourceFingerprint,
        subtasks: clone(candidate),
      },
      v24Subtasks: clone(record),
      migrationPreview: {
        sourceVersion: 22,
        sourceFingerprint: preview.sourceFingerprint,
        occurrenceCount: preview.candidateOccurrenceCount,
        subtaskCount: preview.candidateSubtaskCount,
        trashCount: preview.candidateTrashCount,
      },
    }, 'Before v22-to-v24 subtask migration');
    if (verified !== true) throw new Error('Recovery backup verification failed. Nothing was migrated.');
  }

  async function applyV22Migration() {
    const migration = v22Migration;
    const preview = migration.preview;
    if (migration.phase !== 'ready' || !preview?.candidate || v22MigrationBusy) return;
    v22MigrationBusy = true;
    v22Migration = { ...migration, phase: 'applying', message: 'Checking the v22 copy and creating a verified backup…' };
    enhance();
    try {
      if (!ready || !record) throw new Error('v24 subtask storage is not ready.');
      if (error) throw new Error(error);
      if (Number(record.revision) !== Number(preview.baseRevision)) throw new Error('v24 subtasks changed while this migration was being reviewed. Reload and preview the v22 copy again.');
      const latestCandidate = await readV22LocalRecord();
      if (!latestCandidate || latestCandidate.unavailable) throw new Error('The v22 subtask copy is no longer available for a safe migration. Nothing was changed.');
      const latestFingerprint = migrationFingerprint(latestCandidate);
      if (latestFingerprint !== preview.sourceFingerprint) throw new Error('The v22 copy changed while it was being reviewed. Nothing was migrated; reload the preview.');
      await verifiedBackupBeforeV22Migration(latestCandidate, preview);
      v22Migration = { ...v22Migration, candidate: latestCandidate, message: 'Verified backup created. Copying into v24…' };
      enhance();
      await save(next => {
        preview.additions.forEach(({ occurrenceKey, source }) => {
          next.records[occurrenceKey] = clone(source);
        });
        preview.trashAdditions.forEach(source => next.trash.push(clone(source)));
        preview.conflicts.forEach(({ occurrenceKey, source, reason }) => archiveImportCandidate(next, occurrenceKey, source, reason));
        preview.orphans.forEach(({ occurrenceKey, source, reason }) => archiveImportCandidate(next, occurrenceKey, source, reason));
        preview.trashConflicts.forEach(({ source, reason }) => archiveImportCandidate(next, source.occurrenceKey, source, reason));
        next.migrationHistory = [{
          id: `v22-to-v24:${preview.sourceFingerprint}`,
          sourceVersion: 22,
          sourceKey: String(latestCandidate.sourceKey || ''),
          sourceRevision: Number(latestCandidate.sourceRevision || 0),
          sourceFingerprint: preview.sourceFingerprint,
          occurrenceCount: preview.candidateOccurrenceCount,
          subtaskCount: preview.candidateSubtaskCount,
          trashCount: preview.candidateTrashCount,
          outcome: 'applied',
          appliedAt: new Date().toISOString(),
        }, ...(next.migrationHistory || [])].slice(0, 24);
        return 'keep-empty';
      }, 'v22 subtasks copied into v24');
      v22Migration = { phase: 'applied', candidate: latestCandidate, preview, sourceFingerprint: preview.sourceFingerprint, message: 'The v22 copy remains untouched. Future edits should be made in v24.' };
    } catch (cause) {
      v22Migration = { ...migration, phase: 'ready', candidate: migration.candidate, message: String(cause?.message || cause) };
      throw cause;
    } finally {
      v22MigrationBusy = false;
      enhance();
    }
  }

  async function applyV22Import() {
    const preview = importState.preview;
    if (!preview) return;
    if (!ready || !record) throw new Error('v24 subtask storage is not ready.');
    if (error) throw new Error(error);
    if (Number(record.revision) !== Number(preview.baseRevision)) throw new Error('v24 subtasks changed while this import was being reviewed. Reload and preview the file again.');
    await verifiedBackupBeforeImport();
    await save(next => {
      preview.additions.forEach(({ occurrenceKey, source }) => {
        next.records[occurrenceKey] = clone(source);
      });
      preview.trashAdditions.forEach(source => next.trash.push(clone(source)));
      preview.conflicts.forEach(({ occurrenceKey, source, reason }) => archiveImportCandidate(next, occurrenceKey, source, reason));
      preview.orphans.forEach(({ occurrenceKey, source, reason }) => archiveImportCandidate(next, occurrenceKey, source, reason));
      preview.trashConflicts.forEach(({ source, reason }) => archiveImportCandidate(next, source.occurrenceKey, source, reason));
      return 'keep-empty';
    }, 'Reviewed v22 subtasks imported');
    importState = { fileName: '', preview: null, message: '' };
    enhance();
  }

  async function applyV24AccountImport() {
    const store = root.StudyQuestV24SubtaskStore;
    if (!store?.applyLocalImport || !accountImportState.preview) return;
    if (!ready || pending) throw new Error('Account subtask storage is not ready.');
    pending++;
    enhance();
    try {
      record = await store.applyLocalImport(accountImportState.preview);
      error = '';
      accountImportState = { fileName: '', preview: null, message: '' };
      root.showToast?.('✅ Reviewed laptop subtasks added to the account', '#6af7b0');
    } finally {
      pending--;
      enhance();
    }
  }

  function renderRecoveryPanel() {
    const help = byId('v21Help');
    if (!help) return;
    let panel = byId('v24SubtaskRecovery');
    if (!panel) {
      panel = root.document.createElement('section');
      panel.id = 'v24SubtaskRecovery';
      panel.className = 'v24-subtask-recovery';
      help.appendChild(panel);
    }
    const detailsOpen = panel.querySelector('details')?.open === true;
    const trash = record?.trash || [];
    const importArchive = record?.importArchive || [];
    const syncArchive = record?.syncArchive || [];
    const accountStore = root.StudyQuestV24SubtaskStore?.mode === 'account' ? root.StudyQuestV24SubtaskStore : null;
    const localImportPreview = accountImportState.preview;
    const recoveryCopy = root.StudyQuestV24SubtaskStore?.mode === 'shared-local'
      ? 'Subtasks use one shared laptop copy for v22 and v24. Legacy v22/v24 copies remain preserved for recovery; cloud task records are not changed.'
      : root.StudyQuestV24SubtaskStore
      ? 'Subtasks are saved in your signed-in account and a verified device recovery copy. They never change cloud task records or parent-task XP.'
      : 'Subtasks are laptop-only. The existing v24 laptop export includes them; cloud task records are not changed.';
    panel.innerHTML = `<details ${detailsOpen ? 'open' : ''}><summary>Backup &amp; recovery</summary><p>${recoveryCopy}</p><div class="v24-subtask-recovery-actions">${actionButton('reload', 'Reload saved subtasks', '', pending > 0)}${actionButton('export', 'Export v24 subtasks', '', !ready)}</div><div class="v24-subtask-status" ${error ? 'data-error="true"' : ''} role="status">${esc(statusText())}</div>${accountStore ? `<section class="v24-subtask-import v24-subtask-account-import"><h4>Review laptop v24 import</h4><p>Nothing uploads automatically. Review the counts, create a verified recovery copy, then approve an additive account import. Existing account records win conflicts; missing parent tasks are archived.</p><label class="v24-subtask-import-file">Laptop v24 export<input id="v24LocalImportFile" type="file" accept="application/json,.json" ${ready && !pending ? '' : 'disabled'}></label><div class="v24-subtask-import-preview" role="status">${esc(localPreviewText(localImportPreview, accountStore.getLocalCandidate?.()))}${accountImportState.fileName ? ` · ${esc(accountImportState.fileName)}` : ''}</div>${localPreviewPreviewCounts(localImportPreview)}<div class="v24-subtask-recovery-actions">${actionButton('account-import-apply', 'Apply reviewed account import', '', !localImportPreview || pending > 0 || !ready)}${actionButton('account-import-clear', 'Clear import preview', '', !localImportPreview && !accountImportState.message)}</div></section>` : ''}<section class="v24-subtask-import"><h4>Review v22 subtask import</h4><p>Choose a v22 export to preview. Nothing changes until you approve an additive import. Existing v24 records win conflicts, and missing parent tasks are not created.</p><label class="v24-subtask-import-file">v22 subtask export<input id="v24ImportFile" type="file" accept="application/json,.json" ${ready && !pending ? '' : 'disabled'}></label><div class="v24-subtask-import-preview" role="status">${esc(importPreviewText(importState.preview))}${importState.fileName ? ` · ${esc(importState.fileName)}` : ''}</div>${importState.preview ? `<div class="v24-subtask-import-counts">Ready: ${importState.preview.additions.length} · Conflicts archived: ${importState.preview.conflicts.length + importState.preview.trashConflicts.length} · Orphans archived: ${importState.preview.orphans.length} · Trash additions: ${importState.preview.trashAdditions.length}</div>` : ''}<div class="v24-subtask-recovery-actions">${actionButton('import-apply', 'Apply reviewed import', '', !importState.preview || pending > 0 || !ready)}${actionButton('import-clear', 'Clear preview', '', !importState.preview && !importState.message)}</div></section><div class="v24-subtask-trash"><h4>Recoverable subtask trash</h4>${trash.length ? trash.map(item => `<div class="v24-subtask-trash-row"><span>${item.kind === 'parent' ? `Deleted task: ${esc(item.parentTask?.title || item.parentTaskId)}` : `Removed subtask: ${esc(item.subtasks?.[0]?.title || 'Untitled subtask')}`}</span>${actionButton('restore', item.kind === 'parent' ? 'Restore task & subtasks' : 'Restore subtask', `data-v24-trash-id="${esc(item.id)}"`, pending > 0)}</div>`).join('') : '<p>Trash is empty.</p>'}</div><div class="v24-subtask-import-archive"><h4>Archived import candidates</h4>${importArchive.length ? importArchive.map(item => `<div class="v24-subtask-trash-row"><span>${esc(item.occurrenceKey)} · ${esc(item.reason)}</span></div>`).join('') : '<p>No archived import candidates.</p>'}</div><div class="v24-subtask-import-archive"><h4>Account conflict archive</h4>${syncArchive.length ? syncArchive.map(item => `<div class="v24-subtask-trash-row"><span>${esc(item.reason)} · ${esc(item.archivedAt)}</span></div>`).join('') : '<p>No account conflicts archived.</p>'}</div></details>`;
  }

  function localPreviewText(preview, candidate) {
    if (preview) return `${preview.additions.length} occurrence(s) ready · ${preview.conflicts.length} conflict(s) · ${preview.orphans.length} orphan(s)`;
    if (candidate) return 'A laptop copy is available for review. Choose an export or use the saved candidate.';
    return accountImportState.message || 'Choose a v24 export to see a read-only preview.';
  }

  function localPreviewPreviewCounts(preview) {
    if (!preview) return '';
    return `<div class="v24-subtask-import-counts">Ready: ${preview.additions.length} · Conflicts archived: ${preview.conflicts.length} · Orphans archived: ${preview.orphans.length}</div>`;
  }

  function enhance() {
    if (!installed || !root.document || enhancing) return;
    enhancing = true;
    try {
      byId('v24SubtaskProgressPanel')?.remove();
      byId('v24SubtaskHub')?.remove();
      decorateTaskViews();
      renderRecoveryPanel();
    } finally {
      enhancing = false;
    }
  }

  function ensureRecord(next, occurrence, parentTaskId) {
    if (!next.records[occurrence]) next.records[occurrence] = { parentTaskId: String(parentTaskId || ''), subtasks: [], updatedAt: null };
    return next.records[occurrence];
  }

  function mutateRecord(next, occurrence, parentTaskId, mutator) {
    const target = ensureRecord(next, occurrence, parentTaskId);
    const result = mutator(target, next);
    target.subtasks.forEach((item, index) => { item.order = index; item.updatedAt = Date.now(); });
    target.updatedAt = new Date().toISOString();
    if (!target.subtasks.length && result !== 'keep-empty') delete next.records[occurrence];
    return result;
  }

  async function persistRecovery(next) {
    if (typeof core?.persistRecoveryOnly !== 'function') return;
    try {
      core.markUserInteracted?.();
      const verified = await core.persistRecoveryOnly({ v24Subtasks: clone(next) }, 'v24 subtask save');
      if (verified !== true) warning = 'Subtasks are saved in this browser, but the device recovery copy could not be verified. Export subtasks now.';
    } catch (cause) {
      warning = `Subtasks are saved in this browser, but the device recovery copy failed: ${String(cause?.message || cause)}`;
    }
  }

  function save(mutator, label = 'Update v24 subtasks') {
    pending++;
    enhance();
    const run = queue.then(async () => {
      if (!ready || !record) throw new Error(error || 'v24 subtask storage is not ready.');
      if (error) throw new Error(error);
      if (core?.getStatus?.().storageError) throw new Error('Device recovery needs attention before editing subtasks. Export or retry recovery first.');
      const expected = clone(record);
      const next = clone(record);
      const result = mutator(next);
      if (result === false) return false;
      next.revision++;
      next.updatedAt = new Date().toISOString();
      const saved = await writeRecord(expected, next);
      record = saved;
      error = '';
      warning = '';
      channel?.postMessage({ key, revision: record.revision });
      await persistRecovery(record);
      if (label) {
        const storeStatus = root.StudyQuestV24SubtaskStore?.getStatus?.() || null;
        const suffix = !root.StudyQuestV24SubtaskStore
          ? 'saved on this laptop'
          : storeStatus?.kind === 'synced'
            ? 'saved to your account'
            : storeStatus?.kind === 'conflict'
              ? 'saved with a conflict archived for review'
              : storeStatus?.kind === 'offline' || storeStatus?.kind === 'error'
                ? 'saved locally · account retry needed'
                : 'saved locally · account sync pending';
        root.showToast?.(`${storeStatus?.kind === 'synced' ? '✅' : '⚠️'} ${label} ${suffix}`, storeStatus?.kind === 'synced' ? '#6af7b0' : '#f7c06a');
      }
      return true;
    });
    queue = run.catch(() => {});
    return run.catch(cause => {
      error = String(cause?.message || cause);
      throw cause;
    }).finally(() => {
      pending--;
      enhance();
    });
  }

  async function reload() {
    if (pending) return false;
    try {
      record = await readRecord(key);
      ready = true;
      error = '';
      warning = '';
      editState = null;
      estimateDrafts = {};
      estimateErrors = {};
      importState = { fileName: '', preview: null, message: '' };
      accountImportState = { fileName: '', preview: null, message: '' };
      await scanV22Migration();
      enhance();
      return true;
    } catch (cause) {
      ready = false;
      error = String(cause?.message || cause);
      enhance();
      return false;
    }
  }

  async function addFromTaskEditor(task, rawTitle, rawEstimate) {
    const title = String(rawTitle || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title || !task?.id) return false;
    let duration = null;
    try {
      duration = estimateMinutes(rawEstimate);
    } catch (cause) {
      root.showToast?.(`⚠️ ${String(cause?.message || cause)}`, '#f76a6a');
      return false;
    }
    const occurrence = occurrenceKey(task);
    const parentId = String(task.id);
    try {
      await save(next => mutateRecord(next, occurrence, parentId, entry => {
        const item = { id: uid(), title, checked: false, order: entry.subtasks.length, createdAt: Date.now(), updatedAt: Date.now() };
        if (duration !== null) item.estimateMinutes = duration;
        entry.subtasks.push(item);
        return 'keep-empty';
      }), 'First subtask added');
      return true;
    } catch (cause) {
      root.showToast?.(`⚠️ ${String(cause?.message || cause)}`, '#f76a6a');
      return false;
    }
  }

  function exportSubtasks() {
    if (!record || !core?.download) return;
    try {
      core.download({ format: 'studyquest-v24-subtasks', schemaVersion: SCHEMA_VERSION, capturedAt: new Date().toISOString(), subtasks: clone(record) });
    } catch (cause) {
      error = String(cause?.message || cause);
      enhance();
    }
  }

  function beginDeletionWatch(taskId) {
    const tasks = core?.getState?.().tasks || [];
    deletionWatch = {
      requested: String(taskId),
      before: new Map(tasks.map(task => [String(task.id), copyTask(task)])),
    };
  }

  async function archiveDeletedParents() {
    if (!deletionWatch || !ready || pending) return;
    const watch = deletionWatch;
    const currentIds = new Set((core?.getState?.().tasks || []).map(task => String(task.id)));
    if (currentIds.has(watch.requested)) return;
    deletionWatch = null;
    const removed = [...watch.before.entries()].filter(([id]) => !currentIds.has(id)).map(([, task]) => task).filter(Boolean);
    const trees = removed.map(task => ({ task, occurrence: occurrenceKey(task), tree: record?.records?.[occurrenceKey(task)] })).filter(item => item.tree?.subtasks?.length);
    if (!trees.length) return;
    try {
      await save(next => {
        for (const item of trees) {
          if (!next.records[item.occurrence]) continue;
          const already = next.trash.some(entry => entry.kind === 'parent' && entry.occurrenceKey === item.occurrence);
          if (!already) next.trash.push({
            id: uid(),
            kind: 'parent',
            occurrenceKey: item.occurrence,
            parentTaskId: String(item.task.id),
            parentTask: copyTask(item.task),
            subtasks: clone(item.tree.subtasks),
            deletedAt: new Date().toISOString(),
          });
          delete next.records[item.occurrence];
        }
      }, 'Subtasks moved to recoverable trash');
    } catch {
      // save() has already surfaced the verified storage error; the in-memory task deletion is untouched.
    }
  }

  async function restoreTrash(trashId) {
    const entry = record?.trash?.find(item => item.id === trashId);
    if (!entry) return;
    if (entry.kind === 'subtask') {
      await save(next => {
        const target = ensureRecord(next, entry.occurrenceKey, entry.parentTaskId);
        const existing = new Set(target.subtasks.map(item => item.id));
        target.subtasks.push(...entry.subtasks.filter(item => !existing.has(item.id)));
        next.trash = next.trash.filter(item => item.id !== trashId);
        return 'keep-empty';
      }, 'Subtask restored');
      return;
    }
    const parent = entry.parentTask;
    if (!parent) throw new Error('The deleted parent task copy is missing from v24 recovery trash.');
    const current = core?.getState?.();
    const alreadyThere = (current?.tasks || []).some(task => String(task.id) === String(parent.id));
    if (!alreadyThere) {
      const before = clone(current);
      const nextState = clone(current);
      nextState.tasks = [...(nextState.tasks || []), clone(parent)];
      try {
        core.setState(nextState);
        await core.save();
      } catch (cause) {
        core.setState(before);
        throw cause;
      }
    }
    await save(next => {
      const target = ensureRecord(next, entry.occurrenceKey, String(parent.id));
      target.subtasks = clone(entry.subtasks);
      next.trash = next.trash.filter(item => item.id !== trashId);
      return 'keep-empty';
    }, 'Task and subtasks restored');
    root.renderAll?.();
  }

  async function handleClick(event) {
    const target = event.target.closest?.('[data-v24-action]');
    if (!target) return;
    const scope = target.closest('.v24-subtask-host, #v24SubtaskRecovery');
    if (!scope) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.v24Action;
    const occurrence = target.dataset.v24Record;
    const itemId = target.dataset.v24Id;
    if (action === 'check') {
      event.preventDefault();
      event.stopPropagation();
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (action === 'toggle') {
      const nextExpanded = target.getAttribute('aria-expanded') !== 'true';
      rememberExpanded(occurrence, nextExpanded);
      enhance();
      return;
    }
    if (action === 'reload') {
      await reload();
      return;
    }
    if (action === 'export') {
      exportSubtasks();
      return;
    }
    if (action === 'v22-migrate-apply') {
      try {
        await applyV22Migration();
      } catch (cause) {
        error = String(cause?.message || cause);
        enhance();
      }
      return;
    }
    if (action === 'v22-migrate-refresh') {
      await scanV22Migration();
      return;
    }
    if (action === 'title-start') {
      startTitleEdit(occurrence, itemId);
      return;
    }
    if (action === 'import-apply') {
      try {
        await applyV22Import();
      } catch (cause) {
        error = String(cause?.message || cause);
        enhance();
      }
      return;
    }
    if (action === 'import-clear') {
      importState = { fileName: '', preview: null, message: '' };
      enhance();
      return;
    }
    if (action === 'account-import-apply') {
      try {
        await applyV24AccountImport();
      } catch (cause) {
        error = String(cause?.message || cause);
        enhance();
      }
      return;
    }
    if (action === 'account-import-clear') {
      accountImportState = { fileName: '', preview: null, message: '' };
      enhance();
      return;
    }
    if (action === 'move') {
      const direction = Number(target.dataset.v24Direction);
      await save(next => mutateRecord(next, occurrence, target.closest('[data-v24-subtask-host]')?.dataset.v24Parent, (entry) => {
        const ordered = orderedItems(entry);
        const at = ordered.findIndex(item => item.id === itemId);
        const other = ordered[at + direction];
        if (at < 0 || !other) return false;
        [ordered[at], ordered[at + direction]] = [ordered[at + direction], ordered[at]];
        entry.subtasks = ordered;
        return 'keep-empty';
      }), 'Subtask order');
      return;
    }
    if (action === 'remove') {
      if (!root.confirm?.('Move this subtask to recoverable v24 trash?')) return;
      await save(next => mutateRecord(next, occurrence, target.closest('[data-v24-subtask-host]')?.dataset.v24Parent, entry => {
        const at = entry.subtasks.findIndex(item => item.id === itemId);
        if (at < 0) return false;
        const [removed] = entry.subtasks.splice(at, 1);
        next.trash.push({ id: uid(), kind: 'subtask', occurrenceKey: occurrence, parentTaskId: entry.parentTaskId, parentTask: copyTask(currentTask(entry.parentTaskId)), subtasks: [removed], deletedAt: new Date().toISOString() });
        return 'keep-empty';
      }), 'Subtask moved to trash');
      return;
    }
    if (action === 'restore') {
      try { await restoreTrash(target.dataset.v24TrashId); } catch (cause) { error = String(cause?.message || cause); enhance(); }
    }
  }

  async function handleChange(event) {
    const changed = event.target.closest?.('#v24ImportFile');
    if (changed) {
      event.stopPropagation();
      await readV22Import(changed.files?.[0]);
      return;
    }
    const accountImport = event.target.closest?.('#v24LocalImportFile');
    if (accountImport) {
      event.stopPropagation();
      await readV24AccountImport(accountImport.files?.[0]);
      return;
    }
    const estimate = event.target.closest?.('[data-v24-action="estimate-input"]');
    if (estimate) {
      event.stopPropagation();
      await commitEstimateInput(estimate);
      return;
    }
    const target = event.target.closest?.('[data-v24-action="check"]');
    if (!target) return;
    event.stopPropagation();
    const occurrence = target.dataset.v24Record;
    const itemId = target.dataset.v24Id;
    await save(next => mutateRecord(next, occurrence, target.closest('[data-v24-subtask-host]')?.dataset.v24Parent, entry => {
      const item = entry.subtasks.find(candidate => candidate.id === itemId);
      if (!item) return false;
      item.checked = target.checked === true;
      return 'keep-empty';
    }), 'Subtask checkmark');
  }

  function handleInput(event) {
    const target = event.target.closest?.('[data-v24-action="title-input"], [data-v24-action="estimate-input"]');
    if (!target) return;
    if (target.dataset.v24Action === 'title-input') {
      if (editState?.key === target.dataset.v24Record && editState?.id === target.dataset.v24Id) editState.draft = target.value;
      return;
    }
    const draftKey = itemDraftKey(target.dataset.v24Record, target.dataset.v24Id);
    estimateDrafts[draftKey] = target.value;
    delete estimateErrors[draftKey];
    target.setCustomValidity('');
  }

  async function handleFocusout(event) {
    const target = event.target.closest?.('[data-v24-action="title-input"], [data-v24-action="estimate-input"]');
    if (!target) return;
    if (target.dataset.v24Action === 'title-input') await commitTitleInput(target);
    else await commitEstimateInput(target);
  }

  async function handleKeydown(event) {
    const target = event.target.closest?.('[data-v24-action="add-input"], [data-v24-action="title-input"], [data-v24-action="estimate-input"]');
    if (!target) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (target.dataset.v24Action === 'title-input') editState = null;
      if (target.dataset.v24Action === 'estimate-input') {
        const draftKey = itemDraftKey(target.dataset.v24Record, target.dataset.v24Id);
        delete estimateDrafts[draftKey];
        delete estimateErrors[draftKey];
      }
      if (target.dataset.v24Action === 'add-input') target.value = '';
      enhance();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (target.dataset.v24Action === 'title-input') {
      await commitTitleInput(target);
      return;
    }
    if (target.dataset.v24Action === 'estimate-input') {
      await commitEstimateInput(target);
      return;
    }
    const title = String(target.value || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) {
      target.setCustomValidity('Enter a subtask title.');
      target.reportValidity?.();
      return;
    }
    target.setCustomValidity('');
    const occurrence = target.dataset.v24Record;
    const parentId = target.closest('[data-v24-subtask-host]')?.dataset.v24Parent;
    if (target.dataset.v24Action === 'add-input') {
      await save(next => mutateRecord(next, occurrence, parentId, entry => {
        entry.subtasks.push({ id: uid(), title, checked: false, order: entry.subtasks.length, createdAt: Date.now(), updatedAt: Date.now() });
        return 'keep-empty';
      }), 'Subtask added');
      return;
    }
  }

  function wrapRenderer(name) {
    const original = root[name];
    if (typeof original !== 'function' || original.__v24SubtaskWrapper) return;
    const wrapped = function wrappedV24SubtaskRenderer(...args) {
      const result = original.apply(this, args);
      if (name === 'openFocusTask') {
        const taskId = args[0];
        const body = byId('focusTaskBody');
        if (body) {
          body.dataset.v24SubtaskParent = String(taskId || '');
          const source = [...root.document.querySelectorAll('[data-id], [data-v24-subtask-parent]')]
            .find(node => String(node.dataset.id || node.dataset.v24SubtaskParent || '') === String(taskId || ''));
          if (source) {
            body.dataset.v24SubtaskDate = source.dataset.v24SubtaskDate || '';
            body.dataset.v24SubtaskRecurrence = source.dataset.v24SubtaskRecurrence || '';
            body.dataset.v24SubtaskRecurrenceId = source.dataset.v24SubtaskRecurrenceId || '';
          }
        }
      }
      enhance();
      if (name === 'renderAll') queueMicrotask(() => { void archiveDeletedParents(); });
      return result;
    };
    wrapped.__v24SubtaskWrapper = true;
    root[name] = wrapped;
  }

  function wrapDelete() {
    const original = root.deleteTask;
    if (typeof original !== 'function' || original.__v24SubtaskWrapper) return;
    const wrapped = function wrappedV24SubtaskDelete(taskId, ...args) {
      beginDeletionWatch(taskId);
      return original.call(this, taskId, ...args);
    };
    wrapped.__v24SubtaskWrapper = true;
    root.deleteTask = wrapped;
  }

  function install(bridge) {
    if (installed || !root.document || !bridge) return;
    installed = true;
    core = bridge;
    if ((typeof core.persistRecoveryOnly !== 'function' || typeof core.markUserInteracted !== 'function') && root.studyQuestV20Core) {
      core = Object.assign({}, bridge, {
        persistRecoveryOnly: core.persistRecoveryOnly || ((...args) => root.studyQuestV20Core.persistRecoveryOnly?.(...args)),
        markUserInteracted: core.markUserInteracted || (() => root.studyQuestV20Core.markUserInteracted?.()),
      });
    }
    root.StudyQuestSharedSubtasks?.install?.(core);
    key = `${core.storageKey()}:${core.accountKey()}:subtasks:v${SCHEMA_VERSION}`;
    root.StudyQuestV24SubtaskStore?.watch?.(() => {
      if (pending || editState || !key) return;
      Promise.resolve(root.StudyQuestV24SubtaskStore.read(key)).then(stored => {
        const next = normalizeRecord(stored);
        if (JSON.stringify(next) !== JSON.stringify(record)) { record=next; ready=true; error=''; enhance(); }
      }).catch(cause => { error=String(cause.message || cause); enhance(); });
    });
    loadUiPrefs();
    const style = root.document.createElement('style');
    style.textContent = `
      .v24-subtask-host{margin-top:8px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:rgba(124,106,247,.055);min-width:0;max-width:100%;font-size:11px;overflow:hidden}
      .v24-subtask-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.v24-subtask-toggle{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--text);cursor:pointer;padding:2px 0;font:inherit}.v24-subtask-toggle>span:first-child{color:var(--accent);width:12px}.v24-subtask-count{font-family:'Space Mono',monospace;color:var(--accent)}.v24-subtask-independent{color:var(--text-muted);font-size:10px;overflow-wrap:anywhere}.v24-subtask-body{margin-top:6px}.v24-subtask-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}.v24-subtask-row{display:flex;align-items:center;gap:7px;min-width:0;padding:4px 0}.v24-subtask-row>input{width:17px;height:17px;flex:0 0 auto;accent-color:var(--accent);cursor:pointer}.v24-subtask-row.is-checked .v24-subtask-title{text-decoration:line-through;color:var(--text-muted)}.v24-subtask-title-wrap{min-width:0;flex:1}.v24-subtask-title{display:block;width:100%;overflow-wrap:anywhere;line-height:1.45;border:0;background:transparent;color:inherit;text-align:left;cursor:text;padding:0;font:inherit}.v24-subtask-title:disabled{cursor:not-allowed;opacity:.7}.v24-subtask-title:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}.v24-subtask-edit-input{width:100%;min-width:0;box-sizing:border-box}.v24-subtask-estimate{display:inline-flex;align-items:center;gap:3px;position:relative;flex:0 0 auto;white-space:nowrap}.v24-subtask-estimate-error{position:absolute;top:calc(100% + 2px);right:0;color:var(--red,#f76a6a);font-size:9px;line-height:1.25;white-space:normal;z-index:3;width:220px;max-width:60vw;text-align:right}.v24-subtask-row-actions{display:flex;align-items:center;gap:3px;flex:0 0 auto}.v24-subtask-row-actions .btn{min-width:28px;min-height:27px;padding:2px 6px;font-size:10px}.v24-subtask-add{display:flex;align-items:center;gap:5px;margin-top:6px;color:var(--accent)}.v24-subtask-add input{width:100%;min-width:0;box-sizing:border-box;background:transparent;border:1px dashed var(--border);color:var(--text);padding:6px 8px;border-radius:6px}.v24-subtask-empty,.v24-subtask-status{color:var(--text-muted);font-size:10px;line-height:1.5;overflow-wrap:anywhere}.v24-subtask-status[data-error=true],.v24-subtask-recovery .v24-subtask-status[data-error=true]{color:var(--red,#f76a6a)}.v24-subtask-calendar .v24-subtask-independent{display:none}.v24-subtask-calendar{margin-top:5px;padding:6px 7px}.v24-subtask-calendar .v24-subtask-row-actions .btn:nth-child(n+2){display:none}.v24-subtask-progress-panel{margin:18px 0;padding:14px;border:1px solid var(--border);border-radius:12px;min-width:0}.v24-subtask-progress-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}.v24-subtask-progress-heading h3{margin:0 0 4px}.v24-subtask-progress-heading p{margin:0;color:var(--text-muted);font-size:11px;line-height:1.5}.v24-subtask-progress-item{margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:9px;min-width:0}.v24-subtask-progress-task{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}.v24-subtask-progress-task strong{overflow-wrap:anywhere}.v24-subtask-progress-task span{color:var(--text-muted);font-size:10px}.v24-subtask-recovery{margin-top:12px}.v24-subtask-recovery details{padding:10px;border:1px solid var(--border);border-radius:10px}.v24-subtask-recovery summary{cursor:pointer;font-weight:700}.v24-subtask-recovery p{font-size:11px;line-height:1.5;color:var(--text-muted)}.v24-subtask-recovery-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.v24-subtask-import{margin-top:12px;padding:10px;border:1px dashed var(--border);border-radius:10px}.v24-subtask-import h4{margin:0 0 5px;font-size:11px}.v24-subtask-import-file{display:grid;gap:5px;color:var(--text-muted);font-size:10px}.v24-subtask-import-file input{max-width:100%}.v24-subtask-import-preview,.v24-subtask-import-counts{margin-top:7px;font-size:10px;line-height:1.45;color:var(--text-muted);overflow-wrap:anywhere}.v24-subtask-trash{margin-top:10px}.v24-subtask-trash h4{font-size:11px;margin:0 0 6px}.v24-subtask-trash-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding:7px 0;font-size:11px}.v24-subtask-trash-row>span{min-width:0;overflow-wrap:anywhere}.v24-subtask-trash-row .btn{white-space:normal;height:auto;min-height:30px}.v24-subtask-recovery .v24-subtask-status{margin-top:6px}.v24-subtask-host .btn{white-space:normal;height:auto}
      @media(max-width:600px){.v24-subtask-row{align-items:flex-start;flex-wrap:wrap}.v24-subtask-estimate{margin-left:24px}.v24-subtask-row-actions{margin-left:24px}.v24-subtask-progress-heading{display:block}.v24-subtask-progress-heading>.btn{margin-top:8px}.v24-subtask-host{padding:7px}.v24-subtask-independent{flex-basis:100%;margin-left:18px}}
    `;
    style.textContent += `.v24-subtask-hub-shell{padding:18px 0 40px}.v24-subtask-hub-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px}.v24-subtask-eyebrow{font:800 9px/1.2 'Space Mono',monospace;letter-spacing:1.3px;color:var(--accent);margin-bottom:4px}.v24-subtask-hub-heading h2{margin:0 0 5px;font-size:28px}.v24-subtask-hub-heading p{margin:0;color:var(--text-muted);font-size:12px;line-height:1.5;max-width:680px}.v24-subtask-hub-tools{display:flex;gap:10px;align-items:end;flex-wrap:wrap;padding:12px;border:1px solid var(--border);border-radius:12px;background:rgba(124,106,247,.055);margin-bottom:12px}.v24-subtask-hub-tools label{display:grid;gap:4px;color:var(--text-muted);font-size:10px;font-weight:700}.v24-subtask-hub-search{flex:1 1 260px}.v24-subtask-hub-filter{flex:0 1 180px}.v24-subtask-hub-tools input,.v24-subtask-hub-tools select{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface2);color:var(--text);font:inherit}.v24-subtask-hub-summary{color:var(--text-muted);font:700 10px/1.45 'Space Mono',monospace;margin:8px 2px 12px;overflow-wrap:anywhere}.v24-subtask-hub-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px}.v24-subtask-hub-card{min-width:0;border:1px solid var(--border);border-radius:12px;background:rgba(19,22,42,.72);padding:12px}.v24-subtask-hub-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;min-width:0}.v24-subtask-hub-card-head h3{margin:0 0 4px;overflow-wrap:anywhere}.v24-subtask-hub-card-head p{margin:0;color:var(--text-muted);font-size:10px;line-height:1.4}.v24-subtask-hub-card .v24-subtask-host{margin-top:10px}.v24-subtask-hub-card .v24-subtask-independent{display:none}.v24-subtask-hub-card .v24-subtask-head{border-bottom:1px solid rgba(124,106,247,.12);padding-bottom:5px}.v24-subtask-hub-card .v24-subtask-add{margin-top:8px}@media(max-width:600px){.v24-subtask-hub-shell{padding-top:12px}.v24-subtask-hub-heading h2{font-size:23px}.v24-subtask-hub-tools{display:grid;grid-template-columns:1fr}.v24-subtask-hub-filter{max-width:none}.v24-subtask-hub-card{padding:9px}}`;
    style.textContent += `.v24-subtask-migration{margin:0 0 14px;padding:14px;border:1px solid rgba(247,192,106,.55);border-radius:12px;background:rgba(247,192,106,.08);min-width:0}.v24-subtask-migration.is-complete{border-color:rgba(106,247,176,.45);background:rgba(106,247,176,.06)}.v24-subtask-migration.is-error{border-color:rgba(247,106,106,.55);background:rgba(247,106,106,.08)}.v24-subtask-migration-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.v24-subtask-migration h3{margin:0 0 4px;font-size:14px}.v24-subtask-migration p{margin:0;color:var(--text-muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.v24-subtask-migration-badge{font:800 9px/1.2 'Space Mono',monospace;color:#f7c06a;border:1px solid rgba(247,192,106,.55);border-radius:999px;padding:4px 7px;white-space:nowrap}.v24-subtask-migration-counts{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0 7px}.v24-subtask-migration-counts span{border:1px solid var(--border);border-radius:999px;padding:4px 7px;color:var(--text);font:700 10px/1.2 'Space Mono',monospace;overflow-wrap:anywhere}.v24-subtask-migration-note{margin-top:8px!important}.v24-subtask-migration-meta{margin-top:7px;color:var(--text-muted);font-size:10px;line-height:1.4;overflow-wrap:anywhere}.v24-subtask-migration-hint{align-self:center;color:var(--text-muted);font-size:10px;line-height:1.4;overflow-wrap:anywhere}@media(max-width:600px){.v24-subtask-migration{padding:10px}.v24-subtask-migration-counts{display:grid;grid-template-columns:1fr 1fr}.v24-subtask-migration-hint{flex-basis:100%}}`;
    root.document.head.appendChild(style);
    root.document.addEventListener('click', event => { void handleClick(event); }, true);
    root.document.addEventListener('change', event => { void handleChange(event); });
    root.document.addEventListener('input', event => { handleInput(event); });
    root.document.addEventListener('focusout', event => { void handleFocusout(event); });
    root.document.addEventListener('keydown', event => { void handleKeydown(event); });
    ['renderAll', 'renderBins', 'renderCalendar', 'renderUnscheduled', 'renderTodayTaskWidget', 'renderProgress', 'switchTab'].forEach(wrapRenderer);
    wrapRenderer('openFocusTask');
    wrapDelete();
    root.StudyQuestV24AccountSync?.install?.(core);
    try {
      channel = new root.BroadcastChannel('studyquest-subtasks');
      channel.onmessage = event => {
        if (event.data?.key === key && Number(event.data.revision) > Number(record?.revision || 0) && !pending) {
          error = 'Another tab saved newer subtasks. Reload saved subtasks before editing.';
          enhance();
        }
      };
    } catch {}
    enhance();
    void reload();
  }

  async function snapshot() {
    const stored = await readRecord(key);
    const extras = root.StudyQuestV24SubtaskStore?.snapshotExtras
      ? await root.StudyQuestV24SubtaskStore.snapshotExtras()
      : {};
    return { format: 'studyquest-v24-subtasks', schemaVersion: SCHEMA_VERSION, subtasks: stored, ...extras };
  }

  const api = {
    install,
    snapshot,
    reload,
    scanV22Migration,
    migrateV22: applyV22Migration,
    addFromTaskEditor,
    occurrenceKey,
    estimateMinutes,
    parseV22Import,
    validate: normalizeRecord,
    getRecord: () => clone(record),
    getV22Migration: () => clone(v22Migration),
    whenIdle: () => queue,
    DB,
    SCHEMA_VERSION,
  };
  root.StudyQuestV24Subtasks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
