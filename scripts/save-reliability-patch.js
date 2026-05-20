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

const gradeAwareHasUserData = `function hasUserData(s) {
  const hasObjectEntries = value => value && typeof value === 'object' && Object.keys(value).length > 0;
  const hasCustomSubjects = value => value && typeof value === 'object' && Object.values(value).some(list => Array.isArray(list) && list.length);
  return !!(s && (
    (Array.isArray(s.tasks) && s.tasks.length) ||
    (Array.isArray(s.notebooks) && s.notebooks.length) ||
    (Array.isArray(s.notes) && s.notes.length) ||
    (Array.isArray(s.fileLinks) && s.fileLinks.length) ||
    (Array.isArray(s.checklistItems) && s.checklistItems.length) ||
    (Array.isArray(s.trips) && s.trips.length) ||
    (Array.isArray(s.sessions) && s.sessions.length) ||
    hasObjectEntries(s.grades) ||
    hasObjectEntries(s.cutoffs) ||
    hasObjectEntries(s.electiveNames) ||
    hasCustomSubjects(s.customSubjects) ||
    (Array.isArray(s.customCurricula) && s.customCurricula.length) ||
    (Array.isArray(s.archivedCurriculumIds) && s.archivedCurriculumIds.length) ||
    hasObjectEntries(s.activeSemesterByCurriculum) ||
    (s.tracker && Array.isArray(s.tracker.weeks) && s.tracker.weeks.length) ||
    hasObjectEntries(s.studyTime) ||
    hasObjectEntries(s.xpByDay) ||
    hasObjectEntries(s.completedByDay) ||
    Number(s.totalXP || 0) > 0 ||
    Number(s.totalDone || 0) > 0 ||
    Number(s.pomodorosDone || 0) > 0 ||
    Number(s.streak || 0) > 0
  ));
}
`;

if (!html.includes("const hasObjectEntries = value => value && typeof value === 'object' && Object.keys(value).length > 0;")) {
  html = html.replace(
    /function hasUserData\(s\) \{\s+return !!\(s && \(\s+\(Array\.isArray\(s\.tasks\) && s\.tasks\.length\) \|\|\s+\(Array\.isArray\(s\.notebooks\) && s\.notebooks\.length\) \|\|\s+\(Array\.isArray\(s\.notes\) && s\.notes\.length\) \|\|\s+\(Array\.isArray\(s\.fileLinks\) && s\.fileLinks\.length\) \|\|\s+\(Array\.isArray\(s\.checklistItems\) && s\.checklistItems\.length\) \|\|\s+\(Array\.isArray\(s\.trips\) && s\.trips\.length\) \|\|\s+\(Array\.isArray\(s\.sessions\) && s\.sessions\.length\)\s+\)\);\s+\}/,
    gradeAwareHasUserData
  );
}

if (!html.includes("Spotify login was cancelled or failed:")) {
  html = html.replace(
    `async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");`,
    `async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const spotifyError = params.get("error");
  if (spotifyError) {
    window.history.replaceState({}, document.title, SPOTIFY_REDIRECT_URI);
    spotifyToast("Spotify login was cancelled or failed: " + spotifyError, "#f76a6a");
    return;
  }
  const code = params.get("code");`
  );
}

if (html !== original) {
  fs.writeFileSync(htmlPath, html);
  console.log("Applied StudyQuest save reliability patch.");
} else {
  console.log("StudyQuest save reliability patch already applied.");
}
