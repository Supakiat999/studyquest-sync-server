(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_SUFFIX = '_studyquest_device_date_shifts_v1';
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const EFFECTIVE_MARKER = '__studyquestDeviceDateShiftEffective';

  let installed = false;
  let snapshot = emptySnapshot();
  let originals = {};
  let staleIds = new Set();
  let pruneScheduled = false;
  let decorateScheduled = false;
  let storageBlocked = false;
  let channel = null;

  function isDateKey(value) {
    if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }

  function normalizeDate(value) {
    return isDateKey(value) ? value : '';
  }

  function normalizeEndDate(value, startDate) {
    const end = normalizeDate(value);
    return end && startDate && end >= startDate ? end : '';
  }

  function normalizeStoredEndDate(value, startDate) {
    if (value === undefined || value === null || value === '') return '';
    const end = normalizeDate(value);
    return end && startDate && end >= startDate ? end : null;
  }

  function addDays(value, amount) {
    const key = normalizeDate(value);
    const delta = Number(amount);
    if (!key || !Number.isInteger(delta)) return '';
    const [year, month, day] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  }

  function sameDate(a, b) {
    return normalizeDate(a) === normalizeDate(b);
  }

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  }

  function emptySnapshot() {
    return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: 0, overrides: {} };
  }

  function normalizeRecord(taskId, raw) {
    if (!taskId || !raw || typeof raw !== 'object') return null;
    const baseDate = normalizeDate(raw.baseDate);
    const baseEndDate = normalizeStoredEndDate(raw.baseEndDate, baseDate);
    const date = normalizeDate(raw.date);
    const endDate = normalizeStoredEndDate(raw.endDate, date);
    if (!baseDate || !date) return null;
    if (baseEndDate === null || endDate === null || date < '0001-01-01') return null;
    return {
      baseDate,
      baseEndDate,
      date,
      endDate,
      shiftedAt: Number.isFinite(Number(raw.shiftedAt)) ? Number(raw.shiftedAt) : 0,
    };
  }

  function normalizeSnapshot(raw) {
    let source = raw;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch { source = null; }
    }
    const result = emptySnapshot();
    if (!source || typeof source !== 'object') return result;
    const overrides = source.overrides && typeof source.overrides === 'object' ? source.overrides : {};
    Object.entries(overrides).forEach(([taskId, record]) => {
      const normalized = normalizeRecord(String(taskId), record);
      if (normalized) result.overrides[String(taskId)] = normalized;
    });
    const revision = Number(source.revision);
    const updatedAt = Number(source.updatedAt);
    result.revision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    result.updatedAt = Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0;
    return result;
  }

  function activeStorageKey() {
    const configured = String(root.__STUDYQUEST_ACTIVE_STORAGE_KEY__ || '').trim();
    return configured || 'studyquest_v3';
  }

  function storageKey() {
    return `${activeStorageKey()}${STORAGE_SUFFIX}`;
  }

  function getStorage() {
    try {
      const storage = root.localStorage;
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null;
      return storage;
    } catch {
      return null;
    }
  }

  function readSnapshot() {
    const storage = getStorage();
    if (!storage) {
      storageBlocked = true;
      return emptySnapshot();
    }
    try {
      const raw = storage.getItem(storageKey());
      storageBlocked = false;
      return normalizeSnapshot(raw);
    } catch {
      storageBlocked = true;
      return emptySnapshot();
    }
  }

  function emitChanged() {
    try {
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('studyquest-device-date-shifts', { detail: { key: storageKey() } }));
      }
    } catch {}
    try {
      channel?.postMessage({ key: storageKey(), revision: snapshot.revision });
    } catch {}
  }

  function writeSnapshot(next, { notify = true } = {}) {
    const normalized = normalizeSnapshot(next);
    normalized.revision = Math.max(snapshot.revision + 1, normalized.revision + 1);
    normalized.updatedAt = Date.now();
    const storage = getStorage();
    if (!storage) {
      storageBlocked = true;
      return { ok: false, reason: 'storage-unavailable' };
    }
    try {
      storage.setItem(storageKey(), JSON.stringify(normalized));
      storageBlocked = false;
      snapshot = normalized;
      if (notify) emitChanged();
      return { ok: true, snapshot: clone(snapshot) };
    } catch (error) {
      storageBlocked = true;
      return { ok: false, reason: 'storage-write-failed', error };
    }
  }

  function getState() {
    try {
      if (root.SQ_State && typeof root.SQ_State === 'object') return root.SQ_State;
    } catch {}
    try {
      if (root.state && typeof root.state === 'object') return root.state;
    } catch {}
    return null;
  }

  function taskIdOf(taskOrId) {
    const raw = taskOrId && typeof taskOrId === 'object' ? taskOrId.id : taskOrId;
    const id = String(raw ?? '').trim();
    return id || '';
  }

  function findTask(taskOrId) {
    const id = taskIdOf(taskOrId);
    if (!id) return null;
    return (getState()?.tasks || []).find(task => String(task?.id) === id) || null;
  }

  function isSuppressed(task) {
    try {
      return typeof root.StudyQuestV18?.isSuppressedTask === 'function' && root.StudyQuestV18.isSuppressedTask(task) === true;
    } catch {
      return false;
    }
  }

  function recordMatchesTask(record, task) {
    if (!record || !task) return false;
    const taskDate = normalizeDate(task.date);
    const taskEndDate = normalizeEndDate(task.endDate, taskDate);
    return sameDate(record.baseDate, taskDate) && sameDate(record.baseEndDate, taskEndDate);
  }

  function schedulePrune() {
    if (pruneScheduled) return;
    pruneScheduled = true;
    const run = () => {
      pruneScheduled = false;
      pruneStaleRecords();
    };
    if (typeof root.queueMicrotask === 'function') root.queueMicrotask(run);
    else if (typeof root.setTimeout === 'function') root.setTimeout(run, 0);
    else run();
  }

  function pruneStaleRecords() {
    const current = readSnapshot();
    let changed = false;
    Object.keys(current.overrides).forEach(id => {
      const task = findTask(id);
      const record = current.overrides[id];
      if (!task || !normalizeDate(task.date) || isSuppressed(task) || !recordMatchesTask(record, task)) {
        delete current.overrides[id];
        changed = true;
      }
    });
    staleIds.clear();
    if (changed) writeSnapshot(current, { notify: false });
    else snapshot = current;
    return changed;
  }

  function getRecord(taskOrId) {
    const id = taskIdOf(taskOrId);
    if (!id) return null;
    const record = snapshot.overrides[id];
    if (!record) return null;
    const task = findTask(id);
    if (!task || !recordMatchesTask(record, task)) {
      staleIds.add(id);
      schedulePrune();
      return null;
    }
    return record;
  }

  function markEffective(task) {
    try { Object.defineProperty(task, EFFECTIVE_MARKER, { value: true, enumerable: false }); } catch {}
    return task;
  }

  function getEffectiveTask(task) {
    if (!task || typeof task !== 'object') return task;
    if (task[EFFECTIVE_MARKER]) return task;
    const record = getRecord(task);
    if (!record) return task;
    return markEffective({ ...task, date: record.date, endDate: record.endDate });
  }

  function hasOverride(taskOrId) {
    return !!getRecord(taskOrId);
  }

  function dateRangeForTask(task) {
    const effective = getEffectiveTask(task);
    const start = normalizeDate(effective?.date);
    const end = normalizeEndDate(effective?.endDate, start);
    return { start, end };
  }

  function fallbackTaskDateCovers(task, dateStr) {
    if (!isDateKey(dateStr)) return false;
    const { start, end } = dateRangeForTask(task);
    return !!start && dateStr >= start && dateStr <= (end || start);
  }

  function taskDateCovers(task, dateStr) {
    const effective = getEffectiveTask(task);
    if (typeof originals.taskDateCovers === 'function') {
      try { return !!originals.taskDateCovers.call(root, effective, dateStr); } catch {}
    }
    return fallbackTaskDateCovers(effective, dateStr);
  }

  function dateLabel(dateStr) {
    if (!isDateKey(dateStr)) return 'No date';
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      }).format(new Date(Date.UTC(year, month - 1, day)));
    } catch {
      return dateStr;
    }
  }

  function rangeLabel(start, end = '') {
    return end && end !== start ? `${dateLabel(start)} – ${dateLabel(end)}` : dateLabel(start);
  }

  function compactDateLabel(dateStr) {
    if (!isDateKey(dateStr)) return 'No date';
    const [year, month, day] = dateStr.split('-').map(Number);
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC', month: 'short', day: 'numeric',
      }).format(new Date(Date.UTC(year, month - 1, day)));
    } catch {
      return dateStr;
    }
  }

  function compactRangeLabel(start, end = '') {
    if (!isDateKey(start)) return 'No date';
    if (!end || end === start) return compactDateLabel(start);
    const [startYear, startMonth, startDay] = start.split('-').map(Number);
    const [endYear, endMonth, endDay] = end.split('-').map(Number);
    if (startYear === endYear && startMonth === endMonth) {
      return `${compactDateLabel(start).replace(` ${startDay}`, '')} ${startDay}–${endDay}`;
    }
    return `${compactDateLabel(start)}–${compactDateLabel(end)}`;
  }

  function destinationFor(task, delta) {
    const effective = getEffectiveTask(task);
    const start = addDays(effective?.date, delta);
    const end = effective?.endDate ? addDays(effective.endDate, delta) : '';
    return { start, end, label: rangeLabel(start, end) };
  }

  function showToast(message, color) {
    try {
      if (typeof root.showToast === 'function') root.showToast(message, color);
    } catch {}
  }

  function rerender() {
    try {
      if (typeof root.renderAll === 'function') root.renderAll();
      else scheduleDecorate();
    } catch {
      scheduleDecorate();
    }
  }

  async function saveCanonicalState() {
    try {
      if (typeof root.saveState !== 'function') return { ok: false, reason: 'save-unavailable' };
      const bridge = root.studyQuestV21Core;
      if (!bridge || root.document?.documentElement.classList.contains('studyquest-account-loading')) return { ok:false, reason:'account-loading' };
      await bridge.save();
      const pending = bridge.hostedSync?.();
      if (pending?.cloudMode && !pending.acknowledged) {
        try { await bridge.retryUpload?.(); } catch {}
      }
      return { ok:true, acknowledged:bridge.hostedSync?.().acknowledged === true };
    } catch (error) {
      return { ok: false, reason: 'save-failed', error };
    }
  }

  function canonicalDatesPersisted(changes) {
    const storage = getStorage();
    if (!storage || !Array.isArray(changes) || changes.length === 0) return false;
    try {
      const raw = storage.getItem(activeStorageKey());
      const saved = raw ? JSON.parse(raw) : null;
      const tasks = Array.isArray(saved?.tasks) ? saved.tasks : [];
      return changes.every(change => {
        const task = tasks.find(item => String(item?.id) === String(change.id));
        return task
          && normalizeDate(task.date) === change.date
          && normalizeEndDate(task.endDate, task.date) === change.endDate;
      });
    } catch {
      return false;
    }
  }

  function clearOverrides(ids, { notify = false } = {}) {
    const clearIds = new Set((ids || []).map(taskIdOf).filter(Boolean));
    if (!clearIds.size) return { ok: true, unchanged: true };
    snapshot = readSnapshot();
    const nextOverrides = { ...snapshot.overrides };
    let changed = false;
    clearIds.forEach(id => {
      if (nextOverrides[id]) {
        delete nextOverrides[id];
        changed = true;
      }
    });
    if (!changed) return { ok: true, unchanged: true };
    const result = writeSnapshot({ ...snapshot, overrides: nextOverrides }, { notify });
    if (!result.ok) return result;
    return { ok: true, snapshot: result.snapshot };
  }

  async function migrateLegacyOverridesToCanonical() {
    snapshot = readSnapshot();
    if (Object.keys(snapshot.overrides).length) {
      const preview = Object.entries(snapshot.overrides).map(([id, value]) => ({ id, current:findTask(id)?.date, proposed:value.date }));
      root.studyQuestV21Core?.download?.({ format:'studyquest-v24-date-import-preview', legacy:snapshot, preview });
      if (!root.confirm('Review the downloaded date comparison. Apply these legacy date moves to this account? Existing recovery copies will be kept.')) return { ok:false, reason:'cancelled', migrated:0 };
      const backedUp = await root.studyQuestV20Core?.persistRecoveryOnly?.({ state:root.SQ_State, legacyDateMoves:snapshot }, 'Before reviewed v24 date import');
      if (backedUp !== true) return { ok:false, reason:'backup-unverified', migrated:0 };
    }
    const changes = [];
    const migratedIds = [];
    Object.entries(snapshot.overrides).forEach(([id, record]) => {
      const task = findTask(id);
      if (!task || !normalizeDate(task.date) || !recordMatchesTask(record, task)) return;
      const nextDate = normalizeDate(record.date);
      const nextEndDate = normalizeEndDate(record.endDate, nextDate);
      if (!nextDate) return;
      migratedIds.push(id);
      if (nextDate === normalizeDate(task.date)
        && nextEndDate === normalizeEndDate(task.endDate, task.date)) return;
      changes.push({ id, date: nextDate, endDate: nextEndDate });
      task.date = nextDate;
      task.endDate = nextEndDate;
    });

    if (!migratedIds.length) return { ok: true, migrated: 0 };
    if (changes.length) {
      const saved = await saveCanonicalState();
      if (!saved.ok) {
        changes.forEach(change => {
          const task = findTask(change.id);
          const record = snapshot.overrides[change.id];
          if (task && record) {
            task.date = record.baseDate;
            task.endDate = record.baseEndDate || '';
          }
        });
        return { ok: false, reason: saved.reason || 'canonical-save-not-confirmed', migrated: 0 };
      }
    }
    const cleared = clearOverrides(migratedIds);
    if (!cleared.ok) return { ok: false, reason: cleared.reason, migrated: changes.length };
    return { ok: true, migrated: changes.length };
  }

  function persistForTask(taskId, nextOverrides) {
    const latest = readSnapshot();
    latest.overrides = nextOverrides;
    return writeSnapshot(latest);
  }

  async function moveByDay(taskId, delta) {
    const id = taskIdOf(taskId);
    if (![ -1, 1 ].includes(Number(delta))) return { ok: false, reason: 'invalid-delta' };
    const task = findTask(id);
    if (!task || !normalizeDate(task.date)) return { ok: false, reason: 'unscheduled-task' };
    snapshot = readSnapshot();
    const currentRecord = getRecord(task);
    const effective = getEffectiveTask(task);
    const destination = destinationFor(effective, Number(delta));
    if (!destination.start) return { ok: false, reason: 'invalid-destination' };
    const originalDate = normalizeDate(task.date);
    const originalEndDate = normalizeEndDate(task.endDate, originalDate);
    const alreadyCanonical = destination.start === originalDate && destination.end === originalEndDate;
    if (!alreadyCanonical) {
      try { root.pushUndoSnapshot?.('Move task date'); } catch {}
      task.date = destination.start;
      task.endDate = destination.end;
      const saved = await saveCanonicalState();
      if (!saved.ok) {
        task.date = originalDate;
        task.endDate = originalEndDate;
        showToast('The task date could not be saved. Please try again.', '#f76a6a');
        return saved;
      }
    }
    clearOverrides([id]);
    const verb = Number(delta) < 0 ? 'Previous day' : 'Next day';
    const acknowledged = root.studyQuestV21Core?.hostedSync?.().acknowledged === true;
    showToast(`${verb}: ${task.title || 'Task'} → ${destination.label} · ${acknowledged ? 'Saved to account' : 'Saved on this device · cloud backup pending'}`, acknowledged ? '#6af7b0' : '#f7c06a');
    rerender();
    return {
      ok: true,
      taskId: id,
      date: destination.start,
      endDate: destination.end,
      hadOverride: !!currentRecord,
      persisted: !alreadyCanonical,
    };
  }

  function resetTask(taskId) {
    const id = taskIdOf(taskId);
    if (!id) return { ok: false, reason: 'invalid-task' };
    snapshot = readSnapshot();
    if (!snapshot.overrides[id]) return { ok: true, taskId: id, unchanged: true };
    const nextOverrides = { ...snapshot.overrides };
    delete nextOverrides[id];
    const result = persistForTask(id, nextOverrides);
    if (!result.ok) {
      showToast('The saved date could not be restored because browser storage is blocked.', '#f76a6a');
      return result;
    }
    showToast(`${findTask(id)?.title || 'Task'} reset to its saved date`, '#6af7b0');
    rerender();
    return { ok: true, taskId: id };
  }

  function getSnapshot() {
    return clone(snapshot) || emptySnapshot();
  }

  function createButton({ id, delta, title, disabled }) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.className = `sq-date-shift-btn ${delta < 0 ? 'sq-date-shift-prev' : 'sq-date-shift-next'}`;
    button.dataset.sqDeviceDateShift = String(delta);
    button.dataset.sqDeviceTaskId = id;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    const visible = root.document.createElement('span');
    visible.className = 'sq-date-shift-label';
    visible.textContent = delta < 0 ? '←' : '→';
    button.appendChild(visible);
    return button;
  }

  function createResetButton(id, title, disabled) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'sq-date-shift-btn sq-date-shift-reset';
    button.dataset.sqDeviceDateShiftReset = 'true';
    button.dataset.sqDeviceTaskId = id;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    const visible = root.document.createElement('span');
    visible.className = 'sq-date-shift-label';
    visible.textContent = '↺';
    button.appendChild(visible);
    return button;
  }

  function taskElementId(element) {
    if (!element) return '';
    return String(
      element.dataset.id ||
      element.dataset.v23SubtaskParent ||
      element.dataset.v22SubtaskParent ||
      '',
    ).trim();
  }

  function createDateSummary(effective, record, id, disabled) {
    const summary = root.document.createElement('div');
    summary.className = `sq-date-shift-summary ${record ? 'sq-date-shift-summary-adjusted' : ''}`;
    const displayed = rangeLabel(effective.date, effective.endDate);
    const compactDisplayed = compactRangeLabel(effective.date, effective.endDate);
    const current = root.document.createElement('span');
    current.className = 'sq-date-shift-current';
    current.textContent = compactDisplayed;
    summary.appendChild(current);
    if (record) {
      summary.appendChild(createResetButton(
        id,
        `Reset to saved date: ${rangeLabel(record.baseDate, record.baseEndDate)}`,
        disabled,
      ));
    }
    summary.title = record
      ? `Displayed date: ${displayed}. Saved date: ${rangeLabel(record.baseDate, record.baseEndDate)}.`
      : `Saved date: ${displayed}. Use the arrows to save a different day.`;
    summary.setAttribute('aria-label', record
      ? `Displayed date ${displayed}. Saved date ${rangeLabel(record.baseDate, record.baseEndDate)}.`
      : `Saved date ${displayed}.`);
    return summary;
  }

  function restoreOriginalInlineControls(host) {
    if (!host) return;
    host.querySelector(':scope > .sq-date-shift-inline-row')?.remove();
    const primary = host.querySelector(':scope > .sq-date-shift-primary');
    if (primary) {
      [...primary.children].forEach(child => host.insertBefore(child, primary));
      primary.remove();
    }
    host.classList.remove('sq-date-shift-inline-host');
    delete host.dataset.sqDateShiftInline;
  }

  function clearDateShiftDecoration(element) {
    element.querySelectorAll('.sq-date-shift-footer, .sq-date-shift-actions, .sq-device-date-badge').forEach(child => child.remove());
    restoreOriginalInlineControls(element.querySelector('.task-title-row > .task-inline-controls'));
    element.classList.remove('sq-device-date-adjusted', 'sq-date-shift-footer-layout');
  }

  function ensureInlineControls(element) {
    const host = element.querySelector('.task-title-row > .task-inline-controls');
    if (!host) return null;
    host.classList.add('sq-date-shift-inline-host');
    host.dataset.sqDateShiftInline = 'true';

    let primary = host.querySelector(':scope > .sq-date-shift-primary');
    if (!primary) {
      primary = root.document.createElement('div');
      primary.className = 'sq-date-shift-primary';
      [...host.children].forEach(child => primary.appendChild(child));
      host.appendChild(primary);
    }

    let row = host.querySelector(':scope > .sq-date-shift-inline-row');
    if (!row) {
      row = root.document.createElement('div');
      row.className = 'sq-date-shift-inline-row';
      host.appendChild(row);
    }
    return { host, primary, row };
  }

  function decorateTaskElement(element) {
    const id = taskElementId(element);
    if (!id) return;
    const task = findTask(id);
    if (!task || !normalizeDate(task.date)) {
      clearDateShiftDecoration(element);
      return;
    }
    const effective = getEffectiveTask(task);
    const record = getRecord(task);
    const controls = ensureInlineControls(element);
    if (!controls) return;
    const { row } = controls;
    element.querySelectorAll('.sq-date-shift-footer, .sq-date-shift-actions, .sq-device-date-badge').forEach(child => child.remove());
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `Move ${task.title || 'task'} to another day`);
    row.replaceChildren();
    const blocked = storageBlocked;
    const previous = destinationFor(effective, -1);
    const next = destinationFor(effective, 1);
    const previousButton = createButton({
      id,
      delta: -1,
      disabled: blocked,
      title: `Previous Day: save this task on ${previous.label}`,
    });
    const nextButton = createButton({
      id,
      delta: 1,
      disabled: blocked,
      title: `Next Day: save this task on ${next.label}`,
    });
    row.appendChild(previousButton);
    row.appendChild(createDateSummary(effective, record, id, blocked));
    row.appendChild(nextButton);
    row.firstElementChild?.classList.add('sq-date-shift-inline-prev');
    row.lastElementChild?.classList.add('sq-date-shift-inline-next');
    if (element.dataset.v23SubtaskDate !== undefined) element.dataset.v23SubtaskDate = effective.date || '';
    if (element.dataset.v22SubtaskDate !== undefined) element.dataset.v22SubtaskDate = effective.date || '';
    element.classList.toggle('sq-device-date-adjusted', !!record);
  }

  function decorateAll() {
    if (!root.document) return;
    root.document.querySelectorAll('.task-item[data-id]').forEach(decorateTaskElement);
    decorateEditor();
  }

  function keepTodayBinOpen() {
    if (!root.document) return;
    const todayBin = root.document.querySelector('.date-bin.today-bin');
    todayBin?.querySelector('.bin-body')?.classList.add('open');
    todayBin?.querySelector('.bin-toggle')?.classList.add('open');
  }

  function scheduleDecorate() {
    if (decorateScheduled) return;
    decorateScheduled = true;
    const run = () => {
      decorateScheduled = false;
      pruneStaleRecords();
      decorateAll();
      keepTodayBinOpen();
      updateTodayCounts();
    };
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(run);
    else if (typeof root.setTimeout === 'function') root.setTimeout(run, 0);
    else run();
  }

  function getEffectiveTaskList(tasks) {
    return Array.isArray(tasks) ? tasks.map(getEffectiveTask) : tasks;
  }

  function effectiveFutureTasks(limit = 5) {
    const todayStr = typeof root.today === 'function' ? root.today() : '';
    return (getState()?.tasks || [])
      .map(getEffectiveTask)
      .filter(task => task.date && task.date > todayStr && !task.done && root.studyQuestV19TaskVisible?.(task) !== false)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
        || Number(root.taskUrgencyRank?.(a) || 999) - Number(root.taskUrgencyRank?.(b) || 999)
        || Number(a.priority ?? 999) - Number(b.priority ?? 999)
        || String(a.time || '99:99').localeCompare(String(b.time || '99:99'))
        || Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .slice(0, limit);
  }

  function effectiveUpcomingExamTasks() {
    if (root.StudyQuestV19?.isLifeMode?.() || root.studyQuestV19IsLifeMode?.()) return [];
    const todayStr = typeof root.today === 'function' ? root.today() : '';
    const todayMs = typeof root.studyQuestLogicalDateMs === 'function'
      ? root.studyQuestLogicalDateMs(todayStr)
      : Date.parse(`${todayStr}T00:00:00Z`);
    return (getState()?.tasks || [])
      .map(getEffectiveTask)
      .filter(task => {
        if (!task.date || task.done) return false;
        const dateMs = typeof root.studyQuestLogicalDateMs === 'function'
          ? root.studyQuestLogicalDateMs(task.date)
          : Date.parse(`${task.date}T00:00:00Z`);
        return Number.isFinite(dateMs) && dateMs >= todayMs && /exam|final|midterm|test|quiz/i.test(task.title || '');
      })
      .sort((a, b) => {
        const dateA = typeof root.studyQuestLogicalDateMs === 'function' ? root.studyQuestLogicalDateMs(a.date) : Date.parse(`${a.date}T00:00:00Z`);
        const dateB = typeof root.studyQuestLogicalDateMs === 'function' ? root.studyQuestLogicalDateMs(b.date) : Date.parse(`${b.date}T00:00:00Z`);
        return dateA - dateB || String(a.time || '99:99').localeCompare(String(b.time || '99:99'));
      });
  }

  function effectiveCalendarTasks(dateStr) {
    if (typeof originals.getCalendarTasksForDate !== 'function') return [];
    try { return getEffectiveTaskList(originals.getCalendarTasksForDate.call(root, dateStr)); } catch { return []; }
  }

  function effectiveWorkloadSummary(dateStr) {
    const api = originals.v18Api || root.StudyQuestV18;
    const base = typeof originals.v18WorkloadSummary === 'function'
      ? (() => { try { return originals.v18WorkloadSummary.call(api, dateStr); } catch { return null; } })()
      : null;
    const minutes = typeof originals.v18MinutesForTaskOnDate === 'function'
      ? originals.v18MinutesForTaskOnDate
      : api?.minutesForTaskOnDate;
    const suppressed = api?.isSuppressedTask;
    let completedMinutes = 0;
    let totalPlannedMinutes = 0;
    let unfinishedMinutes = 0;
    (getState()?.tasks || []).filter(task => !suppressed?.(task) && taskDateCovers(task, dateStr)).forEach(rawTask => {
      const task = getEffectiveTask(rawTask);
      const value = Math.max(0, Math.round(Number(typeof minutes === 'function' ? minutes.call(api, task, dateStr) : 0) || 0));
      totalPlannedMinutes += value;
      if (task.done === true || Number(task.progressPercent) >= 100) completedMinutes += value;
      else unfinishedMinutes += value;
    });
    const capacityMinutes = Number.isFinite(Number(base?.capacityMinutes)) ? Number(base.capacityMinutes) : 0;
    const status = unfinishedMinutes > capacityMinutes ? 'overloaded' : unfinishedMinutes >= capacityMinutes * 0.8 ? 'warning' : 'normal';
    return { completedMinutes, totalPlannedMinutes, unfinishedMinutes, capacityMinutes, status };
  }

  function updateTodayCounts() {
    const todayStr = typeof root.today === 'function' ? root.today() : '';
    const tasks = getState()?.tasks || [];
    const allToday = tasks.filter(task => taskDateCovers(task, todayStr) && !task.done);
    const allFuture = tasks.map(getEffectiveTask).filter(task => task.date && task.date > todayStr && !task.done && root.studyQuestV19TaskVisible?.(task) !== false);
    const count = root.document?.getElementById('todayTaskFabCount');
    const sub = root.document?.getElementById('todayTaskSub');
    if (count) count.textContent = String(allToday.length + allFuture.length);
    if (sub) sub.textContent = `${allToday.length} today · ${allFuture.length} upcoming`;
  }

  function currentEditingTaskId() {
    try {
      // The frozen pages declare this as a top-level `let`, which is shared by
      // later same-origin scripts but is intentionally not a window property.
      if (editingTaskId) return String(editingTaskId);
    } catch {}
    try {
      const value = root.editingTaskId;
      return value ? String(value) : '';
    } catch {
      return '';
    }
  }

  function decorateEditor() {
    if (!root.document) return;
    root.document.querySelectorAll('.sq-device-date-note').forEach(note => note.remove());
  }

  let moveQueue = Promise.resolve();
  function handleClick(event) {
    const target = event.target?.closest?.('[data-sq-device-date-shift], [data-sq-device-date-shift-reset]');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const id = target.dataset.sqDeviceTaskId;
    if (target.dataset.sqDeviceDateShiftReset) resetTask(id);
    else { const delta = Number(target.dataset.sqDeviceDateShift); moveQueue = moveQueue.then(() => moveByDay(id, delta)).catch(() => showToast("Date save needs attention. Your recovery copies are kept.", "#f76a6a")); }
  }

  function handleStorage(event) {
    if (event?.key && event.key !== storageKey()) return;
    snapshot = readSnapshot();
    rerender();
  }

  function install() {
    if (installed || !root.document) return api;
    installed = true;
    snapshot = readSnapshot();
    const legacyMigration = { ok:true }; // Hosted startup never converts or saves legacy overlays.
    if (!legacyMigration.ok) {
      showToast('A previous temporary date move could not be saved yet. It is being kept safely.', '#f7c06a');
    }
    originals = {
      renderAll: root.renderAll,
      renderBins: root.renderBins,
      setPastDays: root.setPastDays,
      renderTaskList: root.renderTaskList,
      renderCalendarTaskBlock: root.renderCalendarTaskBlock,
      renderCalendar: root.renderCalendar,
      renderTodayTaskRow: root.renderTodayTaskRow,
      renderTodayTaskWidget: root.renderTodayTaskWidget,
      getCalendarTasksForDate: root.getCalendarTasksForDate,
      getTodayPriorityTasks: root.getTodayPriorityTasks,
      getFuturePriorityTasks: root.getFuturePriorityTasks,
      taskMatchesFilter: root.taskMatchesFilter,
      getUpcomingExamTasks: root.getUpcomingExamTasks,
      taskDateCovers: root.taskDateCovers,
      getOpenTasksForDate: root.getOpenTasksForDate,
      editTask: root.editTask,
      openCreateTask: root.openCreateTask,
      saveTask: root.saveTask,
      v18Api: root.StudyQuestV18,
      v18WorkloadSummary: root.StudyQuestV18?.workloadSummaryForDate,
      v18MinutesForTaskOnDate: root.StudyQuestV18?.minutesForTaskOnDate,
      v19WorkloadSummary: root.studyQuestV19WorkloadSummary,
    };

    root.taskDateCovers = taskDateCovers;
    root.studyQuestV16TaskDateCovers = taskDateCovers;
    root.getOpenTasksForDate = function (dateStr) {
      return (getState()?.tasks || []).filter(task => taskDateCovers(task, dateStr) && !task.done);
    };
    root.studyQuestV16GetOpenTasksForDate = root.getOpenTasksForDate;

    if (typeof originals.taskMatchesFilter === 'function') {
      root.taskMatchesFilter = function (task, filter, ...rest) {
        return originals.taskMatchesFilter.call(this, getEffectiveTask(task), filter, ...rest);
      };
    }
    if (typeof originals.getUpcomingExamTasks === 'function') {
      root.getUpcomingExamTasks = effectiveUpcomingExamTasks;
    }

    // v24 rebuilds the date bins synchronously when the past-range control is
    // changed. Re-apply the inline controls after that DOM replacement, and
    // also cover direct renderBins() callers used by other v24 refresh paths.
    if (typeof originals.renderBins === 'function') {
      root.renderBins = function (...args) {
        const result = originals.renderBins.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.setPastDays === 'function') {
      root.setPastDays = function (...args) {
        const result = originals.setPastDays.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }

    if (typeof originals.renderTaskList === 'function') {
      root.renderTaskList = function (dateStr, tasks, ...rest) {
        return originals.renderTaskList.call(this, dateStr, getEffectiveTaskList(tasks), ...rest);
      };
    }
    if (typeof originals.renderCalendarTaskBlock === 'function') {
      root.renderCalendarTaskBlock = function (task, options, ...rest) {
        return originals.renderCalendarTaskBlock.call(this, getEffectiveTask(task), options, ...rest);
      };
    }
    if (typeof originals.renderCalendar === 'function') {
      root.renderCalendar = function (...args) {
        const result = originals.renderCalendar.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.renderTodayTaskRow === 'function') {
      root.renderTodayTaskRow = function (task, index, options, ...rest) {
        return originals.renderTodayTaskRow.call(this, getEffectiveTask(task), index, options, ...rest);
      };
    }
    if (typeof originals.getCalendarTasksForDate === 'function') root.getCalendarTasksForDate = effectiveCalendarTasks;
    if (typeof originals.getFuturePriorityTasks === 'function') root.getFuturePriorityTasks = effectiveFutureTasks;
    if (typeof originals.getTodayPriorityTasks === 'function') {
      root.getTodayPriorityTasks = function (limit, ...rest) {
        return getEffectiveTaskList(originals.getTodayPriorityTasks.call(this, limit, ...rest));
      };
    }
    if (typeof originals.renderTodayTaskWidget === 'function') {
      root.renderTodayTaskWidget = function (...args) {
        const result = originals.renderTodayTaskWidget.apply(this, args);
        updateTodayCounts();
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.renderAll === 'function') {
      root.renderAll = function (...args) {
        pruneStaleRecords();
        const result = originals.renderAll.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.editTask === 'function') {
      root.editTask = function (...args) {
        const result = originals.editTask.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.openCreateTask === 'function') {
      root.openCreateTask = function (...args) {
        const result = originals.openCreateTask.apply(this, args);
        scheduleDecorate();
        return result;
      };
    }
    if (typeof originals.saveTask === 'function') {
      root.saveTask = function (...args) {
        const id = currentEditingTaskId();
        const before = id ? findTask(id) : null;
        const beforeDates = before ? { date: before.date || '', endDate: before.endDate || '' } : null;
        const result = originals.saveTask.apply(this, args);
        const after = id ? findTask(id) : null;
        if (beforeDates && after && (String(after.date || '') !== beforeDates.date || String(after.endDate || '') !== beforeDates.endDate)) {
          const latest = readSnapshot();
          if (latest.overrides[id]) {
            delete latest.overrides[id];
            writeSnapshot(latest, { notify: false });
          }
        }
        scheduleDecorate();
        return result;
      };
    }

    if (root.StudyQuestV18) {
      root.StudyQuestV18.minutesForTaskOnDate = function (task, dateStr) {
        return originals.v18MinutesForTaskOnDate?.call(originals.v18Api, getEffectiveTask(task), dateStr) || 0;
      };
      root.StudyQuestV18.workloadSummaryForDate = effectiveWorkloadSummary;
    }
    root.studyQuestV17GetWorkloadSummary = effectiveWorkloadSummary;

    if (root.document.addEventListener) root.document.addEventListener('click', handleClick, true);
    if (typeof root.addEventListener === 'function') root.addEventListener('storage', handleStorage);
    if (typeof root.addEventListener === 'function') root.addEventListener('studyquest-device-date-shifts', handleStorage);
    try {
      if (typeof root.BroadcastChannel === 'function') {
        channel = new root.BroadcastChannel(storageKey());
        channel.addEventListener('message', handleStorage);
      }
    } catch { channel = null; }
    try {
      const observer = new root.MutationObserver(() => decorateEditor());
      const modal = root.document.getElementById('taskModal');
      if (modal) observer.observe(modal, { attributes: true, attributeFilter: ['class', 'style'] });
      api._observer = observer;
    } catch {}
    root.document.getElementById('taskDate')?.addEventListener('input', decorateEditor);
    root.document.getElementById('taskEndDate')?.addEventListener('input', decorateEditor);
    try { root.StudyQuestDeviceDateShifts = api; } catch {}
    try { root.renderAll?.(); } catch {}
    scheduleDecorate();
    return api;
  }

  const api = {
    schemaVersion: SCHEMA_VERSION,
    storageSuffix: STORAGE_SUFFIX,
    storageKey,
    normalizeSnapshot,
    normalizeRecord,
    addDays,
    isDateKey,
    dateLabel,
    readSnapshot: () => {
      snapshot = readSnapshot();
      return getSnapshot();
    },
    getSnapshot,
    getEffectiveTask,
    hasOverride,
    taskDateCovers,
    migrateLegacyOverridesToCanonical,
    moveByDay,
    resetTask,
    install,
  };

  root.StudyQuestDeviceDateShifts = api;
  if (root.document) api.install();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
