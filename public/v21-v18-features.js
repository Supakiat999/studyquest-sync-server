(function (root) {
  'use strict';

  const SERIES_KEY = '_studyquestV16Series';
  const DURATION_MODE_KEY = '_studyquestV16DurationMode';
  const EARNED_XP_KEY = '_studyquestV16EarnedXP';
  const SETTINGS_KEY = '_studyquestV17Settings';
  const LEGACY_SETTINGS_KEY = '_studyquestV16Settings';
  const DELETION_KEY = '_studyquestV18Deletion';
  const TIME_ZONE = 'Asia/Bangkok';
  const DEFAULT_CAPACITY_MINUTES = 240;
  const MIN_CAPACITY_MINUTES = 30;
  const MAX_CAPACITY_MINUTES = 1440;
  const WEEKDAY_LABELS = [
    ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'],
    ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday'],
  ];
  const HORIZON_DAYS = 365;
  const PATTERNS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'custom'];
  const PATTERN_LABELS = {
    none: 'Does not repeat',
    daily: 'Every day',
    weekdays: 'Weekdays',
    weekly: 'Every week',
    biweekly: 'Every 2 weeks',
    monthly: 'Every month',
    custom: 'Custom interval',
  };

  const isDateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const pad = value => String(value).padStart(2, '0');

  function bangkokDateKey(value = new Date()) {
    if (isDateKey(value)) return value;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : '';
  }

  // Expose the pure logical-date utility immediately. The inline app calls
  // today() during bootstrap, before the feature installer has replaced any
  // render hooks; exposing it here keeps the fixed Bangkok boundary stable.
  root.studyQuestBangkokDateKey = bangkokDateKey;
  root.studyQuestBangkokToday = bangkokDateKey;

  function parseDateKey(value) {
    const source = isDateKey(value) ? value : '1970-01-01';
    const [year, month, day] = source.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function dateKey(value) {
    const date = value instanceof Date ? value : parseDateKey(value);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function addDays(value, amount) {
    const date = parseDateKey(value);
    date.setUTCDate(date.getUTCDate() + Number(amount || 0));
    return dateKey(date);
  }

  function addMonths(value, amount) {
    const date = parseDateKey(value);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + Number(amount || 0));
    return dateKey(date);
  }

  function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  function clampDay(year, monthIndex, day) {
    return Math.min(Math.max(1, Number(day || 1)), daysInMonth(year, monthIndex));
  }

  function monthDate(monthStart, day) {
    const base = parseDateKey(monthStart);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    return `${year}-${pad(month + 1)}-${pad(clampDay(year, month, day))}`;
  }

  function ordinalWeekdayDate(monthStart, ordinal, weekday) {
    const base = parseDateKey(monthStart);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth();
    const wantedWeekday = Math.min(6, Math.max(0, Number(weekday || 0)));
    const wantedOrdinal = Number(ordinal) === -1 ? -1 : Math.min(5, Math.max(1, Number(ordinal || 1)));
    if (wantedOrdinal === -1) {
      const last = new Date(Date.UTC(year, month + 1, 0));
      const delta = (last.getUTCDay() - wantedWeekday + 7) % 7;
      last.setUTCDate(last.getUTCDate() - delta);
      return dateKey(last);
    }
    const first = new Date(Date.UTC(year, month, 1));
    const delta = (wantedWeekday - first.getUTCDay() + 7) % 7;
    const day = 1 + delta + ((wantedOrdinal - 1) * 7);
    if (day > daysInMonth(year, month)) return '';
    return `${year}-${pad(month + 1)}-${pad(day)}`;
  }

  function normalizeWeekdays(value, fallbackDate) {
    const source = Array.isArray(value) ? value : [];
    const days = [...new Set(source.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
    if (days.length) return days;
    return [parseDateKey(fallbackDate).getUTCDay()];
  }

  function normalizeRule(raw, fallbackDate = '') {
    const source = raw && typeof raw === 'object' ? raw : {};
    const rootDate = isDateKey(source.rootDate) ? source.rootDate : (isDateKey(fallbackDate) ? fallbackDate : '');
    const pattern = PATTERNS.includes(source.pattern) ? source.pattern : 'weekly';
    const unit = ['days', 'weeks', 'months'].includes(source.unit) ? source.unit : 'days';
    const interval = Number.isInteger(Number(source.interval)) && Number(source.interval) > 0
      ? Math.min(365, Number(source.interval)) : (pattern === 'biweekly' ? 2 : 1);
    const endMode = ['never', 'until', 'count'].includes(source.endMode) ? source.endMode : 'never';
    const untilDate = endMode === 'until' && isDateKey(source.untilDate) ? source.untilDate : '';
    const occurrenceCount = endMode === 'count' && Number.isInteger(Number(source.occurrenceCount)) && Number(source.occurrenceCount) > 0
      ? Math.min(10000, Number(source.occurrenceCount)) : null;
    const monthlyMode = source.monthlyMode === 'weekday' ? 'weekday' : 'date';
    const monthlyDay = Math.min(31, Math.max(1, Number(source.monthlyDay || (rootDate ? rootDate.slice(8) : 1))));
    const monthlyOrdinal = Number(source.monthlyOrdinal) === -1 ? -1 : Math.min(5, Math.max(1, Number(source.monthlyOrdinal || 1)));
    const monthlyWeekday = Number.isInteger(Number(source.monthlyWeekday))
      ? Math.min(6, Math.max(0, Number(source.monthlyWeekday)))
      : (rootDate ? parseDateKey(rootDate).getUTCDay() : 1);
    return {
      id: String(source.id || ''),
      pattern,
      interval: pattern === 'biweekly' ? 2 : interval,
      unit,
      weekdays: normalizeWeekdays(source.weekdays, rootDate),
      monthlyMode,
      monthlyDay,
      monthlyOrdinal,
      monthlyWeekday,
      endMode,
      untilDate,
      occurrenceCount,
      rootDate,
    };
  }

  function dateWithinEnd(rule, candidate, index) {
    if (rule.endMode === 'until' && rule.untilDate && candidate > rule.untilDate) return false;
    if (rule.endMode === 'count' && rule.occurrenceCount && index >= rule.occurrenceCount) return false;
    return true;
  }

  function buildRecurrenceDates(rawRule, options = {}) {
    const rule = normalizeRule(rawRule, rawRule?.rootDate);
    if (!rule.rootDate) return [];
    const horizonDate = addDays(rule.rootDate, Number.isInteger(options.horizonDays) ? options.horizonDays : HORIZON_DAYS);
    const lastDate = rule.endMode === 'until' && rule.untilDate && rule.untilDate < horizonDate ? rule.untilDate : horizonDate;
    const dates = [];
    const addCandidate = candidate => {
      if (!isDateKey(candidate) || candidate < rule.rootDate || candidate > lastDate) return false;
      if (!dateWithinEnd(rule, candidate, dates.length)) return false;
      if (dates[dates.length - 1] !== candidate) dates.push(candidate);
      return rule.endMode === 'count' && rule.occurrenceCount && dates.length >= rule.occurrenceCount;
    };

    if (rule.pattern === 'daily' || (rule.pattern === 'custom' && rule.unit === 'days')) {
      for (let index = 0; index <= HORIZON_DAYS + 1; index += 1) {
        if (addCandidate(addDays(rule.rootDate, index * rule.interval))) break;
        if (addDays(rule.rootDate, index * rule.interval) > lastDate) break;
      }
      return dates;
    }

    if (rule.pattern === 'weekdays') {
      let cursor = rule.rootDate;
      let weekdayOccurrences = 0;
      while (cursor <= lastDate && dates.length < 10000) {
        const weekday = parseDateKey(cursor).getUTCDay();
        if (weekday >= 1 && weekday <= 5) {
          if (weekdayOccurrences % rule.interval === 0 && addCandidate(cursor)) break;
          weekdayOccurrences += 1;
        }
        cursor = addDays(cursor, 1);
      }
      return dates;
    }

    if (rule.pattern === 'weekly' || rule.pattern === 'biweekly' || (rule.pattern === 'custom' && rule.unit === 'weeks')) {
      let cursor = rule.rootDate;
      const root = parseDateKey(rule.rootDate);
      const selected = new Set(normalizeWeekdays(rule.weekdays, rule.rootDate));
      while (cursor <= lastDate && dates.length < 10000) {
        const current = parseDateKey(cursor);
        const dayDelta = Math.round((current.getTime() - root.getTime()) / 86400000);
        const weekDelta = Math.floor(dayDelta / 7);
        if (selected.has(current.getUTCDay()) && weekDelta >= 0 && weekDelta % rule.interval === 0) {
          if (addCandidate(cursor)) break;
        }
        cursor = addDays(cursor, 1);
      }
      return dates;
    }

    const monthInterval = rule.pattern === 'monthly' ? rule.interval : rule.interval;
    for (let monthIndex = 0; monthIndex <= 14; monthIndex += 1) {
      const monthStart = addMonths(rule.rootDate, monthIndex * monthInterval);
      if (monthStart > lastDate) break;
      const candidate = rule.monthlyMode === 'weekday'
        ? ordinalWeekdayDate(monthStart, rule.monthlyOrdinal, rule.monthlyWeekday)
        : monthDate(monthStart, rule.monthlyDay);
      if (addCandidate(candidate)) break;
    }
    return dates;
  }

  function parseTimeMinutes(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function durationFromTimes(task) {
    const startMinutes = parseTimeMinutes(task?.time);
    const endMinutes = parseTimeMinutes(task?.endTime);
    if (startMinutes === null || endMinutes === null || !isDateKey(task?.date)) return null;
    const endDate = isDateKey(task.endDate) && task.endDate >= task.date ? task.endDate : task.date;
    const start = (parseDateKey(task.date).getTime() / 60000) + startMinutes;
    const end = (parseDateKey(endDate).getTime() / 60000) + endMinutes;
    const value = end - start;
    return value > 0 ? value : null;
  }

  function taskStoredDuration(task) {
    const value = Number(task?.durationMinutes);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function minutesForTaskOnDate(task, dateStr) {
    if (!task || !isDateKey(dateStr) || !isDateKey(task.date)) return 0;
    const stored = taskStoredDuration(task);
    const mode = task?.[DURATION_MODE_KEY] === 'manual' ? 'manual' : 'computed';
    if (mode === 'manual' || !task.endTime) return dateStr === task.date ? (stored || 0) : 0;
    const computed = durationFromTimes(task);
    if (computed === null) return dateStr === task.date ? (stored || 0) : 0;
    const dayStart = parseDateKey(dateStr).getTime() / 60000;
    const dayEnd = dayStart + 1440;
    const start = parseDateKey(task.date).getTime() / 60000 + (parseTimeMinutes(task.time) || 0);
    const endDate = isDateKey(task.endDate) && task.endDate >= task.date ? task.endDate : task.date;
    const end = parseDateKey(endDate).getTime() / 60000 + (parseTimeMinutes(task.endTime) || 0);
    return Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart));
  }

  function seriesMeta(task) {
    const meta = task && task[SERIES_KEY];
    if (meta?.detached === true) return null;
    if (meta && typeof meta === 'object' && meta.id && !meta.detached) {
      return { ...meta, rule: normalizeRule(meta, meta.rootDate || task.date) };
    }
    if (task?.recurrence === 'weekly' && task.recurrenceId && isDateKey(task.date)) {
      return {
        id: String(task.recurrenceId),
        index: 0,
        rootDate: task.recurrenceRootDate || task.date,
        rule: normalizeRule({
          id: String(task.recurrenceId),
          pattern: 'weekly',
          interval: 1,
          weekdays: [parseDateKey(task.recurrenceRootDate || task.date).getUTCDay()],
          rootDate: task.recurrenceRootDate || task.date,
          endMode: 'never',
        }, task.date),
        legacy: true,
      };
    }
    return null;
  }

  function isSuppressedTask(task) {
    const meta = task?.[SERIES_KEY];
    const deletion = task?.[DELETION_KEY];
    return meta?.skipped === true || meta?.superseded === true || meta?.suppressed === true || deletion?.suppressed === true;
  }

  function seriesLabel(task) {
    const meta = seriesMeta(task);
    if (!meta) return '';
    const rule = meta.rule || {};
    const labels = {
      daily: 'daily', weekdays: 'weekdays', weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', custom: `every ${rule.interval} ${rule.unit}`,
    };
    return labels[rule.pattern] || 'repeating';
  }

  const api = {
    SERIES_KEY,
    DURATION_MODE_KEY,
    DELETION_KEY,
    TIME_ZONE,
    HORIZON_DAYS,
    bangkokDateKey,
    normalizeRule,
    buildRecurrenceDates,
    durationFromTimes,
    inlineDurationDisplay,
    isUntouchedComputedDuration,
    minutesForTaskOnDate,
    isSuppressedTask,
    seriesLabel,
    seriesMeta,
    repeatSummary,
    softDeleteSeries,
    normalizeV17Settings,
    weekdayCapacityForDate,
    workloadSummaryForDate,
  };

  let originals = null;
  let installed = false;
  let agendaInitialized = false;
  const openDates = new Set();
  let editorContext = null;
  let workloadSettingsDirty = false;

  function getState() {
    try { return state; } catch { return root.state; }
  }

  function getEditingTaskId() {
    try { return editingTaskId; } catch { return root.editingTaskId || null; }
  }

  function setEditingTaskId(value) {
    try { editingTaskId = value; } catch { root.editingTaskId = value; }
  }

  function setUserInteracted() {
    try { v16UserInteracted = true; } catch {}
  }

  function call(name, ...args) {
    const fn = root[name];
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  }

  function safeEscape(value) {
    return typeof root.escapeHtml === 'function' ? root.escapeHtml(value) : String(value ?? '');
  }

  function installStyles() {
    if (document.getElementById('v16-local-feature-styles')) return;
    const style = document.createElement('style');
    style.id = 'v16-local-feature-styles';
    style.textContent = `
      .v16-repeat-editor { margin-top:8px; padding:10px; border:1px solid var(--border); border-radius:8px; background:rgba(0,0,0,.12); }
      .v16-repeat-editor [hidden] { display:none !important; }
      .v16-repeat-summary { margin-bottom:8px; color:var(--text); font-size:11px; font-weight:800; line-height:1.4; }
      .v16-repeat-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .v16-repeat-grid > label { display:flex; flex-direction:column; gap:4px; min-width:0; color:var(--text-dim); font-size:10px; font-weight:700; }
      .v16-repeat-grid input, .v16-repeat-grid select { min-width:0; }
      .v16-repeat-grid input:disabled, .v16-repeat-grid select:disabled { opacity:.45; cursor:not-allowed; }
      .v16-repeat-inactive { margin-top:7px; color:var(--text-muted); font-size:9px; line-height:1.45; }
      .v16-weekdays { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
      .v16-weekdays label { display:flex; flex-direction:row; align-items:center; gap:3px; padding:4px 6px; border:1px solid var(--border); border-radius:5px; font-size:9px; }
      .v16-repeat-preview, .v16-duration-help { margin-top:7px; color:var(--text-muted); font-size:10px; line-height:1.45; }
      .v16-recalculate { margin-top:6px; padding:4px 7px; border:1px solid var(--border); border-radius:5px; background:var(--surface2); color:var(--text-dim); cursor:pointer; font:inherit; font-size:9px; }
      .v16-day-workload { color:var(--text-muted); font:800 9px 'Space Mono',monospace; white-space:nowrap; }
      .v16-day-workload.warning { color:var(--gold); }
      .v16-day-workload.overloaded { color:var(--red); }
      .v17-workload-settings { margin:8px 0; padding:8px; border:1px solid var(--border); border-radius:7px; background:rgba(0,0,0,.12); min-width:250px; }
      .v17-workload-settings-title { display:flex; flex-direction:column; gap:2px; color:var(--text); font-size:10px; font-weight:800; }
      .v17-workload-settings-copy { color:var(--text-muted); font-size:8px; font-weight:600; line-height:1.35; }
      .v17-capacity-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; margin-top:7px; }
      .v17-capacity-field { display:grid; grid-template-columns:minmax(0,1fr) 58px; align-items:center; gap:4px; min-width:0; color:var(--text-dim); font-size:9px; font-weight:700; }
      .v17-capacity-field input { width:100%; min-width:0; box-sizing:border-box; padding:4px 5px; border:1px solid var(--border); border-radius:4px; background:var(--surface2); color:var(--text); font:inherit; }
      .v17-capacity-field input:focus { border-color:var(--accent); outline:2px solid rgba(124,106,247,.2); }
      .v17-capacity-message { min-height:22px; margin-top:6px; color:var(--text-muted); font-size:8px; line-height:1.35; }
      .v17-capacity-message.error { color:var(--red); }
      .v17-capacity-actions { display:flex; flex-wrap:wrap; gap:5px; margin-top:4px; }
      .v17-day-workload { color:var(--text-muted); font:800 9px 'Space Mono',monospace; white-space:nowrap; }
      .v17-day-workload.warning { color:var(--gold); }
      .v17-day-workload.overloaded { color:var(--red); }
      .v16-task-extra { display:inline-flex; gap:5px; flex-wrap:wrap; margin-left:5px; }
      .v16-task-extra-chip { display:inline-flex; align-items:center; gap:2px; padding:2px 5px; border:1px solid var(--border); border-radius:4px; color:var(--text-dim); font-size:9px; }
      .v16-skip-occurrence { margin-left:4px; padding:2px 5px; border:1px solid var(--border); border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; font:inherit; font-size:9px; }
      .v16-skip-occurrence:hover, .v16-skip-occurrence:focus-visible { color:var(--text); border-color:var(--accent); }
      @media (max-width:700px) { .v16-repeat-grid { grid-template-columns:1fr; } .v17-capacity-grid { grid-template-columns:1fr; } .v17-workload-settings { min-width:0; } }
    `;
    document.head.appendChild(style);
  }

  function ensureTaskForm() {
    const repeat = document.getElementById('taskRepeat');
    if (!repeat) return;
    repeat.innerHTML = `
      <option value="none">Does not repeat</option>
      <option value="daily">Every day</option>
      <option value="weekdays">Weekdays</option>
      <option value="weekly">Every week</option>
      <option value="biweekly">Every 2 weeks</option>
      <option value="monthly">Every month</option>
      <option value="custom">Custom interval</option>
    `;
    const group = repeat.closest('.form-group');
    if (!group) return;
    let panel = document.getElementById('v16RepeatEditor');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'v16RepeatEditor';
      panel.className = 'v16-repeat-editor';
      panel.innerHTML = `
        <div id="v16RepeatSummary" class="v16-repeat-summary" role="status" aria-live="polite"></div>
        <div class="v16-repeat-grid">
          <label id="v16CustomIntervalRow">Repeat every
            <span style="display:flex;gap:4px;"><input id="v16RepeatInterval" class="form-input" type="number" min="1" max="365" step="1" value="1"><select id="v16RepeatUnit" class="form-input"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></span>
          </label>
          <label id="v16MonthlyModeRow">Monthly pattern
            <select id="v16MonthlyMode" class="form-input"><option value="date">Calendar day</option><option value="weekday">Ordinal weekday</option></select>
          </label>
          <label id="v16MonthlyDayRow">Day of month
            <input id="v16MonthlyDay" class="form-input" type="number" min="1" max="31" step="1" value="1">
          </label>
          <label id="v16MonthlyWeekdayRow">Weekday
            <span style="display:flex;gap:4px;"><select id="v16MonthlyOrdinal" class="form-input"><option value="1">First</option><option value="2">Second</option><option value="3">Third</option><option value="4">Fourth</option><option value="-1">Last</option></select><select id="v16MonthlyWeekday" class="form-input"><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></span>
          </label>
          <label id="v16EndModeRow">Ends
            <select id="v16RepeatEndMode" class="form-input"><option value="never">Never</option><option value="until">On date</option><option value="count">After occurrences</option></select>
          </label>
          <label id="v16UntilRow">Until date
            <input id="v16RepeatUntil" class="form-input" type="date">
          </label>
          <label id="v16CountRow">Occurrences
            <input id="v16RepeatCount" class="form-input" type="number" min="1" max="10000" step="1" value="10">
          </label>
          <label id="v16EditScopeRow">Apply changes to
            <select id="v16EditScope" class="form-input"><option value="occurrence">This occurrence</option><option value="future">This and future</option><option value="series">Entire series</option></select>
          </label>
        </div>
        <label id="v16WeekdaysRow" style="display:block;margin-top:8px;color:var(--text-dim);font-size:10px;font-weight:700;">Repeat on
          <span class="v16-weekdays">${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['0','Sun']].map(([value, label]) => `<label><input type="checkbox" value="${value}" data-v16-weekday="${value}"> ${label}</label>`).join('')}</span>
        </label>
        <div id="v16RepeatInactiveNote" class="v16-repeat-inactive"></div>
        <div id="v16RepeatPreview" class="v16-repeat-preview" aria-live="polite"></div>
      `;
      group.appendChild(panel);
    }
    const durationInput = document.getElementById('taskDurationMinutes');
    if (durationInput && !document.getElementById('v16DurationHelp')) {
      const help = document.createElement('div');
      help.id = 'v16DurationHelp';
      help.className = 'v16-duration-help';
      help.innerHTML = '<span id="v16DurationHint">Enter minutes, or leave blank to calculate from start/end time.</span><br><button type="button" class="v16-recalculate" id="v16RecalculateDuration">↻ Recalculate from times</button>';
      durationInput.parentElement.appendChild(help);
    }
    if (repeat.dataset.v16Bound !== '1') {
      repeat.dataset.v16Bound = '1';
      repeat.addEventListener('change', () => {
        if (['weekly', 'biweekly'].includes(repeat.value)) selectDefaultRepeatWeekday();
        if (repeat.value === 'custom' && document.getElementById('v16RepeatUnit')?.value === 'weeks') selectDefaultRepeatWeekday();
        updateRepeatUi();
      });
      ['v16RepeatInterval', 'v16RepeatUnit', 'v16MonthlyMode', 'v16MonthlyDay', 'v16MonthlyOrdinal', 'v16MonthlyWeekday', 'v16RepeatEndMode', 'v16RepeatUntil', 'v16RepeatCount'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateRepeatUi);
        document.getElementById(id)?.addEventListener('change', updateRepeatUi);
      });
      document.getElementById('v16RepeatUnit')?.addEventListener('change', () => {
        if (document.getElementById('v16RepeatUnit')?.value === 'weeks') selectDefaultRepeatWeekday();
        updateRepeatUi();
      });
      document.querySelectorAll('[data-v16-weekday]').forEach(input => input.addEventListener('change', updateRepeatUi));
      document.getElementById('v16RecalculateDuration')?.addEventListener('click', () => {
        setUserInteracted();
        const value = durationFromTimes({
          date: document.getElementById('taskDate')?.value || '',
          endDate: document.getElementById('taskEndDate')?.value || '',
          time: document.getElementById('taskTime')?.value || '',
          endTime: document.getElementById('taskEndTime')?.value || '',
        });
        const input = document.getElementById('taskDurationMinutes');
        if (input) {
          input.value = value === null ? '' : String(value);
          input.dataset.v16DurationMode = 'computed';
        }
        updateDurationHint();
      });
      ['taskDate', 'taskEndDate', 'taskTime', 'taskEndTime', 'taskDurationMinutes'].forEach(id => {
        const input = document.getElementById(id);
        input?.addEventListener('input', () => {
          if (id === 'taskDurationMinutes') input.dataset.v16DurationMode = 'manual';
          updateDurationHint();
          updateRepeatUi();
        });
      });
    }
    updateRepeatUi();
    updateDurationHint();
  }

  function getFormDate() { return document.getElementById('taskDate')?.value || ''; }

  function selectDefaultRepeatWeekday() {
    const date = getFormDate();
    if (!date) return;
    const inputs = [...document.querySelectorAll('[data-v16-weekday]')];
    if (inputs.some(input => input.checked)) return;
    const weekday = String(parseDateKey(date).getUTCDay());
    const input = inputs.find(item => item.value === weekday);
    if (input) input.checked = true;
  }

  function editingSeriesTask() {
    const id = getEditingTaskId();
    if (!id) return null;
    const current = getState();
    return current?.tasks?.find(task => String(task.id) === String(id)) || null;
  }

  function setRepeatRowVisible(id, visible) {
    const element = document.getElementById(id);
    if (!element) return;
    element.hidden = !visible;
    element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    element.querySelectorAll('input, select, button, textarea').forEach(control => {
      control.disabled = !visible;
    });
  }

  function repeatDayLabel(value) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(value)] || '';
  }

  function repeatSummary(rule) {
    if (!rule) return 'One-time task. No future occurrences will be generated.';
    let summary = PATTERN_LABELS[rule.pattern] || 'Repeating task';
    if (rule.pattern === 'weekly' || rule.pattern === 'biweekly' || (rule.pattern === 'custom' && rule.unit === 'weeks')) {
      const days = (rule.weekdays || []).map(repeatDayLabel).filter(Boolean).join(', ');
      if (days) summary += ` on ${days}`;
    } else if (rule.pattern === 'monthly' || (rule.pattern === 'custom' && rule.unit === 'months')) {
      summary += rule.monthlyMode === 'weekday'
        ? ` on the selected ${rule.monthlyOrdinal === -1 ? 'last' : ['first', 'second', 'third', 'fourth', 'fifth'][rule.monthlyOrdinal - 1] || 'first'} weekday`
        : ` on day ${rule.monthlyDay}`;
    } else if (rule.pattern === 'custom') {
      summary = `Every ${rule.interval} ${rule.unit}`;
    }
    if (rule.endMode === 'until') summary += ` until ${rule.untilDate || 'the selected date'}`;
    if (rule.endMode === 'count') summary += ` · ${rule.occurrenceCount || 0} occurrences`;
    return summary;
  }

  function getFormRule(existing = null) {
    const pattern = document.getElementById('taskRepeat')?.value || 'none';
    if (pattern === 'none') return null;
    const date = getFormDate();
    const intervalInput = Number(document.getElementById('v16RepeatInterval')?.value || 1);
    const endMode = document.getElementById('v16RepeatEndMode')?.value || 'never';
    const selectedDays = [...document.querySelectorAll('[data-v16-weekday]:checked')].map(input => Number(input.value));
    const rule = normalizeRule({
      id: existing?.id || Math.random().toString(36).slice(2, 11),
      pattern,
      interval: pattern === 'biweekly' ? 2 : (pattern === 'custom' ? intervalInput : 1),
      unit: pattern === 'custom' ? (document.getElementById('v16RepeatUnit')?.value || 'days') : (pattern === 'monthly' ? 'months' : 'days'),
      weekdays: selectedDays,
      monthlyMode: document.getElementById('v16MonthlyMode')?.value || 'date',
      monthlyDay: Number(document.getElementById('v16MonthlyDay')?.value || (date ? date.slice(8) : 1)),
      monthlyOrdinal: Number(document.getElementById('v16MonthlyOrdinal')?.value || 1),
      monthlyWeekday: Number(document.getElementById('v16MonthlyWeekday')?.value || (date ? parseDateKey(date).getUTCDay() : 1)),
      endMode,
      untilDate: document.getElementById('v16RepeatUntil')?.value || '',
      occurrenceCount: Number(document.getElementById('v16RepeatCount')?.value || 0),
      rootDate: date,
    }, date);
    const usesWeekdays = pattern === 'weekly' || pattern === 'biweekly' || (pattern === 'custom' && rule.unit === 'weeks');
    if (usesWeekdays && !selectedDays.length && date) rule.weekdays = [parseDateKey(date).getUTCDay()];
    return rule;
  }

  function updateRepeatUi() {
    const pattern = document.getElementById('taskRepeat')?.value || 'none';
    const panel = document.getElementById('v16RepeatEditor');
    if (!panel) return;
    const editingSeries = !!editingSeriesTask();
    const panelVisible = pattern !== 'none' || editingSeries;
    panel.hidden = !panelVisible;
    panel.setAttribute('aria-hidden', panelVisible ? 'false' : 'true');
    const showCustom = pattern === 'custom';
    const customUnit = document.getElementById('v16RepeatUnit')?.value || 'days';
    const showMonthly = pattern === 'monthly' || (pattern === 'custom' && customUnit === 'months');
    const showWeekdays = pattern === 'weekly' || pattern === 'biweekly' || (pattern === 'custom' && customUnit === 'weeks');
    setRepeatRowVisible('v16CustomIntervalRow', showCustom);
    setRepeatRowVisible('v16MonthlyModeRow', showMonthly);
    const monthlyMode = document.getElementById('v16MonthlyMode')?.value || 'date';
    setRepeatRowVisible('v16MonthlyDayRow', showMonthly && monthlyMode === 'date');
    setRepeatRowVisible('v16MonthlyWeekdayRow', showMonthly && monthlyMode === 'weekday');
    setRepeatRowVisible('v16WeekdaysRow', showWeekdays);
    const endMode = document.getElementById('v16RepeatEndMode')?.value || 'never';
    setRepeatRowVisible('v16EndModeRow', pattern !== 'none');
    setRepeatRowVisible('v16UntilRow', pattern !== 'none' && endMode === 'until');
    setRepeatRowVisible('v16CountRow', pattern !== 'none' && endMode === 'count');
    setRepeatRowVisible('v16EditScopeRow', editingSeries);
    const hint = document.getElementById('taskRepeatHint');
    if (hint) hint.textContent = pattern === 'none'
      ? 'Optional. Choose a repeat type to generate future occurrences.'
      : 'Only the settings used by this repeat type are active. Completed occurrences remain recoverable when the series changes.';
    const summary = document.getElementById('v16RepeatSummary');
    const inactiveNote = document.getElementById('v16RepeatInactiveNote');
    const rule = pattern === 'none' ? null : getFormRule();
    if (summary) summary.textContent = repeatSummary(rule);
    if (inactiveNote) {
      inactiveNote.textContent = pattern === 'none'
        ? (editingSeries ? 'This occurrence belongs to a series. Choose how your changes should apply, or choose a new repeat type.' : 'Repeat settings will appear after you choose a repeat type.')
        : pattern === 'daily'
          ? 'Daily uses the task start date; weekday and monthly settings are not needed.'
          : pattern === 'weekdays'
            ? 'Weekdays repeats Monday through Friday; choose an ending rule below.'
            : pattern === 'weekly' || pattern === 'biweekly'
              ? 'Choose one or more weekdays. The task date is selected by default.'
              : pattern === 'monthly'
                ? 'Choose either a calendar day or an ordinal weekday for each month.'
                : customUnit === 'days'
                  ? 'Custom day intervals use only the interval and ending rule.'
                  : customUnit === 'weeks'
                    ? 'Custom week intervals also use the selected weekdays.'
                    : 'Custom month intervals also use the monthly pattern.';
    }
    updateRepeatPreview();
  }

  function updateRepeatPreview() {
    const preview = document.getElementById('v16RepeatPreview');
    if (!preview) return;
    const pattern = document.getElementById('taskRepeat')?.value || 'none';
    if (pattern === 'none') { preview.textContent = ''; return; }
    const rule = getFormRule();
    if (!rule?.rootDate) { preview.textContent = 'Choose a start date to preview occurrences.'; return; }
    const dates = buildRecurrenceDates(rule, { horizonDays: HORIZON_DAYS }).slice(0, 5);
    preview.textContent = `${repeatSummary(rule)}\nNext: ${dates.join(' · ') || 'No valid dates'}`;
  }

  function updateDurationHint() {
    const hint = document.getElementById('v16DurationHint');
    const input = document.getElementById('taskDurationMinutes');
    if (!hint || !input) return;
    const calculated = durationFromTimes({
      date: document.getElementById('taskDate')?.value || '',
      endDate: document.getElementById('taskEndDate')?.value || '',
      time: document.getElementById('taskTime')?.value || '',
      endTime: document.getElementById('taskEndTime')?.value || '',
    });
    if (input.dataset.v16DurationMode !== 'manual' && calculated !== null && document.activeElement !== input) {
      input.value = String(calculated);
      input.dataset.v16DurationMode = 'computed';
    }
    hint.textContent = calculated === null
      ? 'Enter whole minutes, or provide valid start and end times to calculate them.'
      : `${calculated} minutes from the current start/end times. Manual edits are preserved until recalculated.`;
  }

  function validateForm(rule, duration) {
    const date = getFormDate();
    const endDate = document.getElementById('taskEndDate')?.value || '';
    const time = document.getElementById('taskTime')?.value || '';
    const endTime = document.getElementById('taskEndTime')?.value || '';
    if (endDate && (!date || endDate < date)) return 'End date must be on or after the start date.';
    if (time && endTime && endDate === date && endTime <= time) return 'End time must be after start time.';
    if (rule && !date) return 'Repeating tasks need a start date.';
    if (rule?.endMode === 'until' && (!rule.untilDate || rule.untilDate < date)) return 'Repeat-until date must be on or after the start date.';
    if (rule?.endMode === 'count' && (!Number.isInteger(rule.occurrenceCount) || rule.occurrenceCount < 1)) return 'Repeat count must be a positive whole number.';
    if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0)) return 'Duration must use whole minutes only.';
    return '';
  }

  function readDuration() {
    const input = document.getElementById('taskDurationMinutes');
    const raw = input?.value?.trim() || '';
    const calculated = durationFromTimes({
      date: getFormDate(),
      endDate: document.getElementById('taskEndDate')?.value || '',
      time: document.getElementById('taskTime')?.value || '',
      endTime: document.getElementById('taskEndTime')?.value || '',
    });
    if (!raw) return { value: calculated, mode: calculated === null ? null : 'computed' };
    const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0) return { error: 'Duration must use whole minutes only.' };
    return { value: parsed, mode: input?.dataset.v16DurationMode === 'computed' ? 'computed' : 'manual' };
  }

  function taskFieldsFromForm(duration, xpSelection = null) {
    const input = document.getElementById('taskDurationMinutes');
    const fields = {
      title: document.getElementById('taskName')?.value?.trim() || '',
      catId: document.getElementById('taskCat')?.value || '',
      date: getFormDate(),
      endDate: document.getElementById('taskEndDate')?.value || '',
      time: document.getElementById('taskTime')?.value || '',
      endTime: document.getElementById('taskEndTime')?.value || '',
      notes: document.getElementById('taskNotes')?.value?.trim() || '',
      xp: Number(xpSelection?.value ?? getSelectedXP()),
      kind: typeof root.normalizeTaskKind === 'function' ? root.normalizeTaskKind(document.getElementById('taskKind')?.value) : (document.getElementById('taskKind')?.value || 'task'),
      priorityLevel: typeof root.normalizePriorityLevel === 'function' ? root.normalizePriorityLevel(document.getElementById('taskPriorityLevel')?.value) : (document.getElementById('taskPriorityLevel')?.value || 'normal'),
    };
    fields.durationMinutes = duration.value;
    fields.durationMode = duration.mode;
    if (fields.endDate === fields.date) fields.endDate = '';
    if (fields.durationMinutes === null) delete fields.durationMinutes;
    if (!fields.durationMode) delete fields.durationMode;
    if (input?.dataset.v16DurationMode === 'manual') fields.durationMode = 'manual';
    if (fields.durationMode) {
      fields[DURATION_MODE_KEY] = fields.durationMode;
      delete fields.durationMode;
    }
    return fields;
  }

  function getSelectedXP() {
    const selection = root.studyQuestV16ReadXP?.();
    if (selection?.ok) return selection.value;
    try { return selectedXP; } catch { return root.selectedXP || 10; }
  }

  function applyTaskFields(task, fields) {
    Object.assign(task, {
      title: fields.title,
      catId: fields.catId,
      date: fields.date,
      endDate: fields.endDate,
      time: fields.time,
      endTime: fields.endTime,
      notes: fields.notes,
      xp: fields.xp,
      kind: fields.kind,
      priorityLevel: fields.priorityLevel,
    });
    if (fields.durationMinutes === undefined) delete task.durationMinutes;
    else task.durationMinutes = fields.durationMinutes;
    if (fields[DURATION_MODE_KEY]) task[DURATION_MODE_KEY] = fields[DURATION_MODE_KEY];
    else delete task[DURATION_MODE_KEY];
  }

  function makeOccurrence(base, occurrenceDate, index, rule) {
    const payload = {
      ...base,
      id: index === 0 && base.id ? base.id : (Math.random().toString(36).slice(2, 11)),
      date: occurrenceDate,
      endDate: base.endDate && base.endDate > base.date ? addDays(occurrenceDate, Math.max(0, Math.round((parseDateKey(base.endDate).getTime() - parseDateKey(base.date).getTime()) / 86400000))) : '',
      done: index === 0 ? !!base.done : false,
      progressPercent: index === 0 ? Number(base.progressPercent || 0) : 0,
      progressBeforeDone: index === 0 ? Number(base.progressBeforeDone || 0) : 0,
      createdAt: Number(base.createdAt || Date.now()) + index,
      recurrence: 'none',
      recurrenceId: '',
      recurrenceRootDate: '',
    };
    const normalized = typeof root.normalizeTaskItem === 'function' ? root.normalizeTaskItem(payload) : payload;
    if (!normalized.done) delete normalized[EARNED_XP_KEY];
    normalized[SERIES_KEY] = {
      version: 1,
      id: rule.id,
      index,
      rootDate: rule.rootDate,
      pattern: rule.pattern,
      interval: rule.interval,
      unit: rule.unit,
      weekdays: [...rule.weekdays],
      monthlyMode: rule.monthlyMode,
      monthlyDay: rule.monthlyDay,
      monthlyOrdinal: rule.monthlyOrdinal,
      monthlyWeekday: rule.monthlyWeekday,
      endMode: rule.endMode,
      untilDate: rule.untilDate,
      occurrenceCount: rule.occurrenceCount,
    };
    return normalized;
  }

  function seriesTasks(seriesId) {
    const current = getState();
    return (current?.tasks || []).filter(task => {
      const meta = task?.[SERIES_KEY];
      if (meta?.detached === true) return false;
      return (meta?.id && String(meta.id) === String(seriesId)) || (task?.recurrenceId && String(task.recurrenceId) === String(seriesId));
    });
  }

  function createSeries(base, rule, preserveDates = new Set()) {
    const current = getState();
    const dates = buildRecurrenceDates(rule, { horizonDays: HORIZON_DAYS });
    const existing = new Set((current?.tasks || []).filter(task => !isSuppressedTask(task)).map(task => `${task.date}|${task.title || ''}|${task[SERIES_KEY]?.id || ''}`));
    const completedDates = new Set(preserveDates);
    const newTasks = [];
    dates.forEach((date, index) => {
      if (completedDates.has(date)) return;
      const key = `${date}|${base.title || ''}|${rule.id}`;
      if (existing.has(key)) return;
      newTasks.push(makeOccurrence(base, date, index, rule));
    });
    current.tasks.push(...newTasks);
    return newTasks;
  }

  function markSeriesSuperseded(seriesId, fromDate = '', entire = false) {
    const current = getState();
    const preservedDates = new Set();
    seriesTasks(seriesId).forEach(task => {
      const afterStart = entire || !fromDate || task.date >= fromDate;
      if (!afterStart) return;
      if (task.done) preservedDates.add(task.date);
      else {
        task[SERIES_KEY] = { ...(task[SERIES_KEY] || {}), superseded: true };
      }
    });
    return preservedDates;
  }

  function storedSeriesMetadata(task) {
    if (!task) return null;
    const current = task[SERIES_KEY];
    if (current && typeof current === 'object' && current.id) return { ...current };
    const derived = seriesMeta(task);
    if (!derived) return null;
    return {
      version: 1,
      id: derived.id,
      index: Number(derived.index || 0),
      rootDate: derived.rootDate || task.date || '',
      pattern: derived.rule?.pattern || 'weekly',
      interval: derived.rule?.interval || 1,
      unit: derived.rule?.unit || 'days',
      weekdays: [...(derived.rule?.weekdays || [])],
      monthlyMode: derived.rule?.monthlyMode || 'date',
      monthlyDay: derived.rule?.monthlyDay || (task.date ? Number(task.date.slice(8)) : 1),
      monthlyOrdinal: derived.rule?.monthlyOrdinal || 1,
      monthlyWeekday: derived.rule?.monthlyWeekday ?? (task.date ? parseDateKey(task.date).getUTCDay() : 1),
      endMode: derived.rule?.endMode || 'never',
      untilDate: derived.rule?.untilDate || '',
      occurrenceCount: derived.rule?.occurrenceCount || null,
    };
  }

  function softDeleteSeries(taskId, mode = 'single') {
    const current = getState();
    const task = current?.tasks?.find(item => String(item.id) === String(taskId));
    const info = seriesMeta(task);
    if (!task || !info || !['single', 'future', 'series'].includes(mode)) return false;
    const members = seriesTasks(info.id);
    const fromDate = task.date || info.rootDate || '';
    const stopFromDate = mode === 'series' ? (info.rootDate || fromDate) : fromDate;
    const now = new Date().toISOString();
    const reason = mode === 'single' ? 'deleted-occurrence' : mode === 'future' ? 'deleted-future' : 'deleted-series';
    call('pushUndoSnapshot', mode === 'single' ? 'Delete repeating occurrence' : mode === 'future' ? 'Delete future repeating events' : 'Delete repeating series');
    let hiddenCount = 0;

    members.forEach(member => {
      const inScope = mode === 'series'
        || (mode === 'future' && (!fromDate || !member.date || member.date >= fromDate))
        || (mode === 'single' && String(member.id) === String(taskId));
      if (!inScope) return;
      const prior = member[DELETION_KEY] && typeof member[DELETION_KEY] === 'object' ? member[DELETION_KEY] : {};
      const next = {
        ...prior,
        version: 1,
        seriesId: String(info.id),
        scope: mode,
        reason,
        deletedAt: now,
      };
      if (mode !== 'single') {
        next.seriesStatus = 'stopped';
        next.stopFromDate = stopFromDate;
        next.stoppedAt = now;
      }
      // Completed occurrences are deliberately retained and remain visible in
      // history. Only unfinished records are hidden from the schedule.
      if (!member.done) {
        next.suppressed = true;
        next.suppressionReason = reason;
        hiddenCount += 1;
      }
      member[DELETION_KEY] = next;
    });

    current.updatedAt = Date.now();
    call('saveState');
    call('renderAll');
    const label = mode === 'single' ? 'This repeating occurrence was removed from the schedule.' : mode === 'future' ? `Removed ${hiddenCount} current and future occurrence${hiddenCount === 1 ? '' : 's'} from the schedule.` : `Removed ${hiddenCount} unfinished occurrence${hiddenCount === 1 ? '' : 's'} from the schedule.`;
    call('showToast', `${label} History is preserved in Recovery.`);
    return true;
  }

  function detachAsStandalone(task) {
    const metadata = task?.[SERIES_KEY];
    if (!metadata || typeof metadata !== 'object') {
      task.recurrence = 'none';
      task.recurrenceId = '';
      task.recurrenceRootDate = '';
      return;
    }
    const next = { ...metadata, detached: true, detachedAt: new Date().toISOString(), exception: 'edited-occurrence' };
    delete next.skipped;
    delete next.superseded;
    delete next.suppressed;
    delete next.suppressionReason;
    task[SERIES_KEY] = next;
  }

  function recurrenceScope() {
    return document.getElementById('v16EditScope')?.value || 'occurrence';
  }

  function saveTask() {
    setUserInteracted();
    const current = getState();
    const title = document.getElementById('taskName')?.value?.trim() || '';
    if (!title) { call('showToast', '❗ Please enter a task name!', '#f76a6a'); return; }
    const duration = readDuration();
    if (duration.error) { call('showToast', `❗ ${duration.error}`, '#f76a6a'); return; }
    const existingId = getEditingTaskId();
    const existing = existingId ? current.tasks.find(task => task.id === existingId) : null;
    const priorSeries = existing ? seriesMeta(existing) : null;
    const rule = getFormRule(priorSeries?.rule || null);
    const validation = validateForm(rule, duration.value);
    if (validation) { call('showToast', `❗ ${validation}`, '#f76a6a'); return; }
    const xpSelection = root.studyQuestV16ReadXP?.() || { ok:true, value:Number(getSelectedXP()) };
    if (!xpSelection.ok) { call('showToast', `❗ ${xpSelection.message}`, '#f76a6a'); return; }
    const fields = taskFieldsFromForm(duration, xpSelection);
    const context = editorContext;
    call('pushUndoSnapshot', existing ? 'Edit task' : 'Add task');

    if (!existing) {
      const base = {
        id: Math.random().toString(36).slice(2, 11),
        ...fields,
        done: false,
        progressPercent: 0,
        createdAt: Date.now(),
        priority: 0,
      };
      if (rule) {
        rule.id = Math.random().toString(36).slice(2, 11);
        const occurrences = createSeries(base, rule);
        call('showToast', `↻ Added ${occurrences.length} repeating task occurrences!`);
      } else {
        const normalized = typeof root.normalizeTaskItem === 'function' ? root.normalizeTaskItem(base) : base;
        current.tasks.push(normalized);
        call('showToast', '⚡ Task added!');
      }
    } else if (!priorSeries) {
      applyTaskFields(existing, fields);
      if (rule) {
        rule.id = Math.random().toString(36).slice(2, 11);
        const base = { ...existing, ...fields, id: Math.random().toString(36).slice(2, 11), done: false, progressPercent: 0, createdAt: Date.now() };
        existing[SERIES_KEY] = { ...(makeOccurrence(base, fields.date, 0, rule)[SERIES_KEY]) };
        createSeries(base, rule);
        call('showToast', '↻ Repeating schedule added!');
      } else {
        call('showToast', '✏️ Task updated!');
      }
    } else {
      const scope = recurrenceScope();
      if (!rule) {
        if (scope !== 'occurrence') markSeriesSuperseded(priorSeries.id, scope === 'series' ? '' : fields.date, scope === 'series');
        applyTaskFields(existing, fields);
        detachAsStandalone(existing);
        call('showToast', scope === 'occurrence'
          ? '✏️ This occurrence became a standalone task; future occurrences were preserved.'
          : '✏️ The selected occurrence was kept and the chosen future series events were stopped safely.');
      } else if (scope === 'occurrence') {
        applyTaskFields(existing, fields);
        detachAsStandalone(existing);
        call('showToast', '✏️ This occurrence changed; future occurrences were preserved.');
      } else {
        const preserveDates = markSeriesSuperseded(priorSeries.id, scope === 'series' ? '' : fields.date, scope === 'series');
        rule.id = Math.random().toString(36).slice(2, 11);
        rule.rootDate = scope === 'series' ? (priorSeries.rule.rootDate || fields.date) : fields.date;
        const base = { ...existing, ...fields, id: Math.random().toString(36).slice(2, 11), done: false, progressPercent: 0, createdAt: Date.now() };
        createSeries(base, rule, preserveDates);
        call('showToast', scope === 'series' ? '↻ Entire series updated safely.' : '↻ This and future occurrences updated safely.');
      }
    }

    current.updatedAt = Date.now();
    call('saveState');
    call('closeModal', 'taskModal');
    setEditingTaskId(null);
    call('renderAll');
    restoreAgendaContext(context);
  }

  function openCreateTask(dateStr) {
    captureAgendaContext();
    editorContext = { ...(editorContext || {}), sourceDate: dateStr || (typeof root.today === 'function' ? root.today() : dateKey(new Date())), scrollY: root.scrollY || 0 };
    originals.openCreateTask?.(dateStr);
    ensureTaskForm();
    document.getElementById('taskRepeat').value = 'none';
    document.getElementById('v16RepeatInterval').value = '1';
    document.getElementById('v16RepeatUnit').value = 'days';
    document.getElementById('v16RepeatEndMode').value = 'never';
    document.getElementById('v16RepeatUntil').value = '';
    document.getElementById('v16RepeatCount').value = '10';
    document.getElementById('v16MonthlyMode').value = 'date';
    document.getElementById('v16MonthlyDay').value = getFormDate() ? String(Number(getFormDate().slice(8))) : '1';
    document.getElementById('v16MonthlyOrdinal').value = '1';
    document.getElementById('v16MonthlyWeekday').value = getFormDate() ? String(parseDateKey(getFormDate()).getUTCDay()) : '1';
    document.getElementById('v16EditScope').value = 'occurrence';
    document.querySelectorAll('[data-v16-weekday]').forEach(input => { input.checked = false; });
    const input = document.getElementById('taskDurationMinutes');
    if (input) input.dataset.v16DurationMode = '';
    updateRepeatUi();
    updateDurationHint();
  }

  function editTask(taskId) {
    const current = getState();
    const task = current.tasks.find(item => item.id === taskId);
    if (!task) return;
    captureAgendaContext();
    editorContext = { ...(editorContext || {}), sourceDate: task.date || '', scrollY: root.scrollY || 0 };
    originals.editTask?.(taskId);
    ensureTaskForm();
    const meta = seriesMeta(task);
    const rule = meta?.rule;
    document.getElementById('taskRepeat').value = rule?.pattern || 'none';
    if (rule) {
      document.getElementById('v16RepeatInterval').value = String(rule.interval || 1);
      document.getElementById('v16RepeatUnit').value = rule.unit || 'days';
      document.getElementById('v16MonthlyMode').value = rule.monthlyMode || 'date';
      document.getElementById('v16MonthlyDay').value = String(rule.monthlyDay || 1);
      document.getElementById('v16MonthlyOrdinal').value = String(rule.monthlyOrdinal || 1);
      document.getElementById('v16MonthlyWeekday').value = String(rule.monthlyWeekday ?? 1);
      document.getElementById('v16RepeatEndMode').value = rule.endMode || 'never';
      document.getElementById('v16RepeatUntil').value = rule.untilDate || '';
      document.getElementById('v16RepeatCount').value = String(rule.occurrenceCount || 10);
      document.querySelectorAll('[data-v16-weekday]').forEach(input => { input.checked = (rule.weekdays || []).includes(Number(input.value)); });
      document.getElementById('v16EditScope').value = 'occurrence';
    } else {
      document.getElementById('v16RepeatInterval').value = '1';
      document.getElementById('v16RepeatUnit').value = 'days';
      document.getElementById('v16MonthlyMode').value = 'date';
      document.getElementById('v16MonthlyDay').value = task.date ? String(Number(task.date.slice(8))) : '1';
      document.getElementById('v16MonthlyOrdinal').value = '1';
      document.getElementById('v16MonthlyWeekday').value = task.date ? String(parseDateKey(task.date).getUTCDay()) : '1';
      document.getElementById('v16RepeatEndMode').value = 'never';
      document.getElementById('v16RepeatUntil').value = '';
      document.getElementById('v16RepeatCount').value = '10';
      document.getElementById('v16EditScope').value = 'occurrence';
      document.querySelectorAll('[data-v16-weekday]').forEach(input => { input.checked = false; });
    }
    const durationInput = document.getElementById('taskDurationMinutes');
    if (durationInput) {
      durationInput.dataset.v16DurationMode = task[DURATION_MODE_KEY] || (taskStoredDuration(task) !== null ? 'manual' : '');
    }
    updateRepeatUi();
    updateDurationHint();
  }

  function skipOccurrence(taskId) {
    setUserInteracted();
    const current = getState();
    const task = current.tasks.find(item => item.id === taskId);
    if (!task || !seriesMeta(task)) return;
    call('pushUndoSnapshot', 'Skip repeating occurrence');
    task[SERIES_KEY] = { ...(task[SERIES_KEY] || {}), skipped: true, skippedAt: new Date().toISOString() };
    current.updatedAt = Date.now();
    call('saveState');
    call('renderAll');
    call('showToast', '⏭ Occurrence skipped and kept in recovery history.');
  }

  let pendingRecurringDeleteTaskId = null;

  function openRecurringDeleteChoice(taskId) {
    const current = getState();
    const task = current?.tasks?.find(item => String(item.id) === String(taskId));
    if (!task || !seriesMeta(task)) return;
    pendingRecurringDeleteTaskId = taskId;
    const dateLabel = task.date ? `${task.date}${task.time ? ` · ${task.time}${task.endTime ? `–${task.endTime}` : ''}` : ''}` : 'this occurrence';
    const msg = document.getElementById('recurringDeleteMessage');
    if (msg) msg.textContent = `${task.title || 'This task'} repeats ${seriesLabel(task) || 'on a schedule'} (${dateLabel}).\n\nChoose what to remove from the schedule. Completed occurrences stay in history and no task record is physically deleted.`;
    call('openModal', 'recurringDeleteModal');
  }

  function closeRecurringDeleteChoice() {
    pendingRecurringDeleteTaskId = null;
    call('closeModal', 'recurringDeleteModal');
  }

  function confirmRecurringDelete(mode) {
    const taskId = pendingRecurringDeleteTaskId;
    closeRecurringDeleteChoice();
    if (!taskId) return;
    softDeleteSeries(taskId, mode);
  }

  // Compatibility aliases keep existing v16/v17 inline callers working while
  // every new v18 caller goes through the one canonical service.
  const openV16RecurringDeleteChoice = openRecurringDeleteChoice;
  const closeV16RecurringDeleteChoice = closeRecurringDeleteChoice;
  const confirmV16RecurringDelete = confirmRecurringDelete;

  function deleteTask(taskId) {
    const current = getState();
    const task = current.tasks.find(item => item.id === taskId);
    if (task && seriesMeta(task)) {
      openV16RecurringDeleteChoice(taskId);
      return;
    }
    originals.deleteTask?.(taskId);
  }

  function moveToUnplanned(taskId) {
    const current = getState();
    const task = current.tasks.find(item => item.id === taskId);
    if (!task) return;
    setUserInteracted();
    call('pushUndoSnapshot', 'Move task to backlog');
    task.date = '';
    task.endDate = '';
    task.time = '';
    task.endTime = '';
    if (task[SERIES_KEY]) task[SERIES_KEY] = { ...task[SERIES_KEY], detached: true };
    task.recurrence = 'none';
    task.recurrenceId = '';
    task.recurrenceRootDate = '';
    current.updatedAt = Date.now();
    call('saveState');
    call('renderAll');
    call('showToast', '📭 Task moved to No Deadline');
  }

  function captureAgendaContext() {
    document.querySelectorAll('.date-bin').forEach(bin => {
      const date = bin.dataset.date;
      const body = document.getElementById(`body_${date}`);
      if (date && body?.classList.contains('open')) openDates.add(date);
    });
    if (root.scrollY !== undefined) editorContext = { ...(editorContext || {}), scrollY: root.scrollY };
  }

  function restoreAgendaContext(context = editorContext) {
    if (context?.sourceDate) openDates.add(context.sourceDate);
    root.requestAnimationFrame?.(() => {
      if (context && Number.isFinite(context.scrollY)) root.scrollTo?.({ top: context.scrollY, behavior: 'auto' });
      if (context?.sourceDate) {
        const body = document.getElementById(`body_${context.sourceDate}`);
        const toggle = document.getElementById(`toggle_${context.sourceDate}`);
        body?.classList.add('open');
        toggle?.classList.add('open');
      }
    });
  }

  function toggleBin(dateStr) {
    const body = document.getElementById(`body_${dateStr}`);
    const toggle = document.getElementById(`toggle_${dateStr}`);
    if (!body) return;
    body.classList.toggle('open');
    toggle?.classList.toggle('open');
    if (body.classList.contains('open')) openDates.add(dateStr); else openDates.delete(dateStr);
  }

  function renderTaskList(dateStr, tasks) {
    const visible = tasks.filter(task => !isSuppressedTask(task));
    originals.renderTaskList?.(dateStr, visible);
    const list = document.getElementById(`list_${dateStr}`);
    visible.forEach(task => {
      const row = [...(list?.querySelectorAll('.task-item') || [])].find(item => item.dataset.id === String(task.id));
      if (!row) return;
      syncInlineDuration(task, row);
      const meta = row.querySelector('.task-meta');
      const chips = [];
      const repeat = seriesLabel(task);
      if (repeat) chips.push(`<span class="v16-task-extra-chip">↻ ${safeEscape(repeat)}</span>`);
      if (chips.length && meta && !meta.querySelector('.v16-task-extra')) {
        meta.insertAdjacentHTML('beforeend', `<span class="v16-task-extra">${chips.join('')}</span>`);
      }
      if (seriesMeta(task)) {
        const actions = row.querySelector('.task-actions');
        if (actions && !actions.querySelector('.v16-skip-occurrence')) {
          actions.insertAdjacentHTML('beforeend', `<button type="button" class="v16-skip-occurrence" onclick="event.stopPropagation();skipV16Occurrence('${safeEscape(task.id)}')" title="Skip this repeating occurrence" aria-label="Skip this repeating occurrence">Skip</button>`);
        }
      }
    });
  }

  function syncInlineDuration(task, row) {
    const input = row?.querySelector('.task-duration-input');
    if (!input) return;
    const display = inlineDurationDisplay(task);
    input.value = display.value === null ? '' : String(display.value);
    input.dataset.v16ComputedDisplay = display.computed ? '1' : '0';
    if (input.dataset.v16DurationBound !== '1') {
      input.dataset.v16DurationBound = '1';
      input.addEventListener('input', () => { input.dataset.v16ComputedDisplay = '0'; });
    }
  }

  function inlineDurationDisplay(task) {
    const stored = taskStoredDuration(task);
    if (stored !== null) return { value: stored, computed: false };
    const calculated = durationFromTimes(task);
    return { value: calculated, computed: calculated !== null };
  }

  function isUntouchedComputedDuration(task, rawValue, computedDisplay) {
    const calculated = durationFromTimes(task);
    return computedDisplay === true
      && taskStoredDuration(task) === null
      && calculated !== null
      && String(rawValue ?? '').trim() === String(calculated);
  }

  function commitInlineDuration(taskId, rawValue, input = null) {
    const current = getState();
    const task = current?.tasks?.find(item => String(item.id) === String(taskId));
    if (task && isUntouchedComputedDuration(task, rawValue, input?.dataset.v16ComputedDisplay === '1')) {
      input.value = String(inlineDurationDisplay(task).value);
      return true;
    }
    if (input) input.dataset.v16ComputedDisplay = '0';
    return originals.commitTaskDuration?.(taskId, rawValue, input) ?? false;
  }

  function validCapacity(value) {
    return Number.isSafeInteger(value) && value >= MIN_CAPACITY_MINUTES && value <= MAX_CAPACITY_MINUTES;
  }

  function normalizeCapacity(value, fallback = DEFAULT_CAPACITY_MINUTES) {
    const parsed = Number(value);
    return validCapacity(parsed) ? parsed : fallback;
  }

  function legacyWorkloadCapacity() {
    const current = getState();
    return normalizeCapacity(current?.[LEGACY_SETTINGS_KEY]?.dailyCapacityMinutes, DEFAULT_CAPACITY_MINUTES);
  }

  function normalizeV17Settings(raw, fallback = DEFAULT_CAPACITY_MINUTES) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const sourceDays = source.weekdayCapacityMinutes;
    const fallbackValue = normalizeCapacity(fallback, DEFAULT_CAPACITY_MINUTES);
    const weekdayCapacityMinutes = {};
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      weekdayCapacityMinutes[String(weekday)] = normalizeCapacity(sourceDays?.[String(weekday)], fallbackValue);
    }
    return { version: 1, weekdayCapacityMinutes };
  }

  function currentV17Settings() {
    return normalizeV17Settings(getState()?.[SETTINGS_KEY], legacyWorkloadCapacity());
  }

  function weekdayCapacityForDate(dateStr) {
    if (!isDateKey(dateStr)) return legacyWorkloadCapacity();
    const weekday = parseDateKey(dateStr).getUTCDay();
    return currentV17Settings().weekdayCapacityMinutes[String(weekday)];
  }

  function workloadCapacity(dateStr = '') {
    return isDateKey(dateStr) ? weekdayCapacityForDate(dateStr) : legacyWorkloadCapacity();
  }

  function scheduledTasksForDate(dateStr) {
    const current = getState();
    const covers = typeof root.taskDateCovers === 'function' ? root.taskDateCovers : null;
    if (!covers || !isDateKey(dateStr)) return [];
    return (current?.tasks || []).filter(task => !isSuppressedTask(task) && covers(task, dateStr));
  }

  function taskMinutesForDate(task, dateStr) {
    return Math.max(0, Math.round(Number(minutesForTaskOnDate(task, dateStr)) || 0));
  }

  function normalizedProgress(task) {
    const value = Number(task?.progressPercent);
    if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
    return task?.done === true ? 100 : 0;
  }

  function taskIsFullyComplete(task) {
    return normalizedProgress(task) === 100;
  }

  function workloadClassForCapacity(minutes, capacity) {
    if (minutes > capacity) return 'overloaded';
    if (minutes >= capacity * .8) return 'warning';
    return 'normal';
  }

  function workloadClass(minutes, dateStr = '') {
    return workloadClassForCapacity(minutes, workloadCapacity(dateStr));
  }

  function workloadSummaryForDate(dateStr) {
    let completedMinutes = 0;
    let totalPlannedMinutes = 0;
    let unfinishedMinutes = 0;
    scheduledTasksForDate(dateStr).forEach(task => {
      const minutes = taskMinutesForDate(task, dateStr);
      totalPlannedMinutes += minutes;
      if (taskIsFullyComplete(task)) completedMinutes += minutes;
      else unfinishedMinutes += minutes;
    });
    const capacityMinutes = workloadCapacity(dateStr);
    return {
      completedMinutes,
      totalPlannedMinutes,
      unfinishedMinutes,
      capacityMinutes,
      status: workloadClassForCapacity(unfinishedMinutes, capacityMinutes),
    };
  }

  function workloadForDate(dateStr) {
    return workloadSummaryForDate(dateStr).unfinishedMinutes;
  }

  function workloadSettingsMessage(message, error = false) {
    const element = document.getElementById('v17WorkloadSettingsMessage');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('error', error);
  }

  function syncWorkloadSettingsForm() {
    if (workloadSettingsDirty) return;
    const settings = currentV17Settings();
    document.querySelectorAll('[data-v17-capacity-day]').forEach(input => {
      input.value = String(settings.weekdayCapacityMinutes[input.dataset.v17CapacityDay]);
    });
    workloadSettingsMessage('Changes apply only after you choose Save limits.');
  }

  function readWorkloadSettingsForm() {
    const values = {};
    for (const [weekday] of WEEKDAY_LABELS) {
      const input = document.querySelector(`[data-v17-capacity-day="${weekday}"]`);
      const raw = String(input?.value || '').trim();
      if (!/^\d+$/.test(raw)) return { error: 'Each weekday limit must be a whole number of minutes.' };
      const value = Number(raw);
      if (!validCapacity(value)) return { error: `Weekday limits must be between ${MIN_CAPACITY_MINUTES} and ${MAX_CAPACITY_MINUTES} minutes.` };
      values[weekday] = value;
    }
    return { values };
  }

  function cancelWorkloadSettings() {
    workloadSettingsDirty = false;
    syncWorkloadSettingsForm();
    document.getElementById('localLabMenuWrap')?.removeAttribute('open');
  }

  function saveWorkloadSettings() {
    const result = readWorkloadSettingsForm();
    if (result.error) {
      workloadSettingsMessage(result.error, true);
      return false;
    }
    const current = getState();
    if (!current) return false;
    const next = { version: 1, weekdayCapacityMinutes: result.values };
    const prior = currentV17Settings();
    if (JSON.stringify(prior.weekdayCapacityMinutes) === JSON.stringify(next.weekdayCapacityMinutes)) {
      workloadSettingsDirty = false;
      syncWorkloadSettingsForm();
      return true;
    }
    setUserInteracted();
    call('pushUndoSnapshot', 'Update weekday workload limits');
    current[SETTINGS_KEY] = next;
    current.updatedAt = Date.now();
    call('saveState');
    workloadSettingsDirty = false;
    syncWorkloadSettingsForm();
    renderWorkload();
    call('showToast', '✅ Weekday workload limits saved.');
    return true;
  }

  function ensureWorkloadCapacityControl() {
    const menu = document.querySelector('#localLabMenuWrap .local-lab-menu');
    if (!menu) return;
    let panel = menu.querySelector('#v17WorkloadSettings');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'v17WorkloadSettings';
      panel.className = 'v17-workload-settings';
      panel.setAttribute('aria-label', 'Weekday workload limits');
      panel.innerHTML = `
        <div class="v17-workload-settings-title">Workload limits <span class="v17-workload-settings-copy">Unfinished minutes above a day’s limit show as overloaded.</span></div>
        <div class="v17-capacity-grid">${WEEKDAY_LABELS.map(([weekday, label]) => `<label class="v17-capacity-field"><span>${label}</span><input type="number" min="${MIN_CAPACITY_MINUTES}" max="${MAX_CAPACITY_MINUTES}" step="1" inputmode="numeric" data-v17-capacity-day="${weekday}" aria-label="${label} workload limit in minutes"></label>`).join('')}</div>
        <div id="v17WorkloadSettingsMessage" class="v17-capacity-message" role="status" aria-live="polite"></div>
        <div class="v17-capacity-actions"><button type="button" class="btn btn-ghost btn-sm" id="v17WorkloadCancel">Cancel</button><button type="button" class="btn btn-primary btn-sm" id="v17WorkloadSave">Save limits</button></div>
      `;
      const actions = menu.querySelector('.local-lab-actions');
      menu.insertBefore(panel, actions || null);
      panel.querySelectorAll('[data-v17-capacity-day]').forEach(input => input.addEventListener('input', () => {
        workloadSettingsDirty = true;
        workloadSettingsMessage('Unsaved weekday limits. Choose Save limits to apply them.');
      }));
      panel.querySelector('#v17WorkloadCancel')?.addEventListener('click', cancelWorkloadSettings);
      panel.querySelector('#v17WorkloadSave')?.addEventListener('click', saveWorkloadSettings);
    }
    syncWorkloadSettingsForm();
  }

  function renderWorkload() {
    const bins = document.getElementById('binsContainer');
    if (!bins?.parentElement) return;
    document.getElementById('v16WorkloadStrip')?.remove();
    ensureWorkloadCapacityControl();
    document.querySelectorAll('.date-bin').forEach(bin => {
      const date = bin.dataset.date;
      const right = bin.querySelector('.bin-right');
      if (!date || !right) return;
      right.querySelector('.v16-day-workload')?.remove();
      right.querySelector('.v17-day-workload')?.remove();
      const summary = workloadSummaryForDate(date);
      const badge = document.createElement('div');
      badge.className = `v17-day-workload ${summary.status}`;
      badge.textContent = `${summary.completedMinutes}/${summary.totalPlannedMinutes} min`;
      badge.title = `${summary.completedMinutes} of ${summary.totalPlannedMinutes} planned minutes complete; ${summary.unfinishedMinutes} unfinished minutes against a ${summary.capacityMinutes}-minute capacity`;
      badge.setAttribute('aria-label', `${summary.completedMinutes} of ${summary.totalPlannedMinutes} planned minutes complete; ${summary.unfinishedMinutes} unfinished minutes against a ${summary.capacityMinutes}-minute capacity`);
      const count = right.querySelector('.bin-count');
      const toggle = right.querySelector('.bin-toggle');
      right.insertBefore(badge, count || toggle || null);
    });
  }

  function renderBins() {
    if (!agendaInitialized) {
      originals.renderBins?.();
      captureAgendaContext();
      agendaInitialized = true;
    } else {
      captureAgendaContext();
      originals.renderBins?.();
      document.querySelectorAll('.date-bin').forEach(bin => {
        const date = bin.dataset.date;
        const body = document.getElementById(`body_${date}`);
        const toggle = document.getElementById(`toggle_${date}`);
        const shouldOpen = openDates.has(date);
        body?.classList.toggle('open', shouldOpen);
        toggle?.classList.toggle('open', shouldOpen);
      });
    }
    renderWorkload();
  }

  function taskDateCovers(task, dateStr) {
    if (isSuppressedTask(task)) return false;
    return originals.taskDateCovers ? originals.taskDateCovers(task, dateStr) : false;
  }

  function getOpenTasksForDate(dateStr) {
    const current = getState();
    return (current?.tasks || []).filter(task => taskDateCovers(task, dateStr) && !task.done && !isSuppressedTask(task));
  }

  function getDayWorkloadWarnings(dateStr, tasks) {
    const base = originals.getDayWorkloadWarnings ? originals.getDayWorkloadWarnings(dateStr, tasks.filter(task => !isSuppressedTask(task))) : [];
    const summary = workloadSummaryForDate(dateStr);
    if (summary.status === 'overloaded' && !base.includes('overloaded')) base.push('overloaded');
    return base;
  }

  function install() {
    if (installed || !root.document) return;
    installed = true;
    originals = {
      renderBins: root.renderBins,
      renderTaskList: root.renderTaskList,
      commitTaskDuration: root.commitTaskDuration,
      toggleBin: root.toggleBin,
      openCreateTask: root.openCreateTask,
      editTask: root.editTask,
      saveTask: root.saveTask,
      deleteTask: root.deleteTask,
      moveToUnplanned: root.moveToUnplanned,
      taskDateCovers: root.taskDateCovers,
      getOpenTasksForDate: root.getOpenTasksForDate,
      getDayWorkloadWarnings: root.getDayWorkloadWarnings,
    };
    root.StudyQuestV16 = api;
    root.StudyQuestV17 = api;
    root.StudyQuestV18 = api;
    root.skipV16Occurrence = skipOccurrence;
    root.skipV18Occurrence = skipOccurrence;
    root.openRecurringDeleteChoice = openRecurringDeleteChoice;
    root.closeRecurringDeleteChoice = closeRecurringDeleteChoice;
    root.confirmRecurringDelete = confirmRecurringDelete;
    root.openV18RecurringDeleteChoice = openRecurringDeleteChoice;
    root.closeV18RecurringDeleteChoice = closeRecurringDeleteChoice;
    root.confirmV18RecurringDelete = confirmRecurringDelete;
    root.openV16RecurringDeleteChoice = openV16RecurringDeleteChoice;
    root.closeV16RecurringDeleteChoice = closeV16RecurringDeleteChoice;
    root.confirmV16RecurringDelete = confirmV16RecurringDelete;
    root.softDeleteV16Series = softDeleteSeries;
    root.softDeleteV18Series = softDeleteSeries;
    root.softDeleteRepeatingEvent = softDeleteSeries;
    root.renderBins = renderBins;
    root.renderTaskList = renderTaskList;
    root.commitTaskDuration = commitInlineDuration;
    root.toggleBin = toggleBin;
    root.openCreateTask = openCreateTask;
    root.editTask = editTask;
    root.saveTask = saveTask;
    root.deleteTask = deleteTask;
    root.moveToUnplanned = moveToUnplanned;
    root.taskDateCovers = taskDateCovers;
    root.getOpenTasksForDate = getOpenTasksForDate;
    root.getDayWorkloadWarnings = getDayWorkloadWarnings;
    root.studyQuestV16RenderBins = renderBins;
    root.studyQuestV16RenderTaskList = renderTaskList;
    root.studyQuestV16TaskDateCovers = taskDateCovers;
    root.studyQuestV16IsSuppressedTask = isSuppressedTask;
    root.studyQuestV16GetOpenTasksForDate = getOpenTasksForDate;
    root.studyQuestV16GetDayWorkloadWarnings = getDayWorkloadWarnings;
    root.studyQuestV17GetWorkloadSummary = workloadSummaryForDate;
    root.studyQuestV17WeekdayCapacityForDate = weekdayCapacityForDate;
    try { renderBins = root.renderBins; } catch {}
    try { renderTaskList = root.renderTaskList; } catch {}
    try { toggleBin = root.toggleBin; } catch {}
    try { openCreateTask = root.openCreateTask; } catch {}
    try { editTask = root.editTask; } catch {}
    try { saveTask = root.saveTask; } catch {}
    try { deleteTask = root.deleteTask; } catch {}
    try { moveToUnplanned = root.moveToUnplanned; } catch {}
    try { taskDateCovers = root.taskDateCovers; } catch {}
    try { getOpenTasksForDate = root.getOpenTasksForDate; } catch {}
    try { getDayWorkloadWarnings = root.getDayWorkloadWarnings; } catch {}
    installStyles();
    ensureTaskForm();
    ensureWorkloadCapacityControl();
  }

  api.install = install;
  root.studyQuestV16Install = install;
  root.studyQuestV17Install = install;
  root.studyQuestV18Install = install;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
