const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const { additiveIncidentRecovery, stateHash, stateSummary } = require("../lib/state-safety");

const DATABASE_URL = process.env.STUDYQUEST_BACKUP_DATABASE_URL;
if (!DATABASE_URL) throw new Error("STUDYQUEST_BACKUP_DATABASE_URL is required.");

function shouldUseSsl(databaseUrl) {
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function idCoverage(records) {
  const rows = Array.isArray(records) ? records : [];
  const fields = ["id", "uid", "weekId", "taskId", "key"];
  return {
    count: rows.length,
    withStableId: rows.filter((row) => row && fields.some((field) => String(row[field] ?? "").trim())).length,
    keySets: Array.from(new Set(rows.map((row) => Object.keys(row || {}).sort().join(",")))).slice(0, 10),
  };
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: 1,
  });
  try {
    const accountsResult = await pool.query(
      `select username, state, state_revision, state_bytes, state_updated_at
       from accounts order by username`
    );
    const sourceResult = await pool.query(
      `select id, revision, state, created_at from state_backups
       where username = 'anya' and revision = 4
       order by created_at desc limit 1`
    );
    const anya = accountsResult.rows.find((row) => row.username === "anya");
    const source = sourceResult.rows[0];
    if (!anya || !source) throw new Error("Verified Anya revision 4 source is unavailable.");
    const proposed = additiveIncidentRecovery(anya.state, source.state);
    const output = {
      auditedAt: new Date().toISOString(),
      accounts: accountsResult.rows.map((row) => ({
        username: row.username,
        revision: Number(row.state_revision || 0),
        stateBytes: Number(row.state_bytes || 0),
        stateUpdatedAt: row.state_updated_at,
        stateHash: stateHash(row.state),
        summary: stateSummary(row.state),
      })),
      anyaIncident: {
        sourceSnapshotId: String(source.id),
        sourceRevision: Number(source.revision),
        sourceCreatedAt: source.created_at,
        sourceHash: stateHash(source.state),
        currentHash: stateHash(anya.state),
        currentTasks: idCoverage(anya.state?.tasks),
        sourceTasks: idCoverage(source.state?.tasks),
        currentWeeks: idCoverage(anya.state?.tracker?.weeks),
        sourceWeeks: idCoverage(source.state?.tracker?.weeks),
        addedTaskCount: proposed.addedTasks.length,
        addedWeekCount: proposed.addedWeeks.length,
        addedTasks: proposed.addedTasks.map((task) => ({ id: task.id || null, title: task.title || task.name || "Untitled task" })),
        addedWeeks: proposed.addedWeeks.map((week) => ({ id: week.id || null, label: week.label || week.name || week.date || "Weekly week" })),
        proposedSummary: proposed.summary,
      },
    };
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (process.env.STUDYQUEST_INCIDENT_AUDIT_FILE) {
      const outputPath = path.resolve(process.env.STUDYQUEST_INCIDENT_AUDIT_FILE);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, serialized, { flag:"wx", mode:0o600 });
      fs.renameSync(temporary, outputPath);
    }
    process.stdout.write(serialized);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`StudyQuest incident audit failed: ${error.message || error}`);
  process.exit(1);
});
