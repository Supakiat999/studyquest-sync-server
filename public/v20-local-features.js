(function installStudyQuestV20Module(root) {
  'use strict';

  root.__STUDYQUEST_V20_SCRIPT_LOADED__ = true;

  const NOTE_STORAGE_SUFFIX = '_v20_exam_note';
  const NOTE_SCHEMA_VERSION = 1;
  const AUTOSAVE_DELAY_MS = 400;

  const WEEKLY_VIEW_STORAGE_SUFFIX = '_v20_weekly_ui';
  const WEEKLY_UI_SCHEMA_VERSION = 3;
  const WEEKLY_SUBJECT_SCHEMA_VERSION = 2;
  const WEEKLY_OVERLAY_KEY = 'weeklyV20';
  const WEEKLY_ORIGINAL_SURFACE_ID = 'v20WeeklyOriginalSurface';
  const WEEKLY_VIEW_MODES = new Set(['week', 'subject']);
  const MAX_STAGE_LABEL_LENGTH = 80;
  // New profiles start with no stages. This remains exported for compatibility
  // with the earlier v20 API, but prior saved stage definitions are preserved.
  const DEFAULT_SUBJECT_STAGE_SPECS = Object.freeze([]);

  let installed = false;
  let noteText = '';
  let loadedStorageKey = '';
  let pendingSave = false;
  let saveTimer = null;

  let weeklyViewMode = 'week';
  let loadedWeeklyViewKey = '';
  let weeklyViewPreference = { schemaVersion:WEEKLY_UI_SCHEMA_VERSION, viewMode:'week', viewModes:{}, subjectRanges:{} };
  let weeklyStatusText = '';
  let weeklyStatusState = '';
  let stageManagerSemId = '';
  let stageManagerSetup = false;
  let pendingStageLayouts = null;
  let requestedActivationView = 'subject';
  let activationPromise = null;
  let mutationQueue = Promise.resolve();
  let weeklyWrappersInstalled = false;

  function safeText(value) {
    return String(value ?? '');
  }

  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneJson(value, fallback = {}) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
  }

  function escapeHtml(value) {
    return safeText(value).replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
    })[character]);
  }

  function token(value) {
    return escapeHtml(encodeURIComponent(safeText(value)));
  }

  function decodeToken(value) {
    try { return decodeURIComponent(safeText(value)); } catch { return safeText(value); }
  }

  function numericTimestamp(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function storage() {
    try { return root.localStorage || null; } catch { return null; }
  }

  function activeStorageKey() {
    return safeText(root.__STUDYQUEST_ACTIVE_STORAGE_KEY__).trim() || 'studyquest_v3';
  }

  function hostedCloudMode() {
    return root.__STUDYQUEST_V20_HOSTED__ === true;
  }

  // ── v20 command-center note ─────────────────────────────
  function noteStorageKey(activeKey) {
    const active = safeText(activeKey ?? root.__STUDYQUEST_ACTIVE_STORAGE_KEY__).trim();
    return `${active || 'studyquest_v3'}${NOTE_STORAGE_SUFFIX}`;
  }

  function normalizeNote(raw) {
    let source = raw;
    if (typeof raw === 'string') {
      try { source = JSON.parse(raw); } catch { source = null; }
    }
    if (!plainObject(source)) {
      return { schemaVersion: NOTE_SCHEMA_VERSION, text:'', updatedAt:0 };
    }
    return {
      ...source,
      schemaVersion: NOTE_SCHEMA_VERSION,
      text: safeText(source.text),
      updatedAt: numericTimestamp(source.updatedAt),
    };
  }

  function notePayload(text, updatedAt = Date.now()) {
    return {
      schemaVersion: NOTE_SCHEMA_VERSION,
      text: safeText(text),
      updatedAt: numericTimestamp(updatedAt, Date.now()),
    };
  }

  function readNote(activeKey) {
    const store = storage();
    if (!store) return '';
    try { return normalizeNote(store.getItem(noteStorageKey(activeKey))).text; } catch { return ''; }
  }

  function writeNote(text, activeKey, updatedAt = Date.now()) {
    const store = storage();
    if (!store) return { ok:false, error:'Browser storage is unavailable.' };
    try {
      store.setItem(noteStorageKey(activeKey), JSON.stringify(notePayload(text, updatedAt)));
      return { ok:true };
    } catch {
      return { ok:false, error:'Could not save this note in the browser.' };
    }
  }

  function noteStatusElement() {
    return root.document?.getElementById('v20QuickNoteStatus') || null;
  }

  function setNoteStatus(message, state = '') {
    const element = noteStatusElement();
    if (!element) return;
    element.textContent = safeText(message);
    element.dataset.state = state;
  }

  function syncAccountNote() {
    const key = noteStorageKey(activeStorageKey());
    if (key === loadedStorageKey && !pendingSave) return;
    if (pendingSave) return;
    loadedStorageKey = key;
    noteText = readNote(activeStorageKey());
  }

  function flushNote() {
    if (!pendingSave) return true;
    const result = writeNote(noteText, activeStorageKey());
    pendingSave = false;
    if (result.ok) {
      loadedStorageKey = noteStorageKey(activeStorageKey());
      setNoteStatus('Saved locally', 'saved');
      return true;
    }
    setNoteStatus(result.error, 'error');
    return false;
  }

  function queueNoteSave(value) {
    noteText = safeText(value);
    pendingSave = true;
    setNoteStatus('Saving locally...', 'saving');
    root.clearTimeout?.(saveTimer);
    saveTimer = root.setTimeout?.(flushNote, AUTOSAVE_DELAY_MS) || null;
  }

  function handleNoteInput(event) {
    const input = event?.target;
    if (!input || input.id !== 'v20ExamNoteInput') return;
    queueNoteSave(input.value);
  }

  function handlePageHide() {
    if (saveTimer) root.clearTimeout?.(saveTimer);
    saveTimer = null;
    flushNote();
  }

  function afterNoteRender() {
    syncAccountNote();
    const input = root.document?.getElementById('v20ExamNoteInput');
    if (!input) return;
    if (input.value !== noteText) input.value = noteText;
    if (!pendingSave && !noteStatusElement()?.textContent) {
      setNoteStatus(noteText ? 'Saved locally' : 'Available on this device', noteText ? 'saved' : 'idle');
    }
  }

  // ── v20 Weekly Subject Tracking data model ───────────────
  function normalizeWeeklyViewMode(value) {
    const mode = safeText(value).trim().toLowerCase();
    return WEEKLY_VIEW_MODES.has(mode) ? mode : 'week';
  }

  function emptyWeeklySubjectRange() {
    return { startWeekId:'', endWeekId:'' };
  }

  function normalizeWeeklySubjectRange(raw) {
    let source = raw;
    if (typeof raw === 'string') {
      try { source = JSON.parse(raw); } catch { source = {}; }
    }
    source = plainObject(source) ? source : {};
    return {
      ...source,
      startWeekId:safeText(source.startWeekId).trim(),
      endWeekId:safeText(source.endWeekId).trim(),
    };
  }

  function weeklySubjectRangeHasBounds(range) {
    const normalized = normalizeWeeklySubjectRange(range);
    return !!normalized.startWeekId && !!normalized.endWeekId;
  }

  function emptyWeeklyViewPreference() {
    return { schemaVersion:WEEKLY_UI_SCHEMA_VERSION, viewMode:'week', viewModes:{}, subjectRanges:{} };
  }

  function normalizeWeeklyViewPreference(raw) {
    let source = raw;
    if (typeof raw === 'string') {
      try { source = JSON.parse(raw); } catch { source = {}; }
    }
    source = plainObject(source) ? source : {};
    const viewModes = {};
    if (plainObject(source.viewModes)) {
      Object.entries(source.viewModes).forEach(([semId, mode]) => {
        const key = safeText(semId).trim();
        if (key) viewModes[key] = normalizeWeeklyViewMode(mode);
      });
    }
    const subjectRanges = {};
    if (plainObject(source.subjectRanges)) {
      Object.entries(source.subjectRanges).forEach(([semId, range]) => {
        const key = safeText(semId).trim();
        if (key) subjectRanges[key] = normalizeWeeklySubjectRange(range);
      });
    }
    return {
      ...source,
      schemaVersion: WEEKLY_UI_SCHEMA_VERSION,
      viewMode: normalizeWeeklyViewMode(source.viewMode),
      viewModes,
      subjectRanges,
    };
  }

  function weeklyViewStorageKey(activeKey) {
    const active = safeText(activeKey ?? root.__STUDYQUEST_ACTIVE_STORAGE_KEY__).trim();
    return `${active || 'studyquest_v3'}${WEEKLY_VIEW_STORAGE_SUFFIX}`;
  }

  function updateWeeklyViewPreference(activeKey, mutator, errorMessage) {
    const store = storage();
    if (!store) return { ok:false, error:'Browser storage is unavailable.' };
    try {
      const key = weeklyViewStorageKey(activeKey);
      const preference = normalizeWeeklyViewPreference(store.getItem(key));
      const result = mutator(preference);
      if (result && result.ok === false) return result;
      preference.schemaVersion = WEEKLY_UI_SCHEMA_VERSION;
      store.setItem(key, JSON.stringify(preference));
      weeklyViewPreference = preference;
      loadedWeeklyViewKey = key;
      return { ok:true, ...(plainObject(result) ? result : {}) };
    } catch {
      return { ok:false, error:errorMessage || 'Could not save the Weekly view preference in the browser.' };
    }
  }

  function readWeeklyViewMode(activeKey, semId = '') {
    const store = storage();
    if (!store) return 'week';
    try {
      const preference = normalizeWeeklyViewPreference(store.getItem(weeklyViewStorageKey(activeKey)));
      const key = safeText(semId).trim();
      return key && preference.viewModes[key]
        ? preference.viewModes[key]
        : preference.viewMode;
    } catch { return 'week'; }
  }

  function writeWeeklyViewMode(mode, activeKey, semId = '') {
    const normalized = normalizeWeeklyViewMode(mode);
    const result = updateWeeklyViewPreference(activeKey, preference => {
      const key = safeText(semId).trim();
      if (key) preference.viewModes[key] = normalized;
      else preference.viewMode = normalized;
      return { mode:normalized };
    }, 'Could not save the Weekly view preference in the browser.');
    return result.ok
      ? { ok:true, mode:normalized }
      : { ok:false, mode:normalized, error:result.error };
  }

  function readWeeklySubjectRange(activeKey, semId = '') {
    const store = storage();
    const key = safeText(semId).trim();
    if (!store || !key) return null;
    try {
      const preference = normalizeWeeklyViewPreference(store.getItem(weeklyViewStorageKey(activeKey)));
      const range = normalizeWeeklySubjectRange(preference.subjectRanges?.[key]);
      return weeklySubjectRangeHasBounds(range) ? range : null;
    } catch { return null; }
  }

  function writeWeeklySubjectRange(range, activeKey, semId = '') {
    const key = safeText(semId).trim();
    if (!key) return { ok:false, range:null, error:'A Weekly semester is required for the display range.' };
    const isClear = range === null || range === undefined;
    const normalized = isClear ? emptyWeeklySubjectRange() : normalizeWeeklySubjectRange(range);
    if (!isClear && !weeklySubjectRangeHasBounds(normalized)) {
      return { ok:false, range:null, error:'Choose both a start week and an end week.' };
    }
    const result = updateWeeklyViewPreference(activeKey, preference => {
      if (!plainObject(preference.subjectRanges)) preference.subjectRanges = {};
      // Keep an explicit empty entry on clear so no existing browser key is
      // removed and a later account switch can safely restore the preference.
      preference.subjectRanges[key] = normalized;
      return { range:weeklySubjectRangeHasBounds(normalized) ? normalized : null };
    }, 'Could not save the Subject Track display range in the browser.');
    return result.ok
      ? { ok:true, range:result.range }
      : { ok:false, range:null, error:result.error };
  }

  function syncWeeklyViewPreference(semId = '') {
    const key = weeklyViewStorageKey(activeStorageKey());
    if (key !== loadedWeeklyViewKey) {
      loadedWeeklyViewKey = key;
      const store = storage();
      try {
        weeklyViewPreference = normalizeWeeklyViewPreference(store?.getItem(key));
      } catch {
        weeklyViewPreference = emptyWeeklyViewPreference();
      }
    }
    const keyForSemester = safeText(semId).trim();
    weeklyViewMode = keyForSemester && weeklyViewPreference.viewModes[keyForSemester]
      ? weeklyViewPreference.viewModes[keyForSemester]
      : weeklyViewPreference.viewMode;
  }

  function getState() {
    try {
      if (plainObject(root.SQ_State)) return root.SQ_State;
    } catch {}
    try { return state; } catch { return root.state || null; }
  }

  function getCore() {
    return plainObject(root.studyQuestV20Core) ? root.studyQuestV20Core : {};
  }

  function callRoot(name, ...args) {
    const fn = root[name];
    if (typeof fn !== 'function') return undefined;
    return fn(...args);
  }

  function normalizeStage(raw, index, seen = new Set()) {
    const source = plainObject(raw) ? raw : {};
    let id = safeText(source.id).trim() || `v20stage_${index + 1}`;
    if (seen.has(id)) id = `v20stage_${index + 1}_${seen.size + 1}`;
    seen.add(id);
    return {
      ...source,
      id,
      label:(safeText(source.label).trim() || `Stage ${index + 1}`).slice(0, MAX_STAGE_LABEL_LENGTH),
      order:Number.isSafeInteger(Number(source.order)) ? Number(source.order) : index,
      archived:source.archived === true,
    };
  }

  function defaultSubjectStages() {
    return [];
  }

  function normalizeWeeklySubjectTracking(raw) {
    let source = raw;
    if (typeof raw === 'string') {
      try { source = JSON.parse(raw); } catch { source = {}; }
    }
    source = plainObject(source) ? source : {};
    const normalized = cloneJson(source, {});
    normalized.version = WEEKLY_SUBJECT_SCHEMA_VERSION;
    normalized.enabled = source.enabled === true;
    normalized.activatedAt = safeText(source.activatedAt);
    normalized.layouts = plainObject(source.layouts) ? cloneJson(source.layouts, {}) : {};
    normalized.cells = plainObject(source.cells) ? cloneJson(source.cells, {}) : {};
    Object.entries(normalized.layouts).forEach(([semesterId, rawLayout]) => {
      const layout = plainObject(rawLayout) ? rawLayout : {};
      const seen = new Set();
      const stages = Array.isArray(layout.stages)
        ? layout.stages.map((stage, index) => normalizeStage(stage, index, seen))
        : [];
      normalized.layouts[semesterId] = { ...layout, stages };
    });
    return normalized;
  }

  function buildDefaultWeeklySubjectTracking(source = getState(), activatedAt = new Date().toISOString(), layoutSource = null) {
    const prior = weeklyOverlay(source);
    const priorNormalized = prior ? normalizeWeeklySubjectTracking(prior) : null;
    const layouts = {};
    (Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : []).forEach(semester => {
      const id = safeText(semester?.id).trim();
      if (!id) return;
      const candidate = plainObject(layoutSource?.[id])
        ? layoutSource[id]
        : priorNormalized?.layouts?.[id];
      const stages = Array.isArray(candidate?.stages)
        ? candidate.stages.map((stage, index) => normalizeStage(stage, index))
        : [];
      layouts[id] = {
        ...(plainObject(candidate) ? cloneJson(candidate, {}) : {}),
        stages:sortStages(stages).map((stage, index) => ({ ...stage, order:index })),
      };
    });
    return {
      ...(priorNormalized ? cloneJson(priorNormalized, {}) : {}),
      version:WEEKLY_SUBJECT_SCHEMA_VERSION,
      enabled:true,
      activatedAt:safeText(activatedAt) || new Date().toISOString(),
      layouts,
      cells:priorNormalized?.cells ? cloneJson(priorNormalized.cells, {}) : {},
    };
  }

  function weeklyOverlay(source = getState()) {
    const overlay = source?.tracker?.[WEEKLY_OVERLAY_KEY];
    return plainObject(overlay) ? overlay : null;
  }

  function subjectTrackingEnabled(source = getState()) {
    return weeklyOverlay(source)?.enabled === true;
  }

  function sortStages(stages = []) {
    return (Array.isArray(stages) ? stages : []).slice().sort((left, right) => (
      Number(left?.order ?? 0) - Number(right?.order ?? 0)
      || safeText(left?.id).localeCompare(safeText(right?.id))
    ));
  }

  function semesterIdFor(source, requested = '') {
    const semesters = Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : [];
    const wanted = safeText(requested).trim();
    if (wanted && semesters.some(semester => semester?.id === wanted)) return wanted;
    const active = safeText(source?.activeSemTracker).trim();
    if (active && (semesters.length === 0 || semesters.some(semester => semester?.id === active))) return active;
    if (semesters[0]?.id) return semesters[0].id;
    const week = (Array.isArray(source?.tracker?.weeks) ? source.tracker.weeks : []).find(item => item?.semesterId);
    return safeText(week?.semesterId).trim() || 'Y3-S1';
  }

  function semesterFor(source, semId) {
    return (Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : [])
      .find(semester => semester?.id === semId) || null;
  }

  function weeklyWeeksForSemester(source = getState(), semId = semesterIdFor(source)) {
    const key = safeText(semId).trim();
    return (Array.isArray(source?.tracker?.weeks) ? source.tracker.weeks : [])
      .filter(week => (week?.semesterId || 'Y3-S1') === key);
  }

  function resolveWeeklySubjectRange(source = getState(), semId = semesterIdFor(source), range = null) {
    const weeks = weeklyWeeksForSemester(source, semId);
    const normalized = normalizeWeeklySubjectRange(range);
    if (!weeklySubjectRangeHasBounds(normalized)) {
      return { range:null, weeks:[], startIndex:-1, endIndex:-1, stale:false };
    }
    const startIndex = weeks.findIndex(week => safeText(week?.id) === normalized.startWeekId);
    const endIndex = weeks.findIndex(week => safeText(week?.id) === normalized.endWeekId);
    if (startIndex < 0 || endIndex < 0) {
      return { range:normalized, weeks:[], startIndex, endIndex, stale:true };
    }
    const firstIndex = Math.min(startIndex, endIndex);
    const lastIndex = Math.max(startIndex, endIndex);
    return {
      range:{
        ...normalized,
        startWeekId:safeText(weeks[firstIndex]?.id),
        endWeekId:safeText(weeks[lastIndex]?.id),
      },
      weeks:weeks.slice(firstIndex, lastIndex + 1),
      startIndex:firstIndex,
      endIndex:lastIndex,
      stale:false,
    };
  }

  function addWeeklySubjectRange(startWeekId, endWeekId, activeKey = activeStorageKey(), semId = '', source = getState()) {
    const semesterId = safeText(semId).trim() || semesterIdFor(source);
    const weeks = weeklyWeeksForSemester(source, semesterId);
    const startId = safeText(startWeekId).trim();
    const endId = safeText(endWeekId).trim();
    const startIndex = weeks.findIndex(week => safeText(week?.id) === startId);
    const endIndex = weeks.findIndex(week => safeText(week?.id) === endId);
    if (startIndex < 0 || endIndex < 0) {
      return { ok:false, range:null, error:'Choose start and end weeks from the selected semester.' };
    }
    if (startIndex > endIndex) {
      return { ok:false, range:null, error:'The start week must come before or match the end week.' };
    }

    const prior = readWeeklySubjectRange(activeKey, semesterId);
    const resolvedPrior = resolveWeeklySubjectRange(source, semesterId, prior);
    if (prior && resolvedPrior.stale) {
      return { ok:false, range:null, error:'The saved range includes a missing Weekly week. Clear it before adding a new range.' };
    }
    const firstIndex = prior ? Math.min(startIndex, resolvedPrior.startIndex) : startIndex;
    const lastIndex = prior ? Math.max(endIndex, resolvedPrior.endIndex) : endIndex;
    const nextRange = {
      startWeekId:safeText(weeks[firstIndex]?.id),
      endWeekId:safeText(weeks[lastIndex]?.id),
    };
    return writeWeeklySubjectRange(nextRange, activeKey, semesterId);
  }

  function clearWeeklySubjectRange(activeKey = activeStorageKey(), semId = '') {
    const semesterId = safeText(semId).trim() || semesterIdFor(getState() || {});
    return writeWeeklySubjectRange(null, activeKey, semesterId);
  }

  function stageLayout(source, semId) {
    const overlay = weeklyOverlay(source);
    const stored = overlay?.layouts?.[semId];
    if (plainObject(stored) && Array.isArray(stored.stages)) {
      return { ...stored, stages:sortStages(stored.stages.map((stage, index) => normalizeStage(stage, index))) };
    }
    return { stages:[] };
  }

  function visibleStages(source, semId) {
    return sortStages(stageLayout(source, semId).stages).filter(stage => stage.archived !== true);
  }

  function ensureOverlayLayout(overlay, semId) {
    if (!plainObject(overlay.layouts)) overlay.layouts = {};
    if (!plainObject(overlay.layouts[semId])) overlay.layouts[semId] = { stages:[] };
    const layout = overlay.layouts[semId];
    if (!Array.isArray(layout.stages)) layout.stages = [];
    layout.stages = sortStages(layout.stages.map((stage, index) => normalizeStage(stage, index)));
    layout.stages.forEach((stage, index) => { stage.order = index; });
    return layout;
  }

  function weeklyCellChecked(source, weekId, rowId, stageId) {
    return source?.tracker?.[WEEKLY_OVERLAY_KEY]?.cells?.[weekId]?.[rowId]?.[stageId] === true;
  }

  function baseWeeklyFingerprint(source) {
    const copy = cloneJson(source, {});
    if (copy && typeof copy === 'object') {
      if (copy.tracker && typeof copy.tracker === 'object') delete copy.tracker[WEEKLY_OVERLAY_KEY];
      delete copy._syncMeta;
      delete copy.updatedAt;
    }
    try { return JSON.stringify(copy); } catch { return ''; }
  }

  function weeklySummary(source = getState(), semId = semesterIdFor(source), range = undefined) {
    const weeks = weeklyWeeksForSemester(source, semId);
    const regular = weeks.filter(week => !week?.isBreak);
    const rows = regular.reduce((sum, week) => sum + (Array.isArray(week?.rows) ? week.rows.length : 0), 0);
    const subjects = semesterFor(source, semId)?.subjects || [];
    const stages = visibleStages(source, semId);
    const displayedWeeks = range === undefined
      ? weeks
      : resolveWeeklySubjectRange(source, semId, range).weeks;
    return {
      semesters:Array.isArray(source?.trackerSemesters) ? source.trackerSemesters.length : 0,
      weeks:regular.length,
      availableWeeks:weeks.length,
      displayedWeeks:displayedWeeks.length,
      breaks:weeks.length - regular.length,
      rows,
      subjects:subjects.length,
      stages:stages.length,
    };
  }

  function getWeekDate(week, row) {
    try {
      if (typeof root.wtRowDate === 'function') return root.wtRowDate(week, row);
    } catch {}
    const start = safeText(week?.weekStart);
    const dayOffsets = { mon:0, tue:1, wed:2, thu:3, fri:4, sat:5, sun:6 };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return '';
    const date = new Date(`${start}T00:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + (dayOffsets[safeText(row?.dayKey)] || 0));
    return date.toISOString().slice(0, 10);
  }

  function formatRowDate(dateKey) {
    try {
      if (typeof root.wtFormatRowDate === 'function') return root.wtFormatRowDate(dateKey);
    } catch {}
    return safeText(dateKey) || 'Date needed';
  }

  function formatFullDate(dateKey) {
    try {
      if (typeof root.wtFormatFullDate === 'function') return root.wtFormatFullDate(dateKey);
    } catch {}
    return safeText(dateKey);
  }

  function formatWeekRange(week) {
    try {
      if (typeof root.wtWeekRange === 'function') return root.wtWeekRange(week?.weekStart);
    } catch {}
    return safeText(week?.weekStart) || 'Date needed';
  }

  function sortedRows(rows) {
    try {
      if (typeof root.wtSortedRows === 'function') return root.wtSortedRows(rows || []);
    } catch {}
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function displayPlaceholder(week, subject) {
    return {
      id:`v20display_${safeText(week?.id)}_${safeText(subject?.id)}`,
      sourceSubjectId:safeText(subject?.id),
      subject:safeText(subject?.subject || subject?.name) || 'Untitled Subject',
      dayKey:safeText(subject?.dayKey),
      note:'',
      checks:{},
      noClass:false,
      _v20Placeholder:true,
    };
  }

  function subjectName(subject, fallback = 'Untitled Subject') {
    return safeText(subject?.subject || subject?.name || fallback).trim() || fallback;
  }

  function weekDisplayLabel(week, index = 0) {
    return safeText(week?.label).trim() || `Week ${index + 1}`;
  }

  function subjectRangeDescription(source, semId, range) {
    const resolved = resolveWeeklySubjectRange(source, semId, range);
    if (!resolved.range || !resolved.weeks.length) return '';
    const start = weekDisplayLabel(resolved.weeks[0], resolved.startIndex);
    const end = weekDisplayLabel(resolved.weeks[resolved.weeks.length - 1], resolved.endIndex);
    return start === end ? start : `${start} → ${end}`;
  }

  function rowsForWeek(week, subjects = []) {
    const storedRows = Array.isArray(week?.rows) ? sortedRows(week.rows) : [];
    const subjectList = Array.isArray(subjects) ? subjects : [];
    if (!subjectList.length) return storedRows;
    const result = [];
    const used = new Set();
    subjectList.forEach(subject => {
      let found = storedRows.find(row => !used.has(row?.id) && safeText(row?.sourceSubjectId) === safeText(subject?.id));
      if (!found) {
        found = storedRows.find(row => !used.has(row?.id)
          && safeText(row?.subject).trim().toLowerCase() === subjectName(subject).toLowerCase());
      }
      if (found) {
        used.add(found.id);
        result.push(found);
      } else {
        result.push(displayPlaceholder(week, subject));
      }
    });
    storedRows.forEach(row => {
      if (!used.has(row?.id)) result.push(row);
    });
    return result;
  }

  function weekIsNonWritable(week) {
    return week?.isBreak === true
      || week?.isExam === true
      || week?.isExamWeek === true
      || week?.examWeek === true
      || week?.kind === 'exam'
      || week?.type === 'exam';
  }

  function rowIsWritable(row, week = null) {
    return !!row && !weekIsNonWritable(week) && row._v20Placeholder !== true && row.noClass !== true;
  }

  function rowProgress(source, semId, weekId, row, stages = visibleStages(source, semId), week = null) {
    if (!rowIsWritable(row, week)) return { done:0, max:0, pct:100 };
    const done = stages.reduce((count, stage) => count + (weeklyCellChecked(source, weekId, row.id, stage.id) ? 1 : 0), 0);
    const max = stages.length;
    return { done, max, pct:max ? Math.round(done / max * 100) : 100 };
  }

  function entriesProgress(source, semId, entries, stages = visibleStages(source, semId)) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => rowIsWritable(entry?.row, entry?.week));
    const done = list.reduce((sum, entry) => sum + rowProgress(source, semId, entry.week?.id, entry.row, stages, entry.week).done, 0);
    const max = list.length * stages.length;
    return { done, max, pct:max ? Math.round(done / max * 100) : 100 };
  }

  function progressMarkup(progress, label = '') {
    const active = progress.max > 0;
    return `<div class="v20-weekly-progress" aria-label="${escapeHtml(label ? `${label}: ` : '')}${progress.done} of ${progress.max} stages complete">
      <div class="v20-weekly-progress-line"><strong>${progress.done}/${progress.max}</strong><span>${active ? `${progress.pct}%` : 'No active stages'}</span></div>
      <div class="v20-weekly-progress-bar"><div class="v20-weekly-progress-fill" style="width:${progress.pct}%;"></div></div>
    </div>`;
  }

  function stageCheckMarkup(source, semId, week, row, stage) {
    const checked = weeklyCellChecked(source, week?.id, row?.id, stage?.id);
    const canEdit = subjectTrackingEnabled(source) && rowIsWritable(row, week);
    const rowLabel = safeText(row?.subject || 'this subject');
    const weekLabel = safeText(week?.label || 'this week');
    return `<td class="v20-weekly-check-cell"><button type="button" class="v20-weekly-check" data-v20-week-id="${token(week?.id)}" data-v20-row-id="${token(row?.id)}" data-v20-stage-id="${token(stage?.id)}" data-v20-weekly-action="toggle-stage" aria-label="${escapeHtml(`${checked ? 'Uncheck' : 'Check'} ${stage.label} for ${rowLabel} in ${weekLabel}`)}" aria-pressed="${checked ? 'true' : 'false'}" ${canEdit ? '' : 'disabled'}>${checked ? '✓' : ''}</button></td>`;
  }

  function emptyMarkup(message) {
    return `<div class="v20-weekly-empty">${escapeHtml(message)}</div>`;
  }

  function renderWeekView(source = getState(), semId = semesterIdFor(source)) {
    const semesters = Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : [];
    const semester = semesterFor(source, semId);
    const subjects = semester?.subjects || [];
    const stages = visibleStages(source, semId);
    const weeks = weeklyWeeksForSemester(source, semId);
    if (!semesters.length && !weeks.length) return emptyMarkup('Create a Weekly semester to begin subject tracking.');
    if (!weeks.length) return emptyMarkup(`No weeks yet for “${semester?.name || 'this semester'}”. Existing Weekly controls remain available below.`);
    const stageHead = stages.map(stage => `<th title="${escapeHtml(stage.label)}">${escapeHtml(stage.label)}</th>`).join('');
    const blocks = [];
    weeks.forEach(week => {
      if (week?.isBreak) {
        blocks.push(`<section class="v20-weekly-week"><div class="v20-weekly-break">BREAK · ${escapeHtml(week.event || 'Break week')}</div></section>`);
        return;
      }
      const rows = rowsForWeek(week, subjects);
      const progress = entriesProgress(source, semId, rows.map(row => ({ week, row })), stages);
      const body = rows.length
        ? rows.map(row => {
          const date = getWeekDate(week, row);
          const rowProgressValue = rowProgress(source, semId, week.id, row, stages, week);
          const muted = week?.isBreak || row._v20Placeholder || row.noClass;
          return `<tr class="${muted ? 'v20-weekly-row-muted' : ''}">
            <td class="v20-weekly-date" title="${escapeHtml(formatFullDate(date))}">${escapeHtml(formatRowDate(date))}</td>
            <td class="v20-weekly-subject" title="${escapeHtml(row.subject || '')}">${escapeHtml(row.subject || 'Untitled Subject')}${row.noClass ? ' · No class' : row._v20Placeholder ? ' · Not recorded' : ''}</td>
            <td class="v20-weekly-note">${escapeHtml(row.note || '—')}</td>
            ${stages.map(stage => stageCheckMarkup(source, semId, week, row, stage)).join('')}
            <td>${progressMarkup(rowProgressValue, `${row.subject || 'Subject'} progress`)}</td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="${4 + stages.length}">${emptyMarkup('No subjects are configured for this week.')}</td></tr>`;
      blocks.push(`<section class="v20-weekly-week">
        <div class="v20-weekly-week-head"><div><div class="v20-weekly-week-title">${escapeHtml(week.label || 'Week')}</div><div class="v20-weekly-week-meta">${escapeHtml(formatWeekRange(week))} · ${rows.length} subject row${rows.length === 1 ? '' : 's'}</div></div>${progressMarkup(progress, `${week.label || 'Week'} progress`)}</div>
        <div class="v20-weekly-table-wrap"><table class="v20-weekly-table"><thead><tr><th>Date</th><th>Subject</th><th>Existing note</th>${stageHead}<th>Progress</th></tr></thead><tbody>${body}</tbody></table></div>
      </section>`);
    });
    return `<div class="v20-weekly-week-list">${blocks.join('')}</div>`;
  }

  function subjectGroupEntries(source, semId, selectedWeeks = null) {
    const semester = semesterFor(source, semId);
    const subjects = Array.isArray(semester?.subjects) ? semester.subjects : [];
    const weeks = Array.isArray(selectedWeeks) ? selectedWeeks : weeklyWeeksForSemester(source, semId);
    const groups = new Map();
    const getGroup = (key, label, subject = null) => {
      if (!groups.has(key)) groups.set(key, { key, label, subject, entries:[] });
      return groups.get(key);
    };
    weeks.forEach(week => {
      const rows = rowsForWeek(week, subjects);
      const used = new Set();
      subjects.forEach(subject => {
        let row = rows.find(candidate => !used.has(candidate?.id) && safeText(candidate?.sourceSubjectId) === safeText(subject?.id));
        if (!row) row = rows.find(candidate => !used.has(candidate?.id) && safeText(candidate?.subject).trim().toLowerCase() === subjectName(subject).toLowerCase());
        if (!row) row = displayPlaceholder(week, subject);
        used.add(row.id);
        getGroup(safeText(subject.id) || `subject:${subjectName(subject)}`, subjectName(subject), subject).entries.push({ week, row });
      });
      rows.forEach(row => {
        if (row._v20Placeholder || used.has(row.id)) return;
        const label = safeText(row.subject || 'Untitled Subject') || 'Untitled Subject';
        getGroup(`orphan:${label.toLowerCase()}`, label, null).entries.push({ week, row });
      });
    });
    return { groups:[...groups.values()], breaks:[] };
  }

  function renderSubjectView(source = getState(), semId = semesterIdFor(source), options = undefined) {
    const semester = semesterFor(source, semId);
    const rangeScoped = plainObject(options) && Object.prototype.hasOwnProperty.call(options, 'range');
    const selection = rangeScoped
      ? resolveWeeklySubjectRange(source, semId, options.range)
      : { weeks:weeklyWeeksForSemester(source, semId), range:null, stale:false };
    if (rangeScoped && selection.stale) {
      return emptyMarkup('The saved Subject Track range includes a missing Weekly week. Choose a new range or clear the displayed weeks.');
    }
    if (rangeScoped && !selection.weeks.length) {
      return emptyMarkup('No Subject Track weeks are displayed yet. Choose a start and end week above, then select Add weeks.');
    }
    const { groups, breaks } = subjectGroupEntries(source, semId, selection.weeks);
    const stages = visibleStages(source, semId);
    if (!groups.length && !breaks.length) {
      return emptyMarkup(semester ? `No subject/week rows yet for “${semester.name || 'this semester'}”.` : 'Create subjects and weeks in Weekly first.');
    }
    const stageHead = stages.map(stage => `<th title="${escapeHtml(stage.label)}">${escapeHtml(stage.label)}</th>`).join('');
    const sections = groups.map(group => {
      const progress = entriesProgress(source, semId, group.entries, stages);
      const rows = group.entries.map(({ week, row }) => {
        const date = getWeekDate(week, row);
        const rowProgressValue = rowProgress(source, semId, week.id, row, stages, week);
        const muted = weekIsNonWritable(week) || row._v20Placeholder || row.noClass;
        const weekLabel = week?.isBreak
          ? `BREAK · ${week.event || week.label || 'Break week'}`
          : week?.isExam === true || week?.isExamWeek === true || week?.examWeek === true || week?.kind === 'exam' || week?.type === 'exam'
            ? `EXAM · ${week.event || week.label || 'Exam week'}`
          : (week.label || 'Week');
        const note = row.note || (week?.isBreak ? week.event : '') || '—';
        return `<tr class="${muted ? 'v20-weekly-row-muted' : ''}">
          <td class="v20-weekly-date" title="${escapeHtml(formatWeekRange(week))}">${escapeHtml(weekLabel)}</td>
          <td class="v20-weekly-date" title="${escapeHtml(formatFullDate(date))}">${escapeHtml(formatRowDate(date) || '—')}</td>
          <td class="v20-weekly-note">${escapeHtml(note)}</td>
          ${stages.map(stage => stageCheckMarkup(source, semId, week, row, stage)).join('')}
          <td>${progressMarkup(rowProgressValue, `${group.label} progress`)}</td>
        </tr>`;
      }).join('');
      return `<section class="v20-weekly-subject-section">
        <div class="v20-weekly-subject-head"><div><div class="v20-weekly-subject-title">${escapeHtml(group.label)}</div><div class="v20-weekly-subject-meta">${group.entries.length} week row${group.entries.length === 1 ? '' : 's'}</div></div><div class="v20-weekly-subject-progress">${progressMarkup(progress, `${group.label} total`)}</div></div>
        <div class="v20-weekly-table-wrap"><table class="v20-weekly-table"><thead><tr><th>Week</th><th>Date</th><th>Existing note</th>${stageHead}<th>Progress</th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>`;
    });
    return `<div class="v20-weekly-subject-list">${sections.join('')}</div>`;
  }

  function setWeeklyStatus(message, state = '') {
    weeklyStatusText = safeText(message);
    weeklyStatusState = safeText(state);
    const element = root.document?.getElementById('v20WeeklyTrackingStatus');
    if (element) {
      element.textContent = weeklyStatusText;
      element.dataset.state = weeklyStatusState;
    }
  }

  function renderWeeklyRangeControls(source, semId, storedRange = null) {
    const weeks = weeklyWeeksForSemester(source, semId);
    const resolved = resolveWeeklySubjectRange(source, semId, storedRange);
    const rangeDescription = subjectRangeDescription(source, semId, storedRange);
    const status = !weeks.length
      ? 'No Weekly weeks are available for this semester yet.'
      : resolved.stale
        ? 'The saved range includes a missing Weekly week. Choose a new range or clear the displayed weeks.'
        : resolved.range
          ? `Displaying ${rangeDescription}. Add another range to expand it.`
          : 'No weeks displayed yet. Choose a start and end week, then select Add weeks.';
    const selectedStart = resolved.range?.startWeekId || '';
    const selectedEnd = resolved.range?.endWeekId || '';
    const hasStoredRange = weeklySubjectRangeHasBounds(storedRange);
    const renderOptions = selectedId => weeks.length
      ? `<option value="">Choose a week</option>${weeks.map((week, index) => `<option value="${token(week?.id)}"${safeText(week?.id) === selectedId ? ' selected' : ''}>${escapeHtml(weekDisplayLabel(week, index))} · ${escapeHtml(formatWeekRange(week))}</option>`).join('')}`
      : '<option value="" disabled selected>No Weekly weeks available</option>';
    return `<div class="v20-weekly-range-controls" aria-label="Subject Track displayed week range">
      <div class="v20-weekly-range-heading"><div><strong>Displayed weeks</strong><span>${rangeDescription ? escapeHtml(rangeDescription) : 'None selected'}</span></div><div class="v20-weekly-range-help">Visibility only · Weekly records are unchanged</div></div>
      <div class="v20-weekly-range-fields">
        <label class="v20-weekly-range-field" for="v20SubjectRangeStart">Start week<select class="form-input" id="v20SubjectRangeStart" aria-label="Subject Track start week">${renderOptions(selectedStart)}</select></label>
        <label class="v20-weekly-range-field" for="v20SubjectRangeEnd">End week<select class="form-input" id="v20SubjectRangeEnd" aria-label="Subject Track end week">${renderOptions(selectedEnd)}</select></label>
        <div class="v20-weekly-range-actions"><button class="btn btn-primary btn-sm" type="button" data-v20-weekly-action="add-subject-range" data-v20-sem-id="${token(semId)}" ${weeks.length ? '' : 'disabled'}>Add weeks</button><button class="btn btn-ghost btn-sm" type="button" data-v20-weekly-action="clear-subject-range" data-v20-sem-id="${token(semId)}" ${hasStoredRange ? '' : 'disabled'}>Clear displayed weeks</button></div>
      </div>
      <div class="v20-weekly-range-status" id="v20WeeklyRangeStatus" role="status" aria-live="polite">${escapeHtml(status)}</div>
    </div>`;
  }

  function renderWeeklyOverview(source, semId, range = undefined) {
    const summary = weeklySummary(source, semId, range);
    return `<div class="v20-weekly-overview" aria-label="Weekly Subject Tracking summary">
      <span>${summary.subjects} subject${summary.subjects === 1 ? '' : 's'}</span><span>${summary.availableWeeks} available week${summary.availableWeeks === 1 ? '' : 's'}</span><span>${summary.displayedWeeks} displayed</span><span>${summary.rows} existing row${summary.rows === 1 ? '' : 's'}</span><span>${summary.stages} active stage${summary.stages === 1 ? '' : 's'}</span>
    </div>`;
  }

  function renderWeeklyToolbarControls(source, semId) {
    const document = root.document;
    const host = document?.querySelector('#weeklyTrackerTable .wt-toolbar .wt-toolbar-actions');
    if (!document || !host) return;
    host.querySelector('#v20WeeklyToolbarControls')?.remove();
    const enabled = subjectTrackingEnabled(source);
    const mode = normalizeWeeklyViewMode(weeklyViewMode);
    const wrapper = document.createElement('div');
    wrapper.id = 'v20WeeklyToolbarControls';
    wrapper.className = 'v20-weekly-toolbar-controls';
    wrapper.setAttribute('aria-label', 'Subject Track controls');
    if (!enabled) {
      wrapper.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-v20-weekly-action="open-subject-setup">Set up Subject Track</button>`;
    } else {
      wrapper.innerHTML = `<div class="v20-weekly-view-switch" role="group" aria-label="Weekly view"><button type="button" class="v20-weekly-view-btn" data-v20-weekly-action="set-view" data-v20-view-mode="week" aria-pressed="${mode === 'week' ? 'true' : 'false'}">By week</button><button type="button" class="v20-weekly-view-btn" data-v20-weekly-action="set-view" data-v20-view-mode="subject" aria-pressed="${mode === 'subject' ? 'true' : 'false'}">By subject</button></div><button type="button" class="btn btn-ghost btn-sm" data-v20-weekly-action="open-stage-manager">Subject Track settings</button>`;
    }
    host.appendChild(wrapper);
  }

  function ensureOriginalWeeklySurface(container) {
    const document = root.document;
    if (!document || !container) return null;
    const existing = container.querySelector(`#${WEEKLY_ORIGINAL_SURFACE_ID}`);
    if (existing) return existing;

    // v14 renders the two Weekly toolbars first, followed by either the
    // desktop/mobile table pair or the program/empty-state content. Keep that
    // whole original surface intact so a view switch never has to rebuild it.
    const children = Array.from(container.children || []);
    const toolbars = children.filter(child => child?.classList?.contains('wt-toolbar'));
    const boundary = toolbars[toolbars.length - 1];
    if (!boundary) return null;

    const surface = document.createElement('div');
    surface.id = WEEKLY_ORIGINAL_SURFACE_ID;
    surface.className = 'v20-weekly-original-surface';
    surface.setAttribute('data-v20-original-weekly', 'true');
    const boundaryIndex = children.indexOf(boundary);
    children.slice(boundaryIndex + 1).forEach(child => surface.appendChild(child));
    container.appendChild(surface);
    return surface;
  }

  function setOriginalWeeklySurfaceHidden(surface, hidden) {
    if (!surface) return;
    surface.hidden = !!hidden;
    if (hidden) {
      surface.setAttribute('aria-hidden', 'true');
      surface.setAttribute('inert', '');
      try { surface.inert = true; } catch {}
    } else {
      surface.removeAttribute('aria-hidden');
      surface.removeAttribute('inert');
      try { surface.inert = false; } catch {}
    }
  }

  function renderWeeklyFeatureCard() {
    const document = root.document;
    const container = document?.getElementById('weeklyTrackerTable');
    if (!document || !container) return;
    const source = getState() || {};
    const semId = semesterIdFor(source);
    syncWeeklyViewPreference(semId);
    document.getElementById('v20WeeklySubjectTracking')?.remove();
    const originalSurface = ensureOriginalWeeklySurface(container);
    renderWeeklyToolbarControls(source, semId);
    const subjectMode = subjectTrackingEnabled(source) && normalizeWeeklyViewMode(weeklyViewMode) === 'subject';
    container.classList.toggle('v20-weekly-subject-mode', subjectMode);
    setOriginalWeeklySurfaceHidden(originalSurface, subjectMode);
    if (!subjectMode) return;

    const card = document.createElement('section');
    card.id = 'v20WeeklySubjectTracking';
    card.className = 'v20-weekly-tracking-card';
    card.setAttribute('aria-labelledby', 'v20WeeklySubjectTrackingTitle');
    const storedRange = readWeeklySubjectRange(activeStorageKey(), semId);
    const modeLabel = hostedCloudMode() ? 'v20 account sync' : 'v20 local';
    const trackingCopy = hostedCloudMode()
      ? 'An additive, account-synced overlay over the existing Weekly records. Stage values follow this signed-in account across devices through revision-protected cloud sync. Notes and columns are read-only references here; edit them in By week.'
      : 'An additive, browser-local overlay over the existing Weekly records. Notes and columns are read-only references here; edit them in By week. Choose which existing weeks to display below.';
    card.innerHTML = `<div class="v20-weekly-tracking-head">
      <div><div class="v20-weekly-tracking-title" id="v20WeeklySubjectTrackingTitle">Subject Track <span style="color:var(--accent2);font:800 9px 'Space Mono',monospace;">${escapeHtml(modeLabel)}</span></div><div class="v20-weekly-tracking-copy">${escapeHtml(trackingCopy)}</div></div>
      <button type="button" class="btn btn-ghost btn-sm" data-v20-weekly-action="open-stage-manager">Subject Track settings</button>
    </div>
    ${renderWeeklyRangeControls(source, semId, storedRange)}
    ${renderWeeklyOverview(source, semId, storedRange)}
    <div class="v20-weekly-tracking-status" id="v20WeeklyTrackingStatus" role="status" aria-live="polite" data-state="${escapeHtml(weeklyStatusState)}">${escapeHtml(weeklyStatusText)}</div>
    ${renderSubjectView(source, semId, { range:storedRange })}`;
    if (originalSurface) originalSurface.parentNode?.insertBefore(card, originalSurface);
    else container.append(card);
  }

  function cloneStageLayoutsForSetup(source) {
    const layouts = {};
    const prior = weeklyOverlay(source);
    const semesters = Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : [];
    semesters.forEach(semester => {
      const semId = safeText(semester?.id).trim();
      if (!semId) return;
      const stored = prior?.layouts?.[semId];
      const stages = Array.isArray(stored?.stages)
        ? stored.stages.map((stage, index) => normalizeStage(stage, index))
        : [];
      layouts[semId] = {
        ...(plainObject(stored) ? cloneJson(stored, {}) : {}),
        stages:sortStages(stages).map((stage, index) => ({ ...stage, order:index })),
      };
    });
    return layouts;
  }

  function pendingStageLayout(source, semId) {
    if (!pendingStageLayouts) pendingStageLayouts = cloneStageLayoutsForSetup(source);
    if (!plainObject(pendingStageLayouts[semId])) pendingStageLayouts[semId] = { stages:[] };
    if (!Array.isArray(pendingStageLayouts[semId].stages)) pendingStageLayouts[semId].stages = [];
    pendingStageLayouts[semId].stages = sortStages(pendingStageLayouts[semId].stages.map((stage, index) => normalizeStage(stage, index)));
    pendingStageLayouts[semId].stages.forEach((stage, index) => { stage.order = index; });
    return pendingStageLayouts[semId];
  }

  function setActivationStatus(message, error = false) {
    const document = root.document;
    const element = document?.getElementById('v20WeeklyStageManagerStatus') || document?.getElementById('v20WeeklyEnableStatus');
    if (!element) return;
    element.textContent = safeText(message);
    element.dataset.state = error ? 'error' : '';
  }

  function openSubjectTrackingPrompt(view = 'subject') {
    requestedActivationView = normalizeWeeklyViewMode(view);
    stageManagerSetup = !subjectTrackingEnabled();
    pendingStageLayouts = stageManagerSetup ? cloneStageLayoutsForSetup(getState() || {}) : null;
    stageManagerSemId = semesterIdFor(getState() || {}, stageManagerSemId);
    renderStageManager();
    callRoot('openModal', 'v20WeeklyStageManagerModal');
    return true;
  }

  async function waitForDurableSave(core) {
    if (typeof core.durableSaveDrain !== 'function') {
      throw new Error('Browser storage is unavailable or full; device recovery could not be confirmed.');
    }
    const promise = core.durableSaveDrain();
    if (!promise || typeof promise.then !== 'function') {
      throw new Error('Browser storage is unavailable or full; device recovery could not be confirmed.');
    }
    const result = await promise;
    if (result === false) {
      throw new Error('Browser storage is unavailable or full; device recovery could not be confirmed.');
    }
    return true;
  }

  function browserMirrorUnavailable(core) {
    return core.getSaveMeta?.()?.localStorageAvailable === false;
  }

  async function rollbackState(core, previous, label) {
    try { core.setSQState?.(previous, { resetSyncBaseline:true }); } catch {}
    try { core.syncSQStateReference?.(); } catch {}
    try {
      if (typeof core.persistDeviceState === 'function') {
        await core.persistDeviceState(previous, { pending:false, label });
      }
    } catch (error) {
      callRoot('recordAppError', label, error);
    }
    try {
      if (typeof core.saveState === 'function') {
        core.saveState({ rollback:true, label });
        await waitForDurableSave(core);
      }
    } catch (error) {
      callRoot('recordAppError', `${label}-save`, error);
    }
  }

  function activePendingStages(source, semId) {
    const layout = pendingStageLayout(source, semId);
    return sortStages(layout.stages).filter(stage => stage.archived !== true);
  }

  async function enableSubjectTracking(view = requestedActivationView, layoutSource = pendingStageLayouts) {
    if (activationPromise) return activationPromise;
    if (subjectTrackingEnabled()) {
      const source = getState() || {};
      const semId = semesterIdFor(source);
      weeklyViewMode = normalizeWeeklyViewMode(view);
      const preference = writeWeeklyViewMode(weeklyViewMode, activeStorageKey(), semId);
      if (!preference.ok) setWeeklyStatus(preference.error, 'error');
      renderWeeklyFeatureCard();
      return { ok:true, alreadyEnabled:true };
    }
    activationPromise = (async () => {
      let previous = null;
      let core = getCore();
      let stateChanged = false;
      try {
        const source = getState();
        core = getCore();
        if (!source || typeof core.setSQState !== 'function' || typeof core.persistRecoveryOnly !== 'function') {
          throw new Error('The local StudyQuest save bridge is not ready.');
        }
        previous = cloneJson(source, {});
        const baseBefore = baseWeeklyFingerprint(previous);
        const semId = semesterIdFor(previous, stageManagerSemId);
        const requestedLayouts = plainObject(layoutSource)
          ? cloneJson(layoutSource, {})
          : cloneStageLayoutsForSetup(previous);
        const selectedStages = Array.isArray(requestedLayouts?.[semId]?.stages)
          ? requestedLayouts[semId].stages.filter(stage => stage?.archived !== true)
          : [];
        if (!selectedStages.length) {
          throw new Error('Add at least one active stage in Subject Track settings before enabling it.');
        }
        const label = 'Before enabling v20 Subject Track';
        setActivationStatus('Creating a recovery backup...');
        core.markUserInteracted?.();
        const snapshot = typeof core.makeSafetySnapshot === 'function'
          ? core.makeSafetySnapshot(label, previous)
          : { state:cloneJson(previous, {}), label };
        const backupState = snapshot?.state || previous;
        const backupResult = await core.persistRecoveryOnly(backupState, label);
        if (backupResult !== true) throw new Error('The recovery backup could not be saved. v20 stayed read-only.');
        core.pushAutoBackup?.(label, previous);
        setActivationStatus('Saving your Subject Track settings...');
        const next = cloneJson(previous, {});
        if (!plainObject(next.tracker)) next.tracker = {};
        next.tracker[WEEKLY_OVERLAY_KEY] = buildDefaultWeeklySubjectTracking(next, new Date().toISOString(), requestedLayouts);
        if (baseWeeklyFingerprint(next) !== baseBefore) throw new Error('Existing Weekly data changed while preparing v20.');
        core.setSQState(next);
        stateChanged = true;
        core.syncSQStateReference?.();
        if (typeof core.saveState !== 'function') throw new Error('The local StudyQuest save bridge is not ready.');
        core.saveState();
        await waitForDurableSave(core);
        if (baseWeeklyFingerprint(getState()) !== baseBefore) throw new Error('Existing Weekly data changed while saving v20.');
        if (!subjectTrackingEnabled(getState())) throw new Error('The v20 overlay was not confirmed after saving.');
        weeklyViewMode = normalizeWeeklyViewMode(view);
        const preference = writeWeeklyViewMode(weeklyViewMode, activeStorageKey(), semId);
        stageManagerSetup = false;
        pendingStageLayouts = null;
        callRoot('closeModal', 'v20WeeklyStageManagerModal');
        if (!preference.ok) setWeeklyStatus(preference.error, 'error');
        else if (browserMirrorUnavailable(core)) setWeeklyStatus('Subject Track enabled in device recovery; the browser mirror is full, and existing Weekly records were preserved.', 'saved');
        else setWeeklyStatus('Subject Track enabled; existing Weekly records were preserved.', 'saved');
        callRoot('showToast', 'Subject Track enabled; existing Weekly data was kept', '#6af7b0');
        callRoot('renderWeekly');
        renderWeeklyFeatureCard();
        return { ok:true };
      } catch (error) {
        if (stateChanged && previous) await rollbackState(core, previous, 'v20-weekly-enable-rollback');
        callRoot('recordAppError', 'v20-weekly-enable', error);
        renderStageManager();
        setActivationStatus(`Subject Track stayed off: ${error.message || 'backup or save failed'}`, true);
        setWeeklyStatus(`v20 stayed read-only: ${error.message || 'backup or save failed'}`, 'error');
        callRoot('showToast', `v20 stayed read-only: ${error.message || 'backup or save failed'}`, '#f76a6a');
        return { ok:false, error:error.message || 'backup or save failed' };
      }
    })().finally(() => {
      activationPromise = null;
    });
    return activationPromise;
  }

  function commitWeeklyMutation(label, mutator) {
    const run = async () => {
      const source = getState();
      const core = getCore();
      if (!source || !subjectTrackingEnabled(source)) {
        openSubjectTrackingPrompt('subject');
        return false;
      }
      const previous = cloneJson(source, {});
      const baseBefore = baseWeeklyFingerprint(previous);
      const next = cloneJson(previous, {});
      if (!plainObject(next.tracker)) next.tracker = {};
      const overlay = normalizeWeeklySubjectTracking(next.tracker[WEEKLY_OVERLAY_KEY]);
      next.tracker[WEEKLY_OVERLAY_KEY] = overlay;
      try {
        const changed = mutator(overlay, next);
        if (changed === false) return false;
        if (baseWeeklyFingerprint(next) !== baseBefore) throw new Error('Existing Weekly data changed while saving v20.');
        if (typeof core.setSQState !== 'function' || typeof core.saveState !== 'function') throw new Error('The local StudyQuest save bridge is not ready.');
        core.setSQState(next);
        core.syncSQStateReference?.();
        core.saveState();
        await waitForDurableSave(core);
        if (baseWeeklyFingerprint(getState()) !== baseBefore) throw new Error('Existing Weekly data changed while saving v20.');
        setWeeklyStatus(browserMirrorUnavailable(core)
          ? 'Saved in device recovery; the browser mirror is full, and existing Weekly records were unchanged.'
          : 'Saved locally; existing Weekly records were unchanged.', 'saved');
        callRoot('renderWeekly');
        renderWeeklyFeatureCard();
        return true;
      } catch (error) {
        await rollbackState(core, previous, 'v20-weekly-mutation-rollback');
        callRoot('recordAppError', 'v20-weekly-mutation', error);
        setWeeklyStatus(`Not saved: ${error.message || 'browser storage failed'}`, 'error');
        callRoot('showToast', `v20 change rolled back: ${error.message || 'browser storage failed'}`, '#f76a6a');
        callRoot('renderWeekly');
        renderWeeklyFeatureCard();
        return false;
      }
    };
    const job = mutationQueue.then(run, run);
    mutationQueue = job.catch(() => false);
    return job;
  }

  function toggleSubjectStage(weekId, rowId, stageId) {
    const source = getState();
    const week = (source?.tracker?.weeks || []).find(item => item?.id === safeText(weekId));
    const row = week?.rows?.find(item => item?.id === safeText(rowId));
    if (!week || !row || !rowIsWritable(row, week)) return Promise.resolve(false);
    const semId = safeText(week.semesterId || semesterIdFor(source));
    if (!visibleStages(source, semId).some(stage => stage.id === safeText(stageId))) return Promise.resolve(false);
    return commitWeeklyMutation('Weekly subject stage updated', overlay => {
      if (!plainObject(overlay.cells)) overlay.cells = {};
      if (!plainObject(overlay.cells[weekId])) overlay.cells[weekId] = {};
      if (!plainObject(overlay.cells[weekId][rowId])) overlay.cells[weekId][rowId] = {};
      const current = overlay.cells[weekId][rowId][stageId] === true;
      overlay.cells[weekId][rowId][stageId] = !current;
      return true;
    });
  }

  function commitPendingStageMutation(label, semId, mutator) {
    if (!stageManagerSetup) return null;
    const source = getState() || {};
    const layout = pendingStageLayout(source, semId);
    const changed = mutator(layout);
    if (changed === false) return Promise.resolve(false);
    layout.stages = sortStages(layout.stages).map((stage, index) => ({ ...stage, order:index }));
    weeklyStatusText = `${label}. Create backup and enable to save these settings.`;
    weeklyStatusState = 'pending';
    renderStageManager();
    return Promise.resolve(true);
  }

  function renameStage(semId, stageId, value) {
    const label = safeText(value).trim().slice(0, MAX_STAGE_LABEL_LENGTH);
    if (!label) return Promise.resolve(false);
    if (stageManagerSetup) {
      return commitPendingStageMutation('Stage name updated', semId, layout => {
        const stage = layout.stages.find(item => item.id === stageId);
        if (!stage || stage.label === label) return false;
        stage.label = label;
        return true;
      });
    }
    return commitWeeklyMutation('Weekly stage renamed', overlay => {
      const stage = ensureOverlayLayout(overlay, semId).stages.find(item => item.id === stageId);
      if (!stage || stage.label === label) return false;
      stage.label = label;
      return true;
    }).then(result => { if (result) renderStageManager(); return result; });
  }

  function moveStage(semId, stageId, direction) {
    if (stageManagerSetup) {
      return commitPendingStageMutation('Stage order updated', semId, layout => {
        const stages = sortStages(layout.stages);
        const index = stages.findIndex(stage => stage.id === stageId);
        const target = index + Number(direction || 0);
        if (index < 0 || target < 0 || target >= stages.length) return false;
        [stages[index], stages[target]] = [stages[target], stages[index]];
        layout.stages = stages;
        return true;
      });
    }
    return commitWeeklyMutation('Weekly stage order updated', overlay => {
      const layout = ensureOverlayLayout(overlay, semId);
      const stages = sortStages(layout.stages);
      const index = stages.findIndex(stage => stage.id === stageId);
      const target = index + Number(direction || 0);
      if (index < 0 || target < 0 || target >= stages.length) return false;
      [stages[index], stages[target]] = [stages[target], stages[index]];
      stages.forEach((stage, order) => { stage.order = order; });
      layout.stages = stages;
      return true;
    }).then(result => { if (result) renderStageManager(); return result; });
  }

  function archiveStage(semId, stageId, archived) {
    if (stageManagerSetup) {
      return commitPendingStageMutation(archived ? 'Stage archived' : 'Stage restored', semId, layout => {
        const stage = layout.stages.find(item => item.id === stageId);
        if (!stage || stage.archived === archived) return false;
        stage.archived = archived;
        return true;
      });
    }
    return commitWeeklyMutation(archived ? 'Weekly stage archived' : 'Weekly stage restored', overlay => {
      const stage = ensureOverlayLayout(overlay, semId).stages.find(item => item.id === stageId);
      if (!stage || stage.archived === archived) return false;
      stage.archived = archived;
      return true;
    }).then(result => { if (result) renderStageManager(); return result; });
  }

  function makeCustomStageId(stages) {
    const ids = new Set(stages.map(stage => safeText(stage?.id)));
    let id = `v20stage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    while (ids.has(id)) id += 'x';
    return id;
  }

  function addCustomStage(semId, value) {
    const label = safeText(value).trim().slice(0, MAX_STAGE_LABEL_LENGTH);
    if (!label) return Promise.resolve(false);
    if (stageManagerSetup) {
      return commitPendingStageMutation('Custom stage added', semId, layout => {
        layout.stages.push({ id:makeCustomStageId(layout.stages), label, order:layout.stages.length, archived:false, custom:true });
        return true;
      });
    }
    return commitWeeklyMutation('Custom Weekly stage added', overlay => {
      const layout = ensureOverlayLayout(overlay, semId);
      layout.stages.push({ id:makeCustomStageId(layout.stages), label, order:layout.stages.length, archived:false, custom:true });
      return true;
    }).then(result => { if (result) renderStageManager(); return result; });
  }

  function ensureStageManagerModal() {
    const document = root.document;
    if (!document) return null;
    let modal = document.getElementById('v20WeeklyStageManagerModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'v20WeeklyStageManagerModal';
    modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="v20WeeklyStageManagerTitle" style="width:min(720px,calc(100vw - 24px));max-height:min(90dvh,760px);overflow:auto;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;"><div><div class="modal-title" id="v20WeeklyStageManagerTitle" style="margin-bottom:4px;">Subject Track settings</div><div id="v20WeeklyStageManagerCopy" style="font-size:11px;color:var(--text-muted);line-height:1.5;">Stages are shared by the selected semester. Archiving hides a stage without deleting its saved values.</div></div><button class="task-modal-close" type="button" data-v20-weekly-action="close-manager" title="Close" aria-label="Close">×</button></div>
      <div id="v20WeeklyStageManagerBody" style="margin-top:14px;"></div>
      <div id="v20WeeklyStageManagerFooter" class="modal-btns" style="position:sticky;bottom:-24px;background:var(--surface);padding-top:12px;"></div>
    </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  function renderStageManager() {
    const modal = ensureStageManagerModal();
    const body = modal?.querySelector('#v20WeeklyStageManagerBody');
    if (!modal || !body) return;
    const source = getState() || {};
    const semesters = Array.isArray(source.trackerSemesters) ? source.trackerSemesters : [];
    const fallback = semesterIdFor(source, stageManagerSemId);
    stageManagerSemId = semesters.some(semester => semester.id === stageManagerSemId) ? stageManagerSemId : fallback;
    const semId = stageManagerSemId;
    if (!semId) {
      body.innerHTML = emptyMarkup('Create a semester first.');
      return;
    }
    const layout = stageManagerSetup ? pendingStageLayout(source, semId) : stageLayout(source, semId);
    const stages = sortStages(layout.stages);
    const options = semesters.map(semester => `<option value="${token(semester.id)}" ${semester.id === semId ? 'selected' : ''}>${escapeHtml(semester.name || semester.id)}</option>`).join('');
    const rows = stages.length ? stages.map((stage, index) => {
      const archived = stage.archived === true;
      return `<div class="v20-weekly-manager-row ${archived ? 'archived' : ''}">
        <div class="v20-weekly-manager-order">${index + 1}</div>
        <div class="v20-weekly-manager-name"><input class="form-input" type="text" value="${escapeHtml(stage.label)}" maxlength="${MAX_STAGE_LABEL_LENGTH}" data-v20-weekly-action="rename-stage" data-v20-sem-id="${token(semId)}" data-v20-stage-id="${token(stage.id)}" aria-label="Stage name for ${escapeHtml(stage.label)}"><div class="v20-weekly-manager-meta">${stage.custom ? 'Custom stage' : 'Built-in stage'} · ${archived ? 'Archived; values retained' : 'Visible in both views'}</div></div>
        <div class="v20-weekly-manager-actions"><button class="wt-icon-btn" type="button" data-v20-weekly-action="move-stage" data-v20-sem-id="${token(semId)}" data-v20-stage-id="${token(stage.id)}" data-v20-direction="-1" ${index === 0 ? 'disabled' : ''} title="Move stage up" aria-label="Move ${escapeHtml(stage.label)} up">↑</button><button class="wt-icon-btn" type="button" data-v20-weekly-action="move-stage" data-v20-sem-id="${token(semId)}" data-v20-stage-id="${token(stage.id)}" data-v20-direction="1" ${index === stages.length - 1 ? 'disabled' : ''} title="Move stage down" aria-label="Move ${escapeHtml(stage.label)} down">↓</button>${archived ? `<button class="btn btn-ghost btn-sm" type="button" data-v20-weekly-action="restore-stage" data-v20-sem-id="${token(semId)}" data-v20-stage-id="${token(stage.id)}">Restore</button>` : `<button class="btn btn-ghost btn-sm" type="button" data-v20-weekly-action="archive-stage" data-v20-sem-id="${token(semId)}" data-v20-stage-id="${token(stage.id)}">Archive</button>`}</div>
      </div>`;
    }).join('') : emptyMarkup('No stages yet. Add a custom stage below.');
    body.innerHTML = `<div class="form-group" style="margin-bottom:12px;"><label for="v20WeeklyStageSemester">Semester</label><select class="form-input" id="v20WeeklyStageSemester" data-v20-weekly-action="manager-semester">${options}</select></div>${stageManagerSetup ? '<div class="recovery-empty" style="margin-bottom:12px;">Add at least one active stage. Your existing Weekly data stays unchanged; a verified recovery backup is created before these settings are saved.</div>' : ''}<div class="v20-weekly-manager-list">${rows}</div><div class="v20-weekly-manager-add" style="margin-top:12px;"><label for="v20NewWeeklyStage">Add custom stage<input class="form-input" id="v20NewWeeklyStage" type="text" maxlength="${MAX_STAGE_LABEL_LENGTH}" placeholder="e.g. Flashcards" data-v20-weekly-action="new-stage-input"></label><button class="btn btn-primary btn-sm" type="button" data-v20-weekly-action="add-stage">Add stage</button></div><div id="v20WeeklyStageManagerStatus" class="v20-weekly-tracking-status" role="status" aria-live="polite">${escapeHtml(weeklyStatusText || (stageManagerSetup ? 'These changes are pending until you create a backup and enable Subject Track.' : 'Changes are saved through the existing local Weekly recovery path.'))}</div>`;
    const title = modal.querySelector('#v20WeeklyStageManagerTitle');
    const copy = modal.querySelector('#v20WeeklyStageManagerCopy');
    if (title) title.textContent = stageManagerSetup ? 'Set up Subject Track' : 'Subject Track settings';
    if (copy) copy.textContent = stageManagerSetup
      ? 'Create the stages you want to track for each semester. Nothing is saved until you create a recovery backup and enable Subject Track.'
      : 'Stages are shared by the selected semester. Archiving hides a stage without deleting its saved values.';
    const footer = modal.querySelector('#v20WeeklyStageManagerFooter');
    if (footer) footer.innerHTML = stageManagerSetup
      ? `<button class="btn btn-ghost" type="button" data-v20-weekly-action="cancel-setup">Cancel</button><button class="btn btn-primary" type="button" data-v20-weekly-action="activate" ${stages.some(stage => stage.archived !== true) ? '' : 'disabled'}>Create backup and enable</button>`
      : `<button class="btn btn-ghost" type="button" data-v20-weekly-action="close-manager">Done</button>`;
  }

  function openStageManager() {
    const source = getState() || {};
    if (!subjectTrackingEnabled(source)) {
      stageManagerSetup = true;
      pendingStageLayouts = cloneStageLayoutsForSetup(source);
    } else {
      stageManagerSetup = false;
      pendingStageLayouts = null;
    }
    stageManagerSemId = semesterIdFor(source, stageManagerSemId);
    renderStageManager();
    callRoot('openModal', 'v20WeeklyStageManagerModal');
    return true;
  }

  function setWeeklyViewMode(mode, semId = semesterIdFor(getState() || {})) {
    weeklyViewMode = normalizeWeeklyViewMode(mode);
    if (!subjectTrackingEnabled() && weeklyViewMode === 'subject') {
      openSubjectTrackingPrompt('subject');
      return { ok:false, mode:'week', error:'Enable Subject Track in its settings before choosing By subject.' };
    }
    const result = writeWeeklyViewMode(weeklyViewMode, activeStorageKey(), semId);
    if (!result.ok) setWeeklyStatus(result.error, 'error');
    else setWeeklyStatus(`Showing Weekly ${weeklyViewMode === 'subject' ? 'By subject' : 'By week'}.`, 'saved');
    renderWeeklyFeatureCard();
    return result;
  }

  function afterWeeklyRender() {
    const active = root.document?.getElementById('tab-weekly')?.classList.contains('active');
    if (active) renderWeeklyFeatureCard();
  }

  function didSwitchTab(name) {
    if (safeText(name) === 'weekly') afterWeeklyRender();
  }

  function wrapWeeklyFunction(name) {
    const original = root[name];
    if (typeof original !== 'function' || original.__studyQuestV20WeeklyWrapped) return;
    const wrapped = function wrappedWeeklyFunction(...args) {
      const result = original.apply(this, args);
      afterWeeklyRender();
      return result;
    };
    wrapped.__studyQuestV20WeeklyWrapped = true;
    wrapped.__studyQuestV20WeeklyOriginal = original;
    root[name] = wrapped;
  }

  function installWeeklyWrappers() {
    if (weeklyWrappersInstalled) return;
    ['renderWeekly', 'v14RenderWeekly', 'openWeeklyAtToday', 'v14OpenWeeklyAtToday'].forEach(wrapWeeklyFunction);
    weeklyWrappersInstalled = true;
  }

  function handleSubjectRangeAction(action, target) {
    const source = getState() || {};
    const semId = decodeToken(target?.dataset?.v20SemId) || semesterIdFor(source);
    if (action === 'add-subject-range') {
      const start = root.document?.getElementById('v20SubjectRangeStart')?.value || '';
      const end = root.document?.getElementById('v20SubjectRangeEnd')?.value || '';
      const result = addWeeklySubjectRange(decodeToken(start), decodeToken(end), activeStorageKey(), semId, source);
      if (result.ok) {
        setWeeklyStatus(`Subject Track display expanded to ${subjectRangeDescription(source, semId, result.range)}.`, 'saved');
      } else {
        setWeeklyStatus(result.error, 'error');
      }
      renderWeeklyFeatureCard();
      return true;
    }
    if (action === 'clear-subject-range') {
      const result = clearWeeklySubjectRange(activeStorageKey(), semId);
      if (result.ok) setWeeklyStatus('Subject Track display cleared; saved stage values remain.', 'saved');
      else setWeeklyStatus(result.error, 'error');
      renderWeeklyFeatureCard();
      return true;
    }
    return false;
  }

  function handleWeeklyClick(event) {
    const target = event?.target?.closest?.('[data-v20-weekly-action]');
    if (!target) return;
    const action = target.dataset.v20WeeklyAction;
    if (!action) return;
    if (action === 'set-view') {
      setWeeklyViewMode(target.dataset.v20ViewMode);
    } else if (action === 'open-subject-setup') {
      openSubjectTrackingPrompt('subject');
    } else if (action === 'activate') {
      target.disabled = true;
      void enableSubjectTracking('week', pendingStageLayouts).finally(() => { if (target.isConnected) target.disabled = false; });
    } else if (action === 'cancel-enable' || action === 'cancel-setup') {
      stageManagerSetup = false;
      pendingStageLayouts = null;
      callRoot('closeModal', 'v20WeeklyStageManagerModal');
    } else if (action === 'open-stage-manager') {
      openStageManager();
    } else if (action === 'add-subject-range' || action === 'clear-subject-range') {
      handleSubjectRangeAction(action, target);
    } else if (action === 'close-manager') {
      stageManagerSetup = false;
      pendingStageLayouts = null;
      callRoot('closeModal', 'v20WeeklyStageManagerModal');
    } else if (action === 'toggle-stage') {
      void toggleSubjectStage(decodeToken(target.dataset.v20WeekId), decodeToken(target.dataset.v20RowId), decodeToken(target.dataset.v20StageId));
    } else if (action === 'manager-semester') {
      stageManagerSemId = decodeToken(target.value);
      renderStageManager();
    } else if (action === 'move-stage') {
      void moveStage(decodeToken(target.dataset.v20SemId), decodeToken(target.dataset.v20StageId), Number(target.dataset.v20Direction));
    } else if (action === 'archive-stage' || action === 'restore-stage') {
      void archiveStage(decodeToken(target.dataset.v20SemId), decodeToken(target.dataset.v20StageId), action === 'archive-stage');
    } else if (action === 'add-stage') {
      const input = root.document?.getElementById('v20NewWeeklyStage');
      const value = input?.value || '';
      void addCustomStage(stageManagerSemId, value).then(result => { if (result && input) input.value = ''; });
    }
  }

  function handleWeeklyChange(event) {
    const target = event?.target;
    const action = target?.dataset?.v20WeeklyAction;
    if (action === 'rename-stage') {
      void renameStage(decodeToken(target.dataset.v20SemId), decodeToken(target.dataset.v20StageId), target.value);
    } else if (action === 'manager-semester') {
      stageManagerSemId = decodeToken(target.value);
      renderStageManager();
    }
  }

  function install() {
    if (installed || !root.document) return;
    installed = true;
    loadedStorageKey = noteStorageKey(activeStorageKey());
    noteText = readNote(activeStorageKey());
    // Let the first render hydrate the full per-semester preference map. Keeping
    // this key empty is important: a stored subject preference must not be
    // skipped just because install() ran before the first Weekly render.
    loadedWeeklyViewKey = '';
    weeklyViewPreference = emptyWeeklyViewPreference();
    weeklyViewMode = 'week';
    root.document.addEventListener('input', handleNoteInput);
    root.document.addEventListener('click', handleWeeklyClick);
    root.document.addEventListener('change', handleWeeklyChange);
    root.addEventListener?.('pagehide', handlePageHide);
    root.StudyQuestV20 = api;
    root.studyQuestV20OpenSubjectTrackingPrompt = openSubjectTrackingPrompt;
    root.studyQuestV20EnableSubjectTracking = enableSubjectTracking;
    root.openV20WeeklyStageManager = openStageManager;
    root.studyQuestV20ToggleSubjectStage = toggleSubjectStage;
    root.studyQuestV20DidSwitchTab = didSwitchTab;
    root.studyQuestV20AfterRender = afterRender;
    installWeeklyWrappers();
  }

  function afterRender() {
    afterNoteRender();
    afterWeeklyRender();
  }

  const api = {
    NOTE_STORAGE_SUFFIX,
    NOTE_SCHEMA_VERSION,
    AUTOSAVE_DELAY_MS,
    noteStorageKey,
    normalizeNote,
    notePayload,
    readNote,
    writeNote,
    flushNote,
    afterRender,
    WEEKLY_VIEW_STORAGE_SUFFIX,
    WEEKLY_UI_SCHEMA_VERSION,
    WEEKLY_SUBJECT_SCHEMA_VERSION,
    WEEKLY_OVERLAY_KEY,
    DEFAULT_SUBJECT_STAGE_SPECS,
    normalizeWeeklyViewMode,
    normalizeWeeklySubjectRange,
    normalizeWeeklyViewPreference,
    weeklyViewStorageKey,
    readWeeklyViewMode,
    writeWeeklyViewMode,
    readWeeklySubjectRange,
    writeWeeklySubjectRange,
    weeklyWeeksForSemester,
    resolveWeeklySubjectRange,
    addWeeklySubjectRange,
    clearWeeklySubjectRange,
    normalizeWeeklySubjectTracking,
    buildDefaultWeeklySubjectTracking,
    subjectTrackingEnabled,
    weeklySummary,
    renderWeeklyRangeControls,
    renderSubjectView,
    renderWeekView,
    openSubjectTrackingPrompt,
    enableSubjectTracking,
    toggleSubjectStage,
    openStageManager,
    addCustomStage,
    renameStage,
    moveStage,
    archiveStage,
    setWeeklyViewMode,
    install,
  };

  root.StudyQuestV20 = api;
  root.studyQuestV20Install = install;
  root.studyQuestV20AfterRender = afterRender;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
