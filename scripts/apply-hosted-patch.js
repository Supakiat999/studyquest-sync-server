const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.join(__dirname, "..", "public", "claudever9.html");
let html = fs.readFileSync(htmlPath, "utf8");
const original = html;

const logoutFunction = `    async function performLogout() {
      const user = window.__STUDYQUEST_AUTH_USER__;
      if (AUTH_SERVER_AVAILABLE && !(user && user.legacy) && typeof window.studyquestFlushSave === "function") {
        await window.studyquestFlushSave().catch(() => {});
      }
      if (AUTH_SERVER_AVAILABLE && !(user && user.legacy)) {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
      }
      try { sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch (error) {}
      window.location.reload();
    }

    window.studyquestLogout = performLogout;

`;

if (!html.includes("window.studyquestLogout = performLogout;")) {
  html = html.replace("    function renderAccountBadge(user) {", logoutFunction + "    function renderAccountBadge(user) {");
  html = html.replace(
    /      badge\.querySelector\("button"\)\.addEventListener\("click", async \(\) => \{\s+if \(AUTH_SERVER_AVAILABLE && !user\.legacy\) \{\s+await fetch\("\/api\/logout", \{ method: "POST", credentials: "same-origin" \}\)\.catch\(\(\) => \{\}\);\s+\}\s+try \{ sessionStorage\.removeItem\(LEGACY_SESSION_KEY\); \} catch \(error\) \{\}\s+window\.location\.reload\(\);\s+\}\);/,
    '      badge.querySelector("button").addEventListener("click", performLogout);'
  );
}

