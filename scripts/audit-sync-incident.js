const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { deserializeStateVersion, stateHash, stateSummary } = require("../lib/state-safety");

const databaseUrl = process.env.STUDYQUEST_BACKUP_DATABASE_URL || process.env.DATABASE_URL;
const username = String(process.env.STUDYQUEST_INCIDENT_USERNAME || "anya").trim().toLowerCase();
const from = new Date(process.env.STUDYQUEST_INCIDENT_FROM || "2026-08-25T17:00:00.000Z");
const to = new Date(process.env.STUDYQUEST_INCIDENT_TO || "2026-08-28T17:00:00.000Z");
if (!databaseUrl) throw new Error("STUDYQUEST_BACKUP_DATABASE_URL or DATABASE_URL is required.");
if (!/^[a-z0-9_-]{3,32}$/.test(username)) throw new Error("STUDYQUEST_INCIDENT_USERNAME is invalid.");
if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error("Incident time range is invalid.");

function explicitSslUrl(value) {
  if (/localhost|127\.0\.0\.1/i.test(value)) return value;
  const parsed = new URL(value);
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

function writePrivateJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive:true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag:"wx", mode:0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

function taskId(task, index) {
  return String(task?.id || task?._syncId || `unstable-index-${index}`);
}

function taskDate(task) {
  return String(task?.date || task?.dueDate || task?.day || "").slice(0, 10);
}

function taskMap(state) {
  return new Map((Array.isArray(state?.tasks) ? state.tasks : []).map((task, index) => [taskId(task, index), task]));
}

function relevantTask(task) {
  const date = taskDate(task);
  return date >= "2026-08-26" && date <= "2026-08-28";
}

async function main() {
  const pool = new Pool({
    connectionString:explicitSslUrl(databaseUrl),
    ssl:/localhost|127\.0\.0\.1/i.test(databaseUrl) ? false : { rejectUnauthorized:true },
    max:1,
  });
  try {
    const [accountResult, versionResult, eventResult] = await Promise.all([
      pool.query(`select username, state, state_revision, state_hash, state_bytes, state_updated_at, updated_at
                  from accounts where username = $1`, [username]),
      pool.query(`with selected as (
                    select id, revision, state_gzip, state_hash, state_bytes, source_device, summary, created_at
                    from state_versions where username = $1 and created_at >= $2 and created_at < $3
                    union all
                    (select id, revision, state_gzip, state_hash, state_bytes, source_device, summary, created_at
                     from state_versions where username = $1 and created_at < $2 order by created_at desc limit 1)
                  ) select * from selected order by created_at asc, revision asc limit 400`,
        [username, from.toISOString(), to.toISOString()]),
      pool.query(`select e.id, e.result, e.base_revision, e.current_revision, e.resulting_revision, e.state_hash,
                         e.state_bytes, e.device_id, e.detail, e.base_hash, e.mutation_id, e.change_manifest,
                         to_jsonb(e)->>'merge_source' as merge_source, e.created_at
                  from state_save_events e
                  where username = $1 and created_at >= $2 and created_at < $3
                  order by created_at asc, id asc limit 1000`,
        [username, from.toISOString(), to.toISOString()]),
    ]);
    const account = accountResult.rows[0];
    if (!account) throw new Error(`Account ${username} was not found.`);
    const versions = versionResult.rows.map((row) => ({ ...row, state:deserializeStateVersion(row.state_gzip) }));
    const transitions = [];
    const seenRelevant = new Map();
    for (let index = 0; index < versions.length; index += 1) {
      const current = versions[index];
      const currentTasks = taskMap(current.state);
      currentTasks.forEach((task, id) => { if (relevantTask(task)) seenRelevant.set(id, task); });
      if (!index) continue;
      const previous = versions[index - 1];
      const previousTasks = taskMap(previous.state);
      const removed = [...previousTasks.keys()].filter((id) => !currentTasks.has(id));
      const added = [...currentTasks.keys()].filter((id) => !previousTasks.has(id));
      if (removed.length || added.length) {
        transitions.push({
          fromRevision:Number(previous.revision || 0),
          toRevision:Number(current.revision || 0),
          at:current.created_at,
          sourceDevice:current.source_device || null,
          addedTaskIds:added,
          removedTaskIds:removed,
        });
      }
    }
    const currentTasks = taskMap(account.state);
    const recoverableMissing = [...seenRelevant.entries()]
      .filter(([id]) => !currentTasks.has(id))
      .map(([id, task]) => ({ id, title:task.title || task.name || "Untitled task", date:taskDate(task), task }));
    const audit = {
      auditedAt:new Date().toISOString(),
      readOnly:true,
      username,
      range:{ from:from.toISOString(), to:to.toISOString() },
      current:{
        revision:Number(account.state_revision || 0),
        stateHash:account.state_hash || stateHash(account.state),
        stateBytes:Number(account.state_bytes || 0),
        updatedAt:account.state_updated_at || account.updated_at || null,
        summary:stateSummary(account.state),
        state:account.state,
      },
      versions:versions.map((row) => ({
        id:String(row.id), revision:Number(row.revision || 0), stateHash:row.state_hash,
        stateBytes:Number(row.state_bytes || 0), sourceDevice:row.source_device || null,
        summary:row.summary, createdAt:row.created_at,
      })),
      saveEvents:eventResult.rows.map((row) => ({
        id:String(row.id), result:row.result, baseRevision:row.base_revision,
        currentRevision:row.current_revision, resultingRevision:row.resulting_revision,
        stateHash:row.state_hash, stateBytes:row.state_bytes, deviceId:row.device_id,
        detail:row.detail, baseHash:row.base_hash, mutationId:row.mutation_id,
        changeManifest:row.change_manifest, mergeSource:row.merge_source, createdAt:row.created_at,
      })),
      transitions,
      recoveryPreview:{
        additiveOnly:true,
        missingCount:recoverableMissing.length,
        items:recoverableMissing,
      },
    };
    let privateAuditFile = null;
    let currentSnapshotFile = null;
    if (process.env.STUDYQUEST_INCIDENT_AUDIT_FILE) privateAuditFile = writePrivateJson(process.env.STUDYQUEST_INCIDENT_AUDIT_FILE, audit);
    if (process.env.STUDYQUEST_INCIDENT_SNAPSHOT_FILE) {
      currentSnapshotFile = writePrivateJson(process.env.STUDYQUEST_INCIDENT_SNAPSHOT_FILE, {
        exportedAt:audit.auditedAt, username, revision:audit.current.revision,
        stateHash:audit.current.stateHash, summary:audit.current.summary, state:account.state,
      });
    }
    process.stdout.write(`${JSON.stringify({
      ok:true, readOnly:true, username, range:audit.range,
      current:{ ...audit.current, state:undefined },
      versionCount:audit.versions.length,
      saveEventCount:audit.saveEvents.length,
      transitions:audit.transitions,
      recoveryPreview:{
        additiveOnly:true,
        missingCount:recoverableMissing.length,
        items:recoverableMissing.map(({ id, date }) => ({ id, date })),
      },
      privateAuditFile,
      currentSnapshotFile,
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`StudyQuest sync incident audit failed: ${error.message || error}`);
  process.exit(1);
});
