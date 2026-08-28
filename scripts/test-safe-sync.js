const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildThreeWayMerge, newestLocalSnapshot, retryDelay } = require("../public/safe-sync.js");

const root = path.join(__dirname, "..");
const v15 = fs.readFileSync(path.join(root, "public", "claudever15.html"), "utf8");
const v16 = fs.readFileSync(path.join(root, "public", "claudever16.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "schema.sql"), "utf8");
const incidentAudit = fs.readFileSync(path.join(root, "scripts", "audit-sync-incident.js"), "utf8");
const renderBlueprints = ["render.yaml", "render-neon-free.yaml"].map((file) => fs.readFileSync(path.join(root, file), "utf8"));

function state(tasks, extra = {}) {
  return { tasks, notes:[], updatedAt:1, ...extra };
}

const base = state([
  { id:"aug-26", title:"Math", date:"2026-08-26", done:false },
  { id:"aug-27", title:"Science", date:"2026-08-27", done:false },
]);

const localDisjoint = state([
  { id:"aug-26", title:"Math revised", date:"2026-08-26", done:false },
  { id:"aug-27", title:"Science", date:"2026-08-27", done:false },
]);
const cloudDisjoint = state([
  { id:"aug-26", title:"Math", date:"2026-08-26", done:false },
  { id:"aug-27", title:"Science", date:"2026-08-27", done:true },
]);
const disjoint = buildThreeWayMerge(base, localDisjoint, cloudDisjoint);
assert.equal(disjoint.autoMergeable, true, "different task fields must merge automatically");
assert.equal(disjoint.mergedState.tasks.find((task) => task.id === "aug-26").title, "Math revised");
assert.equal(disjoint.mergedState.tasks.find((task) => task.id === "aug-27").done, true);

const sameField = buildThreeWayMerge(
  base,
  state([{ ...base.tasks[0], title:"Local title" }, base.tasks[1]]),
  state([{ ...base.tasks[0], title:"Cloud title" }, base.tasks[1]])
);
assert.equal(sameField.autoMergeable, false, "same-field edits must stop for review");
assert.ok(sameField.conflicts.some((conflict) => conflict.kind === "concurrent-field-edit"));

const deleteVersusEdit = buildThreeWayMerge(
  base,
  state([base.tasks[1]]),
  state([{ ...base.tasks[0], title:"Cloud edit" }, base.tasks[1]])
);
assert.equal(deleteVersusEdit.autoMergeable, false, "delete-versus-edit must stop for review");
assert.ok(deleteVersusEdit.conflicts.some((conflict) => conflict.kind === "delete-versus-edit"));

const concurrentAdds = buildThreeWayMerge(
  base,
  state([...base.tasks, { id:"local-new", title:"Local new", date:"2026-08-28" }]),
  state([...base.tasks, { id:"cloud-new", title:"Cloud new", date:"2026-08-28" }])
);
assert.equal(concurrentAdds.autoMergeable, true, "independent additions must merge automatically");
assert.deepEqual(new Set(concurrentAdds.mergedState.tasks.map((task) => task.id)), new Set(["aug-26", "aug-27", "local-new", "cloud-new"]));

const unstable = buildThreeWayMerge(
  state([{ title:"legacy" }]),
  state([{ title:"local legacy" }]),
  state([{ title:"cloud legacy" }])
);
assert.equal(unstable.autoMergeable, false, "records without stable IDs must fail closed");

const newest = newestLocalSnapshot([
  { source:"outbox", priority:3, state:{ tasks:[], updatedAt:100 } },
  { source:"account", priority:2, state:{ tasks:[{ id:"newer" }], updatedAt:200 } },
]);
assert.equal(newest.source, "account", "a stale outbox must not replace newer durable state");
assert.deepEqual([1, 2, 3, 4, 5, 8].map(retryDelay), [1000, 3000, 10000, 30000, 60000, 60000]);

for (const [version, source] of [[15, v15], [16, v16]]) {
  assert.match(source, /<script src="\/safe-sync\.js"><\/script>/, `v${version} must load the shared safe sync helper`);
  assert.match(source, /const LIVE_SYNC_INTERVAL_MS = 60 \* 1000;/, `v${version} must check cloud metadata every minute`);
  assert.match(source, /clearV13DeviceOutboxAcknowledged\(lineage\.mutationId/, `v${version} must only clear an acknowledged mutation`);
  assert.match(source, /pendingCloudMutation\.mutationId !== lineage\.mutationId/, `v${version} must preserve same-millisecond edits behind an older acknowledgement`);
  assert.match(source, /attemptAutomaticNonOverlappingMerge/, `v${version} must use three-way merge`);
  assert.match(source, /kind:'local-changed-during-merge'/, `v${version} must stop if the user edits during merge preparation`);
  assert.match(source, /snapshotOverride:mergedSnapshot/, `v${version} must upload the exact reviewed merge snapshot`);
  assert.match(source, /clearV13DeviceOutboxIfCloudMatches/, `v${version} must clear only an outbox whose content matches cloud`);
  assert.match(source, /v13DurableOutboxPending \|\| liveSync\.pending \|\| !mergeRelevantStatesEquivalent\(state, cloudState\)/, `v${version} must preserve edits made during an automatic pull`);
  assert.match(source, /outcome\?\.ok && !liveSync\.conflict && !liveSync\.pending/, `v${version} must not report synced while a newer edit is pending`);
  assert.match(source, /return await applyCloudState\(cloudState/, `v${version} clean devices must auto-pull newer cloud state`);
  assert.match(source, /metadata && confirmedCloudState && statesEquivalent\(state, confirmedCloudState\)/, `v${version} startup must not trust metadata without a verified local baseline`);
  assert.match(source, /reason:liveSync\.pending \? 'pending-resume' : 'metadata-refresh'/, `v${version} must retry on focus and reconnection`);
  assert.match(source, /Cloud sync is delayed/, `v${version} must explain delayed uploads without a normal popup`);
}

assert.match(server, /url\.pathname === "\/api\/v2\/state\/meta"/, "server must expose authenticated metadata endpoint");
assert.match(server, /acknowledgedMutationId: mutationId \|\| null/g, "save responses must acknowledge mutation identity");
assert.match(server, /v15-auto-nonoverlap/, "server must recognize audited automatic merges");
assert.match(server, /ensureSchemaWithRetry/, "server startup must retry transient database failures");
assert.match(server, /sslmode", "verify-full"/, "database SSL behavior must be explicit");
assert.match(schema, /merge_source text/, "automatic merge source must be retained in audit history");
assert.doesNotMatch(incidentAudit, /pool\.query\(\s*`(?:insert|update|delete)/i, "incident audit must remain read-only");
assert.match(incidentAudit, /additiveOnly:true/, "incident audit must label recovery as additive-only");
for (const blueprint of renderBlueprints) {
  assert.match(blueprint, /key: STUDYQUEST_SAFE_SYNC_MODE\s+value: "off"/, "safe sync must start behind a rollback switch");
  assert.match(blueprint, /key: STUDYQUEST_SAFE_SYNC_USERS\s+sync: false/, "canary usernames must remain private configuration");
}

console.log("safe multi-device sync tests passed");
