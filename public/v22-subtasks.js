(function installStudyQuestV22Subtasks(root) {
  'use strict';

  const DB = 'studyquest-v22-subtasks';
  const SCHEMA_VERSION = 1;
  const MAX_TITLE_LENGTH = 240;
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const uid = () => root.crypto?.randomUUID?.() || `v22st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  let deletionWatch = null;
  let uiPrefs = { expanded: {} };

  function blank(collectionKey = key) {
    return {
      schemaVersion: SCHEMA_VERSION,
      key: collectionKey,
      revision: 0,
      records: {},
      trash: [],
      updatedAt: null,
    };
  }

  function normalizeSubtask(source, index = 0) {
    const item = source && typeof source === 'object' ? source : {};
    const title = String(item.title || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) throw new Error('A subtask title cannot be empty.');
    return {
      id: typeof item.id === 'string' && item.id ? item.id : uid(),
      title,
      checked: item.checked === true,
      order: Number.isSafeInteger(item.order) ? item.order : index,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
    };
  }

  function normalizeRecord(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.key !== 'string' ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !value.records || typeof value.records !== 'object' || Array.isArray(value.records) ||
        !Array.isArray(value.trash)) {
      throw new Error('Unrecognized v22 subtask data. Export your laptop copy and retry; nothing was replaced.');
    }
    const next = blank(value.key);
    next.revision = value.revision;
    next.updatedAt = value.updatedAt || null;
    const ids = new Set();
    for (const [occurrenceKey, source] of Object.entries(value.records)) {
      if (!source || typeof source !== 'object' || typeof source.parentTaskId !== 'string' || !Array.isArray(source.subtasks)) {
        throw new Error('Invalid v22 subtask record.');
      }
      const subtasks = source.subtasks.map((item, index) => normalizeSubtask(item, index));
      for (const item of subtasks) {
        if (ids.has(item.id)) throw new Error('Duplicate v22 subtask id.');
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
        throw new Error('Invalid v22 subtask recovery item.');
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
    return next;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('v22 subtask storage request failed.'));
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
      const timer = setTimeout(() => fail(new Error('v22 subtask storage did not respond. Close other StudyQuest tabs and retry.')), 8000);
      let request;
      try {
        request = root.indexedDB.open(DB, 1);
      } catch (cause) {
        fail(new Error('Laptop storage is unavailable for v22 subtasks. Your existing tasks are unchanged.'));
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { autoIncrement: true });
      };
      request.onerror = () => fail(request.error || new Error('Laptop storage could not be opened for v22 subtasks.'));
      request.onblocked = () => fail(new Error('v22 subtask storage is blocked by another tab. Close it and retry.'));
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

  async function readRecord(collectionKey) {
    const injected = root.StudyQuestV22SubtaskStore;
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
    const injected = root.StudyQuestV22SubtaskStore;
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
        transaction.onabort = () => reject(reason || transaction.error || new Error('v22 subtask save failed.'));
        transaction.onerror = () => {};
        const currentRequest = workspaces.get(expected.key);
        currentRequest.onsuccess = () => {
          try {
            const current = currentRequest.result || blank(expected.key);
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
        throw new Error('v22 subtask save readback changed. Reload saved subtasks to verify the latest copy.');
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
    const injected = root.StudyQuestV22SubtaskStore;
    if (error) return error;
    if (!ready) return injected ? 'Opening your account subtasks…' : 'Opening laptop-only subtask storage…';
    if (pending) return injected ? 'Saving subtasks…' : 'Saving subtasks on this laptop…';
    if (warning) return warning;
    if (injected && typeof injected.statusText === 'function') return injected.statusText({ ready, pending, record, error, warning });
    return record?.revision ? 'Saved on this laptop · subtasks never change cloud task records.' : 'Subtasks stay on this laptop and do not award separate XP.';
  }

  function storageLabel() {
    return root.StudyQuestV22SubtaskStore ? 'your account' : 'this laptop';
  }

  function actionButton(action, label, attrs = '', disabled = false) {
    return `<button type="button" class="btn btn-ghost btn-sm" data-v22-action="${action}" ${attrs} ${disabled ? 'disabled' : ''}>${label}</button>`;
  }

  function renderSubtaskRow(item, k, total, variant) {
    const editing = editState?.key === k && editState?.id === item.id;
    const position = orderedItems(record?.records?.[k]).findIndex(entry => entry.id === item.id);
    const disabled = !ready || !!error || !!pending;
    return `<li class="v22-subtask-row ${item.checked ? 'is-checked' : ''}" data-v22-subtask-id="${esc(item.id)}">
      <input type="checkbox" data-v22-action="check" data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}" ${item.checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(item.title)} · subtask">
      <div class="v22-subtask-title-wrap">${editing
        ? `<input class="v22-subtask-edit-input" data-v22-action="rename-input" data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}" maxlength="${MAX_TITLE_LENGTH}" value="${esc(item.title)}" aria-label="Rename subtask ${esc(item.title)}">`
        : `<span class="v22-subtask-title" title="${esc(item.title)}">${esc(item.title)}</span>`}</div>
      <div class="v22-subtask-row-actions" role="group" aria-label="Subtask actions">
        ${editing ? actionButton('rename-cancel', 'Cancel', `data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}"`, disabled) : actionButton('rename-start', 'Rename', `data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}"`, disabled)}
        ${editing ? '' : actionButton('move', '↑', `data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}" data-v22-direction="-1" aria-label="Move subtask up"`, disabled || position <= 0)}
        ${editing ? '' : actionButton('move', '↓', `data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}" data-v22-direction="1" aria-label="Move subtask down"`, disabled || position < 0 || position >= total - 1)}
        ${editing ? '' : actionButton('remove', '×', `data-v22-record="${esc(k)}" data-v22-id="${esc(item.id)}" aria-label="Move subtask to trash"`, disabled)}
      </div>
    </li>`;
  }

  function renderSubtaskHost(task, variant = 'inline') {
    const k = occurrenceKey(task);
    const stored = taskRecord(task);
    const items = orderedItems(stored);
    if (!items.length) return '';
    const done = items.filter(item => item.checked).length;
    const expanded = expandedFor(k, variant);
    const panelId = `v22-subtask-panel-${hashKey(k)}`;
    const disabled = !ready || !!error || !!pending;
    const listMarkup = `<ul class="v22-subtask-list" aria-label="Subtasks for ${esc(task.title || 'task')}">${items.map(item => renderSubtaskRow(item, k, items.length, variant)).join('')}</ul>`;
    return `<section class="v22-subtask-host v22-subtask-${variant}" data-v22-subtask-host data-v22-record="${esc(k)}" data-v22-parent="${esc(task.id)}">
      <div class="v22-subtask-head">
        <button type="button" class="v22-subtask-toggle" data-v22-action="toggle" data-v22-record="${esc(k)}" aria-expanded="${expanded}" aria-controls="${panelId}">
          <span aria-hidden="true">${expanded ? '▾' : '▸'}</span><strong>Subtasks</strong><span class="v22-subtask-count">${done}/${items.length}</span>
        </button>
        <span class="v22-subtask-independent">Independent from task completion</span>
      </div>
      <div id="${panelId}" class="v22-subtask-body" ${expanded ? '' : 'hidden'}>
        ${error ? `<div class="v22-subtask-status" data-error="true" role="alert">${esc(error)} ${actionButton('reload', 'Reload saved subtasks')}</div>` : ready ? listMarkup : `<div class="v22-subtask-status" role="status">Opening ${storageLabel()} subtasks…</div>`}
        ${ready && !error ? `<div class="v22-subtask-add"><span aria-hidden="true">＋</span><input type="text" data-v22-action="add-input" data-v22-record="${esc(k)}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Add subtask · press Enter" aria-label="Add subtask for ${esc(task.title || 'task')}" ${disabled ? 'disabled' : ''}></div>` : ''}
      </div>
    </section>`;
  }

  function mountHost(target, task, variant) {
    if (!target || !task) return;
    let host = Array.from(target.children).find(child => child.matches?.('.v22-subtask-host'));
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
    if (!data.v22SubtaskDate && !data.v22SubtaskRecurrence && !data.v22SubtaskRecurrenceId) return task;
    return {
      ...task,
      date: data.v22SubtaskDate || task.date || '',
      recurrence: data.v22SubtaskRecurrence || task.recurrence || 'none',
      recurrenceId: data.v22SubtaskRecurrenceId || task.recurrenceId || '',
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
   root.document.querySelectorAll('[data-v22-subtask-parent]').forEach(block => {
      if (block.id === 'focusTaskBody') return;
      const task = taskById.get(String(block.dataset.v22SubtaskParent));
      const target = block.children?.[1] || block;
     mountHost(target, taskForView(task, block), block.classList.contains('calendar-task-block') ? 'calendar' : 'today');
   });
    const focusBody = byId('focusTaskBody');
    const focusTask = focusBody?.dataset.v22SubtaskParent ? taskForView(taskById.get(String(focusBody.dataset.v22SubtaskParent)), focusBody) : null;
    if (focusBody && focusTask) mountHost(focusBody, focusTask, 'focus');
  }

  function renderProgressPanel() {
    const tab = byId('tab-progress');
    if (!tab) return;
    let panel = byId('v22SubtaskProgressPanel');
    if (!panel) {
      panel = root.document.createElement('section');
      panel.id = 'v22SubtaskProgressPanel';
      panel.className = 'v22-subtask-progress-panel';
      tab.appendChild(panel);
    }
    const tasks = (core?.getState?.().tasks || []).filter(task => {
      const items = taskRecord(task).subtasks || [];
      return items.length > 0;
    });
    panel.innerHTML = `<div class="v22-subtask-progress-heading"><div><h3>Task subtasks</h3><p>Checklist progress is shown here without changing parent completion or XP.</p></div>${actionButton('export', 'Export subtasks')}</div>${tasks.length ? tasks.map(task => `<article class="v22-subtask-progress-item"><div class="v22-subtask-progress-task"><strong>${esc(task.title || 'Untitled task')}</strong><span>${esc(task.date || 'No deadline')}</span></div>${renderSubtaskHost(task, 'progress')}</article>`).join('') : '<div class="v22-subtask-empty">No task subtasks yet. Add them from any task in Today, Calendar, Focus, or the no-deadline list.</div>'}`;
  }

  function renderRecoveryPanel() {
    const help = byId('v21Help');
    if (!help) return;
    let panel = byId('v22SubtaskRecovery');
    if (!panel) {
      panel = root.document.createElement('section');
      panel.id = 'v22SubtaskRecovery';
      panel.className = 'v22-subtask-recovery';
      help.appendChild(panel);
    }
    const detailsOpen = panel.querySelector('details')?.open === true;
    const trash = record?.trash || [];
    const recoveryCopy = root.StudyQuestV22SubtaskStore
      ? 'Subtasks are saved in your signed-in account and a verified device recovery copy. They never change cloud task records or parent-task XP.'
      : 'Subtasks are laptop-only. The existing v22 laptop export includes them; cloud task records are not changed.';
    panel.innerHTML = `<details ${detailsOpen ? 'open' : ''}><summary>Subtask backup &amp; recovery</summary><p>${recoveryCopy}</p><div class="v22-subtask-recovery-actions">${actionButton('reload', 'Reload saved subtasks', '', pending > 0)}${actionButton('export', 'Export subtasks', '', !ready)}</div><div class="v22-subtask-status" ${error ? 'data-error="true"' : ''} role="status">${esc(statusText())}</div><div class="v22-subtask-trash"><h4>Recoverable subtask trash</h4>${trash.length ? trash.map(item => `<div class="v22-subtask-trash-row"><span>${item.kind === 'parent' ? `Deleted task: ${esc(item.parentTask?.title || item.parentTaskId)}` : `Removed subtask: ${esc(item.subtasks?.[0]?.title || 'Untitled subtask')}`}</span>${actionButton('restore', item.kind === 'parent' ? 'Restore task & subtasks' : 'Restore subtask', `data-v22-trash-id="${esc(item.id)}"`, pending > 0)}</div>`).join('') : '<p>Trash is empty.</p>'}</div></details>`;
  }

  function enhance() {
    if (!installed || !root.document || enhancing) return;
    enhancing = true;
    try {
      decorateTaskViews();
      renderProgressPanel();
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
      const verified = await core.persistRecoveryOnly({ v22Subtasks: clone(next) }, 'v22 subtask save');
      if (verified !== true) warning = 'Subtasks are saved in this browser, but the device recovery copy could not be verified. Export subtasks now.';
    } catch (cause) {
      warning = `Subtasks are saved in this browser, but the device recovery copy failed: ${String(cause?.message || cause)}`;
    }
  }

  function save(mutator, label = 'Update v22 subtasks') {
    pending++;
    enhance();
    const run = queue.then(async () => {
      if (!ready || !record) throw new Error(error || 'v22 subtask storage is not ready.');
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
      if (label) root.showToast?.(`✅ ${label} ${root.StudyQuestV22SubtaskStore ? 'saved to your account' : 'saved on this laptop'}`, '#6af7b0');
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
      enhance();
      return true;
    } catch (cause) {
      ready = false;
      error = String(cause?.message || cause);
      enhance();
      return false;
    }
  }

  async function addFromTaskEditor(task, rawTitle) {
    const title = String(rawTitle || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title || !task?.id) return false;
    const occurrence = occurrenceKey(task);
    const parentId = String(task.id);
    try {
      await save(next => mutateRecord(next, occurrence, parentId, entry => {
        entry.subtasks.push({ id: uid(), title, checked: false, order: entry.subtasks.length, createdAt: Date.now(), updatedAt: Date.now() });
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
      core.download({ format: 'studyquest-v22-subtasks', schemaVersion: SCHEMA_VERSION, capturedAt: new Date().toISOString(), subtasks: clone(record) });
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
    if (!parent) throw new Error('The deleted parent task copy is missing from v22 recovery trash.');
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
    const target = event.target.closest?.('[data-v22-action]');
    if (!target) return;
    const scope = target.closest('.v22-subtask-host, #v22SubtaskRecovery, #v22SubtaskProgressPanel');
    if (!scope) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.v22Action;
    const occurrence = target.dataset.v22Record;
    const itemId = target.dataset.v22Id;
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
    if (action === 'rename-start') {
      editState = { key: occurrence, id: itemId };
      enhance();
      setTimeout(() => {
        const escapeSelector = value => root.CSS?.escape ? root.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, character => '\\' + character);
        root.document.querySelector('[data-v22-action="rename-input"][data-v22-record="' + escapeSelector(occurrence) + '"][data-v22-id="' + escapeSelector(itemId) + '"]')?.focus();
      }, 0);
      return;
    }
    if (action === 'rename-cancel') {
      editState = null;
      enhance();
      return;
    }
    if (action === 'move') {
      const direction = Number(target.dataset.v22Direction);
      await save(next => mutateRecord(next, occurrence, target.closest('[data-v22-subtask-host]')?.dataset.v22Parent, (entry) => {
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
      if (!root.confirm?.('Move this subtask to recoverable v22 trash?')) return;
      await save(next => mutateRecord(next, occurrence, target.closest('[data-v22-subtask-host]')?.dataset.v22Parent, entry => {
        const at = entry.subtasks.findIndex(item => item.id === itemId);
        if (at < 0) return false;
        const [removed] = entry.subtasks.splice(at, 1);
        next.trash.push({ id: uid(), kind: 'subtask', occurrenceKey: occurrence, parentTaskId: entry.parentTaskId, parentTask: copyTask(currentTask(entry.parentTaskId)), subtasks: [removed], deletedAt: new Date().toISOString() });
        return 'keep-empty';
      }), 'Subtask moved to trash');
      return;
    }
    if (action === 'restore') {
      try { await restoreTrash(target.dataset.v22TrashId); } catch (cause) { error = String(cause?.message || cause); enhance(); }
    }
  }

  async function handleChange(event) {
    const target = event.target.closest?.('[data-v22-action="check"]');
    if (!target) return;
    event.stopPropagation();
    const occurrence = target.dataset.v22Record;
    const itemId = target.dataset.v22Id;
    await save(next => mutateRecord(next, occurrence, target.closest('[data-v22-subtask-host]')?.dataset.v22Parent, entry => {
      const item = entry.subtasks.find(candidate => candidate.id === itemId);
      if (!item) return false;
      item.checked = target.checked === true;
      return 'keep-empty';
    }), 'Subtask checkmark');
  }

  async function handleKeydown(event) {
    const target = event.target.closest?.('[data-v22-action="add-input"], [data-v22-action="rename-input"]');
    if (!target) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (target.dataset.v22Action === 'rename-input') editState = null;
      target.value = '';
      enhance();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const title = String(target.value || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) {
      target.setCustomValidity('Enter a subtask title.');
      target.reportValidity?.();
      return;
    }
    target.setCustomValidity('');
    const occurrence = target.dataset.v22Record;
    const parentId = target.closest('[data-v22-subtask-host]')?.dataset.v22Parent;
    if (target.dataset.v22Action === 'add-input') {
      await save(next => mutateRecord(next, occurrence, parentId, entry => {
        entry.subtasks.push({ id: uid(), title, checked: false, order: entry.subtasks.length, createdAt: Date.now(), updatedAt: Date.now() });
        return 'keep-empty';
      }), 'Subtask added');
      return;
    }
    const itemId = target.dataset.v22Id;
    await save(next => mutateRecord(next, occurrence, parentId, entry => {
      const item = entry.subtasks.find(candidate => candidate.id === itemId);
      if (!item) return false;
      item.title = title;
      return 'keep-empty';
    }), 'Subtask renamed');
    editState = null;
    enhance();
  }

  function wrapRenderer(name) {
    const original = root[name];
    if (typeof original !== 'function' || original.__v22SubtaskWrapper) return;
    const wrapped = function wrappedV22SubtaskRenderer(...args) {
      const result = original.apply(this, args);
      if (name === 'openFocusTask') {
        const taskId = args[0];
        const body = byId('focusTaskBody');
        if (body) {
          body.dataset.v22SubtaskParent = String(taskId || '');
          const source = [...root.document.querySelectorAll('[data-id], [data-v22-subtask-parent]')]
            .find(node => String(node.dataset.id || node.dataset.v22SubtaskParent || '') === String(taskId || ''));
          if (source) {
            body.dataset.v22SubtaskDate = source.dataset.v22SubtaskDate || '';
            body.dataset.v22SubtaskRecurrence = source.dataset.v22SubtaskRecurrence || '';
            body.dataset.v22SubtaskRecurrenceId = source.dataset.v22SubtaskRecurrenceId || '';
          }
        }
      }
      enhance();
      if (name === 'renderAll') queueMicrotask(() => { void archiveDeletedParents(); });
      return result;
    };
    wrapped.__v22SubtaskWrapper = true;
    root[name] = wrapped;
  }

  function wrapDelete() {
    const original = root.deleteTask;
    if (typeof original !== 'function' || original.__v22SubtaskWrapper) return;
    const wrapped = function wrappedV22SubtaskDelete(taskId, ...args) {
      beginDeletionWatch(taskId);
      return original.call(this, taskId, ...args);
    };
    wrapped.__v22SubtaskWrapper = true;
    root.deleteTask = wrapped;
  }

  function install(bridge) {
    if (installed || !root.document || !bridge) return;
    installed = true;
    core = bridge;
    key = `${core.storageKey()}:${core.accountKey()}:v22-subtasks:v${SCHEMA_VERSION}`;
    loadUiPrefs();
    const style = root.document.createElement('style');
    style.textContent = `
      .v22-subtask-host{margin-top:8px;padding:8px 10px;border:1px solid var(--border);border-radius:9px;background:rgba(124,106,247,.055);min-width:0;max-width:100%;font-size:11px;overflow:hidden}
      .v22-subtask-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.v22-subtask-toggle{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--text);cursor:pointer;padding:2px 0;font:inherit}.v22-subtask-toggle>span:first-child{color:var(--accent);width:12px}.v22-subtask-count{font-family:'Space Mono',monospace;color:var(--accent)}.v22-subtask-independent{color:var(--text-muted);font-size:10px;overflow-wrap:anywhere}.v22-subtask-body{margin-top:6px}.v22-subtask-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}.v22-subtask-row{display:flex;align-items:center;gap:7px;min-width:0;padding:4px 0}.v22-subtask-row>input{width:17px;height:17px;flex:0 0 auto;accent-color:var(--accent);cursor:pointer}.v22-subtask-row.is-checked .v22-subtask-title{text-decoration:line-through;color:var(--text-muted)}.v22-subtask-title-wrap{min-width:0;flex:1}.v22-subtask-title{display:block;overflow-wrap:anywhere;line-height:1.45}.v22-subtask-edit-input{width:100%;min-width:0;box-sizing:border-box}.v22-subtask-row-actions{display:flex;align-items:center;gap:3px;flex:0 0 auto}.v22-subtask-row-actions .btn{min-width:28px;min-height:27px;padding:2px 6px;font-size:10px}.v22-subtask-add{display:flex;align-items:center;gap:5px;margin-top:6px;color:var(--accent)}.v22-subtask-add input{width:100%;min-width:0;box-sizing:border-box;background:transparent;border:1px dashed var(--border);color:var(--text);padding:6px 8px;border-radius:6px}.v22-subtask-empty,.v22-subtask-status{color:var(--text-muted);font-size:10px;line-height:1.5;overflow-wrap:anywhere}.v22-subtask-status[data-error=true],.v22-subtask-recovery .v22-subtask-status[data-error=true]{color:var(--red,#f76a6a)}.v22-subtask-calendar .v22-subtask-independent{display:none}.v22-subtask-calendar{margin-top:5px;padding:6px 7px}.v22-subtask-calendar .v22-subtask-row-actions .btn:nth-child(n+2){display:none}.v22-subtask-progress-panel{margin:18px 0;padding:14px;border:1px solid var(--border);border-radius:12px;min-width:0}.v22-subtask-progress-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}.v22-subtask-progress-heading h3{margin:0 0 4px}.v22-subtask-progress-heading p{margin:0;color:var(--text-muted);font-size:11px;line-height:1.5}.v22-subtask-progress-item{margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:9px;min-width:0}.v22-subtask-progress-task{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}.v22-subtask-progress-task strong{overflow-wrap:anywhere}.v22-subtask-progress-task span{color:var(--text-muted);font-size:10px}.v22-subtask-recovery{margin-top:12px}.v22-subtask-recovery details{padding:10px;border:1px solid var(--border);border-radius:10px}.v22-subtask-recovery summary{cursor:pointer;font-weight:700}.v22-subtask-recovery p{font-size:11px;line-height:1.5;color:var(--text-muted)}.v22-subtask-recovery-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.v22-subtask-trash{margin-top:10px}.v22-subtask-trash h4{font-size:11px;margin:0 0 6px}.v22-subtask-trash-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding:7px 0;font-size:11px}.v22-subtask-trash-row>span{min-width:0;overflow-wrap:anywhere}.v22-subtask-trash-row .btn{white-space:normal;height:auto;min-height:30px}.v22-subtask-recovery .v22-subtask-status{margin-top:6px}.v22-subtask-host .btn{white-space:normal;height:auto}
      @media(max-width:600px){.v22-subtask-row{align-items:flex-start;flex-wrap:wrap}.v22-subtask-row-actions{margin-left:24px}.v22-subtask-progress-heading{display:block}.v22-subtask-progress-heading>.btn{margin-top:8px}.v22-subtask-host{padding:7px}.v22-subtask-independent{flex-basis:100%;margin-left:18px}}
    `;
    root.document.head.appendChild(style);
    root.document.addEventListener('click', event => { void handleClick(event); }, true);
    root.document.addEventListener('change', event => { void handleChange(event); });
    root.document.addEventListener('keydown', event => { void handleKeydown(event); });
    ['renderAll', 'renderBins', 'renderCalendar', 'renderUnscheduled', 'renderTodayTaskWidget', 'renderProgress', 'switchTab'].forEach(wrapRenderer);
    wrapRenderer('openFocusTask');
    wrapDelete();
    try {
      channel = new root.BroadcastChannel('studyquest-v22-subtasks');
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
    return { format: 'studyquest-v22-subtasks', schemaVersion: SCHEMA_VERSION, subtasks: stored };
  }

  const api = {
    install,
    snapshot,
    reload,
    addFromTaskEditor,
    occurrenceKey,
    validate: normalizeRecord,
    getRecord: () => clone(record),
    whenIdle: () => queue,
    DB,
    SCHEMA_VERSION,
  };
  root.StudyQuestV22Subtasks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
