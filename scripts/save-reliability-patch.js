const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.join(__dirname, "..", "public", "claudever9.html");
let html = fs.readFileSync(htmlPath, "utf8");
const original = html;

if (html.includes("async function performLogout()") && !html.includes('typeof window.studyquestFlushSave === "function"')) {
  html = html.replace(
    `    async function performLogout() {
      const user = window.__STUDYQUEST_AUTH_USER__;
      if (AUTH_SERVER_AVAILABLE && !(user && user.legacy)) {`,
    `    async function performLogout() {
      const user = window.__STUDYQUEST_AUTH_USER__;
      if (AUTH_SERVER_AVAILABLE && !(user && user.legacy) && typeof window.studyquestFlushSave === "function") {
        await window.studyquestFlushSave().catch(() => {});
      }
      if (AUTH_SERVER_AVAILABLE && !(user && user.legacy)) {`
  );
}

if (!html.includes("window.studyquestFlushSave = flushStateToServerBeforeExit;")) {
  html = html.replace(
    "let serverSaveTimer = null;\nlet saveStatusClearTimer = null;",
    "let serverSaveTimer = null;\nlet saveStatusClearTimer = null;\nlet lastServerSaveStartedAt = 0;"
  );

  html = html.replace(
    "serverSaveTimer = setTimeout(saveStateToServer, 350);",
    "serverSaveTimer = setTimeout(() => saveStateToServer(), 350);"
  );

  html = html.replace(
    `async function saveStateToServer() {
  if (!canUseServerStorage()) {
    setSaveStatus('local', 'Local only');
    return;
  }
  try {
    const res = await fetch(SERVER_STATE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error('Server save failed');
    setSaveStatus('saved', 'Saved');
  } catch (e) {
    console.warn('StudyQuest server save failed', e);
    setSaveStatus('error', 'Save error');
  }
}
`,
    `async function saveStateToServer(options = {}) {
  const { keepalive = false, silent = false } = options;
  if (!canUseServerStorage()) {
    if (!silent) setSaveStatus('local', 'Local only');
    return false;
  }
  clearTimeout(serverSaveTimer);
  serverSaveTimer = null;
  lastServerSaveStartedAt = Date.now();
  try {
    const res = await fetch(SERVER_STATE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
      keepalive,
    });
    if (!res.ok) throw new Error('Server save failed');
    if (!silent) setSaveStatus('saved', 'Saved');
    return true;
  } catch (e) {
    console.warn('StudyQuest server save failed', e);
    if (!silent) setSaveStatus('error', 'Save error');
    return false;
  }
}

async function flushStateToServerBeforeExit() {
  if (!canUseServerStorage()) return false;
  return saveStateToServer({ silent: true });
}

function bestEffortSaveBeforePageExit() {
  if (!canUseServerStorage()) return;
  if (!state || Date.now() - lastServerSaveStartedAt < 300) return;
  try {
    const body = JSON.stringify(state);
    localStorage.setItem(currentStorageKey(), body);
    if (body.length < 60000 && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(SERVER_STATE_ENDPOINT, blob)) return;
    }
    if (body.length < 60000) {
      fetch(SERVER_STATE_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('StudyQuest final save failed', e);
  }
}

window.studyquestFlushSave = flushStateToServerBeforeExit;
window.addEventListener('pagehide', bestEffortSaveBeforePageExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') bestEffortSaveBeforePageExit();
});
`
  );
}

if (html !== original) {
  fs.writeFileSync(htmlPath, html);
  console.log("Applied StudyQuest save reliability patch.");
} else {
  console.log("StudyQuest save reliability patch already applied.");
}
