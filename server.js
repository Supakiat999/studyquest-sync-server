const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Pool } = require("pg");
const {
  additiveIncidentRecovery,
  collectStateRecords,
  deserializeStateVersion,
  recoverMissingRecords,
  serializeStateVersion,
  stableStringify,
  stateActivitySummary,
  stateHash,
  stateManifest,
  statesEqualIgnoringRootUpdatedAt,
  stateRecordDiff,
  stateSummary,
  unapprovedRemovals,
  unapprovedManifestRemovals,
} = require("./lib/state-safety");

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, "public", "claudever9.html");
const V13_HTML_PATH = path.join(ROOT, "public", "claudever13.html");
const V13_VERSION_PATH = path.join(ROOT, "public", "v13-version.json");
const V14_HTML_PATH = path.join(ROOT, "public", "claudever14.html");
const V14_VERSION_PATH = path.join(ROOT, "public", "v14-version.json");
const V15_HTML_PATH = path.join(ROOT, "public", "claudever15.html");
const V15_VERSION_PATH = path.join(ROOT, "public", "v15-version.json");
const V16_HTML_PATH = path.join(ROOT, "public", "claudever16.html");
const V16_FEATURES_PATH = path.join(ROOT, "public", "v16-local-features.js");
const SAFE_SYNC_JS_PATH = path.join(ROOT, "public", "safe-sync.js");
const V16_VERSION_PATH = path.join(ROOT, "public", "v16-version.json");
const V19_HTML_PATH = path.join(ROOT, "public", "claudever19.html");
const V18_FEATURES_PATH = path.join(ROOT, "public", "v18-local-features.js");
const V19_FEATURES_PATH = path.join(ROOT, "public", "v19-local-features.js");
const V19_VERSION_PATH = path.join(ROOT, "public", "v19-version.json");
const V18_ADMIN_COURSE_CRITERIA = require("./lib/v18-admin-course-criteria");
const DEVICE_RECOVERY_HTML_PATH = path.join(ROOT, "public", "device-recovery.html");
const DEVICE_RECOVERY_JS_PATH = path.join(ROOT, "public", "device-recovery.js");
const WEEKLY_STUDY_PLANNER_LITE_PATH = path.join(ROOT, "public", "weekly-study-planner.html");
const WEEKLY_STUDY_PLANNER_FULL_PATH = path.join(ROOT, "public", "weekly-study-planner-full.html");
const SESSION_COOKIE = "sq_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_USERNAME = "admin";
const V14_ACCESS_MODE = (() => {
  const configured = String(process.env.STUDYQUEST_V14_ACCESS || "admin").trim().toLowerCase();
  return ["off", "admin", "all"].includes(configured) ? configured : "admin";
})();
const V15_ACCESS_MODE = (() => {
  const configured = String(process.env.STUDYQUEST_V15_ACCESS || "off").trim().toLowerCase();
  return ["off", "admin", "all"].includes(configured) ? configured : "off";
})();
const V16_ACCESS_MODE = (() => {
  const configured = String(process.env.STUDYQUEST_V16_ACCESS || "off").trim().toLowerCase();
  return ["off", "admin", "all"].includes(configured) ? configured : "off";
})();
const V19_ACCESS_MODE = (() => {
  const configured = String(process.env.STUDYQUEST_V19_ACCESS || "off").trim().toLowerCase();
  return ["off", "admin", "all"].includes(configured) ? configured : "off";
})();
const MAIN_APP_VERSION = (() => {
  const configured = String(process.env.STUDYQUEST_MAIN_VERSION || "15").trim();
  return ["15", "19"].includes(configured) ? configured : "15";
})();
const SAFE_SYNC_MODE = (() => {
  const configured = String(process.env.STUDYQUEST_SAFE_SYNC_MODE || "off").trim().toLowerCase();
  return ["off", "admin", "users", "all"].includes(configured) ? configured : "off";
})();
const SAFE_SYNC_USERS = new Set(String(process.env.STUDYQUEST_SAFE_SYNC_USERS || "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = "sha512";
const MAX_ACCOUNTS = Number(process.env.STUDYQUEST_MAX_ACCOUNTS || 5);
const MAX_AUTH_BODY_BYTES = 64 * 1024;
const MAX_STATE_BYTES = Number(process.env.STUDYQUEST_MAX_STATE_BYTES || 10 * 1024 * 1024);
const MAX_STATE_ENVELOPE_BYTES = Number(process.env.STUDYQUEST_MAX_STATE_ENVELOPE_BYTES || 256 * 1024);
const STATE_HISTORY_BUDGET_BYTES = Number(process.env.STUDYQUEST_STATE_HISTORY_BUDGET_BYTES || 64 * 1024 * 1024);
const CONFLICT_COPY_BUDGET_BYTES = Number(process.env.STUDYQUEST_CONFLICT_COPY_BUDGET_BYTES || 32 * 1024 * 1024);
const TEMP_PASSWORD_MAX_AGE_SECONDS = 24 * 60 * 60;
const IS_HOSTED = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.NODE_ENV === "production");

const ADMIN_PASSWORD = process.env.STUDYQUEST_ADMIN_PASSWORD;
const INVITE_CODE = process.env.STUDYQUEST_INVITE_CODE;
const ADMIN_CONTACT_LABEL = String(process.env.STUDYQUEST_ADMIN_CONTACT_LABEL || "Contact your StudyQuest admin").trim().slice(0, 120);
const ADMIN_CONTACT_URL = safeContactUrl(process.env.STUDYQUEST_ADMIN_CONTACT_URL);
const DATABASE_URL = process.env.DATABASE_URL;
const RECOVERY_PREVIEW_MAX_AGE_MS = 10 * 60 * 1000;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

if (IS_HOSTED && (!ADMIN_PASSWORD || !INVITE_CODE)) {
  throw new Error("Set STUDYQUEST_ADMIN_PASSWORD and STUDYQUEST_INVITE_CODE before hosting StudyQuest.");
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLMODE === "require") return true;
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function explicitSslConnectionString(databaseUrl) {
  if (!shouldUseSsl(databaseUrl)) return databaseUrl;
  try {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

function databaseEndpointSafety(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    return {
      pooled:/-pooler(?:\.|$)/i.test(parsed.hostname),
      tlsVerified:shouldUseSsl(databaseUrl),
      provider:/\.neon\.tech$/i.test(parsed.hostname) ? "neon" : "postgres",
    };
  } catch {
    return { pooled:false, tlsVerified:shouldUseSsl(databaseUrl), provider:"postgres" };
  }
}

const pool = new Pool({
  connectionString: explicitSslConnectionString(DATABASE_URL),
  ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: true } : false,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  query_timeout: 25000,
  statement_timeout: 25000,
  idle_in_transaction_session_timeout: 15000,
});

const authBuckets = new Map();
const deviceTouchTimes = new Map();
const metadataLoads = new Map();
const htmlTemplates = new Map();

function safeSyncEnabledFor(user) {
  if (!user || SAFE_SYNC_MODE === "off") return false;
  if (SAFE_SYNC_MODE === "all") return true;
  if (SAFE_SYNC_MODE === "admin") return user.username === ADMIN_USERNAME;
  return SAFE_SYNC_USERS.has(String(user.username || "").toLowerCase());
}

function serverLog(level, event, details = {}) {
  const payload = JSON.stringify({
    at:new Date().toISOString(), level, event,
    service:process.env.RENDER_SERVICE_NAME || "studyquest-sync-server",
    ...details,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function payloadTooLargeError(maxBytes) {
  const error = new Error(`Request body is too large. Limit is ${maxBytes} bytes.`);
  error.code = "PAYLOAD_TOO_LARGE";
  return error;
}

function stateTooLargePayload(stateBytes) {
  return {
    ok: false,
    error: "STATE_TOO_LARGE",
    stateBytes,
    maxStateBytes: MAX_STATE_BYTES,
    serverTime: new Date().toISOString(),
  };
}

function send(req, res, status, body, headers = {}) {
  const baseHeaders = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,if-none-match",
    "access-control-allow-credentials": "true",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  };
  const origin = req.headers.origin;
  if (isAllowedOrigin(req, origin)) {
    baseHeaders["access-control-allow-origin"] = origin;
    baseHeaders.vary = [baseHeaders.vary, "Origin"].filter(Boolean).join(", ");
  }
  let responseBody = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const contentType = String(baseHeaders["content-type"] || "");
  const accepts = String(req.headers["accept-encoding"] || "");
  const compressible = responseBody.length >= 1024
    && /(?:json|javascript|text|css|html|svg)/i.test(contentType)
    && !baseHeaders["content-encoding"]
    && status !== 204 && status !== 304;
  if (compressible && /\bbr\b/i.test(accepts)) {
    responseBody = zlib.brotliCompressSync(responseBody, {
      params:{ [zlib.constants.BROTLI_PARAM_QUALITY]:5 },
    });
    baseHeaders["content-encoding"] = "br";
  } else if (compressible && /\bgzip\b/i.test(accepts)) {
    responseBody = zlib.gzipSync(responseBody, { level:6 });
    baseHeaders["content-encoding"] = "gzip";
  }
  if (compressible) baseHeaders.vary = [baseHeaders.vary, "Accept-Encoding"].filter(Boolean).join(", ");
  baseHeaders["content-length"] = responseBody.length;
  res.writeHead(status, baseHeaders);
  res.end(req.method === "HEAD" || status === 204 || status === 304 ? undefined : responseBody);
}

function sendJson(req, res, status, data, headers = {}) {
  send(req, res, status, JSON.stringify(data), {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
}

function htmlTemplate(filePath) {
  if (!htmlTemplates.has(filePath)) htmlTemplates.set(filePath, fs.readFileSync(filePath, "utf8"));
  return htmlTemplates.get(filePath);
}

function authenticatedV13Html(user) {
  const html = htmlTemplate(V13_HTML_PATH);
  const bootstrap = `<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__=${JSON.stringify({ username: user.username })};</script>`;
  return html.replace("</head>", `${bootstrap}\n</head>`);
}

function authenticatedV14Html(user) {
  const html = htmlTemplate(V14_HTML_PATH);
  const bootstrap = `<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__=${JSON.stringify({ username: user.username })};</script>`;
  return html.replace("</head>", `${bootstrap}\n</head>`);
}

function canAccessV14(user) {
  if (!user || user.sync_device_id || V14_ACCESS_MODE === "off") return false;
  return V14_ACCESS_MODE === "all" || user.username === ADMIN_USERNAME;
}

function authenticatedV15Html(user) {
  const html = htmlTemplate(V15_HTML_PATH);
  const bootstrap = `<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__=${JSON.stringify({ username: user.username })};window.__STUDYQUEST_SAFE_SYNC_V2__=${JSON.stringify(safeSyncEnabledFor(user))};</script>`;
  return html.replace("</head>", `${bootstrap}\n</head>`);
}

function canAccessV15(user) {
  if (!user || user.sync_device_id || V15_ACCESS_MODE === "off") return false;
  return V15_ACCESS_MODE === "all" || user.username === ADMIN_USERNAME;
}

function authenticatedV16Html(user) {
  const html = htmlTemplate(V16_HTML_PATH);
  const bootstrap = `<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__=${JSON.stringify({ username: user.username })};window.__STUDYQUEST_SAFE_SYNC_V2__=${JSON.stringify(safeSyncEnabledFor(user))};</script>`;
  return html.replace("</head>", `${bootstrap}\n</head>`);
}

function canAccessV16(user) {
  if (!user || user.sync_device_id || V16_ACCESS_MODE === "off") return false;
  return V16_ACCESS_MODE === "all" || user.username === ADMIN_USERNAME;
}

function authenticatedV19Html(user) {
  const html = htmlTemplate(V19_HTML_PATH);
  const bootstrap = `<script>document.documentElement.classList.add("studyquest-account-loading");window.__STUDYQUEST_MULTI_ACCOUNT__=true;window.__STUDYQUEST_AUTH_USER__=${JSON.stringify({ username: user.username })};window.__STUDYQUEST_SAFE_SYNC_V2__=${JSON.stringify(safeSyncEnabledFor(user))};</script>`;
  return html.replace("</head>", `${bootstrap}\n</head>`);
}

function canAccessV19(user) {
  if (!user || user.sync_device_id || V19_ACCESS_MODE === "off") return false;
  return V19_ACCESS_MODE === "all" || user.username === ADMIN_USERNAME;
}

function readBody(req, maxBytes = MAX_AUTH_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredSize = Number(req.headers["content-length"] || 0);
    if (declaredSize > maxBytes) {
      req.resume();
      reject(payloadTooLargeError(maxBytes));
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(payloadTooLargeError(maxBytes));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes = MAX_AUTH_BODY_BYTES) {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST)
    .toString("hex");
  return {
    algorithm: "pbkdf2",
    digest: PBKDF2_DIGEST,
    iterations: PBKDF2_ITERATIONS,
    keyLength: PBKDF2_KEY_LENGTH,
    salt,
    hash
  };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const hash = crypto
    .pbkdf2Sync(
      String(password),
      record.salt,
      Number(record.iterations || PBKDF2_ITERATIONS),
      Number(record.keyLength || PBKDF2_KEY_LENGTH),
      record.digest || PBKDF2_DIGEST
    )
    .toString("hex");
  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readableSecret(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return value;
}

function recoveryCaseId() {
  return `SQ-${readableSecret(10)}`;
}

function temporaryPassword() {
  return `SQ!${readableSecret(6)}-${readableSecret(6)}-${readableSecret(4)}`;
}

function safeDeviceLabel(value, fallback = "unknown") {
  const label = String(value || fallback).trim().slice(0, 120);
  return label || fallback;
}

async function insertStateVersion(client, { username, revision, state, sourceDevice, createdAt = null, version = null }) {
  if (!state || typeof state !== "object") return null;
  const prepared = version || serializeStateVersion(state);
  const result = await client.query(
    `insert into state_versions
       (username, revision, state_gzip, state_hash, state_bytes, compressed_bytes, source_device, summary, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, coalesce($9::timestamptz, now()))
     on conflict (username, revision) do nothing
     returning id`,
    [
      username,
      Number(revision || 0),
      prepared.stateGzip,
      prepared.hash,
      prepared.stateBytes,
      prepared.compressedBytes,
      safeDeviceLabel(sourceDevice),
      JSON.stringify(stateSummary(state)),
      createdAt,
    ]
  );
  return { ...prepared, id: result.rows[0]?.id ? String(result.rows[0].id) : null };
}

async function recordSaveEvent(client, details) {
  const state = details.state && typeof details.state === "object" ? details.state : null;
  const serialized = state ? serializeStateVersion(state) : null;
  await client.query(
    `insert into state_save_events
       (username, result, base_revision, current_revision, resulting_revision,
        state_hash, state_bytes, device_id, summary, detail, base_hash, mutation_id,
        change_manifest, merge_source, conflict_copy_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15)`,
    [
      details.username,
      details.result,
      Number.isInteger(details.baseRevision) ? details.baseRevision : null,
      Number.isInteger(details.currentRevision) ? details.currentRevision : null,
      Number.isInteger(details.resultingRevision) ? details.resultingRevision : null,
      details.stateHash || serialized?.hash || null,
      Number.isInteger(details.stateBytes) ? details.stateBytes : serialized?.stateBytes || null,
      safeDeviceLabel(details.deviceId),
      state ? JSON.stringify(stateSummary(state)) : null,
      String(details.detail || "").slice(0, 240) || null,
      details.baseHash || null,
      details.mutationId || null,
      details.changeManifest ? JSON.stringify(details.changeManifest) : null,
      details.mergeSource || null,
      details.conflictCopyId || null,
    ]
  );
}

async function preserveConflictCopy(client, details) {
  await client.query(
    `delete from state_conflict_copies
     where username = $1 and resolved_at is not null and retention_expires_at < now()`,
    [details.username]
  );
  const mutationId = details.mutationId || `candidate:${details.candidate.hash}`;
  const duplicate = await client.query(
    `select id, candidate_hash, compressed_bytes
     from state_conflict_copies
     where username = $1 and mutation_id = $2 and candidate_hash = $3
     order by created_at desc limit 1`,
    [details.username, mutationId, details.candidate.hash]
  );
  if (duplicate.rowCount) {
    return { id:String(duplicate.rows[0].id), deduplicated:true, storageFull:false };
  }
  const usage = await client.query(
    `select coalesce(sum(compressed_bytes), 0)::bigint as bytes
     from state_conflict_copies
     where username = $1 and retention_expires_at >= now()`,
    [details.username]
  );
  const usedBytes = Number(usage.rows[0]?.bytes || 0);
  if (usedBytes + details.candidate.compressedBytes > CONFLICT_COPY_BUDGET_BYTES) {
    return { id:null, deduplicated:false, storageFull:true, usedBytes };
  }
  const id = crypto.randomUUID();
  await client.query(
    `insert into state_conflict_copies
       (id, username, mutation_id, device_id, reason, base_revision, base_hash,
        cloud_revision, cloud_hash, candidate_hash, candidate_bytes, candidate_gzip, compressed_bytes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      details.username,
      mutationId,
      safeDeviceLabel(details.deviceId),
      String(details.reason || "STATE_CONFLICT").slice(0, 80),
      Number.isInteger(details.baseRevision) ? details.baseRevision : null,
      details.baseHash || null,
      Number(details.cloudRevision || 0),
      details.cloudHash,
      details.candidate.hash,
      details.candidate.stateBytes,
      details.candidate.stateGzip,
      details.candidate.compressedBytes,
    ]
  );
  return { id, deduplicated:false, storageFull:false, usedBytes };
}

function bangkokBucket(dateValue, includeHour) {
  const shifted = new Date(new Date(dateValue).getTime() + 7 * 60 * 60 * 1000);
  const day = shifted.toISOString().slice(0, 10);
  return includeHour ? `${day}T${String(shifted.getUTCHours()).padStart(2, "0")}` : day;
}

async function pruneStateVersions(username) {
  const result = await pool.query(
    `select id, compressed_bytes, created_at
     from state_versions where username = $1
     order by created_at desc, id desc`,
    [username]
  );
  const rows = result.rows;
  if (rows.length <= 100) return;
  const now = Date.now();
  const keep = new Set();
  let keptBytes = 0;
  const hourly = new Set();
  const daily = new Set();

  rows.forEach((row, index) => {
    if (index < 100) {
      keep.add(String(row.id));
      keptBytes += Number(row.compressed_bytes || 0);
    }
  });

  for (let index = 100; index < rows.length; index += 1) {
    const row = rows[index];
    const ageMs = now - new Date(row.created_at).getTime();
    if (ageMs < 0 || ageMs > 90 * 24 * 60 * 60 * 1000) continue;
    const bucketSet = ageMs <= 30 * 24 * 60 * 60 * 1000 ? hourly : daily;
    const bucket = bangkokBucket(row.created_at, bucketSet === hourly);
    if (bucketSet.has(bucket)) continue;
    bucketSet.add(bucket);
    const bytes = Number(row.compressed_bytes || 0);
    if (keptBytes + bytes > STATE_HISTORY_BUDGET_BYTES) continue;
    keep.add(String(row.id));
    keptBytes += bytes;
  }

  await pool.query(
    `delete from state_versions
     where username = $1 and not (id = any($2::bigint[]))`,
    [username, Array.from(keep)]
  );
}

async function backfillCurrentStateVersions(client = pool) {
  const result = await client.query(
    `select username, state, state_revision, state_updated_at, updated_at
     from accounts where state is not null`
  );
  for (const row of result.rows) {
    await insertStateVersion(client, {
      username: row.username,
      revision: Number(row.state_revision || 0),
      state: row.state,
      sourceDevice: "startup-backfill",
      createdAt: row.state_updated_at || row.updated_at || null,
    });
  }
}

async function backfillStateMetadata(client) {
  const result = await client.query(
    `select username, state, state_hash, state_manifest, state_manifest_version
     from accounts
     where state is not null
       and (state_hash is null or state_manifest is null or state_manifest_version <> 1)`
  );
  for (const row of result.rows) {
    const manifest = stateManifest(row.state);
    await client.query(
      `update accounts
       set state_hash = coalesce(state_hash, $2), state_manifest = $3::jsonb,
           state_manifest_version = $4
       where username = $1`,
      [row.username, stateHash(row.state), JSON.stringify(manifest), manifest.version]
    );
  }
}

function isAllowedOrigin(req, origin) {
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientKey(req, suffix = "") {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  return `${ip}:${suffix}`;
}

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const bucket = authBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  authBuckets.set(key, bucket);
  return bucket.count > limit;
}

function cookieOptions(req, maxAgeSeconds) {
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || IS_HOSTED;
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function recoveryPreviewSecret() {
  return crypto.createHash("sha256")
    .update(`studyquest-recovery-preview|${ADMIN_PASSWORD || ""}|${INVITE_CODE || ""}|${DATABASE_URL}`)
    .digest();
}

function signRecoveryPreview(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", recoveryPreviewSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyRecoveryPreview(token, expected = {}) {
  try {
    const [encoded, signature, extra] = String(token || "").split(".");
    if (!encoded || !signature || extra) return null;
    const expectedSignature = crypto.createHmac("sha256", recoveryPreviewSecret()).update(encoded).digest();
    const actualSignature = Buffer.from(signature, "base64url");
    if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || Number(payload.expiresAt || 0) <= Date.now()) return null;
    for (const [key, value] of Object.entries(expected)) {
      if (value !== undefined && String(payload[key]) !== String(value)) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function publicUser(row) {
  return {
    username: row.username,
    displayName: row.display_name || row.username,
    isAdmin: row.username === ADMIN_USERNAME,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateCredentials(username, password) {
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-32 characters using letters, numbers, underscore, or dash.";
  }
  if (String(password || "").length < PASSWORD_MIN_LENGTH) {
    return "Password must be at least 8 characters.";
  }
  return "";
}

async function ensureAdminAccount() {
  const admin = await pool.query("select username, password_record from accounts where username = $1", [ADMIN_USERNAME]);
  if (!admin.rowCount) {
    const initialPassword = ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
    await pool.query(
      `insert into accounts (username, display_name, password_record, state, state_bytes)
       values ($1, $2, $3::jsonb, null, 0)`,
      [ADMIN_USERNAME, "Admin", JSON.stringify(passwordRecord(initialPassword))]
    );
    return;
  }

  if (ADMIN_PASSWORD && !verifyPassword(ADMIN_PASSWORD, admin.rows[0].password_record)) {
    await pool.query(
      `update accounts
       set password_record = $2::jsonb, password_change_required = false,
           temporary_password_expires_at = null, updated_at = now()
       where username = $1`,
      [ADMIN_USERNAME, JSON.stringify(passwordRecord(ADMIN_PASSWORD))]
    );
    await pool.query("delete from sessions where username = $1", [ADMIN_USERNAME]);
    serverLog("info", "admin_password_synchronized");
  }
}

async function runSchemaMigrations() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('studyquest-schema-migrations'))");
    await client.query(
      `create table if not exists schema_migrations (
         version integer primary key,
         name text not null,
         applied_at timestamptz not null default now()
       )`
    );
    const applied = await client.query("select version from schema_migrations order by version");
    const versions = new Set(applied.rows.map((row) => Number(row.version)));
    if (!versions.has(1)) {
      await client.query(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
      await client.query(
        "insert into schema_migrations(version, name) values (1, 'baseline') on conflict do nothing"
      );
      await backfillCurrentStateVersions(client);
    }
    if (!versions.has(2)) {
      await client.query(fs.readFileSync(path.join(ROOT, "migrations", "002_neon_safe_sync.sql"), "utf8"));
      await backfillStateMetadata(client);
      await client.query(
        "insert into schema_migrations(version, name) values (2, 'neon-safe-sync') on conflict do nothing"
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runDailyMaintenance() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtext('studyquest-daily-maintenance')) as locked");
    if (!lock.rows[0]?.locked) {
      await client.query("rollback");
      return false;
    }
    const due = await client.query(
      `select last_completed_at
       from app_maintenance_state where task_name = 'daily-cleanup' for update`
    );
    if (due.rowCount && Date.now() - new Date(due.rows[0].last_completed_at).getTime() < 24 * 60 * 60 * 1000) {
      await client.query("commit");
      return false;
    }
    await client.query("delete from sessions where expires_at < now()");
    await client.query("delete from sync_pairing_codes where expires_at < now() or used_at is not null");
    await client.query("delete from state_backups where created_at < now() - interval '30 days'");
    await client.query("delete from state_save_events where created_at < now() - interval '180 days'");
    await client.query("delete from state_conflict_copies where retention_expires_at < now()");
    await client.query(
      `update password_recovery_requests
       set status = 'expired', resolved_at = coalesce(resolved_at, now())
       where status = 'approved' and expires_at < now()`
    );
    await client.query("delete from sync_pairing_codes where username <> $1", [ADMIN_USERNAME]);
    await client.query(
      "update sync_devices set revoked_at = coalesce(revoked_at, now()) where username <> $1",
      [ADMIN_USERNAME]
    );
    await client.query(
      `insert into app_maintenance_state(task_name, last_completed_at, detail)
       values ('daily-cleanup', now(), '{"retention":"complete"}'::jsonb)
       on conflict (task_name) do update
       set last_completed_at = excluded.last_completed_at, detail = excluded.detail`
    );
    await client.query("commit");
    serverLog("info", "daily_maintenance_complete");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  await runSchemaMigrations();
  await ensureAdminAccount();
  await runDailyMaintenance();
}

async function currentUser(req, { includeState = true } = {}) {
  const stateProjection = includeState ? ", a.state" : "";
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    const deviceToken = authorization.slice(7).trim();
    if (!deviceToken) return null;
    const deviceResult = await pool.query(
      `select a.username, a.display_name, a.password_record, a.state_bytes, a.state_hash,
              a.state_revision, a.state_updated_at, a.state_manifest, a.state_manifest_version,
              a.created_at, a.updated_at ${stateProjection},
              d.id as sync_device_id, d.device_name as sync_device_name
       from sync_devices d
       join accounts a on a.username = d.username
       where d.token_hash = $1 and d.revoked_at is null and d.username = $2`,
      [tokenHash(deviceToken), ADMIN_USERNAME]
    );
    const deviceUser = deviceResult.rows[0] || null;
    if (deviceUser) {
      const lastTouch = Number(deviceTouchTimes.get(deviceUser.sync_device_id) || 0);
      if (Date.now() - lastTouch >= 5 * 60 * 1000) {
        deviceTouchTimes.set(deviceUser.sync_device_id, Date.now());
        await pool.query("update sync_devices set last_used_at = now() where id = $1", [deviceUser.sync_device_id]);
      }
    }
    return deviceUser;
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const result = await pool.query(
    `select a.username, a.display_name, a.password_record, a.state_bytes, a.state_hash,
            a.state_revision, a.state_updated_at, a.state_manifest, a.state_manifest_version,
            a.created_at, a.updated_at ${stateProjection}
     from sessions s
     join accounts a on a.username = s.username
     where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash(token)]
  );

  return result.rows[0] || null;
}

async function createSession(req, res, username) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `insert into sessions (token_hash, username, expires_at, user_agent)
     values ($1, $2, now() + ($3 || ' seconds')::interval, $4)`,
    [tokenHash(token), username, SESSION_MAX_AGE_SECONDS, String(req.headers["user-agent"] || "").slice(0, 180)]
  );
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(req, SESSION_MAX_AGE_SECONDS)}`
  );
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieOptions(req, 0)}`);
}

async function handleLogin(req, res) {
  if (req.method !== "POST") {
    send(req, res, 405, "Method not allowed");
    return;
  }

  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const rateKey = clientKey(req, `login:${username}`);

  if (isRateLimited(rateKey, 20, 15 * 60 * 1000)) {
    sendJson(req, res, 429, { ok: false, error: "Too many login attempts. Try again in 15 minutes." });
    return;
  }

  const result = await pool.query(
    `select username, display_name, password_record, password_change_required,
            temporary_password_expires_at, created_at, updated_at
     from accounts where username = $1`,
    [username]
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_record)) {
    sendJson(req, res, 401, { ok: false, error: "Wrong username or password." });
    return;
  }

  if (user.password_change_required) {
    if (!user.temporary_password_expires_at || new Date(user.temporary_password_expires_at).getTime() <= Date.now()) {
      await pool.query(
        `update password_recovery_requests
         set status = 'expired', resolved_at = coalesce(resolved_at, now())
         where username = $1 and status = 'approved'`,
        [username]
      );
      sendJson(req, res, 403, {
        ok: false,
        code: "TEMPORARY_PASSWORD_EXPIRED",
        error: "That temporary password expired. Contact your StudyQuest admin for a new reset.",
      });
      return;
    }
    sendJson(req, res, 409, {
      ok: false,
      code: "PASSWORD_CHANGE_REQUIRED",
      error: "Choose a new password to finish account recovery.",
    });
    return;
  }

  await createSession(req, res, username);
  sendJson(req, res, 200, { ok: true, user: publicUser(user) });
}