if (html.includes("async function performLogout()") && !html.includes("typeof window.studyquestFlushSave === \"function\"")) {
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

if (!html.includes(".logout-header-btn")) {
  html = html.replace(
    "  .settings-row { display:flex; gap:10px; align-items:center; }",
    `  .logout-header-btn {
    padding-inline: 12px;
    color: var(--red);
  }
  .logout-header-btn:hover {
    border-color: var(--red);
    color: var(--red);
  }
  .settings-row { display:flex; gap:10px; align-items:center; }`
  );
}

if (!html.includes('onclick="studyquestLogout()"')) {
  html = html.replace(
    '      <button class="btn btn-primary" onclick="openCreateTask()">+ New Task</button>\n      <button class="profile-btn"',
    '      <button class="btn btn-primary" onclick="openCreateTask()">+ New Task</button>\n      <button class="btn btn-ghost logout-header-btn" onclick="studyquestLogout()" title="Sign out of this StudyQuest account">Logout</button>\n      <button class="profile-btn"'
  );
}

const industrialPharmacyCurriculum = `const INDUSTRIAL_PHARMACY_CURRICULUM = [
  { sem:'Y1-S1', label:'Year 1 · Sem I', subjects:[
    {code:'2301103',name:'CALCULUS I',credits:3},
    {code:'2302161',name:'GEN CHEM',credits:3},
    {code:'2603282',name:'STAT BIO SCIENCE',credits:3},
    {code:'3300112',name:'IDG I',credits:2},
    {code:'5500111',name:'EXP ENG I',credits:3},
    {code:'3300199',name:'PIL I',credits:1},
    {code:'xxxxxxx',name:'GEN ED / FREE ELECTIVE',credits:6},
  ]},
  { sem:'Y1-S2', label:'Year 1 · Sem II', subjects:[
    {code:'2302236',name:'PHYSICAL CHEMISTRY',credits:2},
    {code:'2302263',name:'ORG CHEM I',credits:3},
    {code:'2302162',name:'CHEM LAB PHARM SCI',credits:1},
    {code:'2304116',name:'PHYS PHARM SCI',credits:2},
    {code:'3315101',name:'PHARMACOG I',credits:2},
    {code:'5500112',name:'EXP ENG II',credits:3},
    {code:'3300199',name:'PIL I',credits:1},
    {code:'xxxxxxx',name:'GEN ED / FREE ELECTIVE',credits:6},
  ]},
  { sem:'Y2-S1', label:'Year 2 · Sem I', subjects:[
    {code:'2302264',name:'ORG CHEM II',credits:3},
    {code:'3300230',name:'CELL BIO BIOCHEM',credits:4},
    {code:'3300231',name:'PHYSIO CLIN BIO I',credits:3},
    {code:'3300233',name:'PHYSIO BIO LAB I',credits:1},
    {code:'3300232',name:'PHYSIO CLIN BIO II',credits:3},
    {code:'3300234',name:'PHYSIO BIO LAB II',credits:1},
    {code:'3300113',name:'MICROBIO PHARM',credits:1.5},
    {code:'3300235',name:'IMMUNO PHARM',credits:2},
    {code:'3300299',name:'PIL II',credits:1},
  ]},
  { sem:'Y2-S2', label:'Year 2 · Sem II', subjects:[
    {code:'3300237',name:'DDD ACTION TOX',credits:5},
    {code:'3300236',name:'PHARM NUTR',credits:1.5},
    {code:'3300331',name:'IDT I',credits:1.5},
    {code:'3300332',name:'IDT II',credits:5},
    {code:'3300242',name:'IDQ III',credits:2},
    {code:'3300244',name:'IDG II',credits:2},
    {code:'3300299',name:'PIL II',credits:1},
    {code:'0295107',name:'GEN ED: Patient Safety',credits:3},
  ]},
  { sem:'Y3-S1', label:'Year 3 · Sem I', subjects:[
    {code:'3300334',name:'IDT IV',credits:4},
    {code:'3300243',name:'IDQ IV',credits:4},
    {code:'3300238',name:'IDQ I',credits:2.5},
    {code:'3300240',name:'IDQ LAB I',credits:1},
    {code:'3300336',name:'IDG III',credits:2},
    {code:'3300398',name:'PIL III',credits:1},
    {code:'xxxxxxx',name:'GEN ED',credits:3},
  ]},
  { sem:'Y3-S2', label:'Year 3 · Sem II', subjects:[
    {code:'3300333',name:'IDT III',credits:5},
    {code:'3300335',name:'IDT V',credits:4},
    {code:'3300340',name:'IDG IV',credits:2},
    {code:'3300239',name:'IDQ II',credits:2.5},
    {code:'3300241',name:'IDQ LAB II',credits:1},
    {code:'3300338',name:'IDQ V',credits:4},
    {code:'3300398',name:'PIL III',credits:1},
  ]},
  { sem:'Y4-S1', label:'Year 4 · Sem I', subjects:[
    {code:'3300433',name:'IDT VI',credits:5},
    {code:'3300434',name:'IDT VII',credits:2.5},
    {code:'3300431',name:'IDQ VI',credits:3},
    {code:'3300435',name:'IDG V',credits:2},
    {code:'3300399',name:'PIL IV',credits:3},
    {code:'5500309',name:'PROF ENG PHARM I',credits:3},
    {code:'xxxxxxx',name:'GEN ED',credits:3},
  ]},
  { sem:'Y4-S2', label:'Year 4 · Sem II', subjects:[
    {code:'3300432',name:'IDQ VII',credits:2},
    {code:'3300436',name:'IDG VI',credits:2},
    {code:'3311501',name:'PRIN IND PHAR PROC',credits:3},
    {code:'3311502',name:'PRIN IND PHAR ENG',credits:2},
    {code:'3315501',name:'PHARMACOG II',credits:2},
    {code:'5500310',name:'PROF ENG PHARM II',credits:3},
    {code:'xxxxxxx',name:'GEN ED',credits:3},
  ]},
  { sem:'Y5-S1', label:'Year 5 · Sem I', subjects:[
    {code:'3300498',name:'PIL V',credits:3},
    {code:'3300499',name:'PIL VI',credits:3},
    {code:'3300503',name:'SENIOR RES PROJ',credits:2},
    {code:'3311401',name:'INT GMP',credits:2},
    {code:'3311503',name:'TECH REQ REG PHARM',credits:1},
    {code:'3314501',name:'DRUG QC I',credits:2},
    {code:'33xxxxx',name:'Professional elective',credits:6},
  ]},
  { sem:'Y5-S2', label:'Year 5 · Sem II', subjects:[
    {code:'3300503',name:'SENIOR PROJ',credits:2},
    {code:'3300xxx',name:'Professional electives',credits:14},
  ]},
  { sem:'Y6-S1', label:'Year 6 · Sem I', subjects:[
    {code:'3301602',name:'PPRAC IND I',credits:4},
    {code:'3301603',name:'PPRAC IND II',credits:4},
    {code:'3301604',name:'PPRAC RC DEV PPROD',credits:4},
    {code:'33016xx',name:'Elective professional practice',credits:4},
  ]},
  { sem:'Y6-S2', label:'Year 6 · Sem II', subjects:[
    {code:'3300xxx',name:'Elective professional practice',credits:12},
  ]},
];
`;

if (!html.includes("INDUSTRIAL_PHARMACY_CURRICULUM")) {
  html = html.replace("const BUILTIN_CURRICULA = {", industrialPharmacyCurriculum + "const BUILTIN_CURRICULA = {");
  html = html.replace(
    "  balac: { id:'balac', name:'BALAC', semesters: BALAC_CURRICULUM },",
    "  balac: { id:'balac', name:'BALAC', semesters: BALAC_CURRICULUM },\n  industrial_pharmacy: { id:'industrial_pharmacy', name:'Industrial Pharmacy', semesters: INDUSTRIAL_PHARMACY_CURRICULUM },"
  );
}

if (html !== original) {
  fs.writeFileSync(htmlPath, html);
  console.log("Applied hosted StudyQuest HTML patch.");
} else {
  console.log("Hosted StudyQuest HTML patch already applied.");
}
