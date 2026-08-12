const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "schema.sql"), "utf8");
const stableHtml = fs.readFileSync(path.join(root, "public", "claudever9.html"), "utf8");
const v13Path = path.join(root, "public", "claudever13.html");
const v13Html = fs.readFileSync(v13Path, "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "public", "v13-version.json"), "utf8"));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function functionSection(name, nextName) {
  const start = server.indexOf(`function ${name}`);
  const asyncStart = server.indexOf(`async function ${name}`);
  const actualStart = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  check(actualStart !== -1, `Missing server function: ${name}`);
  const endMarkers = [`\nfunction ${nextName}`, `\nasync function ${nextName}`]
    .map(marker => server.indexOf(marker, actualStart + 1))
    .filter(index => index !== -1);
  const end = endMarkers.length ? Math.min(...endMarkers) : server.length;
  return server.slice(actualStart, end);
}

const approval = functionSection("approveRecoveryRequest", "handleAdminRecoveryRequests");
const completion = functionSection("handleRecoveryComplete", "expireApprovedRecoveryRequests");
const restore = functionSection("handleAdminRecoverySnapshotRestore", "handleMe");

check(!/\bstate\s*=|\bstate_bytes\b|\bstate_revision\b|\bstate_updated_at\b/.test(approval),
  "Password approval must not update StudyQuest state columns.");
check(!/\bstate\s*=|\bstate_bytes\b|\bstate_revision\b|\bstate_updated_at\b/.test(completion),
  "Password completion must not update StudyQuest state columns.");
check(!/\bpassword_record\b|\bpassword_change_required\b|\btemporary_password_expires_at\b/.test(restore),
  "Snapshot restoration must not update credential columns.");

for (const marker of [
  "password_recovery_requests",
  "password_change_required",
  "temporary_password_expires_at",
  "password_recovery_one_pending_idx",
]) {
  check(schema.includes(marker), `Recovery schema marker missing: ${marker}`);
}

for (const marker of [
  "Forgot password?", "/api/recovery/requests", "/api/recovery/complete", "PASSWORD_CHANGE_REQUIRED",
  "Unsynced work found", "readAuthenticatedAccountState", "openAccountStateRecovery",
  "Export Both", "stable-account-recovery",
]) {
  check(stableHtml.includes(marker), `Stable recovery UI marker missing: ${marker}`);
}

check(server.includes('new Set(["v13-smart-merge", "stable-account-recovery"])'),
  "Stable account recovery must create a pre-recovery server snapshot.");

for (const marker of ["Password Recovery Requests", "Manual User Reset", "Cloud Account Snapshots", "restoreAccountSnapshot"]) {
  check(v13Html.includes(marker), `Admin Recovery Center marker missing: ${marker}`);
}

check(v13Html.includes("const STORAGE_KEY = 'studyquest_v3';"), "The main StudyQuest storage key changed.");
check(v13Html.includes("const ACTIVE_STORAGE_KEY = AUTHENTICATED_STORAGE_USERNAME"),
  "Hosted v13 must use the authenticated account's browser key.");
check(!v13Html.includes("localStorage.getItem(STORAGE_KEY)"),
  "Hosted v13 must not load the unscoped legacy browser save.");
check(!v13Html.includes("localStorage.setItem(STORAGE_KEY"),
  "Hosted v13 must not write the unscoped legacy browser save.");
check(v13Html.includes("button.disabled = preview.smartMerge.size.overLimit;"),
  "Manual merge choices must explain what is missing instead of silently disabling approval.");
check(server.includes("authenticatedV13Html(user)"),
  "The v13 route must inject the authenticated account before browser storage loads.");
check(!v13Html.includes("localStorage.removeItem(STORAGE_KEY)"), "The main StudyQuest save must never be automatically deleted.");

const hash = crypto.createHash("sha256").update(fs.readFileSync(v13Path)).digest("hex");
check(version.hash === hash, "Published v13 hash metadata does not match the HTML file.");

console.log(`Recovery safety checks passed (${hash}).`);
