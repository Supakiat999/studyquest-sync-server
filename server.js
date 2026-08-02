const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, "public", "claudever9.html");
const V13_HTML_PATH = path.join(ROOT, "public", "claudever13.html");
const V13_VERSION_PATH = path.join(ROOT, "public", "v13-version.json");
const WEEKLY_STUDY_PLANNER_LITE_PATH = path.join(ROOT, "public", "weekly-study-planner.html");
const WEEKLY_STUDY_PLANNER_FULL_PATH = path.join(ROOT, "public", "weekly-study-planner-full.html");
const SESSION_COOKIE = "sq_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_USERNAME = "admin";
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = "sha512";
const MAX_ACCOUNTS = Number(process.env.STUDYQUEST_MAX_ACCOUNTS || 5);
const MAX_AUTH_BODY_BYTES = 64 * 1024;
const MAX_STATE_BYTES = Number(process.env.STUDYQUEST_MAX_STATE_BYTES || 1024 * 1024);
const TEMP_PASSWORD_MAX_AGE_SECONDS = 24 * 60 * 60;
const IS_HOSTED = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.NODE_ENV === "production");

const ADMIN_PASSWORD = process.env.STUDYQUEST_ADMIN_PASSWORD;
const INVITE_CODE = process.env.STUDYQUEST_INVITE_CODE;
const ADMIN_CONTACT_LABEL = String(process.env.STUDYQUEST_ADMIN_CONTACT_LABEL || "Contact your StudyQuest admin").trim().slice(0, 120);
const ADMIN_CONTACT_URL = safeContactUrl(process.env.STUDYQUEST_ADMIN_CONTACT_URL);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

if (IS_HOSTED && (!ADMIN_PASSWORD || !INVITE_CODE)) {
  throw new Error("Set STUDYQUEST_ADMIN_PASSWORD and STUDYQUEST_INVITE_CODE before hosting StudyQuest.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000
});

const authBuckets = new Map();

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLMODE === "require") return true;
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function payloadTooLargeError(maxBytes) {
  const error = new Error(`Request body is too large. Limit is ${maxBytes} bytes.`);
  error.code = "PAYLOAD_TOO_LARGE";
  return error;
}

function send(req, res, status, body, headers = {}) {
  const baseHeaders = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-credentials": "true",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  };
  const origin = req.headers.origin;
  if (isAllowedOrigin(req, origin)) {
    baseHeaders["access-control-allow-origin"] = origin;
    baseHeaders.vary = "Origin";
  }
  res.writeHead(status, baseHeaders);
  res.end(body);
}

