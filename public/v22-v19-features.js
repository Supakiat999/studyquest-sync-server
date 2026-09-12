(function installStudyQuestV19Module(root) {
  'use strict';

  root.__STUDYQUEST_V19_SCRIPT_LOADED__ = true;

  const SETTINGS_KEY = '_studyquestV19Settings';
  const SETTINGS_SCHEMA_VERSION = 1;
  const UI_SCHEMA_VERSION = 1;
  const WORKLOAD_SETTINGS_KEY = '_studyquestV19WorkloadSettings';
  const WORKLOAD_SCHEMA_VERSION = 1;
  const DEFAULT_WORKLOAD_BANDS = Object.freeze({
    onTrack: 50,
    busy: 80,
    overloaded: 100,
    critical: 120,
  });
  const MIN_STATUS_PERCENT = 1;
  const MAX_STATUS_PERCENT = 500;
  const DEFAULT_CAPACITY_MINUTES = 240;
  const MIN_CAPACITY_MINUTES = 30;
  const MAX_CAPACITY_MINUTES = 1440;
  const WEEKDAY_LABELS = [
    ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'],
    ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday'],
  ];
  const WORKLOAD_STATUS_LABELS = Object.freeze({
    'no-planned': 'No planned time',
    complete: 'Complete',
    light: 'Light',
    'on-track': 'On track',
    busy: 'Busy',
    overloaded: 'Overloaded',
    critical: 'Critical',
  });
  const CONTEXTS = new Set(['study', 'life', 'both']);
  const MODES = new Set(['study', 'life']);
  const STUDY_ONLY_TABS = new Set(['grades', 'class-guide', 'weekly']);
  const STUDY_TASK_KINDS = new Set(['study', 'exam', 'project']);
  const LIFE_TASK_KINDS = new Set(['life', 'trip']);
  const DEFAULT_UI = Object.freeze({
    schemaVersion: UI_SCHEMA_VERSION,
    activeMode: 'study',
    introSeen: false,
    lastStudyTab: 'grades',
    lastLifeTab: 'tasks',
  });

  let installed = false;
  let currentMode = 'study';
  let includeStudySearch = false;
  let uiPreference = { ...DEFAULT_UI };
  let categoryDraft = null;
  let suppressTabPreferenceWrite = false;
  let originals = null;
  let workloadDraftDirty = false;
  let workloadPanelEnhanced = false;

  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeText(value) {
    return String(value ?? '');
  }

  function escapeHtml(value) {
    return safeText(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function normalizeContext(value, fallback = 'both') {
    const normalized = safeText(value).trim().toLowerCase();
    return CONTEXTS.has(normalized) ? normalized : fallback;
  }

  function normalizeMode(value) {
    const normalized = safeText(value).trim().toLowerCase();
    return MODES.has(normalized) ? normalized : 'study';
  }

  function normalizeName(value, fallback = 'Category') {
    return safeText(value).trim() || fallback;
  }

  function normalizeSettings(raw) {
    const source = plainObject(raw) ? raw : {};
    const rawContexts = plainObject(source.categoryContexts) ? source.categoryContexts : {};
    const categoryContexts = {};
    Object.entries(rawContexts).forEach(([categoryId, entry]) => {
      if (!safeText(categoryId).trim() || !plainObject(entry)) return;
      categoryContexts[categoryId] = {
        ...entry,
        context: normalizeContext(entry.context),
        categoryName: normalizeName(entry.categoryName, categoryId),
      };
    });
    return {
      ...source,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      categoryContexts,
    };
  }

  function normalizeUiPreference(raw) {
    const source = plainObject(raw) ? raw : {};
    return {
      schemaVersion: UI_SCHEMA_VERSION,
      activeMode: normalizeMode(source.activeMode),
      introSeen: source.introSeen === true,
      lastStudyTab: safeText(source.lastStudyTab).trim() || DEFAULT_UI.lastStudyTab,
      lastLifeTab: safeText(source.lastLifeTab).trim() || DEFAULT_UI.lastLifeTab,
    };
  }

  function uiStorageKey(activeStorageKey) {
    const active = safeText(activeStorageKey).trim();
    return `${active || 'studyquest_v3'}_v19_ui`;
  }

  function getState() {
    try { return state; } catch { return root.SQ_State || root.state || null; }
  }

  function getSettings(source = getState()) {
    return normalizeSettings(source?.[SETTINGS_KEY]);
  }

  function categoryContext(source, categoryId) {
    if (!safeText(categoryId).trim()) return 'both';
    return getSettings(source).categoryContexts[categoryId]?.context || 'both';
  }

  function taskContext(source, task) {
    return task?.catId ? categoryContext(source, task.catId) : 'both';
  }

  function taskVisibleInMode(source, task, mode = currentMode) {
    return normalizeMode(mode) === 'study' || taskContext(source, task) !== 'study';
  }

  function categoryVisibleInMode(source, categoryId, mode = currentMode) {
    return normalizeMode(mode) === 'study' || categoryContext(source, categoryId) !== 'study';
  }

  function visibleCategories(source, categories, mode = currentMode) {
    const list = Array.isArray(categories) ? categories : [];
    return normalizeMode(mode) === 'study'
      ? list.slice()
      : list.filter(category => categoryVisibleInMode(source, category?.id, mode));
  }

  function normalizeIdentity(value) {
    return safeText(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function taskKind(task) {
    const kind = safeText(task?.kind || 'task').trim().toLowerCase();
    return kind || 'task';
  }

  function suggestCategoryContext(source, category, academicIdentities = []) {
    const categoryName = normalizeIdentity(category?.name);
    const categoryId = normalizeIdentity(category?.id);
    const identities = new Set((Array.isArray(academicIdentities) ? academicIdentities : [])
      .flatMap(identity => [identity?.name, identity?.code, identity?.id])
      .map(normalizeIdentity)
      .filter(Boolean));
    if ((categoryName && identities.has(categoryName)) || (categoryId && identities.has(categoryId))) {
      return { context: 'study', reason: 'Exact Gradebook or Weekly course match' };
    }
    const tasks = (Array.isArray(source?.tasks) ? source.tasks : []).filter(task => safeText(task?.catId) === safeText(category?.id));
    const hasStudy = tasks.some(task => STUDY_TASK_KINDS.has(taskKind(task)));
    const hasLife = tasks.some(task => LIFE_TASK_KINDS.has(taskKind(task)));
    if (hasStudy && !hasLife) return { context: 'study', reason: 'Only academic task evidence' };
    if (hasLife && !hasStudy) return { context: 'life', reason: 'Only personal or travel task evidence' };
    if (hasStudy && hasLife) return { context: 'both', reason: 'Mixed academic and personal task evidence' };
    return { context: 'both', reason: 'No reliable evidence; visible in both modes' };
  }

  function collectCategoryRows(source, academicIdentities = []) {
    const settings = getSettings(source);
    const rows = [];
    const seen = new Set();
    const append = (category, status) => {
      const id = safeText(category?.id).trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const stored = settings.categoryContexts[id];
      const suggestion = suggestCategoryContext(source, category, academicIdentities);
      rows.push({
        id,
        name: normalizeName(category?.name, stored?.categoryName || id),
        status,
        stored: !!stored,
        context: stored?.context || suggestion.context,
        suggestion: suggestion.context,
        reason: stored ? 'Previously reviewed label' : suggestion.reason,
      });
    };
    (Array.isArray(source?.categories) ? source.categories : []).forEach(category => append(category, category?.archived ? 'archived' : 'active'));
    (Array.isArray(source?.deletedCategories) ? source.deletedCategories : []).forEach(category => append(category, 'trash'));
    Object.entries(settings.categoryContexts).forEach(([id, entry]) => {
      if (seen.has(id)) return;
      rows.push({
        id,
        name: normalizeName(entry?.categoryName, id),
        status: 'orphaned',
        stored: true,
        context: normalizeContext(entry?.context),
        suggestion: normalizeContext(entry?.context),
        reason: 'Orphaned mapping retained for recovery',
      });
    });
    return rows;
  }

  function settingsWithDraft(source, draft, now = Date.now(), options = {}) {
    const current = getSettings(source);
    const nextContexts = { ...current.categoryContexts };
    let changed = false;
    Object.entries(plainObject(draft) ? draft : {}).forEach(([categoryId, value]) => {
      if (!safeText(categoryId).trim()) return;
      const prior = nextContexts[categoryId] || {};
      const entry = plainObject(value) ? value : { context: value };
      const context = normalizeContext(entry.context);
      const categoryName = normalizeName(entry.categoryName, prior.categoryName || categoryId);
      if (prior.context === context && prior.categoryName === categoryName) return;
      changed = true;
      nextContexts[categoryId] = {
        ...prior,
        context,
        categoryName,
        updatedAt: entry.updatedAt || now,
      };
    });
    const setupCompletedAt = options.markSetup ? (current.setupCompletedAt || now) : current.setupCompletedAt;
    if (options.markSetup && !current.setupCompletedAt) changed = true;
    if (!changed) return current;
    return {
      ...current,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      categoryContexts: nextContexts,
      ...(setupCompletedAt ? { setupCompletedAt } : {}),
      updatedAt: now,
    };
  }

  function filterSearchResults(results, source, mode = currentMode, includeStudy = includeStudySearch) {
    const list = Array.isArray(results) ? results.slice() : [];
    if (normalizeMode(mode) === 'study') return list;
    const isStudyResult = result => {
      if (result?.type === 'grade') return true;
      if (result?.type !== 'task') return false;
      const task = (source?.tasks || []).find(item => safeText(item?.id) === safeText(result.id));
      return task ? !taskVisibleInMode(source, task, 'life') : false;
    };
    if (!includeStudy) return list.filter(result => !isStudyResult(result));
    return list.sort((a, b) => Number(isStudyResult(a)) - Number(isStudyResult(b)));
  }

  function hiddenSummary(source) {
    const categories = Array.isArray(source?.categories) ? source.categories : [];
    const hiddenCategoryIds = new Set(categories.filter(category => categoryContext(source, category.id) === 'study').map(category => category.id));
    const hiddenOpenTasks = (Array.isArray(source?.tasks) ? source.tasks : []).filter(task => !task?.done && task?.catId && hiddenCategoryIds.has(task.catId)).length;
    return { hiddenCategories: hiddenCategoryIds.size, hiddenOpenTasks };
  }

  function currentUiKey() {
    return safeText(root.__STUDYQUEST_V19_UI_KEY__).trim()
      || uiStorageKey(root.__STUDYQUEST_ACTIVE_STORAGE_KEY__);
  }

  function readUiPreference() {
    try {
      const raw = root.localStorage?.getItem(currentUiKey());
      return normalizeUiPreference(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...DEFAULT_UI };
    }
  }

  // This is the only v19 local UI write. It is called only after a deliberate
  // mode/tab interaction, never during install, opening, or rendering.
  function writeUiPreference(next) {
    uiPreference = normalizeUiPreference(next);
    try {
      root.localStorage?.setItem(currentUiKey(), JSON.stringify(uiPreference));
      return true;
    } catch {
      return false;
    }
  }

  function call(name, ...args) {
    const fn = root[name];
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  }

  function wholeNumber(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function validCapacity(value) {
    return Number.isSafeInteger(value)
      && value >= MIN_CAPACITY_MINUTES
      && value <= MAX_CAPACITY_MINUTES;
  }

  function validStatusPercent(value) {
    return Number.isSafeInteger(value)
      && value >= MIN_STATUS_PERCENT
      && value <= MAX_STATUS_PERCENT;
  }

  function validStatusBands(bands) {
    return plainObject(bands)
      && validStatusPercent(bands.onTrack)
      && validStatusPercent(bands.busy)
      && validStatusPercent(bands.overloaded)
      && validStatusPercent(bands.critical)
      && bands.onTrack < bands.busy
      && bands.busy < bands.overloaded
      && bands.overloaded < bands.critical;
  }

  function normalizeWorkloadSettings(raw) {
    const source = plainObject(raw) ? raw : {};
    const candidate = plainObject(source.statusBandPercents)
      ? {
        onTrack: wholeNumber(source.statusBandPercents.onTrack),
        busy: wholeNumber(source.statusBandPercents.busy),
        overloaded: wholeNumber(source.statusBandPercents.overloaded),
        critical: wholeNumber(source.statusBandPercents.critical),
      }
      : null;
    const statusBandPercents = validStatusBands(candidate)
      ? candidate
      : { ...DEFAULT_WORKLOAD_BANDS };
    return {
      ...source,
      schemaVersion: WORKLOAD_SCHEMA_VERSION,
      statusBandPercents,
    };
  }

  function workloadSettings(source = getState()) {
    return normalizeWorkloadSettings(source?.[WORKLOAD_SETTINGS_KEY]);
  }

  function weekdayForDateKey(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(safeText(dateStr));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.getUTCDay();
  }

  function effectiveCapacityValues(source = getState()) {
    const v17 = plainObject(source?.['_studyquestV17Settings']) ? source['_studyquestV17Settings'] : {};
    const legacy = plainObject(source?.['_studyquestV16Settings']) ? source['_studyquestV16Settings'] : {};
    const legacyValue = wholeNumber(legacy.dailyCapacityMinutes);
    const fallback = validCapacity(legacyValue) ? legacyValue : DEFAULT_CAPACITY_MINUTES;
    const values = {};
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const stored = wholeNumber(v17.weekdayCapacityMinutes?.[String(weekday)]);
      values[String(weekday)] = validCapacity(stored) ? stored : fallback;
    }
    return values;
  }

  function capacityForDateKey(source, dateStr) {
    const weekday = weekdayForDateKey(dateStr);
    if (weekday === null) return DEFAULT_CAPACITY_MINUTES;
    const values = effectiveCapacityValues(source);
    return values[String(weekday)] || DEFAULT_CAPACITY_MINUTES;
  }

  function workloadSummary(dateStr, source = getState()) {
    let provided = null;
    const provider = typeof root.StudyQuestV18?.workloadSummaryForDate === 'function'
      ? root.StudyQuestV18.workloadSummaryForDate
      : root.studyQuestV17GetWorkloadSummary;
    if (typeof provider === 'function') {
      try { provided = provider(dateStr); } catch {}
    }
    const completedMinutes = Math.max(0, wholeNumber(provided?.completedMinutes) ?? 0);
    const totalPlannedMinutes = Math.max(0, wholeNumber(provided?.totalPlannedMinutes) ?? 0);
    const unfinishedMinutes = Math.max(0, wholeNumber(provided?.unfinishedMinutes) ?? 0);
    const providedCapacity = wholeNumber(provided?.capacityMinutes);
    const capacityMinutes = validCapacity(providedCapacity)
      ? providedCapacity
      : capacityForDateKey(source, dateStr);
    return {
      completedMinutes,
      totalPlannedMinutes,
      unfinishedMinutes,
      capacityMinutes,
      status: statusForWorkload(
        { completedMinutes, totalPlannedMinutes, unfinishedMinutes, capacityMinutes },
        workloadSettings(source),
      ),
    };
  }

  function statusForWorkload(summary, settings = null) {
    const candidate = settings?.statusBandPercents || settings;
    const rules = validStatusBands(candidate)
      ? candidate
      : normalizeWorkloadSettings(settings).statusBandPercents;
    const total = Math.max(0, wholeNumber(summary?.totalPlannedMinutes) ?? 0);
    const unfinished = Math.max(0, wholeNumber(summary?.unfinishedMinutes) ?? 0);
    const capacity = validCapacity(wholeNumber(summary?.capacityMinutes))
      ? wholeNumber(summary.capacityMinutes)
      : DEFAULT_CAPACITY_MINUTES;
    if (total <= 0) return 'no-planned';
    if (unfinished <= 0) return 'complete';
    const ratio = (total / capacity) * 100;
    if (ratio < rules.onTrack) return 'light';
    if (ratio < rules.busy) return 'on-track';
    if (ratio < rules.overloaded) return 'busy';
    if (ratio < rules.critical) return 'overloaded';
    return 'critical';
  }

  function workloadDisplay(summary, settings = workloadSettings()) {
    const key = statusForWorkload(summary, settings);
    const completed = Math.max(0, wholeNumber(summary?.completedMinutes) ?? 0);
    const total = Math.max(0, wholeNumber(summary?.totalPlannedMinutes) ?? 0);
    const unfinished = Math.max(0, wholeNumber(summary?.unfinishedMinutes) ?? 0);
    const capacity = validCapacity(wholeNumber(summary?.capacityMinutes))
      ? wholeNumber(summary.capacityMinutes)
      : DEFAULT_CAPACITY_MINUTES;
    const label = WORKLOAD_STATUS_LABELS[key] || WORKLOAD_STATUS_LABELS['no-planned'];
    const loadPercent = (total / capacity) * 100;
    const formattedLoadPercent = Number.isInteger(loadPercent)
      ? String(loadPercent)
      : loadPercent.toFixed(1);
    const statusBasis = total <= 0
      ? 'There is no planned time.'
      : unfinished <= 0
        ? 'All planned work is complete.'
        : `Status is based on total planned time at ${formattedLoadPercent}% of capacity.`;
    const aria = `${completed} of ${total} planned minutes complete; ${unfinished} unfinished minutes against a ${capacity}-minute capacity. ${statusBasis} Status: ${label}.`;
    return {
      key,
      label,
      text: `${completed}/${total}m · ${label}`,
      aria,
    };
  }

  function workloadMessage(message, error = false) {
    const element = root.document?.getElementById('v17WorkloadSettingsMessage');
    if (!element) return;
    element.textContent = safeText(message);
    element.classList.toggle('error', error);
  }

  function workloadPanel() {
    return root.document?.getElementById('v17WorkloadSettings') || null;
  }

  function setWorkloadFormValues(capacities, bands) {
    const document = root.document;
    if (!document) return;
    document.querySelectorAll('[data-v17-capacity-day]').forEach(input => {
      const value = capacities?.[input.dataset.v17CapacityDay];
      if (value !== undefined) input.value = String(value);
    });
    document.querySelectorAll('[data-v19-band]').forEach(input => {
      const value = bands?.[input.dataset.v19Band];
      if (value !== undefined) input.value = String(value);
    });
  }

  function updateWorkloadBandPreview(bands = null) {
    const element = root.document?.getElementById('v19WorkloadBandPreview');
    if (!element) return;
    const rules = bands && validStatusBands(bands)
      ? bands
      : normalizeWorkloadSettings({ statusBandPercents: bands }).statusBandPercents;
    element.textContent = `Light <${rules.onTrack}% · On track ${rules.onTrack}%+ · Busy ${rules.busy}%+ · Overloaded ${rules.overloaded}%+ · Critical ${rules.critical}%+`;
  }

  function syncWorkloadSettingsForm(force = false) {
    const panel = workloadPanel();
    if (!panel || (workloadDraftDirty && !force)) return;
    const source = getState();
    const settings = workloadSettings(source);
    setWorkloadFormValues(effectiveCapacityValues(source), settings.statusBandPercents);
    updateWorkloadBandPreview(settings.statusBandPercents);
    workloadMessage('Changes apply only after you choose Save workload settings.');
  }

  function readWorkloadSettingsForm() {
    const capacities = {};
    for (const [weekday] of WEEKDAY_LABELS) {
      const input = root.document?.querySelector(`[data-v17-capacity-day="${weekday}"]`);
      const raw = safeText(input?.value).trim();
      if (!/^\d+$/.test(raw)) return { error: 'Each weekday capacity must be a whole number of minutes.' };
      const value = Number(raw);
      if (!validCapacity(value)) return { error: `Weekday capacities must be between ${MIN_CAPACITY_MINUTES} and ${MAX_CAPACITY_MINUTES} minutes.` };
      capacities[weekday] = value;
    }
    const bands = {};
    for (const key of ['onTrack', 'busy', 'overloaded', 'critical']) {
      const input = root.document?.querySelector(`[data-v19-band="${key}"]`);
      const raw = safeText(input?.value).trim();
      if (!/^\d+$/.test(raw)) return { error: 'Each workload boundary must be a whole percentage.' };
      const value = Number(raw);
      if (!validStatusPercent(value)) return { error: `Workload boundaries must be whole percentages from ${MIN_STATUS_PERCENT}% to ${MAX_STATUS_PERCENT}%.` };
      bands[key] = value;
    }
    if (!validStatusBands(bands)) return { error: 'Boundaries must increase strictly: On track < Busy < Overloaded < Critical.' };
    return { capacities, bands };
  }

  function markWorkloadDraftDirty() {
    workloadDraftDirty = true;
    workloadMessage('Unsaved workload settings. Choose Save workload settings to apply them.');
    const values = {};
    root.document?.querySelectorAll('[data-v19-band]').forEach(input => {
      values[input.dataset.v19Band] = wholeNumber(input.value);
    });
    updateWorkloadBandPreview(validStatusBands(values) ? values : null);
  }

  function cancelWorkloadSettings() {
    workloadDraftDirty = false;
    syncWorkloadSettingsForm(true);
    root.document?.getElementById('localLabMenuWrap')?.removeAttribute('open');
  }

  function saveWorkloadSettings() {
    const result = readWorkloadSettingsForm();
    if (result.error) {
      workloadMessage(result.error, true);
      return false;
    }
    const source = getState();
    if (!source) return false;
    const priorCapacities = effectiveCapacityValues(source);
    const priorBands = workloadSettings(source).statusBandPercents;
    const capacitiesChanged = JSON.stringify(priorCapacities) !== JSON.stringify(result.capacities);
    const bandsChanged = JSON.stringify(priorBands) !== JSON.stringify(result.bands);
    if (!capacitiesChanged && !bandsChanged) {
      workloadDraftDirty = false;
      syncWorkloadSettingsForm(true);
      return true;
    }
    call('setUserInteracted');
    call('pushUndoSnapshot', 'Update workload settings');
    if (capacitiesChanged) {
      const prior = plainObject(source['_studyquestV17Settings']) ? source['_studyquestV17Settings'] : {};
      source['_studyquestV17Settings'] = {
        ...prior,
        version: 1,
        weekdayCapacityMinutes: { ...result.capacities },
      };
    }
    if (bandsChanged) {
      const prior = plainObject(source[WORKLOAD_SETTINGS_KEY]) ? source[WORKLOAD_SETTINGS_KEY] : {};
      source[WORKLOAD_SETTINGS_KEY] = {
        ...prior,
        schemaVersion: WORKLOAD_SCHEMA_VERSION,
        statusBandPercents: { ...result.bands },
        updatedAt: Date.now(),
      };
    }
    try {
      call('saveState');
    } catch {
      workloadDraftDirty = true;
      workloadMessage('The settings could not be saved. Your form values remain here; no task data was changed.', true);
      return false;
    }
    workloadDraftDirty = false;
    syncWorkloadSettingsForm(true);
    root.document?.getElementById('localLabMenuWrap')?.removeAttribute('open');
    call('renderAll');
    call('showToast', '✅ Workload settings saved safely.', '#6af7b0');
    return true;
  }

  function restoreWorkloadDefaults() {
    const apply = () => {
      const capacities = {};
      for (let weekday = 0; weekday <= 6; weekday += 1) capacities[String(weekday)] = DEFAULT_CAPACITY_MINUTES;
      setWorkloadFormValues(capacities, DEFAULT_WORKLOAD_BANDS);
      markWorkloadDraftDirty();
      saveWorkloadSettings();
    };
    const options = {
      title: 'Restore workload defaults?',
      message: 'This changes only the seven weekday capacities and workload status boundaries. Tasks, grades, notes, and all other records stay unchanged.',
      confirmText: 'Restore defaults',
      cancelText: 'Keep current settings',
      onConfirm: apply,
    };
    if (typeof root.showAppConfirm === 'function') root.showAppConfirm(options);
    else if (typeof root.confirm === 'function' && root.confirm(options.message)) apply();
  }

  function enhanceWorkloadPanel() {
    const panel = workloadPanel();
    if (!panel || workloadPanelEnhanced) {
      syncWorkloadSettingsForm();
      return;
    }
    workloadPanelEnhanced = true;
    panel.setAttribute('aria-label', 'Daily capacity and workload thresholds');
    const title = panel.querySelector('.v17-workload-settings-title');
    if (title) {
      const copy = title.querySelector('.v17-workload-settings-copy');
      if (title.firstChild) title.firstChild.textContent = 'Daily capacity / overload threshold ';
      if (copy) copy.textContent = 'Unfinished minutes at or above a day’s capacity are Overloaded.';
    }
    const message = panel.querySelector('#v17WorkloadSettingsMessage');
    if (!panel.querySelector('#v19WorkloadAdvanced')) {
      const advanced = root.document.createElement('details');
      advanced.className = 'v19-workload-advanced';
      advanced.id = 'v19WorkloadAdvanced';
      advanced.innerHTML = `
        <summary>More workload settings</summary>
        <div class="v19-workload-advanced-copy">Tune the percentage of each day’s capacity used by unfinished minutes. Exactly 100% is Overloaded.</div>
        <div class="v19-band-grid" role="group" aria-label="Workload status boundaries">
          <label class="v19-band-field"><span>On track starts at</span><input type="number" min="${MIN_STATUS_PERCENT}" max="${MAX_STATUS_PERCENT}" step="1" inputmode="numeric" data-v19-band="onTrack" aria-label="On track boundary percentage"></label>
          <label class="v19-band-field"><span>Busy starts at</span><input type="number" min="${MIN_STATUS_PERCENT}" max="${MAX_STATUS_PERCENT}" step="1" inputmode="numeric" data-v19-band="busy" aria-label="Busy boundary percentage"></label>
          <label class="v19-band-field"><span>Overloaded starts at</span><input type="number" min="${MIN_STATUS_PERCENT}" max="${MAX_STATUS_PERCENT}" step="1" inputmode="numeric" data-v19-band="overloaded" aria-label="Overloaded boundary percentage"></label>
          <label class="v19-band-field"><span>Critical starts at</span><input type="number" min="${MIN_STATUS_PERCENT}" max="${MAX_STATUS_PERCENT}" step="1" inputmode="numeric" data-v19-band="critical" aria-label="Critical boundary percentage"></label>
        </div>
        <div class="v19-workload-band-preview" id="v19WorkloadBandPreview" role="status" aria-live="polite"></div>
      `;
      panel.insertBefore(advanced, message || panel.querySelector('.v17-capacity-actions') || null);
      advanced.querySelectorAll('[data-v19-band]').forEach(input => input.addEventListener('input', markWorkloadDraftDirty));
    }
    const actions = panel.querySelector('.v17-capacity-actions');
    const oldCancel = panel.querySelector('#v17WorkloadCancel');
    const oldSave = panel.querySelector('#v17WorkloadSave');
    if (oldCancel && !oldCancel.dataset.v19Bound) {
      const cancel = oldCancel.cloneNode(true);
      cancel.dataset.v19Bound = '1';
      cancel.textContent = 'Cancel';
      oldCancel.replaceWith(cancel);
      cancel.addEventListener('click', cancelWorkloadSettings);
    }
    if (oldSave && !oldSave.dataset.v19Bound) {
      const save = oldSave.cloneNode(true);
      save.dataset.v19Bound = '1';
      save.textContent = 'Save workload settings';
      oldSave.replaceWith(save);
      save.addEventListener('click', saveWorkloadSettings);
    }
    if (actions && !actions.querySelector('#v19WorkloadRestore')) {
      const restore = root.document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-ghost btn-sm';
      restore.id = 'v19WorkloadRestore';
      restore.textContent = 'Restore defaults';
      restore.title = 'Restore 240 minutes and the default status boundaries';
      restore.addEventListener('click', restoreWorkloadDefaults);
      actions.insertBefore(restore, actions.querySelector('#v17WorkloadSave') || null);
    }
    panel.querySelectorAll('[data-v17-capacity-day]').forEach(input => input.addEventListener('input', markWorkloadDraftDirty));
    const menuWrap = root.document.getElementById('localLabMenuWrap');
    if (menuWrap && !menuWrap.dataset.v19WorkloadBound) {
      menuWrap.dataset.v19WorkloadBound = '1';
      menuWrap.addEventListener('toggle', () => {
        if (!menuWrap.open && workloadDraftDirty) {
          workloadDraftDirty = false;
          syncWorkloadSettingsForm(true);
        }
      });
    }
    syncWorkloadSettingsForm(true);
  }

  function updateTaskWorkloadBadges() {
    const document = root.document;
    if (!document) return;
    document.querySelectorAll('.date-bin').forEach(bin => {
      const date = bin.dataset.date;
      const right = bin.querySelector('.bin-right');
      if (!date || !right) return;
      right.querySelectorAll('.v16-day-workload').forEach(element => element.remove());
      let badge = right.querySelector('.v19-workload-badge');
      if (!badge) {
        badge = document.createElement('div');
        const count = right.querySelector('.bin-count');
        const toggle = right.querySelector('.bin-toggle');
        right.insertBefore(badge, count || toggle || null);
      }
      const display = workloadDisplay(workloadSummary(date));
      badge.className = `v17-day-workload v19-workload-badge v19-workload-${display.key}`;
      badge.textContent = display.text;
      badge.title = display.aria;
      badge.setAttribute('aria-label', display.aria);
      badge.dataset.v19WorkloadStatus = display.key;
    });
  }

  function calendarAnchorDate() {
    const input = root.document?.getElementById('calendarAnchorDate');
    const fromInput = safeText(input?.value).trim();
    if (weekdayForDateKey(fromInput) !== null) return fromInput;
    const fromState = safeText(getState()?.calendarDate).trim();
    return weekdayForDateKey(fromState) !== null ? fromState : (typeof root.today === 'function' ? root.today() : '');
  }

  function calendarWorkloadBadge(host, dateStr) {
    const document = root.document;
    if (!document || !host || weekdayForDateKey(dateStr) === null) return;
    let badge = host.querySelector('.v19-calendar-workload');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'v19-calendar-workload';
      const add = host.querySelector('.calendar-add-day');
      host.insertBefore(badge, add || null);
    }
    const display = workloadDisplay(workloadSummary(dateStr));
    badge.className = `v19-calendar-workload v19-workload-${display.key}`;
    badge.textContent = display.text;
    badge.title = display.aria;
    badge.setAttribute('aria-label', display.aria);
    badge.dataset.v19WorkloadStatus = display.key;
  }

  function updateCalendarWorkloadBadges() {
    const document = root.document;
    const board = document?.getElementById('calendarBoard');
    if (!document || !board) return;
    board.querySelectorAll('[data-v19-calendar-date]').forEach(cell => {
      const host = cell.querySelector('.calendar-day-head, .calendar-month-date') || cell;
      calendarWorkloadBadge(host, cell.dataset.v19CalendarDate);
    });
    const summary = document.getElementById('calendarSummary');
    if (!summary) return;
    summary.querySelectorAll('.v19-calendar-workload-summary').forEach(element => element.remove());
    const dateStr = calendarAnchorDate();
    if (weekdayForDateKey(dateStr) === null) return;
    const display = workloadDisplay(workloadSummary(dateStr));
    const badge = document.createElement('span');
    badge.className = `v19-calendar-workload-summary v19-workload-${display.key}`;
    badge.textContent = display.text;
    badge.title = display.aria;
    badge.setAttribute('aria-label', display.aria);
    badge.dataset.v19WorkloadStatus = display.key;
    summary.appendChild(badge);
  }

  function refreshWorkloadPresentation() {
    enhanceWorkloadPanel();
    updateTaskWorkloadBadges();
    updateCalendarWorkloadBadges();
  }

  function activeTabName() {
    const panel = root.document?.querySelector('.main.active[id^="tab-"]');
    return panel ? panel.id.slice(4) : 'tasks';
  }

  function isLifeMode() {
    return currentMode === 'life';
  }

  function canOpenTab(name) {
    return !isLifeMode() || !STUDY_ONLY_TABS.has(safeText(name));
  }

  function closeModeMenu() {
    const menu = root.document?.getElementById('v19ModeMenu');
    const chip = root.document?.getElementById('v19ModeChip');
    if (menu) menu.hidden = true;
    chip?.setAttribute('aria-expanded', 'false');
  }

  function toggleModeMenu(event) {
    event?.stopPropagation?.();
    const menu = root.document?.getElementById('v19ModeMenu');
    const chip = root.document?.getElementById('v19ModeChip');
    if (!menu) return;
    menu.hidden = !menu.hidden;
    chip?.setAttribute('aria-expanded', String(!menu.hidden));
  }

  function updateModeDom() {
    const document = root.document;
    if (!document) return;
    document.documentElement.dataset.studyquestV19Mode = currentMode;
    document.body?.classList.toggle('v19-life-mode', isLifeMode());
    const label = document.getElementById('v19ModeChipLabel');
    if (label) label.textContent = isLifeMode() ? 'Life' : 'Study';
    document.getElementById('v19ModeStudyChoice')?.classList.toggle('active', !isLifeMode());
    document.getElementById('v19ModeLifeChoice')?.classList.toggle('active', isLifeMode());
    document.getElementById('v19SettingsStudy')?.classList.toggle('active', !isLifeMode());
    document.getElementById('v19SettingsLife')?.classList.toggle('active', isLifeMode());
    const studyLabel = document.getElementById('v19StudyNavLabel');
    if (studyLabel) studyLabel.textContent = isLifeMode() ? 'Activity' : 'Study';
    const studyGroup = document.getElementById('v19StudyNavGroup');
    studyGroup?.setAttribute('aria-label', isLifeMode() ? 'Activity' : 'Study');
    document.querySelectorAll('.v19-study-only').forEach(tab => {
      tab.hidden = isLifeMode();
      tab.setAttribute('aria-hidden', String(isLifeMode()));
      if (isLifeMode()) tab.tabIndex = -1;
    });
    const include = document.getElementById('v19SearchIncludeStudy');
    if (include) include.checked = includeStudySearch;
    const search = document.getElementById('globalSearchInput');
    if (search) search.placeholder = isLifeMode() ? 'Search personal workspace...' : 'Search StudyQuest...';
  }

  function filteredTodaySeconds(source = getState()) {
    const dateKey = typeof root.today === 'function' ? root.today() : '';
    if (!dateKey) return 0;
    const categories = visibleCategories(source, source?.categories || [], 'life');
    return categories.reduce((total, category) => total + Math.max(0, Number(source?.studyTime?.[`${dateKey}_${category.id}`]) || 0), 0);
  }

  function renderHeaderModeMetric() {
    const document = root.document;
    const label = document?.getElementById('todayStudyLabel');
    const value = document?.getElementById('todayStudyHeader');
    const chip = document?.getElementById('todayStudyMetric');
    if (!label || !value) return;
    if (!isLifeMode()) {
      label.textContent = 'Today';
      chip?.setAttribute('title', 'Study time tracked today');
      return;
    }
    label.textContent = 'Focus today';
    const seconds = filteredTodaySeconds();
    value.textContent = typeof root.fmtHeaderStudyTime === 'function'
      ? root.fmtHeaderStudyTime(seconds)
      : `${Math.floor(seconds / 60)}m`;
    chip?.setAttribute('title', 'Focus time today for Life and Both categories');
  }

  function renderHiddenBanner() {
    const banner = root.document?.getElementById('v19HiddenBanner');
    const summary = root.document?.getElementById('v19HiddenSummary');
    if (!banner || !summary) return;
    banner.hidden = !isLifeMode();
    if (!isLifeMode()) return;
    const hidden = hiddenSummary(getState());
    summary.textContent = `${hidden.hiddenCategories} Study categor${hidden.hiddenCategories === 1 ? 'y is' : 'ies are'} hidden with ${hidden.hiddenOpenTasks} open task${hidden.hiddenOpenTasks === 1 ? '' : 's'}. Nothing was deleted.`;
  }

  function renderProgressScope() {
    const layout = root.document?.querySelector('#tab-progress .progress-layout');
    if (!layout) return;
    let note = root.document.getElementById('v19ProgressScopeNote');
    if (!note) {
      note = root.document.createElement('div');
      note.id = 'v19ProgressScopeNote';
      note.className = 'v19-progress-scope-note';
      note.style.gridColumn = '1 / -1';
      layout.prepend(note);
    }
    note.innerHTML = isLifeMode()
      ? '<strong>Life workspace:</strong> category-based Focus totals are filtered. Streak, XP, achievements, and older aggregate charts stay exact and are labeled All Activity because historical records cannot be safely reclassified.'
      : '<strong>All Activity:</strong> this view uses the complete account history. Shared XP, streak, and achievement totals are never rewritten by workspace mode.';
  }

  function afterRender() {
    updateModeDom();
    renderHeaderModeMetric();
    renderHiddenBanner();
    renderProgressScope();
    refreshWorkloadPresentation();
  }

  function applyMode(nextMode, options = {}) {
    const next = normalizeMode(nextMode);
    const currentTab = activeTabName();
    const nextPreference = { ...uiPreference };
    if (currentMode === 'study') nextPreference.lastStudyTab = currentTab;
    else nextPreference.lastLifeTab = currentTab;
    nextPreference.activeMode = next;
    if (options.introSeen === true) nextPreference.introSeen = true;
    currentMode = next;
    includeStudySearch = false;
    writeUiPreference(nextPreference);
    closeModeMenu();
    updateModeDom();

    let target = currentTab;
    if (next === 'life' && STUDY_ONLY_TABS.has(currentTab)) target = uiPreference.lastLifeTab || 'tasks';
    if (next === 'study' && currentTab !== 'travel') target = uiPreference.lastStudyTab || currentTab || 'tasks';
    if (!canOpenTab(target)) target = 'tasks';

    suppressTabPreferenceWrite = true;
    if (target !== currentTab) call('activateStudyQuestTab', target);
    suppressTabPreferenceWrite = false;
    if (typeof root.setFilter === 'function') root.setFilter('all');
    else call('renderAll');
    call('showToast', next === 'life'
      ? '🌿 Life mode is on. School information is hidden, not deleted.'
      : '📚 Study mode restored the complete workspace.', next === 'life' ? '#6af7b0' : '#7c6af7');
  }

  function requestMode(nextMode) {
    const next = normalizeMode(nextMode);
    if (next === currentMode) { closeModeMenu(); return; }
    if (next === 'life' && !uiPreference.introSeen && typeof root.showAppConfirm === 'function') {
      root.showAppConfirm({
        title: 'Switch to Life mode?',
        message: 'Life mode hides Grades, Class Guide, Weekly, exams, and Study-labelled tasks on this device. It does not delete, move, rewrite, or unsync anything. Switch back to Study at any time to restore the complete workspace.',
        confirmText: 'Use Life mode',
        cancelText: 'Stay in Study',
        onConfirm: () => applyMode('life', { introSeen: true }),
      });
      return;
    }
    applyMode(next);
  }

  function didSwitchTab(name) {
    if (!suppressTabPreferenceWrite && canOpenTab(name)) {
      const next = { ...uiPreference };
      if (currentMode === 'study') next.lastStudyTab = name;
      else next.lastLifeTab = name;
      writeUiPreference(next);
    }
    refreshWorkloadPresentation();
  }

  function explainHiddenTab(name) {
    const label = ({ grades: 'Grades', 'class-guide': 'Class Guide', weekly: 'Weekly' })[name] || 'This school view';
    if (typeof root.showAppConfirm !== 'function') return;
    root.showAppConfirm({
      title: `${label} is hidden in Life mode`,
      message: 'The information is still safe in your account. Switch to Study mode to open it.',
      confirmText: 'Switch to Study',
      cancelText: 'Stay in Life',
      onConfirm: () => applyMode('study'),
    });
  }

  function academicIdentities() {
    const identities = [];
    try {
      const courses = typeof root.buildV18ClassGuideCourses === 'function' ? root.buildV18ClassGuideCourses() : [];
      (Array.isArray(courses) ? courses : []).forEach(course => identities.push({ id: course.gradeKey, name: course.courseName, code: course.courseCode }));
    } catch {}
    const source = getState();
    (Array.isArray(source?.trackerSemesters) ? source.trackerSemesters : []).forEach(semester => {
      (Array.isArray(semester?.subjects) ? semester.subjects : []).forEach(subject => identities.push({ id: subject.id, name: subject.subject || subject.name, code: subject.code }));
    });
    return identities;
  }

  function renderCategoryManager() {
    const source = getState();
    const rows = collectCategoryRows(source, academicIdentities());
    const grid = root.document?.getElementById('v19CategoryContextGrid');
    const summary = root.document?.getElementById('v19CategoryManagerSummary');
    if (!grid || !summary) return;
    categoryDraft = Object.fromEntries(rows.map(row => [row.id, { context: row.context, categoryName: row.name }]));
    const suggested = rows.filter(row => !row.stored).length;
    summary.textContent = `${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} · ${suggested} suggestion${suggested === 1 ? '' : 's'} not yet saved · archived, trash, and orphaned mappings remain recoverable.`;
    if (!rows.length) {
      grid.innerHTML = '<div class="v16-empty-state"><strong>No categories yet.</strong><small>Create a category first; no settings were saved.</small></div>';
      return;
    }
    grid.innerHTML = rows.map(row => {
      const encoded = encodeURIComponent(row.id);
      const status = row.status === 'active' ? '' : ` · ${row.status}`;
      return `<div class="v19-context-row" data-v19-category="${escapeHtml(encoded)}">
        <div class="v19-context-copy"><div class="v19-context-name">${escapeHtml(row.name)}${escapeHtml(status)}</div><div class="v19-context-evidence">${escapeHtml(row.reason)}${row.stored ? '' : ` · suggested ${row.suggestion}`}</div></div>
        <div class="v19-context-choices" role="radiogroup" aria-label="Workspace label for ${escapeHtml(row.name)}">
          ${['study','life','both'].map(context => `<label class="v19-context-choice"><input type="radio" name="v19ctx_${escapeHtml(encoded)}" value="${context}" ${row.context === context ? 'checked' : ''}><span>${context === 'study' ? '📚 Study' : context === 'life' ? '🌿 Life' : '↔ Both'}</span></label>`).join('')}
        </div>
      </div>`;
    }).join('');
  }

  function openCategoryManager() {
    closeModeMenu();
    if (root.document?.getElementById('profileSettingsModal')?.classList.contains('open')) call('closeModal', 'profileSettingsModal');
    renderCategoryManager();
    call('openModal', 'v19CategoryManagerModal');
  }

  function cancelCategoryManager() {
    categoryDraft = null;
    call('closeModal', 'v19CategoryManagerModal');
  }

  function saveCategoryLabels() {
    if (!categoryDraft) return false;
    const source = getState();
    if (!source) return false;
    const draft = {};
    root.document?.querySelectorAll('#v19CategoryContextGrid [data-v19-category]').forEach(row => {
      const id = decodeURIComponent(row.dataset.v19Category || '');
      const selected = row.querySelector('input[type="radio"]:checked');
      const existing = categoryDraft[id];
      if (!id || !selected || !existing) return;
      draft[id] = { context: normalizeContext(selected.value), categoryName: existing.categoryName };
    });
    const next = settingsWithDraft(source, draft, Date.now(), { markSetup: true });
    const beforeComparable = JSON.stringify(normalizeSettings(source[SETTINGS_KEY]));
    const nextComparable = JSON.stringify(next);
    if (beforeComparable === nextComparable) {
      cancelCategoryManager();
      call('showToast', 'Category labels are already up to date.');
      return true;
    }
    call('pushUndoSnapshot', 'Update Study and Life category labels');
    source[SETTINGS_KEY] = next;
    call('saveState');
    categoryDraft = null;
    call('closeModal', 'v19CategoryManagerModal');
    call('renderAll');
    call('showToast', '✅ Study and Life labels saved safely.', '#6af7b0');
    return true;
  }

  function prepareCategoryForm(category) {
    const select = root.document?.getElementById('catContext');
    if (!select) return;
    const stored = category?.id ? getSettings().categoryContexts[category.id]?.context : null;
    select.value = stored || (category ? 'both' : currentMode);
  }

  // Called from the existing category Save transaction immediately before its
  // one normal save. This helper never invokes saveState itself.
  function commitCategoryContext(categoryId, categoryName) {
    const source = getState();
    const select = root.document?.getElementById('catContext');
    const id = safeText(categoryId).trim();
    if (!source || !id || !select) return false;
    const context = normalizeContext(select.value, currentMode);
    const current = getSettings(source);
    const prior = current.categoryContexts[id];
    if (prior?.context === context && prior?.categoryName === normalizeName(categoryName, id)) return false;
    source[SETTINGS_KEY] = settingsWithDraft(source, {
      [id]: { context, categoryName: normalizeName(categoryName, id) },
    }, Date.now());
    return true;
  }

  function renderCategoryOptions(categories, currentCategoryId, labeler) {
    const list = Array.isArray(categories) ? categories.slice() : [];
    const option = category => `<option value="${escapeHtml(category.id)}">${escapeHtml(typeof labeler === 'function' ? labeler(category) : category.name)}</option>`;
    if (!isLifeMode()) return list.map(option).join('');
    const personal = list.filter(category => categoryContext(getState(), category.id) !== 'study');
    const study = list.filter(category => categoryContext(getState(), category.id) === 'study');
    const groups = [];
    if (personal.length) groups.push(`<optgroup label="Life and Both">${personal.map(option).join('')}</optgroup>`);
    if (study.length) groups.push(`<optgroup label="Study — hidden in Life mode">${study.map(option).join('')}</optgroup>`);
    return groups.join('');
  }

  function setIncludeStudy(value) {
    includeStudySearch = value === true;
    const input = root.document?.getElementById('globalSearchInput');
    if (input && typeof root.updateGlobalSearch === 'function') root.updateGlobalSearch();
  }

  function filterCurrentSearchResults(results) {
    return filterSearchResults(results, getState(), currentMode, includeStudySearch);
  }

  function openSearchResult(type, id) {
    if (!isLifeMode()) return true;
    const source = getState();
    const task = type === 'task' ? (source?.tasks || []).find(item => safeText(item.id) === safeText(id)) : null;
    const hidden = type === 'grade' || (task && !taskVisibleInMode(source, task, 'life'));
    if (!hidden) return true;
    if (typeof root.showAppConfirm === 'function') {
      root.showAppConfirm({
        title: 'This result is in Study mode',
        message: 'The result is safe and still stored. Switch to Study mode to open it.',
        confirmText: 'Switch and open',
        cancelText: 'Stay in Life',
        onConfirm: () => {
          applyMode('study');
          root.setTimeout?.(() => root.openGlobalSearchResult?.(type, id), 80);
        },
      });
    }
    return false;
  }

  function modeTaskDateCovers(task, dateStr) {
    return taskVisibleInMode(getState(), task, currentMode)
      && (originals?.taskDateCovers ? originals.taskDateCovers(task, dateStr) : false);
  }

  function modeOpenTasksForDate(dateStr) {
    const source = getState();
    const suppressed = root.StudyQuestV18?.isSuppressedTask;
    return (source?.tasks || []).filter(task => modeTaskDateCovers(task, dateStr)
      && !task.done
      && !(typeof suppressed === 'function' && suppressed(task)));
  }

  function install() {
    if (installed || !root.document) return;
    installed = true;
    root.document.documentElement.dataset.studyquestV19Installed = 'true';
    originals = {
      taskDateCovers: root.taskDateCovers,
      getOpenTasksForDate: root.getOpenTasksForDate,
    };
    uiPreference = readUiPreference();
    currentMode = uiPreference.activeMode;

    root.StudyQuestV19 = api;
    root.studyQuestV19TaskVisible = task => taskVisibleInMode(getState(), task, currentMode);
    root.studyQuestV19CategoryVisible = categoryId => categoryVisibleInMode(getState(), categoryId, currentMode);
    root.studyQuestV19VisibleCategories = categories => visibleCategories(getState(), categories, currentMode);
    root.studyQuestV19RenderCategoryOptions = renderCategoryOptions;
    root.studyQuestV19FilterSearchResults = filterCurrentSearchResults;
    root.studyQuestV19OpenSearchResult = openSearchResult;
    root.studyQuestV19SetIncludeStudy = setIncludeStudy;
    root.studyQuestV19IsLifeMode = isLifeMode;
    root.studyQuestV19CanOpenTab = canOpenTab;
    root.studyQuestV19ExplainHiddenTab = explainHiddenTab;
    root.studyQuestV19DidSwitchTab = didSwitchTab;
    root.studyQuestV19AfterRender = afterRender;
    root.toggleV19ModeMenu = toggleModeMenu;
    root.requestV19Mode = requestMode;
    root.openV19CategoryManager = openCategoryManager;
    root.cancelV19CategoryManager = cancelCategoryManager;
    root.saveV19CategoryLabels = saveCategoryLabels;
    root.studyQuestV19PrepareCategoryForm = prepareCategoryForm;
    root.studyQuestV19CommitCategoryContext = commitCategoryContext;
    root.studyQuestV19WorkloadStatus = statusForWorkload;
    root.studyQuestV19WorkloadSummary = workloadSummary;
    root.studyQuestV19NormalizeWorkloadSettings = normalizeWorkloadSettings;
    root.saveV19WorkloadSettings = saveWorkloadSettings;
    root.cancelV19WorkloadSettings = cancelWorkloadSettings;
    root.restoreV19WorkloadDefaults = restoreWorkloadDefaults;

    root.taskDateCovers = modeTaskDateCovers;
    root.getOpenTasksForDate = modeOpenTasksForDate;
    root.studyQuestV16TaskDateCovers = modeTaskDateCovers;
    root.studyQuestV16GetOpenTasksForDate = modeOpenTasksForDate;
    try { taskDateCovers = root.taskDateCovers; } catch {}
    try { getOpenTasksForDate = root.getOpenTasksForDate; } catch {}

    root.document.addEventListener('click', event => {
      if (!root.document.getElementById('v19ModeWrap')?.contains(event.target)) closeModeMenu();
    });
    root.document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeModeMenu();
    });
    enhanceWorkloadPanel();
    updateModeDom();
  }

  const api = {
    SETTINGS_KEY,
    SETTINGS_SCHEMA_VERSION,
    UI_SCHEMA_VERSION,
    DEFAULT_UI,
    normalizeContext,
    normalizeMode,
    normalizeSettings,
    normalizeUiPreference,
    uiStorageKey,
    categoryContext,
    taskContext,
    taskVisibleInMode,
    categoryVisibleInMode,
    visibleCategories,
    suggestCategoryContext,
    collectCategoryRows,
    settingsWithDraft,
    filterSearchResults,
    hiddenSummary,
    WORKLOAD_SETTINGS_KEY,
    WORKLOAD_SCHEMA_VERSION,
    DEFAULT_WORKLOAD_BANDS,
    MIN_STATUS_PERCENT,
    MAX_STATUS_PERCENT,
    normalizeWorkloadSettings,
    effectiveCapacityValues,
    weekdayForDateKey,
    statusForWorkload,
    workloadDisplay,
    workloadSummary,
    install,
  };

  root.StudyQuestV19 = api;
  root.studyQuestV19Install = install;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
