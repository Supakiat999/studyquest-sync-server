const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { Pool } = require("pg");

const DATABASE_URL = process.env.STUDYQUEST_BACKUP_DATABASE_URL;
const KEY_BASE64 = process.env.STUDYQUEST_BACKUP_KEY_BASE64;
const BACKUP_ROOT = process.env.STUDYQUEST_BACKUP_DIR
  || path.join(process.env.LOCALAPPDATA || os.homedir(), "StudyQuest", "database-backups");
const DAILY_DIR = path.join(BACKUP_ROOT, "daily");
const MONTHLY_DIR = path.join(BACKUP_ROOT, "monthly");
const LOG_PATH = path.join(BACKUP_ROOT, "backup.log");
const FORMAT = "studyquest-encrypted-database-backup-v1";
const TABLE_ORDERS = Object.freeze({
  accounts: 'username', state_backups: 'id', state_versions: 'id',
  state_save_events: 'id', state_conflict_copies: 'created_at, id',
  password_recovery_requests: 'created_at, id',
});
const EXCLUDED_TABLES = ['sessions', 'sync_pairing_codes', 'sync_devices'];

function validateDatabaseExport(exported, { allowLegacyConflictCopies = false, expectedAccountCount } = {}) {
  if (exported?.format !== 'studyquest-database-export-v1') throw new Error('Decrypted export format is invalid.');
  for (const name of Object.keys(TABLE_ORDERS)) {
    if (name === 'state_conflict_copies' && allowLegacyConflictCopies
        && !Object.hasOwn(exported.tables || {}, name) && !Object.hasOwn(exported.counts || {}, name)) continue;
    const rows = exported.tables?.[name];
    const count = exported.counts?.[name];
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < 0 || rows.length !== count) {
      throw new Error(`Required table or count is invalid: ${name}`);
    }
  }
  if (exported.counts.accounts < 1) throw new Error('Backup contains no accounts.');
  if (expectedAccountCount !== undefined && exported.counts.accounts !== expectedAccountCount) {
    throw new Error('Backup account count does not match the release baseline.');
  }
  for (const name of Object.keys(exported.tables || {})) {
    if (!Object.hasOwn(TABLE_ORDERS, name)) throw new Error(`Unexpected export table: ${name}`);
  }
  if (JSON.stringify(Object.keys(exported.counts || {}).sort()) !== JSON.stringify(Object.keys(exported.tables || {}).sort())) {
    throw new Error('Export table counts are incomplete.');
  }
  for (const excluded of EXCLUDED_TABLES) {
    if (Object.hasOwn(exported.tables || {}, excluded)) throw new Error(`Excluded table present: ${excluded}`);
  }
  return exported;
}

function backupKey(key = KEY_BASE64) {
  const result = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "base64");
  if (result.length !== 32) throw new Error("STUDYQUEST_BACKUP_KEY_BASE64 must decode to 32 bytes.");
  return result;
}

function shouldUseSsl(databaseUrl) {
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function isoFileTime(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function log(message) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function writeAtomic(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function jsonSafeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return [key, { encoding: "base64", data: Buffer.from(value).toString("base64") }];
    return [key, value];
  }));
}

async function tableExists(client, tableName) {
  const result = await client.query("select to_regclass($1) is not null as exists", [`public.${tableName}`]);
  return result.rows[0]?.exists === true;
}

async function readTable(client, tableName, orderBy) {
  if (!await tableExists(client, tableName)) throw new Error(`Required backup table is missing: ${tableName}`);
  const result = await client.query(`select * from ${tableName} order by ${orderBy}`);
  return result.rows.map(jsonSafeRow);
}