function sendJson(req, res, status, data, headers = {}) {
  send(req, res, status, JSON.stringify(data), {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
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

function stateSummary(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    tasks: Array.isArray(state.tasks) ? state.tasks.length : 0,
    notes: Array.isArray(state.notes) ? state.notes.length : 0,
    files: Array.isArray(state.fileLinks) ? state.fileLinks.length : 0,
    checklist: Array.isArray(state.checklistItems) ? state.checklistItems.length : 0,
    grades: state.grades && typeof state.grades === "object" ? Object.keys(state.grades).length : 0,
    trips: Array.isArray(state.trips) ? state.trips.length : 0,
  };
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

async function ensureSchema() {
  await pool.query(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
  await pool.query("delete from sessions where expires_at < now()");
  await pool.query("delete from sync_pairing_codes where expires_at < now() or used_at is not null");
  await pool.query("delete from state_backups where created_at < now() - interval '30 days'");
  await pool.query(
    `update password_recovery_requests
     set status = 'expired', resolved_at = coalesce(resolved_at, now())
     where status = 'approved' and expires_at < now()`
  );

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
    console.log("Synced admin password from STUDYQUEST_ADMIN_PASSWORD.");
  }
}

async function currentUser(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    const deviceToken = authorization.slice(7).trim();
    if (!deviceToken) return null;
    const deviceResult = await pool.query(
      `select a.username, a.display_name, a.password_record, a.state, a.state_bytes,
              a.state_revision, a.state_updated_at, a.created_at, a.updated_at,
              d.id as sync_device_id, d.device_name as sync_device_name
       from sync_devices d
       join accounts a on a.username = d.username
       where d.token_hash = $1 and d.revoked_at is null`,
      [tokenHash(deviceToken)]
    );
    const deviceUser = deviceResult.rows[0] || null;
    if (deviceUser) {
      await pool.query("update sync_devices set last_used_at = now() where id = $1", [deviceUser.sync_device_id]);
    }
    return deviceUser;
  }

  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const result = await pool.query(
    `select a.username, a.display_name, a.password_record, a.state, a.state_bytes,
            a.state_revision, a.state_updated_at, a.created_at, a.updated_at
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

  const result = await pool.query("select * from accounts where username = $1", [username]);
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
  const user = await currentUser(req);
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
    const updated = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_revision = state_revision + 1,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [username, JSON.stringify(restoredState), stateBytes]
    );
    await client.query("commit");
    sendJson(req, res, 200, {
      ok: true,
      username,
      revision: Number(updated.rows[0].state_revision),
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

async function handleMe(req, res) {
  const user = await currentUser(req);
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
    const state = await readJsonBody(req, MAX_STATE_BYTES);
    const stateBytes = Buffer.byteLength(JSON.stringify(state || null));
    if (stateBytes > MAX_STATE_BYTES) {
      sendJson(req, res, 413, { ok: false, error: `Saved state is too large. Limit is ${MAX_STATE_BYTES} bytes.` });
      return;
    }
    const result = await pool.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_revision = state_revision + 1,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [user.username, JSON.stringify(state && typeof state === "object" ? state : null), stateBytes]
    );
    sendJson(req, res, 200, {
      ok: true,
      revision: Number(result.rows[0]?.state_revision || 0),
      savedAt: result.rows[0]?.state_updated_at || new Date().toISOString()
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
    await client.query(
      `insert into state_backups (username, revision, state, reason)
       values ($1, $2, $3::jsonb, 'daily')`,
      [row.username, Number(row.state_revision || 0), JSON.stringify(row.state)]
    );
  }
  await client.query(
    "delete from state_backups where username = $1 and created_at < now() - interval '30 days'",
    [row.username]
  );
}

async function handleVersionedState(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(req, res, 401, { ok: false, error: "AUTH_REQUIRED" });
    return;
  }

  if (req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      state: user.state || null,
      revision: Number(user.state_revision || 0),
      updatedAt: user.state_updated_at || user.updated_at || null,
    });
    return;
  }

  if (req.method !== "POST") {
    send(req, res, 405, "Method not allowed");
    return;
  }

  const body = await readJsonBody(req, MAX_STATE_BYTES + MAX_AUTH_BODY_BYTES);
  const incomingState = body?.state;
  const baseRevision = body?.baseRevision;
  if (!incomingState || typeof incomingState !== "object" || !Array.isArray(incomingState.tasks)) {
    sendJson(req, res, 400, { ok: false, error: "INVALID_STATE" });
    return;
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    sendJson(req, res, 400, { ok: false, error: "BASE_REVISION_REQUIRED" });
    return;
  }
  const stateBytes = Buffer.byteLength(JSON.stringify(incomingState));
  if (stateBytes > MAX_STATE_BYTES) {
    sendJson(req, res, 413, { ok: false, error: `Saved state is too large. Limit is ${MAX_STATE_BYTES} bytes.` });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = await client.query(
      `select username, state, state_revision, state_updated_at, updated_at
       from accounts where username = $1 for update`,
      [user.username]
    );
    const row = current.rows[0];
    const currentRevision = Number(row?.state_revision || 0);
    if (!row) {
      await client.query("rollback");
      sendJson(req, res, 404, { ok: false, error: "ACCOUNT_NOT_FOUND" });
      return;
    }
    if (baseRevision !== currentRevision) {
      await client.query("rollback");
      sendJson(req, res, 409, {
        ok: false,
        error: "STATE_CONFLICT",
        state: row.state || null,
        revision: currentRevision,
        updatedAt: row.state_updated_at || row.updated_at || null,
      });
      return;
    }

    await createDailyStateBackup(client, row);
    const saved = await client.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, state_revision = state_revision + 1,
           state_updated_at = now(), updated_at = now()
       where username = $1
       returning state_revision, state_updated_at`,
      [user.username, JSON.stringify(incomingState), stateBytes]
    );
    await client.query("commit");
    sendJson(req, res, 200, {
      ok: true,
      revision: Number(saved.rows[0].state_revision),
      savedAt: saved.rows[0].state_updated_at,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function handleAdminPairingCode(req, res) {
  const user = await currentUser(req);
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
  const user = await currentUser(req);
  if (!user?.sync_device_id) return sendJson(req, res, 401, { ok: false, error: "DEVICE_AUTH_REQUIRED" });
  await pool.query("update sync_devices set revoked_at = now() where id = $1", [user.sync_device_id]);
  sendJson(req, res, 200, { ok: true });
}

async function handleAdminSyncDevices(req, res) {
  const user = await currentUser(req);
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
  const user = await currentUser(req);
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
      const user = await currentUser(req);
      if (!user || user.sync_device_id) {
        send(req, res, 302, "Login required", { location: "/app.html?next=v13" });
        return;
      }
      if (user.username !== ADMIN_USERNAME) {
        send(req, res, 302, "Admin v13 only", { location: "/app.html?stable=1" });
        return;
      }
      send(req, res, 200, fs.readFileSync(V13_HTML_PATH), { "content-type": "text/html; charset=utf-8" });
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

    if (url.pathname === "/" || url.pathname === "/app.html" || url.pathname === "/claudever9.html") {
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

    if (url.pathname === "/api/version") {
      let version = { version: 13, hash: null, releasedAt: null };
      try { version = JSON.parse(fs.readFileSync(V13_VERSION_PATH, "utf8")); } catch {}
      sendJson(req, res, 200, { ok: true, ...version });
      return;
    }

    if (url.pathname === "/api/heartbeat" || url.pathname === "/api/health") {
      sendJson(req, res, 200, { ok: true, auth: true, db: "postgres", serverTime: new Date().toISOString() });
      return;
    }

    send(req, res, 404, "Not found");
  } catch (error) {
    if (error && error.code === "PAYLOAD_TOO_LARGE") {
      sendJson(req, res, 413, { ok: false, error: error.message });
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

ensureSchema()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`StudyQuest hosted server listening on ${PORT}`);
      console.log(`Account limit: ${MAX_ACCOUNTS}; per-user state limit: ${MAX_STATE_BYTES} bytes`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
