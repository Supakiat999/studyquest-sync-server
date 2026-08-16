const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const v14 = fs.readFileSync(path.join(root, 'public', 'claudever14.html'), 'utf8');
const v15 = fs.readFileSync(path.join(root, 'public', 'claudever15.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Missing ${name}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `Missing ${name} body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

function loadFunctions(source, names, setup = '') {
  const context = {};
  const code = [setup, ...names.map(name => extractFunction(source, name))]
    .concat(names.map(name => `this.${name} = ${name};`)).join('\n');
  vm.runInNewContext(code, context);
  return context;
}

const duration = loadFunctions(v15, ['parseTaskDurationMinutes']).parseTaskDurationMinutes;
for (const [input, expected] of [['', null], ['   ', null], [null, null], ['0', 0], [45, 45]]) {
  const result = duration(input);
  assert.equal(result.ok, true);
  assert.equal(result.value, expected);
}
for (const invalid of ['1.5', '-1', '12abc', '1e3', '9007199254740992']) {
  assert.equal(duration(invalid).ok, false, `duration should reject ${invalid}`);
}

const progress = loadFunctions(
  v15,
  ['taskProgressValue', 'taskProgressBeforeDone'],
  'const TASK_PROGRESS_VALUES = [0, 25, 50, 75];\nconst TASK_ALL_PROGRESS_VALUES = TASK_PROGRESS_VALUES;',
);
assert.equal(progress.taskProgressValue({ progressPercent: 0 }), 0);
assert.equal(progress.taskProgressValue({ progressPercent: 25 }), 25);
assert.equal(progress.taskProgressValue({ progressPercent: 50 }), 50);
assert.equal(progress.taskProgressValue({ progressPercent: 75 }), 75);
assert.equal(progress.taskProgressValue({ progressPercent: 33 }), 0);
assert.equal(progress.taskProgressValue({ done: true, progressPercent: 75 }), 100);
assert.equal(progress.taskProgressBeforeDone({ progressBeforeDone: 50 }), 50);
assert.equal(progress.taskProgressBeforeDone({ progressBeforeDone: 33 }), 0);

function normalizeWith(source, task) {
  const functions = loadFunctions(
    source,
    ['normalizeTaskItem'],
    `function isValidDateKey(value) { return typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value); }\n` +
    `function normalizePriorityLevel(value) { return ['low','normal','important','urgent'].includes(value) ? value : 'normal'; }\n` +
    `function normalizeTaskKind(value) { return ['task','study','exam','project','trip','life'].includes(value) ? value : 'task'; }`,
  );
  return functions.normalizeTaskItem(task);
}

const crossVersionTask = {
  id: 'cross-version-task',
  title: 'Preserve fields',
  date: '2026-08-14',
  done: false,
  durationMinutes: 45,
  progressPercent: 50,
  progressBeforeDone: 50,
  unknownTaskField: { keep: true },
};
for (const source of [v14, v15]) {
  const normalized = normalizeWith(source, crossVersionTask);
  assert.equal(normalized.durationMinutes, 45);
  assert.equal(normalized.progressPercent, 50);
  assert.equal(normalized.progressBeforeDone, 50);
  assert.deepEqual(normalized.unknownTaskField, { keep: true });
}

for (const source of [v14, v15]) {
  const normalized = normalizeWith(source, { id: 'old-task', title: 'No migration' });
  assert.equal(Object.hasOwn(normalized, 'durationMinutes'), false, 'normalization must not invent duration fields');
  assert.equal(Object.hasOwn(normalized, 'progressPercent'), false, 'normalization must not invent progress fields');
  assert.equal(Object.hasOwn(normalized, 'progressBeforeDone'), false, 'normalization must not invent completion history');
}

assert.match(v15, /t\.progressBeforeDone\s*=\s*taskProgressValue\(t\)/, 'completion must remember the prior percentage');
assert.match(v15, /t\.progressPercent\s*=\s*taskProgressBeforeDone\(t\)/, 'reopening must restore the prior percentage');
assert.match(v15, /if \(next === 100\)\s*\{\s*toggleDone\(taskId\)/, '100% must use the existing completion path');
assert.match(v15, /TASK_PROGRESS_VALUES = \[0, 25, 50, 75\]/, 'progress choices must include a normal 50% option');
assert.doesNotMatch(v15, /TASK_LEGACY_PROGRESS_VALUES/, 'legacy-only 50% progress must be removed');
assert.match(v15, /const active = done \? value === 100 : progress === value;/, 'stored 50% progress must activate the normal button');
assert.match(v15, /\[\.\.\.TASK_PROGRESS_VALUES, 100\]\.map\(value => \{/,
  'the renderer must expose 0%, 25%, 50%, 75%, and 100% controls');
assert.match(v15, /\.\.\.t/, 'task normalization must preserve unknown task properties');

console.log('v15 duration, progress, completion-restore, and cross-version preservation tests passed.');