async function handleRegister(req, res) {
  if (req.method !== "POST") {
    send(req, res, 405, "Method not allowed");
    return;
  }

  const rateKey = clientKey(req, "register");
  if (isRateLimited(rateKey, 10, 60 * 60 * 1000)) {
    sendJson(req, res, 429, { ok: false, error: "Too many account attempts. Try again later." });
    return;
  }

  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const inviteCode = String(body.inviteCode || "").trim();
  const validationError = validateCredentials(username, password);

  if (INVITE_CODE && inviteCode !== INVITE_CODE) {
    sendJson(req, res, 403, { ok: false, error: "Invite code is required to create an account." });
    return;
  }

  if (validationError) {
    sendJson(req, res, 400, { ok: false, error: validationError });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const count = await client.query("select count(*)::int as count from accounts");
    if (count.rows[0].count >= MAX_ACCOUNTS) {
      await client.query("rollback");
      sendJson(req, res, 403, { ok: false, error: `Account limit reached. This StudyQuest server allows ${MAX_ACCOUNTS} accounts total.` });
      return;
    }

    const existing = await client.query("select username from accounts where username = $1", [username]);
    if (existing.rowCount) {
      await client.query("rollback");
      sendJson(req, res, 409, { ok: false, error: "That username already exists." });
      return;
    }

    const inserted = await client.query(
      `insert into accounts (username, display_name, password_record, state, state_bytes)
       values ($1, $2, $3::jsonb, null, 0)
       returning *`,
      [username, username, JSON.stringify(passwordRecord(password))]
    );
    await client.query("commit");
    await createSession(req, res, username);
    sendJson(req, res, 201, { ok: true, user: publicUser(inserted.rows[0]) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function recoveryContact() {
  return { label: ADMIN_CONTACT_LABEL || "Contact your StudyQuest admin", url: ADMIN_CONTACT_URL || null };
}

async function requireBrowserAdmin(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user || user.username !== ADMIN_USERNAME || user.sync_device_id) {
    sendJson(req, res, 403, { ok: false, error: "Admin access required." });
    return null;
  }
  return user;
}

async function handleRecoveryConfig(req, res) {
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  sendJson(req, res, 200, { ok: true, contact: recoveryContact() });
}

async function handleRecoveryRequest(req, res) {
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  if (isRateLimited(clientKey(req, "recovery-request"), 5, 60 * 60 * 1000)) {
    return sendJson(req, res, 429, { ok: false, error: "Too many recovery requests. Try again later." });
  }

  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  let requestId = recoveryCaseId();
  if (USERNAME_PATTERN.test(username)) {
    const existing = await pool.query(
      `select id from password_recovery_requests
       where username = $1 and status = 'pending'
       order by created_at desc limit 1`,
      [username]
    );
    if (existing.rowCount) {
      requestId = existing.rows[0].id;
    } else {
      await pool.query(
        `insert into password_recovery_requests (id, username, source)
         values ($1, $2, 'user')
         on conflict do nothing`,
        [requestId, username]
      );
      const pending = await pool.query(
        `select id from password_recovery_requests
         where username = $1 and status = 'pending'
         order by created_at desc limit 1`,
        [username]
      );
      if (pending.rowCount) requestId = pending.rows[0].id;
    }
  }

  sendJson(req, res, 200, {
    ok: true,
    requestId,
    contact: recoveryContact(),
    adminRecovery: username === ADMIN_USERNAME,
    message: username === ADMIN_USERNAME
      ? "Admin recovery must be completed by the Render owner using STUDYQUEST_ADMIN_PASSWORD."
      : "If that account exists, the request is ready. Contact your StudyQuest admin and provide this case ID.",
  });
}

async function handleRecoveryComplete(req, res) {
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  const suppliedTemporaryPassword = String(body.temporaryPassword || "");
  const newPassword = String(body.newPassword || "");
  const validationError = validateCredentials(username, newPassword);
  if (validationError) return sendJson(req, res, 400, { ok: false, error: validationError });
  if (username === ADMIN_USERNAME) {
    return sendJson(req, res, 403, { ok: false, error: "Admin recovery must be completed in Render." });
  }
  if (isRateLimited(clientKey(req, `recovery-complete:${username}`), 10, 15 * 60 * 1000)) {
    return sendJson(req, res, 429, { ok: false, error: "Too many recovery attempts. Try again in 15 minutes." });
  }

  const client = await pool.connect();
  let recoveredUser = null;
  try {
    await client.query("begin");
    const result = await client.query("select * from accounts where username = $1 for update", [username]);
    const account = result.rows[0];
    const validTemporaryPassword = account
      && account.password_change_required
      && account.temporary_password_expires_at
      && new Date(account.temporary_password_expires_at).getTime() > Date.now()
      && verifyPassword(suppliedTemporaryPassword, account.password_record);
    if (!validTemporaryPassword) {
      await client.query("rollback");
      return sendJson(req, res, 401, { ok: false, error: "Temporary password is invalid or expired." });
    }

    const updated = await client.query(
      `update accounts
       set password_record = $2::jsonb, password_change_required = false,
           temporary_password_expires_at = null, updated_at = now()
       where username = $1
       returning *`,
      [username, JSON.stringify(passwordRecord(newPassword))]
    );
    await client.query(
      `update password_recovery_requests
       set status = 'completed', completed_at = now()
       where id = (
         select id from password_recovery_requests
         where username = $1 and status = 'approved'
         order by resolved_at desc nulls last limit 1
       )`,
      [username]
    );
    await client.query("commit");
    recoveredUser = updated.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await createSession(req, res, username);
  sendJson(req, res, 200, { ok: true, user: publicUser(recoveredUser) });
}

async function expireApprovedRecoveryRequests(client = pool) {
  await client.query(
    `update password_recovery_requests
     set status = 'expired', resolved_at = coalesce(resolved_at, now())
     where status = 'approved' and expires_at < now()`
  );
}

async function approveRecoveryRequest(client, requestId, adminNote) {
  const requestResult = await client.query(
    "select * from password_recovery_requests where id = $1 for update",
    [requestId]
  );
  const request = requestResult.rows[0];
  if (!request) return { error: "Recovery request not found.", status: 404 };
  if (request.username === ADMIN_USERNAME) return { error: "Admin recovery must be completed in Render.", status: 403 };
  if (request.status !== "pending") return { error: "Only pending recovery requests can be approved.", status: 409 };

  const accountResult = await client.query("select * from accounts where username = $1 for update", [request.username]);
  const account = accountResult.rows[0];
  if (!account) return { error: "No account exists for this request.", status: 404 };

  const plaintext = temporaryPassword();
  const expiresAt = new Date(Date.now() + TEMP_PASSWORD_MAX_AGE_SECONDS * 1000);
  await client.query(
    `update accounts
     set password_record = $2::jsonb, password_change_required = true,
         temporary_password_expires_at = $3, updated_at = now()
     where username = $1`,
    [request.username, JSON.stringify(passwordRecord(plaintext)), expiresAt]
  );
  await client.query("delete from sessions where username = $1", [request.username]);
  await client.query("update sync_devices set revoked_at = now() where username = $1 and revoked_at is null", [request.username]);
  await client.query(
    `update password_recovery_requests
     set status = 'approved', admin_note = $2, resolved_at = now(), expires_at = $3
     where id = $1`,
    [requestId, adminNote || null, expiresAt]
  );
  return { request, plaintext, expiresAt };
}

async function handleAdminRecoveryRequests(req, res) {
  if (!await requireBrowserAdmin(req, res)) return;
  await expireApprovedRecoveryRequests();
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const result = await pool.query(
    `select r.*, a.display_name, a.created_at as account_created_at,
            a.username is not null as account_exists, a.state
     from password_recovery_requests r
     left join accounts a on a.username = r.username
     order by case r.status when 'pending' then 0 when 'approved' then 1 else 2 end,
              r.created_at desc`
  );
  const requests = result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    status: row.status,
    source: row.source,
    adminNote: row.admin_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    accountExists: !!row.account_exists,
    displayName: row.display_name || null,
    summary: row.account_exists ? stateSummary(row.state) : null,
  }));
  sendJson(req, res, 200, { ok: true, requests });
}

async function handleAdminRecoveryApprove(req, res, requestId) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await approveRecoveryRequest(client, requestId, String(body.note || "").trim().slice(0, 500));
    if (result.error) {
      await client.query("rollback");
      return sendJson(req, res, result.status, { ok: false, error: result.error });
    }
    await client.query("commit");
    sendJson(req, res, 200, {
      ok: true,
      requestId,
      username: result.request.username,
      temporaryPassword: result.plaintext,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleAdminRecoveryDeny(req, res, requestId) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const result = await pool.query(
    `update password_recovery_requests
     set status = 'denied', admin_note = $2, resolved_at = now()
     where id = $1 and status = 'pending'
     returning id`,
    [requestId, String(body.note || "").trim().slice(0, 500) || null]
  );
  if (!result.rowCount) return sendJson(req, res, 409, { ok: false, error: "That request is no longer pending." });
  sendJson(req, res, 200, { ok: true });
}

async function handleAdminRecoveryManual(req, res) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  const note = String(body.note || "").trim().slice(0, 500);
  if (username === ADMIN_USERNAME) return sendJson(req, res, 403, { ok: false, error: "Admin recovery must be completed in Render." });
  if (!USERNAME_PATTERN.test(username) || note.length < 3) {
    return sendJson(req, res, 400, { ok: false, error: "Choose a valid username and record why the reset was requested." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const account = await client.query("select username from accounts where username = $1", [username]);
    if (!account.rowCount) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "Account not found." });
    }
    let pending = await client.query(
      "select id from password_recovery_requests where username = $1 and status = 'pending' order by created_at desc limit 1",
      [username]
    );
    let requestId = pending.rows[0]?.id;
    if (!requestId) {
      requestId = recoveryCaseId();
      await client.query(
        `insert into password_recovery_requests (id, username, source, admin_note)
         values ($1, $2, 'admin', $3)`,
        [requestId, username, note]
      );
    }
    const result = await approveRecoveryRequest(client, requestId, note);
    if (result.error) {
      await client.query("rollback");
      return sendJson(req, res, result.status, { ok: false, error: result.error });
    }
    await client.query("commit");
    sendJson(req, res, 200, {
      ok: true,
      requestId,
      username,
      temporaryPassword: result.plaintext,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleAdminRecoverySnapshots(req, res, url) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const username = normalizeUsername(url.searchParams.get("username"));
  if (!USERNAME_PATTERN.test(username)) return sendJson(req, res, 400, { ok: false, error: "Choose an account." });
  const account = await pool.query("select username, state, state_revision, state_updated_at from accounts where username = $1", [username]);
  if (!account.rowCount) return sendJson(req, res, 404, { ok: false, error: "Account not found." });
  const backups = await pool.query(
    `select id, revision, reason, created_at, state
     from state_backups where username = $1
     order by created_at desc limit 60`,
    [username]
  );
  const versions = await pool.query(
    `select id, revision, state_hash, state_bytes, compressed_bytes, source_device, summary, created_at
     from state_versions where username = $1
     order by created_at desc, id desc limit 120`,
    [username]
  );
  const events = await pool.query(
    `select id, result, base_revision, current_revision, resulting_revision,
            state_hash, state_bytes, device_id, summary, detail, base_hash,
            mutation_id, change_manifest, merge_source, created_at
     from state_save_events where username = $1
     order by created_at desc, id desc limit 100`,
    [username]
  );
  const historyUsage = await pool.query(
    `select count(*)::int as count, coalesce(sum(compressed_bytes), 0)::bigint as compressed_bytes
     from state_versions where username = $1`,
    [username]
  );
  sendJson(req, res, 200, {
    ok: true,
    username,
    current: {
      revision: Number(account.rows[0].state_revision || 0),
      updatedAt: account.rows[0].state_updated_at,
      summary: stateSummary(account.rows[0].state),
    },
    snapshots: backups.rows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision || 0),
      reason: row.reason,
      createdAt: row.created_at,
      summary: stateSummary(row.state),
    })),
    versions: versions.rows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision || 0),
      stateHash: row.state_hash,
      stateBytes: Number(row.state_bytes || 0),
      compressedBytes: Number(row.compressed_bytes || 0),
      sourceDevice: row.source_device,
      summary: row.summary || {},
      createdAt: row.created_at,
    })),
    saveEvents: events.rows.map((row) => ({
      id: String(row.id),
      result: row.result,
      baseRevision: row.base_revision === null ? null : Number(row.base_revision),
      currentRevision: row.current_revision === null ? null : Number(row.current_revision),
      resultingRevision: row.resulting_revision === null ? null : Number(row.resulting_revision),
      stateHash: row.state_hash,
      stateBytes: row.state_bytes === null ? null : Number(row.state_bytes),
      deviceId: row.device_id,
      summary: row.summary || null,
      detail: row.detail,
      createdAt: row.created_at,
    })),
    history: {
      versionCount: Number(historyUsage.rows[0]?.count || 0),
      compressedBytes: Number(historyUsage.rows[0]?.compressed_bytes || 0),
      budgetBytes: STATE_HISTORY_BUDGET_BYTES,
    },
  });
}

