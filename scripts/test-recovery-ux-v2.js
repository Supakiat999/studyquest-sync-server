const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
const server = read("server.js");
const coreSource = read("public/recovery-ux-v2-core.js");
const patchSource = read("public/recovery-ux-v2.js");
const recoveryHtml = read("public/device-recovery-v2.html");
const recoveryJs = read("public/device-recovery-v2.js");

function functionSection(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const actualStart = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  assert.notEqual(actualStart, -1, `Missing ${name}`);
  const markers = [`\nfunction ${nextName}`, `\nasync function ${nextName}`]
    .map((marker) => source.indexOf(marker, actualStart + 1)).filter((index) => index >= 0);
  return source.slice(actualStart, markers.length ? Math.min(...markers) : source.length);
}

const protectedHashes = {
  // v20 adds its authenticated login return target to the shared gate.
  "public/claudever9.html":"f9feb74a9aea159d4432449f79da7b9c0dd7509122a4cf64a1600382ecc60e13",
  "public/device-recovery.html":"bf3954ee3bcc677123ad6e37d14e822be4ad55f154773842ab1a7f892e112d3b",
  "public/device-recovery.js":"c963ea0e2281c58ac2b15800e8f543bffc7dfe7e427fd4df40d8af3029197662",
  "public/claudever15.html":"c99b6c9ed4f47d01e7d5fe1d74dc7a76b39a926a3901a13cf7081836385031e3",
  "public/claudever19.html":"8436ed03383e3693b88f5b25bc0936a453bec947740ee642377c971e57fc2c3d",
};
for (const [file, expected] of Object.entries(protectedHashes)) {
  assert.equal(hash(file), expected, `${file} must remain byte-for-byte unchanged`);
}

