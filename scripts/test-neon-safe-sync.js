const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  deserializeStateVersion,
  serializeStateVersion,
  stateManifest,
  unapprovedManifestRemovals,
} = require("../lib/state-safety");
const { buildThreeWayMerge, newestLocalSnapshot } = require("../public/safe-sync");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "002_neon_safe_sync.sql"), "utf8");
const clients = [15, 16].map((version) => ({
  version,
  source:fs.readFileSync(path.join(root, "public", `claudever${version}.html`), "utf8"),
}));

const base = {
  tasks:[{ id:"task-a", title:"A", done:false }, { id:"task-b", title:"B", done:false }],
  notes:[{ id:"note-a", title:"Note", body:"safe" }],
  tracker:{ weeks:[] },
  updatedAt:1,
};
const manifest = stateManifest(base);
assert.equal(manifest.version, 1);
assert.equal(manifest.counts.tasks, 2);
assert.match(manifest.records["tasks/task:id:task-a"], /^[a-f0-9]{64}$/);
assert.match(manifest.contentHash, /^[a-f0-9]{64}$/);
const timestampOnly = stateManifest({ ...base, updatedAt:999 });
assert.equal(timestampOnly.contentHash, manifest.contentHash, "root timestamp must not change manifest content hash");

const missingTask = { ...base, tasks:[base.tasks[0]], updatedAt:2 };
const blocked = unapprovedManifestRemovals(manifest, stateManifest(missingTask), null);
assert.equal(blocked.unapproved.length, 1, "unexplained deletion must stop");
const approved = unapprovedManifestRemovals(manifest, stateManifest(missingTask), {
  deletes:[{ key:blocked.unapproved[0].key }],
});
assert.equal(approved.unapproved.length, 0, "explicit stable-ID deletion may proceed");

const serialized = serializeStateVersion(base);
assert.deepEqual(deserializeStateVersion(serialized.stateGzip), base, "conflict gzip copy must round-trip exactly");

const local = structuredClone(base);
local.tasks[0].title = "Local A";
const cloud = structuredClone(base);
cloud.notes[0].body = "Cloud note";
assert.equal(buildThreeWayMerge(base, local, cloud).autoMergeable, true, "different fields must merge automatically");
const overlap = structuredClone(cloud);
overlap.tasks[0].title = "Cloud A";
assert.equal(buildThreeWayMerge(base, local, overlap).autoMergeable, false, "same-field edits must require review");
const deleted = structuredClone(base);
deleted.tasks = [deleted.tasks[1]];
const edited = structuredClone(base);
edited.tasks[0].title = "Edited while other device deleted";
assert.equal(buildThreeWayMerge(base, edited, deleted).autoMergeable, false, "edit-versus-delete must require review");
assert.equal(newestLocalSnapshot([
  { source:"outbox", capturedAtMs:1, state:{ ...base, updatedAt:10 } },
  { source:"browser", capturedAtMs:2, state:{ ...base, updatedAt:20 } },
]).source, "browser", "an older outbox must not roll back a newer browser snapshot");

assert.match(migration, /create table if not exists state_conflict_copies/i);
assert.match(migration, /candidate_gzip bytea not null/i);
assert.match(migration, /retention_expires_at/i);
assert.match(server, /CONFLICT_COPY_BUDGET_BYTES[^\n]+32 \* 1024 \* 1024/);
assert.match(server, /retention_expires_at = now\(\) \+ interval '30 days'/);
assert.match(migration, /default \(now\(\) \+ interval '90 days'\)/i);
assert.match(server, /runSchemaMigrations/);
assert.match(server, /schema_migrations/);
assert.match(server, /runDailyMaintenance/);
assert.match(server, /pg_try_advisory_xact_lock/);
assert.match(server, /max: 3/);
assert.match(server, /statement_timeout: 25000/);
assert.match(server, /rejectUnauthorized: true/);
assert.match(server, /select 1 as healthy/);
assert.doesNotMatch(server, /pg_database_size\(current_database\(\)\)/);
assert.match(server, /immutable_revision/);
assert.match(server, /if-none-match/i);
assert.match(server, /status === 304/);
assert.match(server, /brotliCompressSync/);
assert.match(server, /gzipSync/);
assert.match(server, /preserveConflictCopy/);
assert.match(server, /copiesPreserved:!copy\.storageFull/);
assert.match(server, /handleStateConflictResolve/);
assert.match(server, /PREVIEW_STALE/);
assert.match(server, /where c\.id = \$1 and c\.username = \$2/);

for (const { version, source } of clients) {
  assert.doesNotMatch(source, /sendPageHeartbeat/, `v${version} must not keep Render awake`);
  assert.doesNotMatch(source, /setInterval\(retryPendingServerSync/, `v${version} must not poll metadata`);
  assert.match(source, /Sending saved device work/, `v${version} pending work must upload directly`);
  assert.match(source, /If-None-Match/, `v${version} metadata check must use ETag`);
  assert.match(source, /Date\.now\(\) - lastCloudMetadataAt < 60_000/, `v${version} must coalesce duplicate metadata checks`);
  assert.match(source, /Two changes overlap\. Both copies are safe\./);
  assert.match(source, /Review safely/);
  assert.doesNotMatch(source, />Use Live</);
  assert.doesNotMatch(source, />Use Chrome</);
  assert.match(source, /min-height: 44px/);
  assert.match(source, /env\(safe-area-inset-top\)/);
  assert.match(source, /saveReviewedConflictToCloud/);
  assert.match(source, /conflicts\/\$\{encodeURIComponent\(preview\.conflictCopyId\)\}\/resolve/);
}

for (const version of [13, 14]) {
  const source = fs.readFileSync(path.join(root, "public", `claudever${version}.html`), "utf8");
  assert.doesNotMatch(source, /sendPageHeartbeat/, `v${version} must not keep Render awake`);
}

console.log("Neon-safe sync, conflict escrow, event-driven network, and iPad review checks passed.");
