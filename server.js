const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, "public", "claudever9.html");
const V13_HTML_PATH = path.join(ROOT, "public", "claudever13.html");
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
const IS_HOSTED = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.NODE_ENV === "production");

const ADMIN_PASSWORD = process.env.STUDYQUEST_ADMIN_PASSWORD;
const INVITE_CODE = process.env.STUDYQUEST_INVITE_CODE;
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
    "access-control-allow-headers": "content-type",
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

  const admin = await pool.query("select username from accounts where username = $1", [ADMIN_USERNAME]);
  if (!admin.rowCount) {
    const initialPassword = ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
    await pool.query(
      `insert into accounts (username, display_name, password_record, state, state_bytes)
       values ($1, $2, $3::jsonb, null, 0)`,
      [ADMIN_USERNAME, "Admin", JSON.stringify(passwordRecord(initialPassword))]
    );
  }
}

async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const result = await pool.query(
    `select a.username, a.display_name, a.password_record, a.state, a.state_bytes, a.created_at, a.updated_at
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
    await pool.query(
      `update accounts
       set state = $2::jsonb, state_bytes = $3, updated_at = now()
       where username = $1`,
      [user.username, JSON.stringify(state && typeof state === "object" ? state : null), stateBytes]
    );
    sendJson(req, res, 200, { ok: true });
    return;
  }

  send(req, res, 405, "Method not allowed");
}

async function handleAdminUsers(req, res) {
  const user = await currentUser(req);
  if (!user || user.username !== ADMIN_USERNAME) {
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
      send(req, res, 200, fs.readFileSync(V13_HTML_PATH), { "content-type": "text/html; charset=utf-8" });
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

    if (url.pathname === "/api/admin/users") {
      await handleAdminUsers(req, res);
      return;
    }

    if (url.pathname === "/api/heartbeat" || url.pathname === "/api/health") {
      sendJson(req, res, 200, { ok: true, auth: true, db: "postgres" });
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