async function handleAdminRecoverySnapshotRestore(req, res, snapshotId) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  if (!USERNAME_PATTERN.test(username) || !/^\d+$/.test(snapshotId)) {
    return sendJson(req, res, 400, { ok: false, error: "Invalid restore request." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accountResult = await client.query("select * from accounts where username = $1 for update", [username]);
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "Account not found." });
    }
    const snapshotResult = await client.query(
      "select * from state_backups where id = $1 and username = $2",
      [snapshotId, username]
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "Snapshot not found for that account." });
    }
    const snapshotHash = stateHash(snapshot.state);
    const accountHash = account.state_hash || (account.state ? stateHash(account.state) : stateHash(null));
    const preview = verifyRecoveryPreview(body.previewToken, {
      purpose: "admin-full-restore",
      username,
      sourceKind: "snapshot",
      sourceId: snapshotId,
    });
    if (!preview || Number(preview.currentRevision) !== Number(account.state_revision || 0)
        || preview.currentHash !== accountHash || preview.sourceHash !== snapshotHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok: false, error: "PREVIEW_EXPIRED", message: "Preview this snapshot again before restoring it." });
    }
    let preRestoreBackupId = null;
    if (account.state) {
      const backup = await client.query(
        `insert into state_backups (username, revision, state, reason)
         values ($1, $2, $3::jsonb, 'pre_restore') returning id`,
        [username, Number(account.state_revision || 0), JSON.stringify(account.state)]
      );
      preRestoreBackupId = String(backup.rows[0].id);
    }
    const restoredState = snapshot.state || null;
    const stateBytes = Buffer.byteLength(JSON.stringify(restoredState));
    const restoredManifest = stateManifest(restoredState);
    const updated = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4, state_revision = state_revision + 1,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [username, JSON.stringify(restoredState), stateBytes, snapshotHash,
        JSON.stringify(restoredManifest), restoredManifest.version]
    );
    const resultingRevision = Number(updated.rows[0].state_revision);
    await insertStateVersion(client, {
      username,
      revision: resultingRevision,
      state: restoredState,
      sourceDevice: "admin-snapshot-restore",
    });
    await recordSaveEvent(client, {
      username,
      result: "restored",
      currentRevision: Number(account.state_revision || 0),
      resultingRevision,
      state: restoredState,
      deviceId: "admin-snapshot-restore",
      detail: `Restored state_backups/${snapshotId}`,
    });
    await client.query("commit");
    await pruneStateVersions(username).catch((error) => console.error("State history pruning failed", error));
    sendJson(req, res, 200, {
      ok: true,
      username,
      revision: resultingRevision,
      restoredAt: updated.rows[0].state_updated_at,
      preRestoreBackupId,
      summary: stateSummary(restoredState),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleAdminRecoveryVersionRestore(req, res, versionId) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  if (!USERNAME_PATTERN.test(username) || !/^\d+$/.test(versionId)) {
    return sendJson(req, res, 400, { ok: false, error: "Invalid version restore request." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accountResult = await client.query("select * from accounts where username = $1 for update", [username]);
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "Account not found." });
    }
    const versionResult = await client.query(
      `select id, revision, state_gzip from state_versions
       where id = $1 and username = $2`,
      [versionId, username]
    );
    const version = versionResult.rows[0];
    if (!version) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "Saved revision not found for that account." });
    }
    const restoredState = deserializeStateVersion(version.state_gzip);
    const prepared = serializeStateVersion(restoredState);
    if (prepared.stateBytes > MAX_STATE_BYTES) {
      await client.query("rollback");
      return sendJson(req, res, 413, stateTooLargePayload(prepared.stateBytes));
    }
    const accountHash = account.state_hash || (account.state ? stateHash(account.state) : stateHash(null));
    const preview = verifyRecoveryPreview(body.previewToken, {
      purpose: "admin-full-restore",
      username,
      sourceKind: "version",
      sourceId: versionId,
    });
    if (!preview || Number(preview.currentRevision) !== Number(account.state_revision || 0)
        || preview.currentHash !== accountHash || preview.sourceHash !== prepared.hash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok: false, error: "PREVIEW_EXPIRED", message: "Preview this revision again before restoring it." });
    }
    let preRestoreBackupId = null;
    if (account.state) {
      const backup = await client.query(
        `insert into state_backups (username, revision, state, reason)
         values ($1, $2, $3::jsonb, 'pre_restore') returning id`,
        [username, Number(account.state_revision || 0), JSON.stringify(account.state)]
      );
      preRestoreBackupId = String(backup.rows[0].id);
    }
    const updated = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4, state_revision = state_revision + 1,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [username, prepared.serialized, prepared.stateBytes, prepared.hash,
        JSON.stringify(stateManifest(restoredState)), 1]
    );
    const resultingRevision = Number(updated.rows[0].state_revision);
    await insertStateVersion(client, {
      username,
      revision: resultingRevision,
      state: restoredState,
      sourceDevice: "admin-version-restore",
      version: prepared,
    });
    await recordSaveEvent(client, {
      username,
      result: "restored",
      currentRevision: Number(account.state_revision || 0),
      resultingRevision,
      state: restoredState,
      deviceId: "admin-version-restore",
      detail: `Restored immutable revision ${Number(version.revision || 0)}`,
    });
    await client.query("commit");
    await pruneStateVersions(username).catch((error) => console.error("State history pruning failed", error));
    sendJson(req, res, 200, {
      ok: true,
      username,
      revision: resultingRevision,
      restoredAt: updated.rows[0].state_updated_at,
      restoredFromRevision: Number(version.revision || 0),
      preRestoreBackupId,
      summary: stateSummary(restoredState),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const ANYA_INCIDENT_USERNAME = "anya";
const ANYA_INCIDENT_BACKUP_REVISION = 4;
const ANYA_INCIDENT_CONFIRMATION = "RECOVER ANYA ADDITIVELY";
const ANYA_AUGUST_REVIEW_START = "2026-08-25T17:00:00.000Z";
const ANYA_AUGUST_REVIEW_END = "2026-08-28T17:00:00.000Z";

async function handleAnyaAugustRecoveryPreview(req, res) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const accountResult = await pool.query(
    `select state, state_revision, state_hash, state_updated_at
     from accounts where username = $1`,
    [ANYA_INCIDENT_USERNAME]
  );
  const account = accountResult.rows[0];
  if (!account) return sendJson(req, res, 404, { ok:false, error:"ANYA_ACCOUNT_NOT_FOUND" });
  const currentSummary = stateSummary(account.state);
  const metadata = await pool.query(
    `select id, revision, state_hash, state_bytes, compressed_bytes, source_device, summary, created_at
     from state_versions
     where username = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz
     order by revision desc`,
    [ANYA_INCIDENT_USERNAME, ANYA_AUGUST_REVIEW_START, ANYA_AUGUST_REVIEW_END]
  );
  const countFields = ["tasks", "notes", "files", "checklist", "grades", "trips", "weeklyWeeks", "weeklySemesters"];
  let selected = metadata.rows.filter((row) =>
    countFields.some((field) => Number(row.summary?.[field] || 0) > Number(currentSummary[field] || 0))
  ).slice(0, 12);
  if (!selected.length) {
    const days = new Set();
    selected = metadata.rows.filter((row) => {
      const day = new Date(row.created_at).toISOString().slice(0, 10);
      if (days.has(day)) return false;
      days.add(day);
      return true;
    }).slice(0, 3);
  }
  const selectedIds = selected.map((row) => String(row.id));
  const states = selectedIds.length
    ? await pool.query(
        `select id, state_gzip from state_versions
         where username = $1 and id = any($2::bigint[])`,
        [ANYA_INCIDENT_USERNAME, selectedIds]
      )
    : { rows:[] };
  const statesById = new Map(states.rows.map((row) => [String(row.id), deserializeStateVersion(row.state_gzip)]));
  const candidates = selected.map((row) => {
    const sourceState = statesById.get(String(row.id));
    const recovery = sourceState ? recoverMissingRecords(account.state, sourceState) : { additions:[], unchanged:true, summary:currentSummary };
    return {
      id:String(row.id),
      revision:Number(row.revision || 0),
      stateHash:row.state_hash,
      createdAt:row.created_at,
      sourceDevice:row.source_device,
      sourceSummary:row.summary || {},
      proposedSummary:recovery.summary,
      unchanged:recovery.unchanged,
      additions:recovery.additions.slice(0, 300),
      additionsTruncated:recovery.additions.length > 300,
    };
  });
  const events = await pool.query(
    `select result, base_revision, current_revision, resulting_revision, state_hash,
            state_bytes, device_id, base_hash, mutation_id, merge_source, detail, created_at
     from state_save_events
     where username = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz
     order by created_at asc limit 500`,
    [ANYA_INCIDENT_USERNAME, ANYA_AUGUST_REVIEW_START, ANYA_AUGUST_REVIEW_END]
  );
  sendJson(req, res, 200, {
    ok:true,
    readOnly:true,
    username:ANYA_INCIDENT_USERNAME,
    range:{ start:ANYA_AUGUST_REVIEW_START, end:ANYA_AUGUST_REVIEW_END, timezone:"Asia/Bangkok" },
    current:{ revision:Number(account.state_revision || 0), stateHash:account.state_hash, updatedAt:account.state_updated_at, summary:currentSummary },
    versionsInspected:candidates.length,
    availableVersionCount:metadata.rowCount,
    candidates,
    saveEvents:events.rows,
    warning:"Preview only. Any future recovery must be additive by stable item ID and requires explicit approval.",
  });
}

async function loadAnyaIncidentSource(client) {
  const result = await client.query(
    `select id, revision, state, created_at
     from state_backups
     where username = $1 and revision = $2
     order by created_at desc limit 1`,
    [ANYA_INCIDENT_USERNAME, ANYA_INCIDENT_BACKUP_REVISION]
  );
  return result.rows[0] || null;
}

async function handleAnyaIncidentRecovery(req, res) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return send(req, res, 405, "Method not allowed");

  if (req.method === "GET") {
    const accountResult = await pool.query(
      "select state, state_revision, state_updated_at from accounts where username = $1",
      [ANYA_INCIDENT_USERNAME]
    );
    const account = accountResult.rows[0];
    const source = await loadAnyaIncidentSource(pool);
    if (!account || !source) {
      return sendJson(req, res, 404, { ok: false, error: "The verified Anya incident source is unavailable." });
    }
    const proposed = additiveIncidentRecovery(account.state, source.state);
    return sendJson(req, res, 200, {
      ok: true,
      username: ANYA_INCIDENT_USERNAME,
      sourceSnapshotId: String(source.id),
      sourceRevision: Number(source.revision),
      sourceCreatedAt: source.created_at,
      currentRevision: Number(account.state_revision || 0),
      currentUpdatedAt: account.state_updated_at,
      currentSummary: stateSummary(account.state),
      sourceSummary: stateSummary(source.state),
      proposedSummary: proposed.summary,
      unchanged: !proposed.addedTasks.length && !proposed.addedWeeks.length,
      addTasks: proposed.addedTasks.map((task) => ({ id: task.id || null, title: task.title || task.name || "Untitled task" })),
      addWeeks: proposed.addedWeeks.map((week) => ({ id: week.id || null, label: week.label || week.name || week.date || "Weekly week" })),
      confirmation: ANYA_INCIDENT_CONFIRMATION,
    });
  }

  const body = await readJsonBody(req);
  if (String(body.confirmation || "") !== ANYA_INCIDENT_CONFIRMATION) {
    return sendJson(req, res, 400, { ok: false, error: "Exact incident recovery confirmation is required." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accountResult = await client.query(
      "select * from accounts where username = $1 for update",
      [ANYA_INCIDENT_USERNAME]
    );
    const account = accountResult.rows[0];
    const source = await loadAnyaIncidentSource(client);
    if (!account || !source) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok: false, error: "The verified Anya incident source is unavailable." });
    }

    const proposed = additiveIncidentRecovery(account.state, source.state);
    if (proposed.addedTasks.length > 2 || proposed.addedWeeks.length > 2) {
      await client.query("rollback");
      return sendJson(req, res, 409, {
        ok: false,
        error: "INCIDENT_SOURCE_MISMATCH",
        message: "The live data no longer matches the verified recovery scope. Nothing was changed.",
      });
    }
    if (!proposed.addedTasks.length && !proposed.addedWeeks.length) {
      await client.query("rollback");
      return sendJson(req, res, 200, {
        ok: true,
        unchanged: true,
        username: ANYA_INCIDENT_USERNAME,
        revision: Number(account.state_revision || 0),
        summary: stateSummary(account.state),
      });
    }
    if (proposed.summary.tasks < 28 || proposed.summary.weeklyWeeks < 5 || proposed.summary.weeklySemesters < 6) {
      await client.query("rollback");
      return sendJson(req, res, 409, {
        ok: false,
        error: "INCIDENT_RECOVERY_VALIDATION_FAILED",
        message: "The proposed additive result failed the verified count checks. Nothing was changed.",
        summary: proposed.summary,
      });
    }

    const prepared = serializeStateVersion(proposed.state);
    if (prepared.stateBytes > MAX_STATE_BYTES) {
      await client.query("rollback");
      return sendJson(req, res, 413, stateTooLargePayload(prepared.stateBytes));
    }
    const preRecovery = await client.query(
      `insert into state_backups (username, revision, state, reason)
       values ($1, $2, $3::jsonb, 'pre_incident_recovery') returning id`,
      [ANYA_INCIDENT_USERNAME, Number(account.state_revision || 0), JSON.stringify(account.state)]
    );
    const updated = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4, state_revision = state_revision + 1,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [ANYA_INCIDENT_USERNAME, prepared.serialized, prepared.stateBytes, prepared.hash,
        JSON.stringify(stateManifest(proposed.state)), 1]
    );
    const resultingRevision = Number(updated.rows[0].state_revision);
    await insertStateVersion(client, {
      username: ANYA_INCIDENT_USERNAME,
      revision: resultingRevision,
      state: proposed.state,
      sourceDevice: "admin-incident-recovery",
      version: prepared,
    });
    await recordSaveEvent(client, {
      username: ANYA_INCIDENT_USERNAME,
      result: "recovered",
      currentRevision: Number(account.state_revision || 0),
      resultingRevision,
      state: proposed.state,
      deviceId: "admin-incident-recovery",
      detail: `Added ${proposed.addedTasks.length} tasks and ${proposed.addedWeeks.length} Weekly weeks from revision ${ANYA_INCIDENT_BACKUP_REVISION}`,
    });
    await client.query("commit");
    await pruneStateVersions(ANYA_INCIDENT_USERNAME).catch((error) => console.error("State history pruning failed", error));
    return sendJson(req, res, 200, {
      ok: true,
      username: ANYA_INCIDENT_USERNAME,
      revision: resultingRevision,
      recoveredAt: updated.rows[0].state_updated_at,
      preIncidentRecoverySnapshotId: String(preRecovery.rows[0].id),
      addedTasks: proposed.addedTasks.map((task) => ({ id: task.id || null, title: task.title || task.name || "Untitled task" })),
      addedWeeks: proposed.addedWeeks.map((week) => ({ id: week.id || null, label: week.label || week.name || week.date || "Weekly week" })),
      summary: proposed.summary,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleMe(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user) {
    sendJson(req, res, 401, { ok: false, user: null });
    return;
  }
  sendJson(req, res, 200, { ok: true, user: publicUser(user) });
}

async function handleLogout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await pool.query("delete from sessions where token_hash = $1", [tokenHash(token)]);
  clearSessionCookie(req, res);
  sendJson(req, res, 200, { ok: true });
}

