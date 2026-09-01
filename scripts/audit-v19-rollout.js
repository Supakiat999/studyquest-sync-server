const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { stateHash, stateSummary } = require('../lib/state-safety');

const DATABASE_URL = process.env.STUDYQUEST_BACKUP_DATABASE_URL;

function shouldUseSsl(databaseUrl) {
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function writePrivateJson(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive:true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag:'wx', mode:0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

function compareAccounts(previousAccounts, currentAccounts) {
  const previous = new Map((previousAccounts || []).map((entry) => [entry.username, entry]));
  const anomalies = [];
  for (const current of currentAccounts) {
    const prior = previous.get(current.username);
    if (!prior) continue;
    if (current.revision < Number(prior.revision || 0)) anomalies.push(`${current.username}: revision decreased.`);
    const priorSummary = prior.summary || {};
    const currentSummary = current.summary || {};
    for (const key of Object.keys(priorSummary)) {
      if (typeof priorSummary[key] === 'number' && typeof currentSummary[key] === 'number' && currentSummary[key] < priorSummary[key]) {
        anomalies.push(`${current.username}: ${key} decreased from ${priorSummary[key]} to ${currentSummary[key]}.`);
      }
    }
  }
  for (const prior of previous.values()) {
    if (!currentAccounts.some((entry) => entry.username === prior.username)) anomalies.push(`${prior.username}: account is missing.`);
  }
  return anomalies;
}

async function collectAudit(pool) {
  await pool.query('begin isolation level repeatable read read only');
  try {
    const [accountsResult, eventsResult] = await Promise.all([
      pool.query(`select username, state, state_revision, state_hash, state_bytes, state_updated_at
                  from accounts order by username`),
      pool.query(`select username, result, count(*)::int as count, max(created_at) as latest
                  from state_save_events
                  where created_at >= now() - interval '6 hours'
                  group by username, result order by username, result`),
    ]);
    await pool.query('commit');
    const accounts = accountsResult.rows.map((row) => {
      const computedHash = stateHash(row.state);
      return {
        username:row.username,
        revision:Number(row.state_revision || 0),
        stateHash:computedHash,
        storedStateHash:row.state_hash || null,
        hashMatchesStored:!row.state_hash || row.state_hash === computedHash,
        stateBytes:Number(row.state_bytes || 0),
        stateUpdatedAt:row.state_updated_at,
        summary:stateSummary(row.state),
      };
    });
    const hashFailures = accounts.filter((entry) => !entry.hashMatchesStored).map((entry) => `${entry.username}: stored and computed state hashes differ.`);
    return { accounts, recentSaveEvents:eventsResult.rows, hashFailures };
  } catch (error) {
    await pool.query('rollback').catch(() => {});
    throw error;
  }
}

async function main() {
  if (!DATABASE_URL) throw new Error('STUDYQUEST_BACKUP_DATABASE_URL is required.');
  const pool = new Pool({ connectionString:DATABASE_URL, ssl:shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized:false } : false, max:1, connectionTimeoutMillis:30_000 });
  try {
    const collected = await collectAudit(pool);
    let previous = null;
    if (process.env.STUDYQUEST_ROLLOUT_PREVIOUS_FILE && fs.existsSync(process.env.STUDYQUEST_ROLLOUT_PREVIOUS_FILE)) {
      previous = JSON.parse(fs.readFileSync(process.env.STUDYQUEST_ROLLOUT_PREVIOUS_FILE, 'utf8'));
    }
    const comparisonAnomalies = compareAccounts(previous?.accounts, collected.accounts);
    const output = {
      ok:collected.hashFailures.length === 0 && comparisonAnomalies.length === 0,
      readOnly:true,
      auditedAt:new Date().toISOString(),
      accounts:collected.accounts,
      recentSaveEvents:collected.recentSaveEvents,
      anomalies:[...collected.hashFailures, ...comparisonAnomalies],
    };
    if (process.env.STUDYQUEST_ROLLOUT_AUDIT_FILE) writePrivateJson(process.env.STUDYQUEST_ROLLOUT_AUDIT_FILE, output);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`StudyQuest v19 rollout audit failed: ${error.message || error}`);
  process.exit(1);
});

module.exports = { compareAccounts };
