const assert = require('node:assert/strict');
const { stateActivitySummary, weeklyLayoutSummary } = require('../lib/state-safety');

const state = {
  updatedAt: '2026-08-13T08:00:00.000Z',
  tasks: [
    { id: 'task-1', title: 'Older task' },
    { id: 'task-2', title: 'Prepare Weekly release' },
  ],
  tracker: {
    weeks: [{ id: 'week-1' }],
    trackerSemesters: [],
    weeklyV14: {
      layouts: {
        semesterA: { columns: [
          { id: 'classNote', archived: false },
          { id: 'time', archived: false },
          { id: 'old', archived: true },
        ] },
      },
    },
  },
  _syncMeta: {
    history: [
      { path: 'tasks/%40task-2', kind: 'add-record', at: '2026-08-13T08:00:00.000Z', seq: 3, clockVerified: true },
      { path: 'tracker/weeklyV14/layouts/semesterA', kind: 'field', label: 'Added Weekly column: Time', at: '2026-08-13T07:59:00.000Z', seq: 2, clockVerified: true },
    ],
  },
};

assert.deepEqual(weeklyLayoutSummary(state), { enabled: true, semesters: 1, total: 3, visible: 2, archived: 1 });
const activity = stateActivitySummary(state);
assert.equal(activity.latestTaskAdded.label, 'Task added: Prepare Weekly release');
assert.equal(activity.latestChanges.length, 2);
assert.equal(activity.weekly.visible, 2);
assert.equal(activity.latestChanges[0].clockVerified, true);
console.log('v14 activity summary tests passed.');