async function handleState(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(req, res, 401, { ok: false, error: "AUTH_REQUIRED" });
    return;
  }
  if (user.sync_device_id) {
    sendJson(req, res, 403, { ok: false, error: "VERSIONED_STATE_REQUIRED" });
    return;
  }

  if (req.method === "GET") {
    sendJson(req, res, 200, user.state || null);
    return;
  }

  if (req.method === "POST") {
    req.resume();
    await recordSaveEvent(pool, {
      username: user.username,
      result: "rejected",
      currentRevision: Number(user.state_revision || 0),
      deviceId: "legacy-api",
      detail: "VERSIONED_STATE_REQUIRED",
    }).catch((error) => console.error("Save audit failed", error));
    sendJson(req, res, 426, {
      ok: false,
      error: "VERSIONED_STATE_REQUIRED",
      endpoint: "/api/v2/state",
      message: "Whole-state writes are disabled. Reload StudyQuest before saving.",
      serverTime: new Date().toISOString(),
    });
    return;
  }

  send(req, res, 405, "Method not allowed");
}

function safeContactUrl(value) {
  const url = String(value || "").trim();
  return /^(?:https?:|mailto:)/i.test(url) ? url.slice(0, 500) : "";
}

async function createDailyStateBackup(client, row) {
  if (!row?.state) return;
  const existing = await client.query(
    `select 1 from state_backups
     where username = $1 and reason = 'daily'
       and (created_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date
     limit 1`,
    [row.username]
  );
  if (!existing.rowCount) {
    const serialized = JSON.stringify(row.state);
    const duplicate = await client.query(
      `select 1 from state_backups
       where username = $1 and state = $2::jsonb
       order by created_at desc limit 1`,
      [row.username, serialized]
    );
    if (!duplicate.rowCount) {
      await client.query(
        `insert into state_backups (username, revision, state, reason)
         values ($1, $2, $3::jsonb, 'daily')`,
        [row.username, Number(row.state_revision || 0), serialized]
      );
    }
  }
  await client.query(
    "delete from state_backups where username = $1 and created_at < now() - interval '30 days'",
    [row.username]
  );
}

async function createMergeStateBackup(client, row) {
  if (!row?.state) return false;
  const serialized = JSON.stringify(row.state);
  const duplicate = await client.query(
    `select 1 from state_backups
     where username = $1 and state = $2::jsonb
     order by created_at desc limit 1`,
    [row.username, serialized]
  );
  if (duplicate.rowCount) return false;
  await client.query(
    `insert into state_backups (username, revision, state, reason)
     values ($1, $2, $3::jsonb, 'pre_merge')`,
    [row.username, Number(row.state_revision || 0), serialized]
  );
  return true;
}

function publicRecordDifference(record) {
  return {
    collection: record.collection,
    id: record.id,
    key: record.key,
    label: record.label,
  };
}

function compareRecoveryStates(currentState, earlierState) {
  const structural = stateRecordDiff(currentState, earlierState);
  const recovered = recoverMissingRecords(currentState, earlierState);
  const currentRecords = collectStateRecords(currentState);
  const earlierRecords = collectStateRecords(earlierState);
  const changed = [];
  currentRecords.forEach((record, key) => {
    const earlier = earlierRecords.get(key);
    if (!earlier || stableStringify(record.value) === stableStringify(earlier.value)) return;
    changed.push(publicRecordDifference(record));
  });
  return {
    recoverableMissing: recovered.additions.map((record) => ({ ...record })),
    currentOnly: structural.removed.map(publicRecordDifference),
    changed,
    counts: {
      recoverableMissing: recovered.additions.length,
      currentOnly: structural.removed.length,
      changed: changed.length,
    },
  };
}