for (const yaml of ["render.yaml", "render-neon-free.yaml"]) {
  assert.match(read(yaml), /key:\s*STUDYQUEST_RECOVERY_UX\s*\r?\n\s*value:\s*["']?off["']?/,
    `${yaml} must fail closed with recovery UX off`);
}
assert.match(server, /\["off", "admin", "all"\]\.includes\(configured\) \? configured : "off"/);
assert.match(server, /recoveryUxMode:\s*RECOVERY_UX_MODE/);
assert.match(server, /recoveryUxHash:\s*RECOVERY_UX_HASH/);
assert.match(server, /url\.pathname === "\/api\/recovery\/device-copy-review"/);
assert.match(server, /accountStateChanged:false/);
assert.match(server, /USER_REQUESTED_DEVICE_REVIEW/);
assert.match(server, /stableHtmlWithRecoveryUxV2/);
const reviewEndpoint = functionSection(server, "handleDeviceCopyReview", "handleStateConflicts");
assert.match(reviewEndpoint, /currentUser\(req, \{ includeState:false \}\)/);
assert.match(reviewEndpoint, /user\.sync_device_id/);
assert.match(reviewEndpoint, /canUseRecoveryUxV2\(user\)/, "Advanced Recovery endpoint must follow the fail-closed rollout flag");
assert.match(reviewEndpoint, /from accounts where username = \$1 for update/);
assert.match(reviewEndpoint, /currentRevision !== expectedRevision/);
assert.match(reviewEndpoint, /currentHash !== expectedHash/);
assert.match(reviewEndpoint, /preserveConflictCopy/);
assert.doesNotMatch(reviewEndpoint, /update accounts/i, "Preparing Advanced Recovery must never change account state");

const canUseSource = functionSection(server, "canUseRecoveryUxV2", "stableHtmlWithRecoveryUxV2");
for (const [mode, user, expected] of [
  ["off", { username:"admin" }, false],
  ["admin", { username:"admin" }, true],
  ["admin", { username:"anya" }, false],
  ["all", { username:"anya" }, true],
  ["all", { username:"admin", sync_device_id:"device" }, false],
]) {
  const accessContext = { RECOVERY_UX_MODE:mode, ADMIN_USERNAME:"admin" };
  vm.runInNewContext(`${canUseSource}\nthis.result = canUseRecoveryUxV2(${JSON.stringify(user)});`, accessContext);
  assert.equal(accessContext.result, expected, `Recovery UX access ${mode}/${user.username}`);
}

for (const text of [
  "Account backup", "This computer's saved copy", "Load account backup on this computer",
  "Download both copies", "Decide later", "Advanced Recovery", "REPLACE ACCOUNT BACKUP",
]) assert.match(patchSource, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
assert.match(patchSource, /core\.fetchAccountBackup\(\)/);
assert.match(patchSource, /archiveAndLoadAccountBackup/);
assert.match(patchSource, /Number\(latest\.revision\) !== Number\(recovery\.revision\)/);
assert.match(patchSource, /PREVIEW_EXPIRED/);
assert.match(patchSource, /PREVIEW_STALE/);
assert.doesNotMatch(patchSource, /localStorage\.removeItem/);

const safeLoadStart = patchSource.indexOf("async function loadAccountBackupOnComputerV2");
const safeLoadEnd = patchSource.indexOf("async function prepareAdvancedReplacementV2", safeLoadStart);
const safeLoad = patchSource.slice(safeLoadStart, safeLoadEnd);
assert.ok(safeLoadStart >= 0 && safeLoadEnd > safeLoadStart, "Safe local-load function must exist");
assert.doesNotMatch(safeLoad, /method\s*:\s*["']POST["']/i, "Loading the Account backup locally must never POST");

assert.match(recoveryHtml, /href="\/">Back to StudyQuest/);
assert.match(recoveryHtml, /Load Account backup on this computer/);
assert.match(recoveryHtml, /Recover records missing from the Account backup/);
assert.match(recoveryHtml, /Compare exact differences/);
assert.match(recoveryJs, /No recovery is needed—the current account backup already contains everything from this earlier version\./);
assert.match(recoveryJs, /core\.openExistingDatabase\(\)/, "Opening recovery must not create or upgrade IndexedDB");
assert.doesNotMatch(recoveryJs, /localStorage\.removeItem/);
const initializeSection = functionSection(recoveryJs, "initialize", "not-a-real-next-function");
assert.doesNotMatch(initializeSection, /localStorage\.setItem/, "Opening recovery must not write browser state");
assert.doesNotMatch(initializeSection, /core\.openDatabase\(/, "Opening recovery must not create IndexedDB");
assert.doesNotMatch(initializeSection, /method\s*:\s*["']POST["']/i, "Opening recovery must not POST");

const context = {
  window:{}, console, Date, JSON, Math, Object, Array, Map, Set, String, Number, Boolean, RegExp, Error,
  localStorage:{ getItem:() => null, setItem:() => {} },
  fetch:async () => { throw new Error("not used"); },
  indexedDB:undefined,
};
vm.runInNewContext(coreSource, context, { filename:"recovery-ux-v2-core.js" });
const core = context.window.StudyQuestRecoveryV2;

// Reproduce Chrome's existing v3 database without touching browser or account data.
async function testExistingDatabaseVersions() {
  for (const version of [1, 2, 3, 9]) {
    let closed = false;
    const db = { version, objectStoreNames:{ contains:() => true }, close:() => { closed = true; } };
    const fakeIDB = { open(name, requestedVersion) {
      assert.equal(name, 'studyquest_device_recovery_v1');
      assert.equal(requestedVersion, undefined, 'Never request a downgrade or schema upgrade');
      const request = { result:db };
      queueMicrotask(() => request.onsuccess());
      return request;
    } };
    const sandbox = { window:{ indexedDB:fakeIDB }, indexedDB:fakeIDB, console };
    vm.runInNewContext(coreSource, sandbox);
    assert.equal(await sandbox.window.StudyQuestRecoveryV2.openDatabase(), db);
    assert.equal(closed, false);
    db.onversionchange();
    assert.equal(closed, true, 'Release the connection for other tabs');
    db.objectStoreNames.contains = name => name !== 'recovery';
    await assert.rejects(sandbox.window.StudyQuestRecoveryV2.openDatabase(), /incomplete/);
  }
}
testExistingDatabaseVersions().catch(error => { console.error(error); process.exitCode = 1; });

const make = (count, prefix, field = "id") => Array.from({ length:count }, (_, index) => ({ [field]:`${prefix}-${index}`, title:`${prefix} ${index}` }));
const semesters = make(4, "semester");
const cloud = {
  tasks:make(286, "task"),
  notes:make(20, "note"),
  fileLinks:[{ id:"file-shared", name:"Shared file" }],
  grades:Object.fromEntries(make(44, "grade").map((item) => [item.id, { name:item.title, scores:[] }])),
  trips:make(1, "trip"),
  tracker:{ weeks:make(20, "week") },
  trackerSemesters:semesters,
  checklistItems:make(163, "check"),
};
const device = {
  tasks:cloud.tasks.slice(0, 78),
  notes:cloud.notes,
  fileLinks:[cloud.fileLinks[0], { id:"file-device-only", name:"Device file" }],
  grades:Object.fromEntries(Object.entries(cloud.grades).slice(0, 42)),
  trips:[],
  tracker:{ weeks:[] },
  trackerSemesters:semesters,
  checklistItems:[],
};
const comparison = core.compareStates(cloud, device);
assert.equal(comparison.removed.length, 394, "The incident-shaped fixture must report all 394 at-risk records");
assert.equal(comparison.deviceOnly.length, 1, "The device-only file must remain visible in the comparison");
assert.equal(comparison.changed.length, 0, "Identical shared fixture records must not be reported as changed");
const changedDevice = JSON.parse(JSON.stringify(device));
changedDevice.tasks[0].title = "Changed only on this computer";
const changedComparison = core.compareStates(cloud, changedDevice);
assert.equal(changedComparison.changed.length, 1, "Changed values for the same record must be reported explicitly");
assert.match(core.summaryText(cloud), /286 tasks · 20 notes · 1 files · 44 grade records · 1 trips · 20 Weekly weeks · 4 semesters/);
assert.match(core.summaryText(device), /78 tasks · 20 notes · 2 files · 42 grade records · 0 trips · 0 Weekly weeks · 4 semesters/);

console.log(JSON.stringify({
  ok:true,
  protectedHashes,
  recoveryUxArtifacts:{
    core:hash("public/recovery-ux-v2-core.js"),
    stablePatch:hash("public/recovery-ux-v2.js"),
    recoveryPage:hash("public/device-recovery-v2.html"),
    recoveryScript:hash("public/device-recovery-v2.js"),
  },
  incidentFixture:{ accountTasks:286, computerTasks:78, atRiskRecords:comparison.removed.length },
}, null, 2));
