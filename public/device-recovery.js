(() => {
  "use strict";
  const DB_NAME = "studyquest_device_recovery_v1";
  const status = document.getElementById("status");
  const browserSummary = document.getElementById("browserSummary");
  const durableSummary = document.getElementById("durableSummary");
  const storageKeyNode = document.getElementById("storageKey");
  const exportBundleButton = document.getElementById("exportBundle");
  const exportRawButton = document.getElementById("exportRaw");
  let recoveryBundle = null;

  function summarize(value) {
    if (!value || typeof value !== "object") return "No readable copy found.";
    const weeks = Array.isArray(value.tracker?.weeks) ? value.tracker.weeks.length : 0;
    const semesters = Array.isArray(value.trackerSemesters) ? value.trackerSemesters.length : 0;
    const updated = Number(value.updatedAt || 0);
    return [
      `${Array.isArray(value.tasks) ? value.tasks.length : 0} tasks`,
      `${Array.isArray(value.notes) ? value.notes.length : 0} notes`,
      `${Array.isArray(value.fileLinks) ? value.fileLinks.length : 0} files`,
      `${weeks} Weekly weeks`,
      `${semesters} semesters`,
      updated ? `edited ${new Date(updated).toLocaleString()}` : "no edit timestamp",
    ].join(" · ");
  }

  function download(filename, value) {
    const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openRecoveryDatabase() {
    return new Promise((resolve, reject) => {
      let databaseWasMissing = false;
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => {
        if (databaseWasMissing && request.error?.name === "AbortError") resolve(null);
        else reject(request.error || new Error("IndexedDB could not be opened."));
      };
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        // This page is read-only. Abort creation when the recovery database does not exist.
        databaseWasMissing = true;
        request.transaction.onabort = () => resolve(null);
        request.transaction.abort();
      };
    });
  }

  function readStore(db, storeName, key) {
    if (!db.objectStoreNames.contains(storeName)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async function initialize() {
    const response = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      window.location.replace("/app.html?next=device-recovery&stable=1");
      return;
    }
    const payload = await response.json();
    const username = String(payload.user?.username || "").trim().toLowerCase();
    if (!username) throw new Error("Signed-in account could not be identified.");
    const storageKey = `studyquest_v3_${username}`;
    storageKeyNode.textContent = storageKey;
    const browserRaw = localStorage.getItem(storageKey);
    let browserState = null;
    let browserError = null;
    try { browserState = browserRaw ? JSON.parse(browserRaw) : null; } catch (error) { browserError = String(error.message || error); }

    let durable = null;
    let outbox = null;
    let durableError = null;
    try {
      const db = await openRecoveryDatabase();
      if (db) {
        durable = await readStore(db, "accountStates", username);
        outbox = await readStore(db, "outbox", username);
        db.close();
      }
    } catch (error) {
      durableError = String(error.message || error);
    }

    browserSummary.textContent = browserError ? `Raw copy exists but JSON is damaged: ${browserError}` : summarize(browserState);
    durableSummary.textContent = durableError ? `Could not read IndexedDB: ${durableError}` : summarize(durable?.state);
    recoveryBundle = {
      format: "studyquest-device-recovery-v1",
      exportedAt: new Date().toISOString(),
      username,
      storageKey,
      browser: { raw: browserRaw, state: browserState, parseError: browserError },
      indexedDb: { accountState: durable, outbox, readError: durableError },
    };
    exportBundleButton.disabled = false;
    exportRawButton.disabled = !browserRaw;
    exportBundleButton.onclick = () => download(`studyquest-${username}-device-recovery-${new Date().toISOString().slice(0, 10)}.json`, recoveryBundle);
    exportRawButton.onclick = () => download(`studyquest-${username}-browser-copy-${new Date().toISOString().slice(0, 10)}.json`, browserRaw);
    status.textContent = browserRaw || durable ? `Device copies found for ${username}.` : `No saved device copy was found for ${username}.`;
  }

  initialize().catch((error) => {
    status.textContent = `Recovery check failed: ${String(error.message || error)}`;
    browserSummary.textContent = "No data was changed.";
    durableSummary.textContent = "No data was changed.";
  });
})();