async function stateIntegritySummary(username, currentState, currentRevision) {
  const currentSummary = stateSummary(currentState);
  const candidates = await pool.query(
    `select revision, state_hash, summary, source_device, created_at
     from state_versions
     where username = $1 and revision < $2
     order by revision desc limit 40`,
    [username, currentRevision]
  );
  const countFields = ["tasks", "notes", "files", "checklist", "grades", "trips", "weeklyWeeks", "weeklySemesters"];
  const candidate = candidates.rows.find((row) => countFields.some((field) => Number(row.summary?.[field] || 0) > Number(currentSummary[field] || 0)));
  if (!candidate) return { status: "ok", latestSafeRevision: currentRevision, latestSafeSummary: currentSummary };
  return {
    status: "review_recommended",
    reason: "An earlier saved version contains records that are absent from the current copy.",
    latestSafeRevision: Number(candidate.revision || 0),
    latestSafeHash: candidate.state_hash,
    latestSafeSummary: candidate.summary || {},
    latestSafeDevice: candidate.source_device,
    latestSafeAt: candidate.created_at,
  };
}

function metadataCredential(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice(7).trim();
    return token ? { kind:"device", hash:tokenHash(token) } : null;
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? { kind:"session", hash:tokenHash(token) } : null;
}

async function queryAuthenticatedStateMetadata(req) {
  const credential = metadataCredential(req);
  if (!credential) return null;
  const existing = metadataLoads.get(`${credential.kind}:${credential.hash}`);
  if (existing) return existing;
  const load = (async () => {
    const authJoin = credential.kind === "device"
      ? `from sync_devices auth join accounts a on a.username = auth.username`
      : `from sessions auth join accounts a on a.username = auth.username`;
    const authWhere = credential.kind === "device"
      ? `auth.token_hash = $1 and auth.revoked_at is null and auth.username = $2`
      : `auth.token_hash = $1 and auth.expires_at > now()`;
    const parameters = credential.kind === "device"
      ? [credential.hash, ADMIN_USERNAME]
      : [credential.hash];
    const result = await pool.query(
      `select a.username, a.state_revision, a.state_hash, a.state_bytes, a.state_updated_at,
              a.updated_at, a.state_manifest_version,
              latest.revision as immutable_revision, latest.state_hash as immutable_hash
       ${authJoin}
       left join lateral (
         select revision, state_hash from state_versions
         where username = a.username order by revision desc, id desc limit 1
       ) latest on true
       where ${authWhere}`,
      parameters
    );
    return result.rows[0] || null;
  })();
  metadataLoads.set(`${credential.kind}:${credential.hash}`, load);
  try {
    return await load;
  } finally {
    metadataLoads.delete(`${credential.kind}:${credential.hash}`);
  }
}

function stateConflictPayload(row, error = "STATE_CONFLICT", extra = {}) {
  const currentState = row?.state || null;
  return {
    ok: false,
    error,
    state: currentState,
    revision: Number(row?.state_revision || 0),
    stateHash: row?.state_hash || (currentState ? stateHash(currentState) : stateHash(null)),
    updatedAt: row?.state_updated_at || row?.updated_at || null,
    stateBytes: Buffer.byteLength(JSON.stringify(currentState)),
    maxStateBytes: MAX_STATE_BYTES,
    activity: stateActivitySummary(currentState),
    serverTime: new Date().toISOString(),
    ...extra,
  };
}

async function preserveAndSendStateConflict(req, res, client, details) {
  const current = await client.query(
    `select username, state, state_bytes, state_hash, state_revision, state_updated_at, updated_at
     from accounts where username = $1`,
    [details.username]
  );
  const row = current.rows[0];
  const cloudHash = row?.state_hash || (row?.state ? stateHash(row.state) : stateHash(null));
  const copy = await preserveConflictCopy(client, {
    ...details,
    cloudRevision:Number(row?.state_revision || 0),
    cloudHash,
  });
  await recordSaveEvent(client, {
    username:details.username,
    result: "conflicted",
    baseRevision:details.baseRevision,
    currentRevision:Number(row?.state_revision || 0),
    stateHash:details.candidate.hash,
    stateBytes:details.candidate.stateBytes,
    deviceId:details.deviceId,
    baseHash:details.baseHash,
    mutationId:details.mutationId,
    changeManifest:details.changeSet,
    detail:copy.storageFull ? "CONFLICT_STORAGE_FULL" : details.reason,
    conflictCopyId:copy.id,
  });
  await client.query("commit");
  const error = copy.storageFull ? "CONFLICT_STORAGE_FULL" : details.reason;
  sendJson(req, res, copy.storageFull ? 507 : 409, stateConflictPayload(row, error, {
    message:copy.storageFull
      ? "Cloud conflict storage is full. Your device copy remains pending; export it or ask an administrator to review storage."
      : "Two changes overlap. Both copies are safe.",
    conflictCopyId:copy.id,
    candidateHash:details.candidate.hash,
    copiesPreserved:!copy.storageFull,
    deviceCopyPreserved:true,
    deduplicated:copy.deduplicated,
    conflictBudgetBytes:CONFLICT_COPY_BUDGET_BYTES,
    ...(details.extra || {}),
  }));
}

async function handleVersionedStateMeta(req, res) {
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const user = await queryAuthenticatedStateMetadata(req);
  if (!user) return sendJson(req, res, 401, { ok:false, error:"AUTH_REQUIRED" });
  const revision = Number(user.state_revision || 0);
  const currentHash = user.state_hash || stateHash(null);
  const immutableRevision = user.immutable_revision === null ? null : Number(user.immutable_revision);
  const integrityMatches = immutableRevision === revision && user.immutable_hash === currentHash;
  const emptyAccountMatches = revision === 0 && !user.state_hash && immutableRevision === null;
  const integrity = integrityMatches || emptyAccountMatches
    ? { status:"ok", immutableRevision, immutableHash:user.immutable_hash }
    : {
        status:"mismatch",
        immutableRevision,
        immutableHash:user.immutable_hash || null,
        accountRevision:revision,
        accountHash:currentHash,
      };
  const etag = `"sq-${revision}-${currentHash}"`;
  if (String(req.headers["if-none-match"] || "").split(",").map((value) => value.trim()).includes(etag)) {
    send(req, res, 304, "", { etag });
    return;
  }
  sendJson(req, res, 200, {
    ok:true,
    revision,
    stateHash:currentHash,
    updatedAt:user.state_updated_at || user.updated_at || null,
    stateBytes:Number(user.state_bytes || 0),
    maxStateBytes:MAX_STATE_BYTES,
    manifestVersion:Number(user.state_manifest_version || 0),
    integrity,
    serverTime:new Date().toISOString(),
  }, { etag });
}

