const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const mainHtmlPath = path.join(publicDir, "claudever9.html");
const v13HtmlPath = path.join(publicDir, "claudever13.html");

function writeIfChanged(filePath, next) {
  const current = fs.readFileSync(filePath, "utf8");
  if (current === next) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function patchMainBeta(html) {
  let next = html;

  const quickCaptureButton = '      <button class="btn btn-ghost" onclick="openQuickCapture()" title="Quick add task (Q)">Quick Capture</button>';
  const betaButton = '      <button class="btn btn-ghost" onclick="openV13BetaModal()" title="Try the v13 beta with a backup prompt">v13 Beta</button>';
  if (!next.includes('onclick="openV13BetaModal()"')) {
    if (!next.includes(quickCaptureButton)) {
      throw new Error("Could not find the StudyQuest header actions to add the v13 beta button.");
    }
    next = next.replace(quickCaptureButton, `${quickCaptureButton}\n${betaButton}`);
  }

  if (!next.includes('id="v13BetaModal"')) {
    const modal = `
<!-- V13 BETA MODAL -->
<div class="modal-overlay" id="v13BetaModal">
  <div class="modal" style="max-width:460px;">
    <div class="modal-title">Try StudyQuest v13 Beta?</div>
    <div style="font-size:13px;line-height:1.6;color:var(--text-dim);white-space:pre-wrap;">v13 uses the same StudyQuest account data as this beta app. Export a backup before testing so your current work has a clean restore point.</div>
    <div class="modal-btns" style="flex-wrap:wrap;">
      <button class="btn btn-ghost" type="button" onclick="closeV13BetaModal()">Cancel</button>
      <button class="btn btn-ghost" type="button" onclick="exportV13BetaBackup()">Export Backup</button>
      <button class="btn btn-primary" type="button" id="v13BetaOpenBtn" onclick="openV13Beta()">Open v13</button>
    </div>
  </div>
</div>
`;
    const marker = "<!-- APP CONFIRM MODAL -->";
    if (!next.includes(marker)) {
      throw new Error("Could not find the app confirm modal marker for the v13 beta modal.");
    }
    next = next.replace(marker, `${modal}\n${marker}`);
  }

  if (!next.includes("function openV13BetaModal()")) {
    const helpers = `
function openV13BetaModal() {
  openModal('v13BetaModal');
}

function closeV13BetaModal() {
  closeModal('v13BetaModal');
}

function exportV13BetaBackup() {
  exportData();
  showToast('Backup downloaded. Open v13 when you are ready.', '#6af7b0');
}

async function openV13Beta() {
  const btn = document.getElementById('v13BetaOpenBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening...';
  }
  try {
    if (typeof window.studyquestFlushSave === 'function') {
      await window.studyquestFlushSave().catch(() => {});
    } else if (typeof saveStateToServer === 'function') {
      await saveStateToServer().catch(() => {});
    }
  } finally {
    window.location.href = '/v13';
  }
}

`;
    const marker = "// STATE";
    if (!next.includes(marker)) {
      throw new Error("Could not find the state section marker for v13 beta helpers.");
    }
    next = next.replace(marker, `${helpers}${marker}`);
  }

  return next;
}

function patchV13(html) {
  let next = html;

  if (!next.includes("function isHostedSharedDataRoute()")) {
    const target = `function canUseServerStorage() {
  return window.location.protocol === 'http:' || window.location.protocol === 'https:';
}
`;
    const replacement = `${target}
function isHostedSharedDataRoute() {
  return window.location.protocol === 'https:' && window.location.hostname.endsWith('.onrender.com');
}

function handleHostedAuthExpired() {
  setSaveStatus('error', 'Login needed');
  showToast('Please log in on the main beta first, then reopen v13.', '#f76a6a');
  if (isHostedSharedDataRoute()) {
    setTimeout(() => {
      window.location.href = '/app.html';
    }, 1400);
  }
}
`;
    if (!next.includes(target)) {
      throw new Error("Could not find v13 canUseServerStorage() for hosted safeguards.");
    }
    next = next.replace(target, replacement);
  }

  if (!next.includes("credentials: 'same-origin',\n      headers: { 'Content-Type': 'application/json' }")) {
    next = next.replace(
      "const res = await fetch(SERVER_STATE_ENDPOINT, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },",
      "const res = await fetch(SERVER_STATE_ENDPOINT, {\n      method: 'POST',\n      credentials: 'same-origin',\n      headers: { 'Content-Type': 'application/json' },"
    );
  }

  if (!next.includes("const res = await fetch(SERVER_STATE_ENDPOINT, { credentials: 'same-origin' });")) {
    next = next.replace(
      "const res = await fetch(SERVER_STATE_ENDPOINT);",
      "const res = await fetch(SERVER_STATE_ENDPOINT, { credentials: 'same-origin' });"
    );
  }

  if (!next.includes("if (res.status === 401) {\n      handleHostedAuthExpired();\n      return;\n    }\n    if (!res.ok) throw new Error('Server save failed');")) {
    next = next.replace(
      "if (!res.ok) throw new Error('Server save failed');",
      "if (res.status === 401) {\n      handleHostedAuthExpired();\n      return;\n    }\n    if (!res.ok) throw new Error('Server save failed');"
    );
  }

  if (!next.includes("if (res.status === 401) {\n      handleHostedAuthExpired();\n      return;\n    }\n    if (!res.ok) throw new Error('Server state request failed');")) {
    next = next.replace(
      "if (!res.ok) throw new Error('Server state request failed');",
      "if (res.status === 401) {\n      handleHostedAuthExpired();\n      return;\n    }\n    if (!res.ok) throw new Error('Server state request failed');"
    );
  }

  next = next.replace(
    "showToast('Saved StudyQuest data loaded from 127.0.0.1.', '#6af7b0');",
    "showToast('Saved StudyQuest data loaded from the live server.', '#6af7b0');"
  );

  if (!next.includes("if (localHasData && !serverHasData && !isHostedSharedDataRoute()) saveStateToServer();")) {
    next = next.replace(
      "if (localHasData && !serverHasData) saveStateToServer();",
      "if (localHasData && !serverHasData && !isHostedSharedDataRoute()) saveStateToServer();"
    );
  }

  if (!next.includes("const hasObjectEntries = value => value && typeof value === 'object' && Object.keys(value).length > 0;")) {
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
    next = next.replace(
      /function hasUserData\(s\) \{\s+return !!\(s && \(\s+\(Array\.isArray\(s\.tasks\) && s\.tasks\.length\) \|\|\s+\(Array\.isArray\(s\.notebooks\) && s\.notebooks\.length\) \|\|\s+\(Array\.isArray\(s\.notes\) && s\.notes\.length\) \|\|\s+\(Array\.isArray\(s\.fileLinks\) && s\.fileLinks\.length\) \|\|\s+\(Array\.isArray\(s\.checklistItems\) && s\.checklistItems\.length\) \|\|\s+\(Array\.isArray\(s\.trips\) && s\.trips\.length\) \|\|\s+\(Array\.isArray\(s\.sessions\) && s\.sessions\.length\)\s+\)\);\s+\}/,
      gradeAwareHasUserData
    );
  }

  return next;
}

const changedMain = writeIfChanged(mainHtmlPath, patchMainBeta(fs.readFileSync(mainHtmlPath, "utf8")));
const changedV13 = writeIfChanged(v13HtmlPath, patchV13(fs.readFileSync(v13HtmlPath, "utf8")));

if (changedMain || changedV13) {
  console.log("Applied StudyQuest v13 beta patch.");
} else {
  console.log("StudyQuest v13 beta patch already applied.");
}