async function collectDatabaseExport(client) {
  await client.query("begin isolation level repeatable read read only");
  try {
    const metadata = await client.query(
      `select current_database() as database_name, now() as server_time,
              pg_database_size(current_database())::bigint as database_bytes`
    );
    const tables = {
      accounts: await readTable(client, "accounts", "username"),
      state_backups: await readTable(client, "state_backups", "id"),
      state_versions: await readTable(client, "state_versions", "id"),
      state_save_events: await readTable(client, "state_save_events", "id"),
      state_conflict_copies: await readTable(client, "state_conflict_copies", "created_at, id"),
      password_recovery_requests: await readTable(client, "password_recovery_requests", "created_at, id"),
    };
    const exported = validateDatabaseExport({
      format: "studyquest-database-export-v1",
      exportedAt: new Date().toISOString(),
      exclusions: EXCLUDED_TABLES,
      database: jsonSafeRow(metadata.rows[0] || {}),
      counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
      tables,
    });
    await client.query("commit");
    return exported;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

function encryptExport(databaseExport, key) {
  const encryptionKey = backupKey(key);
  const plaintext = Buffer.from(JSON.stringify(databaseExport), "utf8");
  const compressed = zlib.gzipSync(plaintext, { level: 9 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(FORMAT, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    envelope: {
      format: FORMAT,
      createdAt: databaseExport.exportedAt,
      algorithm: "aes-256-gcm",
      compression: "gzip",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      ciphertextSha256: sha256(ciphertext),
      plaintextSha256: sha256(plaintext),
      counts: databaseExport.counts,
    },
    plaintext,
  };
}

function decryptAndValidate(envelope, key, options = {}) {
  const encryptionKey = backupKey(key);
  if (envelope?.format !== FORMAT) throw new Error("Unexpected backup format.");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (sha256(ciphertext) !== envelope.ciphertextSha256) throw new Error("Encrypted backup checksum mismatch.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(FORMAT, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintext = zlib.gunzipSync(compressed);
  if (sha256(plaintext) !== envelope.plaintextSha256) throw new Error("Decrypted backup checksum mismatch.");
  const parsed = JSON.parse(plaintext.toString("utf8"));
  validateDatabaseExport(parsed, options);
  if (JSON.stringify(Object.keys(envelope.counts || {}).sort()) !== JSON.stringify(Object.keys(parsed.counts).sort())) {
    throw new Error('Encrypted envelope table counts are incomplete.');
  }
  for (const [name, expectedCount] of Object.entries(parsed.counts)) {
    if (envelope.counts[name] !== expectedCount) {
      throw new Error(`Decrypted table count mismatch: ${name}`);
    }
  }
  for (const excluded of parsed.exclusions || []) {
    if (Object.prototype.hasOwnProperty.call(parsed.tables || {}, excluded)) throw new Error(`Excluded table present: ${excluded}`);
  }
  return parsed;
}

function pruneDirectory(directory, keep) {
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".sqbackup"))
    .map((name) => ({ name, path: path.join(directory, name), modified: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  for (const file of files.slice(keep)) fs.unlinkSync(file.path);
}

async function main() {
  if (!DATABASE_URL) throw new Error("STUDYQUEST_BACKUP_DATABASE_URL is required.");
  backupKey();
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 30_000,
  });
  try {
    const client = await pool.connect();
    let databaseExport;
    try { databaseExport = await collectDatabaseExport(client); }
    finally { client.release(); }
    const encrypted = encryptExport(databaseExport);
    const serializedEnvelope = `${JSON.stringify(encrypted.envelope)}\n`;
    const now = new Date();
    const dailyPath = path.join(DAILY_DIR, `studyquest-${isoFileTime(now)}.sqbackup`);
    writeAtomic(dailyPath, serializedEnvelope);

    const validationEnvelope = JSON.parse(fs.readFileSync(dailyPath, "utf8"));
    const validation = decryptAndValidate(validationEnvelope);
    const monthPath = path.join(MONTHLY_DIR, `studyquest-${now.toISOString().slice(0, 7)}.sqbackup`);
    if (!fs.existsSync(monthPath)) writeAtomic(monthPath, serializedEnvelope);

    if (!process.argv.includes('--no-prune')) {
      pruneDirectory(DAILY_DIR, 30);
      pruneDirectory(MONTHLY_DIR, 12);
    }
    log(`OK file=${path.basename(dailyPath)} accounts=${validation.counts.accounts || 0} encryptedBytes=${Buffer.byteLength(serializedEnvelope)}`);
    process.stdout.write(JSON.stringify({
      ok: true,
      file: dailyPath,
      monthlyFile: monthPath,
      counts: validation.counts,
      encryptedBytes: Buffer.byteLength(serializedEnvelope),
      validated: true,
    }));
  } catch (error) {
    log(`FAILED ${String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
    throw error;
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = { collectDatabaseExport, encryptExport, decryptAndValidate, validateDatabaseExport, TABLE_ORDERS, jsonSafeRow, sha256 };
if (require.main === module) main().catch((error) => {
  console.error(`StudyQuest encrypted backup failed: ${error.message || error}`);
  process.exit(1);
});