async function handleVersionedState(req, res) {
  const user = await currentUser(req, { includeState:req.method === "GET" });
  if (!user) {
    sendJson(req, res, 401, { ok: false, error: "AUTH_REQUIRED" });
    return;
  }

  if (req.method === "GET") {
    const revision = Number(user.state_revision || 0);
    const currentHash = user.state_hash || (user.state ? stateHash(user.state) : stateHash(null));
    const integrity = await stateIntegritySummary(user.username, user.state, revision);
    sendJson(req, res, 200, {
      ok: true,
      state: user.state || null,
      revision,
      stateHash: currentHash,
      integrity,
      updatedAt: user.state_updated_at || user.updated_at || null,
      stateBytes: Number(user.state_bytes || 0),
      maxStateBytes: MAX_STATE_BYTES,
      activity: stateActivitySummary(user.state),
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (req.method !== "POST") {
    send(req, res, 405, "Method not allowed");
    return;
  }

  const body = await readJsonBody(req, MAX_STATE_BYTES + MAX_STATE_ENVELOPE_BYTES);
  const incomingState = body?.state;
  const baseRevision = body?.baseRevision;
  const baseHash = typeof body?.baseHash === "string" ? body.baseHash.trim().toLowerCase() : "";
  const mutationId = typeof body?.mutationId === "string" ? body.mutationId.trim().slice(0, 120) : "";
  const changeSet = body?.changeSet && typeof body.changeSet === "object" ? body.changeSet : null;
  const deviceId = safeDeviceLabel(user.sync_device_name || body?.deviceId, user.sync_device_id ? "paired-device" : "browser");
  if (!incomingState || typeof incomingState !== "object" || !Array.isArray(incomingState.tasks)) {
    await recordSaveEvent(pool, {
      username: user.username,
      result: "rejected",
      baseRevision,
      currentRevision: Number(user.state_revision || 0),
      deviceId,
      detail: "INVALID_STATE",
    }).catch((error) => console.error("Save audit failed", error));
    sendJson(req, res, 400, { ok: false, error: "INVALID_STATE" });
    return;
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    await recordSaveEvent(pool, {
      username: user.username,
      result: "rejected",
      currentRevision: Number(user.state_revision || 0),
      state: incomingState,
      deviceId,
      baseHash,
      mutationId,
      changeManifest: changeSet,
      detail: "BASE_REVISION_REQUIRED",
    }).catch((error) => console.error("Save audit failed", error));
    sendJson(req, res, 400, { ok: false, error: "BASE_REVISION_REQUIRED" });
    return;
  }
  if (baseHash && !/^[a-f0-9]{64}$/.test(baseHash)) {
    sendJson(req, res, 400, { ok: false, error: "INVALID_BASE_HASH" });
    return;
  }
  if (mutationId && !/^[a-zA-Z0-9._:-]{8,120}$/.test(mutationId)) {
    sendJson(req, res, 400, { ok: false, error: "INVALID_MUTATION_ID" });
    return;
  }
  const incomingVersion = serializeStateVersion(incomingState);
  const incomingManifest = stateManifest(incomingState);
  const stateBytes = incomingVersion.stateBytes;
  if (stateBytes > MAX_STATE_BYTES) {
    await recordSaveEvent(pool, {
      username: user.username,
      result: "oversized",
      baseRevision,
      currentRevision: Number(user.state_revision || 0),
      stateHash: incomingVersion.hash,
      stateBytes,
      deviceId,
      detail: "STATE_TOO_LARGE",
    }).catch((error) => console.error("Save audit failed", error));
    sendJson(req, res, 413, stateTooLargePayload(stateBytes));
    return;
  }

  const client = await pool.connect();
  let currentRevisionForAudit = Number(user.state_revision || 0);
  try {
    await client.query("begin");
    const current = await client.query(
      `select username, state_bytes, state_hash, state_revision, state_updated_at, updated_at,
              state_manifest, state_manifest_version
       from accounts where username = $1 for update`,
      [user.username]
    );
    const row = current.rows[0];
    const currentRevision = Number(row?.state_revision || 0);
    currentRevisionForAudit = currentRevision;
    if (!row) {
      await client.query("rollback");
      sendJson(req, res, 404, { ok: false, error: "ACCOUNT_NOT_FOUND" });
      return;
    }
    if (mutationId) {
      const duplicate = await client.query(
        `select resulting_revision, state_hash from state_save_events
         where username = $1 and mutation_id = $2 and resulting_revision is not null
         order by id desc limit 1`,
        [user.username, mutationId]
      );
      if (duplicate.rowCount) {
        const duplicateRevision = Number(duplicate.rows[0].resulting_revision || 0);
        if (duplicateRevision !== currentRevision) {
          await client.query("commit");
          sendJson(req, res, 200, {
            ok:true,
            idempotent:true,
            acknowledgedMutationId:mutationId,
            revision:duplicateRevision,
            stateHash:duplicate.rows[0].state_hash,
            acceptedRevision:duplicateRevision,
            currentRevision,
            currentStateHash:row.state_hash || stateHash(null),
            stateBytes,
            maxStateBytes:MAX_STATE_BYTES,
            serverTime:new Date().toISOString(),
            requiresRefresh:true,
          });
          return;
        }
        await client.query("commit");
        sendJson(req, res, 200, {
          ok: true,
          idempotent: true,
          acknowledgedMutationId: mutationId || null,
          revision: currentRevision,
          stateHash: row.state_hash || stateHash(null),
          savedAt: row.state_updated_at || row.updated_at || null,
          stateBytes: Number(row.state_bytes || 0),
          maxStateBytes: MAX_STATE_BYTES,
          serverTime: new Date().toISOString(),
          requiresRefresh: false,
        });
        return;
      }
    }
    const currentHash = row.state_hash || stateHash(null);
    if (currentHash === incomingVersion.hash) {
      await recordSaveEvent(client, {
        username:user.username,
        result:"no_change",
        baseRevision,
        currentRevision,
        resultingRevision:currentRevision,
        stateHash:currentHash,
        stateBytes:Number(row.state_bytes || stateBytes),
        deviceId,
        baseHash,
        mutationId,
        changeManifest:changeSet,
        detail:"Candidate hash already current",
      });
      await client.query("commit");
      sendJson(req, res, 200, {
        ok:true,
        unchanged:true,
        acknowledgedMutationId:mutationId || null,
        revision:currentRevision,
        stateHash:currentHash,
        savedAt:row.state_updated_at || row.updated_at || null,
        stateBytes:Number(row.state_bytes || stateBytes),
        maxStateBytes:MAX_STATE_BYTES,
        serverTime:new Date().toISOString(),
      });
      return;
    }
    if (baseRevision !== currentRevision) {
      await preserveAndSendStateConflict(req, res, client, {
        username:user.username,
        candidate:incomingVersion,
        baseRevision,
        deviceId,
        baseHash,
        mutationId,
        changeSet,
        reason:"STATE_CONFLICT",
      });
      return;
    }

    if (baseHash && baseHash !== currentHash) {
      await preserveAndSendStateConflict(req, res, client, {
        username:user.username,
        candidate:incomingVersion,
        baseRevision,
        deviceId,
        baseHash,
        mutationId,
        changeSet,
        reason:"BASE_HASH_MISMATCH",
      });
      return;
    }

    let currentManifest = row.state_manifest;
    if (!currentManifest || Number(row.state_manifest_version || 0) !== 1) {
      const recoveryState = await client.query("select state from accounts where username = $1", [user.username]);
      currentManifest = stateManifest(recoveryState.rows[0]?.state || null);
      await client.query(
        `update accounts set state_manifest = $2::jsonb, state_manifest_version = $3 where username = $1`,
        [user.username, JSON.stringify(currentManifest), currentManifest.version]
      );
    }
    const rootTimestampOnlyMatch = Boolean(
      currentManifest?.contentHash
      && incomingManifest?.contentHash
      && currentManifest.contentHash === incomingManifest.contentHash
    );
    if (rootTimestampOnlyMatch) {
      await recordSaveEvent(client, {
        username:user.username,
        result:"no_change",
        baseRevision,
        currentRevision,
        resultingRevision:currentRevision,
        stateHash:currentHash,
        stateBytes:Number(row.state_bytes || stateBytes),
        deviceId,
        baseHash,
        mutationId,
        changeManifest:changeSet,
        detail:"Ignored root updatedAt-only save",
      });
      await client.query("commit");
      sendJson(req, res, 200, {
        ok:true,
        unchanged:true,
        ignoredVolatileOnly:true,
        acknowledgedMutationId:mutationId || null,
        revision:currentRevision,
        stateHash:currentHash,
        savedAt:row.state_updated_at || row.updated_at || null,
        stateBytes:Number(row.state_bytes || stateBytes),
        maxStateBytes:MAX_STATE_BYTES,
        serverTime:new Date().toISOString(),
      });
      return;
    }
    const destructive = unapprovedManifestRemovals(currentManifest, incomingManifest, changeSet);
    if (destructive.unapproved.length) {
      const removals = destructive.unapproved.slice(0, 100).map(publicRecordDifference);
      await preserveAndSendStateConflict(req, res, client, {
        username:user.username,
        candidate:incomingVersion,
        baseRevision,
        deviceId,
        baseHash,
        mutationId,
        changeSet,
        reason:"DESTRUCTIVE_CHANGE_REVIEW_REQUIRED",
        extra:{ removalCount:destructive.unapproved.length, removals },
      });
      return;
    }

    const approvedRecoverySources = new Set([
      "v13-smart-merge", "v14-smart-merge", "v15-smart-merge",
      "v15-auto-nonoverlap", "v16-auto-nonoverlap",
    ]);
    const mergeApproved = approvedRecoverySources.has(body?.merge?.source) && body?.merge?.approvedAt;
    const mergeConflictCopyId = mergeApproved && /^[a-f0-9-]{36}$/i.test(String(body?.merge?.conflictCopyId || ""))
      ? String(body.merge.conflictCopyId)
      : null;
    let preMergeBackupCreated = false;
    if (mergeApproved) {
      const currentStateResult = await client.query(
        `select username, state, state_revision from accounts where username = $1`,
        [user.username]
      );
      preMergeBackupCreated = await createMergeStateBackup(client, currentStateResult.rows[0]);
    }
    const saved = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4, state_revision = state_revision + 1,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [user.username, JSON.stringify(incomingState), stateBytes, incomingVersion.hash,
        JSON.stringify(incomingManifest), incomingManifest.version]
    );
    const resultingRevision = Number(saved.rows[0].state_revision);
    await insertStateVersion(client, {
      username: user.username,
      revision: resultingRevision,
      state: incomingState,
      sourceDevice: deviceId,
      version: incomingVersion,
    });
    await recordSaveEvent(client, {
      username: user.username,
      result: "accepted",
      baseRevision,
      currentRevision,
      resultingRevision,
      stateHash: incomingVersion.hash,
      stateBytes,
      state: incomingState,
      deviceId,
      baseHash,
      mutationId,
      changeManifest: changeSet,
      mergeSource: mergeApproved ? body.merge.source : null,
      detail: mergeApproved ? `Approved ${body.merge.source}` : "Revision-protected save",
      conflictCopyId:mergeConflictCopyId,
    });
    if (mergeConflictCopyId && /^[a-f0-9]{64}$/.test(String(body?.merge?.conflictCandidateHash || ""))) {
      await client.query(
        `update state_conflict_copies
         set resolved_at = now(), resolved_revision = $3, resolution_mutation_id = $4,
             retention_expires_at = now() + interval '30 days'
         where id = $1 and username = $2 and candidate_hash = $5 and resolved_at is null`,
        [mergeConflictCopyId, user.username, resultingRevision, mutationId || null, body.merge.conflictCandidateHash]
      );
    }
    await client.query("commit");
    await pruneStateVersions(user.username).catch((error) => console.error("State history pruning failed", error));
    sendJson(req, res, 200, {
      ok: true,
      acknowledgedMutationId: mutationId || null,
      revision: resultingRevision,
      stateHash: incomingVersion.hash,
      savedAt: saved.rows[0].state_updated_at,
      stateBytes,
      maxStateBytes: MAX_STATE_BYTES,
      activity: stateActivitySummary(incomingState),
      serverTime: new Date().toISOString(),
      preMergeBackupCreated,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    await recordSaveEvent(pool, {
      username: user.username,
      result: "rejected",
      baseRevision,
      currentRevision: currentRevisionForAudit,
      stateHash: incomingVersion.hash,
      stateBytes,
      deviceId,
      baseHash,
      mutationId,
      changeManifest: changeSet,
      detail: String(error?.code || error?.message || "SERVER_ERROR").slice(0, 120),
    }).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function publicConflictCopy(row) {
  return {
    id:String(row.id),
    mutationId:row.mutation_id,
    deviceId:row.device_id,
    reason:row.reason,
    baseRevision:row.base_revision === null ? null : Number(row.base_revision),
    baseHash:row.base_hash,
    cloudRevision:Number(row.cloud_revision || 0),
    cloudHash:row.cloud_hash,
    candidateHash:row.candidate_hash,
    candidateBytes:Number(row.candidate_bytes || 0),
    compressedBytes:Number(row.compressed_bytes || 0),
    createdAt:row.created_at,
    resolvedAt:row.resolved_at,
    resolvedRevision:row.resolved_revision === null ? null : Number(row.resolved_revision),
    retentionExpiresAt:row.retention_expires_at,
  };
}

async function handleStateConflicts(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user) return sendJson(req, res, 401, { ok:false, error:"AUTH_REQUIRED" });
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const result = await pool.query(
    `select id, mutation_id, device_id, reason, base_revision, base_hash,
            cloud_revision, cloud_hash, candidate_hash, candidate_bytes, compressed_bytes,
            created_at, resolved_at, resolved_revision, retention_expires_at
     from state_conflict_copies
     where username = $1 and resolved_at is null and retention_expires_at >= now()
     order by created_at desc limit 100`,
    [user.username]
  );
  sendJson(req, res, 200, { ok:true, conflicts:result.rows.map(publicConflictCopy), serverTime:new Date().toISOString() });
}

async function handleStateConflictDetail(req, res, conflictId) {
  const user = await currentUser(req, { includeState:false });
  if (!user) return sendJson(req, res, 401, { ok:false, error:"AUTH_REQUIRED" });
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  if (!/^[a-f0-9-]{36}$/i.test(conflictId)) return sendJson(req, res, 400, { ok:false, error:"INVALID_CONFLICT_ID" });
  const result = await pool.query(
    `select c.*, a.state as cloud_state, a.state_revision as current_revision,
            a.state_hash as current_hash, a.state_updated_at as current_updated_at
     from state_conflict_copies c
     join accounts a on a.username = c.username
     where c.id = $1 and c.username = $2 and c.retention_expires_at >= now()`,
    [conflictId, user.username]
  );
  const row = result.rows[0];
  if (!row) return sendJson(req, res, 404, { ok:false, error:"CONFLICT_COPY_NOT_FOUND" });
  let candidateState;
  try {
    candidateState = deserializeStateVersion(row.candidate_gzip);
  } catch (error) {
    serverLog("error", "conflict_copy_corrupt", { conflictCopyId:String(row.id), code:error?.code || null });
    return sendJson(req, res, 500, { ok:false, error:"CONFLICT_COPY_CORRUPT", conflictCopyId:String(row.id) });
  }
  const candidateHash = stateHash(candidateState);
  const cloudHash = row.current_hash || stateHash(row.cloud_state);
  if (candidateHash !== row.candidate_hash || cloudHash !== stateHash(row.cloud_state)) {
    serverLog("error", "conflict_copy_integrity_mismatch", { conflictCopyId:String(row.id) });
    return sendJson(req, res, 500, { ok:false, error:"CONFLICT_INTEGRITY_MISMATCH", conflictCopyId:String(row.id) });
  }
  const comparison = stateRecordDiff(row.cloud_state, candidateState);
  sendJson(req, res, 200, {
    ok:true,
    conflict:publicConflictCopy(row),
    candidateState,
    cloudState:row.cloud_state,
    current:{
      revision:Number(row.current_revision || 0),
      stateHash:cloudHash,
      updatedAt:row.current_updated_at,
    },
    comparison:{
      removed:comparison.removed.slice(0, 300).map(publicRecordDifference),
      added:comparison.added.slice(0, 300).map(publicRecordDifference),
      byCollection:comparison.byCollection,
      truncated:comparison.removed.length > 300 || comparison.added.length > 300,
    },
    previewToken:signRecoveryPreview({
      purpose:"resolve-conflict",
      username:user.username,
      conflictId:String(row.id),
      currentRevision:Number(row.current_revision || 0),
      currentHash:cloudHash,
      candidateHash,
      expiresAt:Date.now() + RECOVERY_PREVIEW_MAX_AGE_MS,
    }),
    serverTime:new Date().toISOString(),
  });
}

async function handleStateConflictResolve(req, res, conflictId) {
  const user = await currentUser(req, { includeState:false });
  if (!user) return sendJson(req, res, 401, { ok:false, error:"AUTH_REQUIRED" });
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  if (!/^[a-f0-9-]{36}$/i.test(conflictId)) return sendJson(req, res, 400, { ok:false, error:"INVALID_CONFLICT_ID" });
  const body = await readJsonBody(req, MAX_STATE_BYTES + MAX_STATE_ENVELOPE_BYTES);
  const mergedState = body?.state;
  const expectedRevision = body?.expectedRevision;
  const expectedHash = typeof body?.expectedHash === "string" ? body.expectedHash.trim().toLowerCase() : "";
  const mutationId = typeof body?.mutationId === "string" ? body.mutationId.trim().slice(0, 120) : "";
  const preview = verifyRecoveryPreview(body?.previewToken, {
    purpose:"resolve-conflict",
    username:user.username,
    conflictId,
  });
  if (!mergedState || typeof mergedState !== "object" || !Array.isArray(mergedState.tasks)) {
    return sendJson(req, res, 400, { ok:false, error:"INVALID_STATE" });
  }
  if (!Number.isInteger(expectedRevision) || !/^[a-f0-9]{64}$/.test(expectedHash)
      || !/^[a-zA-Z0-9._:-]{8,120}$/.test(mutationId)) {
    return sendJson(req, res, 400, { ok:false, error:"INVALID_RESOLUTION_ENVELOPE" });
  }
  const prepared = serializeStateVersion(mergedState);
  if (prepared.stateBytes > MAX_STATE_BYTES) return sendJson(req, res, 413, stateTooLargePayload(prepared.stateBytes));
  const manifest = stateManifest(mergedState);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const conflictResult = await client.query(
      `select * from state_conflict_copies where id = $1 and username = $2 for update`,
      [conflictId, user.username]
    );
    const conflict = conflictResult.rows[0];
    if (!conflict) {
      await client.query("rollback");
      return sendJson(req, res, 404, { ok:false, error:"CONFLICT_COPY_NOT_FOUND" });
    }
    const accountResult = await client.query(
      `select username, state, state_revision, state_hash, state_bytes, state_updated_at, updated_at
       from accounts where username = $1 for update`,
      [user.username]
    );
    const account = accountResult.rows[0];
    const cloudHash = account?.state_hash || stateHash(account?.state);
    if (conflict.resolved_at) {
      if (conflict.resolution_mutation_id !== mutationId) {
        await client.query("rollback");
        return sendJson(req, res, 409, {
          ok:false,
          error:"CONFLICT_ALREADY_RESOLVED",
          conflictCopyId:conflictId,
          resolvedRevision:Number(conflict.resolved_revision || 0),
        });
      }
      await client.query("commit");
      return sendJson(req, res, 200, {
        ok:true,
        idempotent:true,
        acknowledgedMutationId:mutationId,
        revision:Number(conflict.resolved_revision || account?.state_revision || 0),
        stateHash:cloudHash,
        conflictCopyId:conflictId,
      });
    }
    if (!preview || Number(preview.currentRevision) !== expectedRevision || preview.currentHash !== expectedHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok:false, error:"PREVIEW_EXPIRED", message:"Cloud changed or this review expired. Rebuild the preview before applying." });
    }
    if (!account || Number(account.state_revision || 0) !== expectedRevision || cloudHash !== expectedHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, {
        ok:false,
        error:"PREVIEW_STALE",
        message:"Saved online changed during review. Both copies remain safe; review the rebuilt comparison.",
        currentRevision:Number(account?.state_revision || 0),
        currentHash:cloudHash,
        conflictCopyId:conflictId,
        copiesPreserved:true,
      });
    }
    let candidateState;
    try { candidateState = deserializeStateVersion(conflict.candidate_gzip); }
    catch {
      await client.query("rollback");
      return sendJson(req, res, 500, { ok:false, error:"CONFLICT_COPY_CORRUPT", conflictCopyId:conflictId });
    }
    if (stateHash(candidateState) !== conflict.candidate_hash || conflict.candidate_hash !== preview.candidateHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok:false, error:"CONFLICT_INTEGRITY_MISMATCH", conflictCopyId:conflictId });
    }
    const destructive = unapprovedRemovals(account.state, mergedState, body?.changeSet);
    if (destructive.unapproved.length) {
      await client.query("rollback");
      return sendJson(req, res, 409, {
        ok:false,
        error:"DESTRUCTIVE_CHANGE_REVIEW_REQUIRED",
        conflictCopyId:conflictId,
        copiesPreserved:true,
        removalCount:destructive.unapproved.length,
        removals:destructive.unapproved.slice(0, 100).map(publicRecordDifference),
      });
    }
    if (prepared.hash === cloudHash) {
      await client.query(
        `update state_conflict_copies
         set resolved_at = now(), resolved_revision = $2, resolution_mutation_id = $3,
             retention_expires_at = now() + interval '30 days'
         where id = $1`,
        [conflictId, expectedRevision, mutationId]
      );
      await client.query("commit");
      return sendJson(req, res, 200, {
        ok:true,
        unchanged:true,
        acknowledgedMutationId:mutationId,
        revision:expectedRevision,
        stateHash:cloudHash,
        conflictCopyId:conflictId,
      });
    }
    await createMergeStateBackup(client, account);
    const saved = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_revision = state_revision + 1, state_updated_at = now(), updated_at = now()
       where username = $1 returning state_revision, state_updated_at`,
      [user.username, JSON.stringify(mergedState), prepared.stateBytes, prepared.hash,
        JSON.stringify(manifest), manifest.version]
    );
    const revision = Number(saved.rows[0].state_revision);
    await insertStateVersion(client, {
      username:user.username,
      revision,
      state:mergedState,
      sourceDevice:"conflict-review",
      version:prepared,
    });
    await recordSaveEvent(client, {
      username:user.username,
      result:"accepted",
      baseRevision:expectedRevision,
      currentRevision:expectedRevision,
      resultingRevision:revision,
      stateHash:prepared.hash,
      stateBytes:prepared.stateBytes,
      deviceId:"conflict-review",
      baseHash:expectedHash,
      mutationId,
      changeManifest:body?.changeSet,
      mergeSource:"conflict-review",
      detail:`Resolved conflict ${conflictId}`,
      conflictCopyId:conflictId,
    });
    await client.query(
      `update state_conflict_copies
       set resolved_at = now(), resolved_revision = $2, resolution_mutation_id = $3,
           retention_expires_at = now() + interval '30 days'
       where id = $1`,
      [conflictId, revision, mutationId]
    );
    await client.query("commit");
    sendJson(req, res, 200, {
      ok:true,
      acknowledgedMutationId:mutationId,
      revision,
      stateHash:prepared.hash,
      savedAt:saved.rows[0].state_updated_at,
      conflictCopyId:conflictId,
      copiesPreserved:true,
      serverTime:new Date().toISOString(),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function browserRecoveryUser(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(req, res, 401, { ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  if (user.sync_device_id) {
    sendJson(req, res, 403, { ok: false, error: "BROWSER_SESSION_REQUIRED" });
    return null;
  }
  return user;
}

async function loadStateVersion(client, username, versionId) {
  const result = await client.query(
    `select id, revision, state_gzip, state_hash, state_bytes, compressed_bytes,
            source_device, summary, created_at
     from state_versions where id = $1 and username = $2`,
    [versionId, username]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, state: deserializeStateVersion(row.state_gzip) };
}

function recoveryPreviewPayload({ purpose, username, sourceKind, sourceId, currentRevision, currentHash, sourceHash }) {
  return signRecoveryPreview({
    purpose,
    username,
    sourceKind,
    sourceId: String(sourceId),
    currentRevision: Number(currentRevision || 0),
    currentHash,
    sourceHash,
    nonce: crypto.randomBytes(10).toString("base64url"),
    expiresAt: Date.now() + RECOVERY_PREVIEW_MAX_AGE_MS,
  });
}

function limitedComparison(comparison) {
  return {
    counts: comparison.counts,
    recoverableMissing: comparison.recoverableMissing.slice(0, 300),
    currentOnly: comparison.currentOnly.slice(0, 300),
    changed: comparison.changed.slice(0, 300),
    detailsTruncated: Object.values(comparison.counts).some((count) => count > 300),
  };
}

async function handleRecoveryVersions(req, res) {
  const user = await browserRecoveryUser(req, res);
  if (!user) return;
  if (req.method !== "GET") return send(req, res, 405, "Method not allowed");
  const versions = await pool.query(
    `select id, revision, state_hash, state_bytes, compressed_bytes, source_device, summary, created_at
     from state_versions where username = $1
     order by revision desc, id desc limit 120`,
    [user.username]
  );
  sendJson(req, res, 200, {
    ok: true,
    username: user.username,
    current: {
      revision: Number(user.state_revision || 0),
      stateHash: user.state_hash || (user.state ? stateHash(user.state) : stateHash(null)),
      updatedAt: user.state_updated_at || user.updated_at || null,
      summary: stateSummary(user.state),
    },
    versions: versions.rows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision || 0),
      stateHash: row.state_hash,
      stateBytes: Number(row.state_bytes || 0),
      compressedBytes: Number(row.compressed_bytes || 0),
      sourceDevice: row.source_device,
      summary: row.summary || {},
      createdAt: row.created_at,
      reason: row.source_device || "saved version",
    })),
  });
}

async function handleRecoveryVersionPreview(req, res, versionId) {
  const user = await browserRecoveryUser(req, res);
  if (!user) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  if (!/^\d+$/.test(versionId)) return sendJson(req, res, 400, { ok: false, error: "INVALID_VERSION" });
  await readJsonBody(req);
  const version = await loadStateVersion(pool, user.username, versionId);
  if (!version) return sendJson(req, res, 404, { ok: false, error: "VERSION_NOT_FOUND" });
  const currentHash = user.state_hash || (user.state ? stateHash(user.state) : stateHash(null));
  const comparison = compareRecoveryStates(user.state, version.state);
  const proposed = recoverMissingRecords(user.state, version.state);
  sendJson(req, res, 200, {
    ok: true,
    mode: "recover-missing",
    source: {
      id: String(version.id),
      revision: Number(version.revision || 0),
      stateHash: version.state_hash,
      createdAt: version.created_at,
      sourceDevice: version.source_device,
      summary: version.summary || stateSummary(version.state),
    },
    current: {
      revision: Number(user.state_revision || 0),
      stateHash: currentHash,
      summary: stateSummary(user.state),
    },
    proposedSummary: proposed.summary,
    unchanged: proposed.unchanged,
    comparison: limitedComparison(comparison),
    previewToken: recoveryPreviewPayload({
      purpose: "recover-missing",
      username: user.username,
      sourceKind: "version",
      sourceId: version.id,
      currentRevision: user.state_revision,
      currentHash,
      sourceHash: version.state_hash,
    }),
    expiresInSeconds: Math.floor(RECOVERY_PREVIEW_MAX_AGE_MS / 1000),
  });
}

async function handleRecoveryVersionRecoverMissing(req, res, versionId) {
  const user = await browserRecoveryUser(req, res);
  if (!user) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  if (!/^\d+$/.test(versionId)) return sendJson(req, res, 400, { ok: false, error: "INVALID_VERSION" });
  const body = await readJsonBody(req);
  const preview = verifyRecoveryPreview(body.previewToken, {
    purpose: "recover-missing",
    username: user.username,
    sourceKind: "version",
    sourceId: versionId,
  });
  if (!preview) return sendJson(req, res, 409, { ok: false, error: "PREVIEW_EXPIRED", message: "Preview this version again before recovering it." });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accountResult = await client.query("select * from accounts where username = $1 for update", [user.username]);
    const account = accountResult.rows[0];
    const currentHash = account?.state_hash || (account?.state ? stateHash(account.state) : stateHash(null));
    if (!account || Number(account.state_revision || 0) !== Number(preview.currentRevision) || currentHash !== preview.currentHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok: false, error: "PREVIEW_STALE", message: "Saved online changed. Preview again so no newer work is overwritten." });
    }
    const version = await loadStateVersion(client, user.username, versionId);
    if (!version || version.state_hash !== preview.sourceHash) {
      await client.query("rollback");
      return sendJson(req, res, 409, { ok: false, error: "SOURCE_CHANGED" });
    }
    const recovered = recoverMissingRecords(account.state, version.state);
    if (recovered.unchanged) {
      await client.query("commit");
      return sendJson(req, res, 200, {
        ok: true,
        unchanged: true,
        revision: Number(account.state_revision || 0),
        stateHash: currentHash,
        summary: stateSummary(account.state),
        additions: [],
      });
    }
    recovered.state.updatedAt = Date.now();
    const prepared = serializeStateVersion(recovered.state);
    if (prepared.stateBytes > MAX_STATE_BYTES) {
      await client.query("rollback");
      return sendJson(req, res, 413, stateTooLargePayload(prepared.stateBytes));
    }
    const backup = await client.query(
      `insert into state_backups (username, revision, state, reason)
       values ($1, $2, $3::jsonb, 'pre_restore') returning id`,
      [user.username, Number(account.state_revision || 0), JSON.stringify(account.state)]
    );
    const updated = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_hash = $4,
           state_manifest = $5::jsonb, state_manifest_version = $6,
           state_revision = state_revision + 1, state_updated_at = now(), updated_at = now()
       where username = $1 returning state_revision, state_updated_at`,
      [user.username, prepared.serialized, prepared.stateBytes, prepared.hash,
        JSON.stringify(stateManifest(recovered.state)), 1]
    );
    const resultingRevision = Number(updated.rows[0].state_revision);
    await insertStateVersion(client, {
      username: user.username,
      revision: resultingRevision,
      state: recovered.state,
      sourceDevice: "self-missing-recovery",
      version: prepared,
    });
    await recordSaveEvent(client, {
      username: user.username,
      result: "recovered",
      currentRevision: Number(account.state_revision || 0),
      resultingRevision,
      state: recovered.state,
      stateHash: prepared.hash,
      stateBytes: prepared.stateBytes,
      deviceId: "self-missing-recovery",
      detail: `Recovered ${recovered.additions.length} missing records from revision ${Number(version.revision || 0)}`,
      changeManifest: { additions: recovered.additions },
    });
    await client.query("commit");
    await pruneStateVersions(user.username).catch((error) => console.error("State history pruning failed", error));
    sendJson(req, res, 200, {
      ok: true,
      revision: resultingRevision,
      stateHash: prepared.hash,
      restoredAt: updated.rows[0].state_updated_at,
      preRestoreBackupId: String(backup.rows[0].id),
      recoveredFromRevision: Number(version.revision || 0),
      summary: recovered.summary,
      additions: recovered.additions.slice(0, 300),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleAdminRecoveryRestorePreview(req, res, sourceKind, sourceId) {
  if (!await requireBrowserAdmin(req, res)) return;
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const username = normalizeUsername(body.username);
  if (!USERNAME_PATTERN.test(username) || !/^\d+$/.test(sourceId) || !["snapshot", "version"].includes(sourceKind)) {
    return sendJson(req, res, 400, { ok: false, error: "INVALID_PREVIEW_REQUEST" });
  }
  const accountResult = await pool.query("select * from accounts where username = $1", [username]);
  const account = accountResult.rows[0];
  if (!account) return sendJson(req, res, 404, { ok: false, error: "ACCOUNT_NOT_FOUND" });
  let sourceState;
  let sourceHash;
  let sourceSummary;
  let sourceRevision;
  let sourceCreatedAt;
  if (sourceKind === "version") {
    const version = await loadStateVersion(pool, username, sourceId);
    if (!version) return sendJson(req, res, 404, { ok: false, error: "VERSION_NOT_FOUND" });
    sourceState = version.state;
    sourceHash = version.state_hash;
    sourceSummary = version.summary || stateSummary(version.state);
    sourceRevision = Number(version.revision || 0);
    sourceCreatedAt = version.created_at;
  } else {
    const snapshotResult = await pool.query("select * from state_backups where id = $1 and username = $2", [sourceId, username]);
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) return sendJson(req, res, 404, { ok: false, error: "SNAPSHOT_NOT_FOUND" });
    sourceState = snapshot.state;
    sourceHash = stateHash(snapshot.state);
    sourceSummary = stateSummary(snapshot.state);
    sourceRevision = Number(snapshot.revision || 0);
    sourceCreatedAt = snapshot.created_at;
  }
  const currentHash = account.state_hash || (account.state ? stateHash(account.state) : stateHash(null));
  const comparison = compareRecoveryStates(account.state, sourceState);
  sendJson(req, res, 200, {
    ok: true,
    mode: "full-replacement",
    username,
    source: { kind: sourceKind, id: String(sourceId), revision: sourceRevision, stateHash: sourceHash, summary: sourceSummary, createdAt: sourceCreatedAt },
    current: { revision: Number(account.state_revision || 0), stateHash: currentHash, summary: stateSummary(account.state) },
    comparison: limitedComparison(comparison),
    previewToken: recoveryPreviewPayload({
      purpose: "admin-full-restore",
      username,
      sourceKind,
      sourceId,
      currentRevision: account.state_revision,
      currentHash,
      sourceHash,
    }),
    expiresInSeconds: Math.floor(RECOVERY_PREVIEW_MAX_AGE_MS / 1000),
  });
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function handleAdminPairingCode(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user) return sendJson(req, res, 401, { ok: false, error: "AUTH_REQUIRED" });
  if (user.username !== ADMIN_USERNAME || user.sync_device_id) {
    return sendJson(req, res, 403, { ok: false, error: "ADMIN_BROWSER_SESSION_REQUIRED" });
  }
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const body = await readJsonBody(req);
  const deviceName = String(body.deviceName || "Local v13").trim().slice(0, 80) || "Local v13";
  const code = randomPairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query("delete from sync_pairing_codes where username = $1 or expires_at < now() or used_at is not null", [user.username]);
  await pool.query(
    `insert into sync_pairing_codes (code_hash, username, device_name, expires_at)
     values ($1, $2, $3, $4)`,
    [tokenHash(code), user.username, deviceName, expiresAt]
  );
  sendJson(req, res, 200, { ok: true, code, expiresAt: expiresAt.toISOString() });
}

async function handlePairDevice(req, res) {
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  if (isRateLimited(clientKey(req, "device-pair"), 20, 15 * 60 * 1000)) {
    return sendJson(req, res, 429, { ok: false, error: "Too many pairing attempts. Try again later." });
  }
  const body = await readJsonBody(req);
  const code = String(body.code || "").trim().toUpperCase();
  const requestedName = String(body.deviceName || "Local v13").trim().slice(0, 80) || "Local v13";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pairing = await client.query(
      `select code_hash, username, device_name from sync_pairing_codes
       where code_hash = $1 and expires_at > now() and used_at is null
       for update`,
      [tokenHash(code)]
    );
    const row = pairing.rows[0];
    if (!row || row.username !== ADMIN_USERNAME) {
      await client.query("rollback");
      sendJson(req, res, 401, { ok: false, error: "Pairing code is invalid or expired." });
      return;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const deviceId = crypto.randomUUID();
    await client.query("update sync_pairing_codes set used_at = now() where code_hash = $1", [row.code_hash]);
    await client.query(
      `insert into sync_devices (id, token_hash, username, device_name)
       values ($1, $2, $3, $4)`,
      [deviceId, tokenHash(token), row.username, requestedName || row.device_name]
    );
    const account = await client.query("select * from accounts where username = $1", [row.username]);
    await client.query("commit");
    sendJson(req, res, 200, { ok: true, token, deviceId, user: publicUser(account.rows[0]) });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleRevokeSelf(req, res) {
  if (req.method !== "POST") return send(req, res, 405, "Method not allowed");
  const user = await currentUser(req, { includeState:false });
  if (!user?.sync_device_id) return sendJson(req, res, 401, { ok: false, error: "DEVICE_AUTH_REQUIRED" });
  await pool.query("update sync_devices set revoked_at = now() where id = $1", [user.sync_device_id]);
  sendJson(req, res, 200, { ok: true });
}

async function handleAdminSyncDevices(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user || user.username !== ADMIN_USERNAME || user.sync_device_id) {
    return sendJson(req, res, 403, { ok: false, error: "Admin access required." });
  }
  if (req.method === "GET") {
    const devices = await pool.query(
      `select id, device_name, created_at, last_used_at, revoked_at
       from sync_devices where username = $1 order by created_at desc`,
      [ADMIN_USERNAME]
    );
    return sendJson(req, res, 200, { ok: true, devices: devices.rows });
  }
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    await pool.query("update sync_devices set revoked_at = now() where id = $1 and username = $2", [String(body.deviceId || ""), ADMIN_USERNAME]);
    return sendJson(req, res, 200, { ok: true });
  }
  send(req, res, 405, "Method not allowed");
}

async function handleAdminUsers(req, res) {
  const user = await currentUser(req, { includeState:false });
  if (!user || user.username !== ADMIN_USERNAME || user.sync_device_id) {
    sendJson(req, res, 403, { ok: false, error: "Admin access required." });
    return;
  }

  const result = await pool.query(
    `select username, display_name, state_bytes, created_at, updated_at, state is not null as has_state
     from accounts
     order by created_at asc`
  );
  sendJson(req, res, 200, { ok: true, users: result.rows });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      if (req.headers.origin && !isAllowedOrigin(req, req.headers.origin)) {
        send(req, res, 403, "Origin not allowed");
        return;
      }
      send(req, res, 204, "");
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/v13" || url.pathname === "/claudever13.html") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=v13" });
        return;
      }
      if (user.username !== ADMIN_USERNAME) {
        send(req, res, 302, "Admin v13 only", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, authenticatedV13Html(user), { "content-type": "text/html; charset=utf-8" });
      return;
    }

      if (url.pathname === "/v14" || url.pathname === "/claudever14.html") {
        const user = await currentUser(req, { includeState:false });
        if (!user || user.sync_device_id) {
          send(req, res, 302, "Login required", { location: "/app.html?next=v14" });
          return;
        }
        if (!canAccessV14(user)) {
          send(req, res, 302, V14_ACCESS_MODE === "off" ? "v14 is temporarily unavailable" : "v14 is not enabled for this account", { location: "/app.html?stable=1" });
          return;
        }
        send(req, res, 200, authenticatedV14Html(user), { "content-type": "text/html; charset=utf-8" });
        return;
    }

    if (url.pathname === "/v15" || url.pathname === "/claudever15.html") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=v15" });
        return;
      }
      if (!canAccessV15(user)) {
        send(req, res, 302, V15_ACCESS_MODE === "off" ? "v15 is temporarily unavailable" : "v15 is not enabled for this account", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, authenticatedV15Html(user), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/v16" || url.pathname === "/claudever16.html") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=v16" });
        return;
      }
      if (!canAccessV16(user)) {
        send(req, res, 302, V16_ACCESS_MODE === "off" ? "v16 is temporarily unavailable" : "v16 is not enabled for this account", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, authenticatedV16Html(user), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/v19" || url.pathname === "/claudever19.html") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?stable=1" });
        return;
      }
      if (!canAccessV19(user)) {
        send(req, res, 302, V19_ACCESS_MODE === "off" ? "v19 is temporarily unavailable" : "v19 is not enabled for this account", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, authenticatedV19Html(user), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=v15-main" });
        return;
      }
      if (MAIN_APP_VERSION === "19" && canAccessV19(user)) {
        send(req, res, 200, authenticatedV19Html(user), { "content-type": "text/html; charset=utf-8" });
        return;
      }
      if (!canAccessV15(user)) {
        send(req, res, 302, V15_ACCESS_MODE === "off" ? "v15 is temporarily unavailable" : "v15 is not enabled for this account", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, authenticatedV15Html(user), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/device-recovery" || url.pathname === "/data-recovery") {
      const user = await currentUser(req, { includeState:false });
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=data-recovery&stable=1" });
        return;
      }
      send(req, res, 200, fs.readFileSync(DEVICE_RECOVERY_HTML_PATH), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return;
    }

    if (url.pathname === "/device-recovery.js") {
      send(req, res, 200, fs.readFileSync(DEVICE_RECOVERY_JS_PATH), {
        "content-type": "text/javascript; charset=utf-8",
      });
      return;
    }

    if (url.pathname === "/v16-local-features.js") {
      send(req, res, 200, fs.readFileSync(V16_FEATURES_PATH), {
        "content-type": "text/javascript; charset=utf-8",
      });
      return;
    }

    if (url.pathname === "/v18-local-features.js") {
      send(req, res, 200, fs.readFileSync(V18_FEATURES_PATH), {
        "content-type": "text/javascript; charset=utf-8",
      });
      return;
    }

    if (url.pathname === "/v19-local-features.js") {
      send(req, res, 200, fs.readFileSync(V19_FEATURES_PATH), {
        "content-type": "text/javascript; charset=utf-8",
      });
      return;
    }

    if (url.pathname === "/safe-sync.js") {
      send(req, res, 200, fs.readFileSync(SAFE_SYNC_JS_PATH), {
        "content-type": "text/javascript; charset=utf-8",
        ...(url.searchParams.has("v") ? { "cache-control":"public, max-age=31536000, immutable" } : {}),
      });
      return;
    }

    if (url.pathname === "/weekly-study-planner" || url.pathname === "/weekly-study-planner.html" || url.pathname === "/weekly-study-planner-lite.html") {
      send(req, res, 200, fs.readFileSync(WEEKLY_STUDY_PLANNER_LITE_PATH), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/weekly-study-planner/full" || url.pathname === "/weekly-study-planner-full.html") {
      send(req, res, 200, fs.readFileSync(WEEKLY_STUDY_PLANNER_FULL_PATH), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/app.html" || url.pathname === "/claudever9.html") {
      send(req, res, 200, fs.readFileSync(HTML_PATH), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (url.pathname === "/api/register") {
      await handleRegister(req, res);
      return;
    }

    if (url.pathname === "/api/recovery/config") {
      await handleRecoveryConfig(req, res);
      return;
    }

    if (url.pathname === "/api/recovery/requests") {
      await handleRecoveryRequest(req, res);
      return;
    }

    if (url.pathname === "/api/recovery/complete") {
      await handleRecoveryComplete(req, res);
      return;
    }

    if (url.pathname === "/api/recovery/versions") {
      await handleRecoveryVersions(req, res);
      return;
    }

    const recoveryVersionPreviewMatch = url.pathname.match(/^\/api\/recovery\/versions\/(\d+)\/preview$/);
    if (recoveryVersionPreviewMatch) {
      await handleRecoveryVersionPreview(req, res, recoveryVersionPreviewMatch[1]);
      return;
    }

    const recoveryMissingMatch = url.pathname.match(/^\/api\/recovery\/versions\/(\d+)\/recover-missing$/);
    if (recoveryMissingMatch) {
      await handleRecoveryVersionRecoverMissing(req, res, recoveryMissingMatch[1]);
      return;
    }

    if (url.pathname === "/api/me") {
      await handleMe(req, res);
      return;
    }

    if (url.pathname === "/api/logout") {
      await handleLogout(req, res);
      return;
    }

    if (url.pathname === "/api/state") {
      await handleState(req, res);
      return;
    }

    if (url.pathname === "/api/v2/state") {
      await handleVersionedState(req, res);
      return;
    }

    if (url.pathname === "/api/v2/state/meta") {
      await handleVersionedStateMeta(req, res);
      return;
    }

    if (url.pathname === "/api/v2/state/conflicts") {
      await handleStateConflicts(req, res);
      return;
    }

    const conflictResolveMatch = url.pathname.match(/^\/api\/v2\/state\/conflicts\/([a-f0-9-]{36})\/resolve$/i);
    if (conflictResolveMatch) {
      await handleStateConflictResolve(req, res, conflictResolveMatch[1]);
      return;
    }

    const conflictDetailMatch = url.pathname.match(/^\/api\/v2\/state\/conflicts\/([a-f0-9-]{36})$/i);
    if (conflictDetailMatch) {
      await handleStateConflictDetail(req, res, conflictDetailMatch[1]);
      return;
    }

    if (url.pathname === "/api/admin/pairing-code") {
      await handleAdminPairingCode(req, res);
      return;
    }

    if (url.pathname === "/api/sync/pair") {
      await handlePairDevice(req, res);
      return;
    }

    if (url.pathname === "/api/sync/revoke-self") {
      await handleRevokeSelf(req, res);
      return;
    }

    if (url.pathname === "/api/admin/sync-devices") {
      await handleAdminSyncDevices(req, res);
      return;
    }

    if (url.pathname === "/api/admin/users") {
      await handleAdminUsers(req, res);
      return;
    }

    if (url.pathname === "/api/admin/recovery/requests") {
      await handleAdminRecoveryRequests(req, res);
      return;
    }

    if (url.pathname === "/api/admin/recovery/manual") {
      await handleAdminRecoveryManual(req, res);
      return;
    }

    if (url.pathname === "/api/admin/recovery/snapshots") {
      await handleAdminRecoverySnapshots(req, res, url);
      return;
    }

    if (url.pathname === "/api/admin/recovery/incidents/anya-2026-08-11") {
      await handleAnyaIncidentRecovery(req, res);
      return;
    }

    if (url.pathname === "/api/admin/recovery/incidents/anya-2026-08-26-28/preview") {
      await handleAnyaAugustRecoveryPreview(req, res);
      return;
    }

    const recoveryApproveMatch = url.pathname.match(/^\/api\/admin\/recovery\/requests\/([^/]+)\/approve$/);
    if (recoveryApproveMatch) {
      await handleAdminRecoveryApprove(req, res, decodeURIComponent(recoveryApproveMatch[1]));
      return;
    }

    const recoveryDenyMatch = url.pathname.match(/^\/api\/admin\/recovery\/requests\/([^/]+)\/deny$/);
    if (recoveryDenyMatch) {
      await handleAdminRecoveryDeny(req, res, decodeURIComponent(recoveryDenyMatch[1]));
      return;
    }

    const recoveryRestoreMatch = url.pathname.match(/^\/api\/admin\/recovery\/snapshots\/(\d+)\/restore$/);
    if (recoveryRestoreMatch) {
      await handleAdminRecoverySnapshotRestore(req, res, recoveryRestoreMatch[1]);
      return;
    }

    const recoverySnapshotPreviewMatch = url.pathname.match(/^\/api\/admin\/recovery\/snapshots\/(\d+)\/preview$/);
    if (recoverySnapshotPreviewMatch) {
      await handleAdminRecoveryRestorePreview(req, res, "snapshot", recoverySnapshotPreviewMatch[1]);
      return;
    }

    const recoveryVersionRestoreMatch = url.pathname.match(/^\/api\/admin\/recovery\/versions\/(\d+)\/restore$/);
    if (recoveryVersionRestoreMatch) {
      await handleAdminRecoveryVersionRestore(req, res, recoveryVersionRestoreMatch[1]);
      return;
    }

    const recoveryAdminVersionPreviewMatch = url.pathname.match(/^\/api\/admin\/recovery\/versions\/(\d+)\/preview$/);
    if (recoveryAdminVersionPreviewMatch) {
      await handleAdminRecoveryRestorePreview(req, res, "version", recoveryAdminVersionPreviewMatch[1]);
      return;
    }

      if (url.pathname === "/api/v18/admin-course-criteria") {
        const user = await currentUser(req, { includeState:false });
        if (!user || user.sync_device_id) {
          sendJson(req, res, 401, { ok:false, error:"LOGIN_REQUIRED" });
          return;
        }
        if (user.username !== ADMIN_USERNAME) {
          sendJson(req, res, 403, { ok:false, error:"ADMIN_ONLY" });
          return;
        }
        sendJson(req, res, 200, { ok:true, ...V18_ADMIN_COURSE_CRITERIA });
        return;
      }

      if (url.pathname === "/api/version") {
        const requestedVersion = url.searchParams.get("version");
        const versionNumber = requestedVersion === "19" ? 19 : requestedVersion === "16" ? 16 : requestedVersion === "15" ? 15 : requestedVersion === "14" ? 14 : 13;
        const versionPath = versionNumber === 19 ? V19_VERSION_PATH : versionNumber === 16 ? V16_VERSION_PATH : versionNumber === 15 ? V15_VERSION_PATH : versionNumber === 14 ? V14_VERSION_PATH : V13_VERSION_PATH;
        let version = {
          version: versionNumber,
          hash: null,
          releasedAt: null,
          source: versionNumber === 19 ? "claudever19.html" : versionNumber === 16 ? "claudever16.html" : versionNumber === 15 ? "claudever15.html" : versionNumber === 14 ? "claudever14.html" : "claudever13.html",
        };
        try { version = JSON.parse(fs.readFileSync(versionPath, "utf8")); } catch {}
        sendJson(req, res, 200, {
          ok: true,
          ...version,
          ...(versionNumber === 14 ? { accessMode: V14_ACCESS_MODE, adminOnly: V14_ACCESS_MODE !== "all" } : {}),
          ...(versionNumber === 15 ? {
            accessMode: V15_ACCESS_MODE,
            adminOnly: V15_ACCESS_MODE !== "all",
            main: MAIN_APP_VERSION === "15",
            route: MAIN_APP_VERSION === "15" ? "/" : "/v15",
          } : {}),
          ...(versionNumber === 16 ? { accessMode: V16_ACCESS_MODE, adminOnly: V16_ACCESS_MODE !== "all" } : {}),
          ...(versionNumber === 19 ? {
            accessMode: V19_ACCESS_MODE,
            adminOnly: V19_ACCESS_MODE !== "all",
            main: MAIN_APP_VERSION === "19",
            route: MAIN_APP_VERSION === "19" ? "/" : "/v19",
          } : {}),
        });
        return;
      }

    if (url.pathname === "/api/health") {
      await pool.query("select 1 as healthy");
      sendJson(req, res, 200, {
        ok: true,
        db: "postgres",
        serverTime: new Date().toISOString(),
        v14AccessMode: V14_ACCESS_MODE,
        v15AccessMode: V15_ACCESS_MODE,
        v16AccessMode: V16_ACCESS_MODE,
        v19AccessMode: V19_ACCESS_MODE,
        mainVersion: MAIN_APP_VERSION,
      });
      return;
    }

    if (url.pathname === "/api/heartbeat") {
      sendJson(req, res, 200, { ok:true, serverTime:new Date().toISOString() });
      return;
    }

    send(req, res, 404, "Not found");
  } catch (error) {
    if (error && error.code === "PAYLOAD_TOO_LARGE") {
      sendJson(req, res, 413, {
        ok: false,
        error: "REQUEST_TOO_LARGE",
        message: error.message,
        maxStateBytes: MAX_STATE_BYTES,
        maxRequestBytes: MAX_STATE_BYTES + MAX_STATE_ENVELOPE_BYTES,
        serverTime: new Date().toISOString(),
      });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(req, res, 400, { ok: false, error: "Invalid JSON." });
      return;
    }
    console.error(error);
    sendJson(req, res, 500, { ok: false, error: "Server error." });
  }
});

const STARTUP_RETRY_DELAYS_MS = [1000, 3000, 10000, 30000];
let shuttingDown = false;

async function ensureSchemaWithRetry() {
  for (let attempt = 0; attempt <= STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      serverLog("info", "database_schema_start", { attempt:attempt + 1 });
      await ensureSchema();
      serverLog("info", "database_schema_ready", { attempt:attempt + 1 });
      return;
    } catch (error) {
      const retryDelayMs = STARTUP_RETRY_DELAYS_MS[attempt];
      serverLog(retryDelayMs ? "warn" : "error", "database_schema_failed", {
        attempt:attempt + 1,
        retryDelayMs:retryDelayMs || null,
        code:error?.code || null,
        message:String(error?.message || error).slice(0, 500),
      });
      if (!retryDelayMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function shutdownServer(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverLog(exitCode ? "error" : "info", "server_shutdown", { signal, exitCode });
  const forceTimer = setTimeout(() => process.exit(exitCode), 10000);
  forceTimer.unref();
  await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  await pool.end().catch((error) => serverLog("error", "database_pool_close_failed", { message:String(error?.message || error) }));
  process.exit(exitCode);
}

process.on("SIGTERM", () => { void shutdownServer("SIGTERM", 0); });
process.on("SIGINT", () => { void shutdownServer("SIGINT", 0); });
process.on("unhandledRejection", (error) => {
  serverLog("error", "unhandled_rejection", { message:String(error?.stack || error).slice(0, 2000) });
});
process.on("uncaughtException", (error) => {
  serverLog("error", "uncaught_exception", { message:String(error?.stack || error).slice(0, 2000) });
  void shutdownServer("uncaughtException", 1);
});

const databaseSafety = databaseEndpointSafety(DATABASE_URL);
serverLog("info", "server_starting", {
  port:PORT,
  safeSyncMode:SAFE_SYNC_MODE,
  databaseProvider:databaseSafety.provider,
  databasePooled:databaseSafety.pooled,
  databaseTlsVerified:databaseSafety.tlsVerified,
  databasePoolMax:3,
});
if (IS_HOSTED && databaseSafety.provider === "neon" && !databaseSafety.pooled) {
  serverLog("warn", "database_endpoint_not_pooled", { databaseProvider:"neon" });
}
ensureSchemaWithRetry()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      serverLog("info", "server_listening", {
        port:PORT,
        accountLimit:MAX_ACCOUNTS,
        maxStateBytes:MAX_STATE_BYTES,
      });
    });
  })
  .catch((error) => {
    serverLog("error", "server_startup_failed", { message:String(error?.stack || error).slice(0, 2000) });
    process.exit(1);
  });
