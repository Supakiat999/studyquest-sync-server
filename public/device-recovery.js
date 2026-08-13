(() => {
  "use strict";
  const DB_NAME = "studyquest_device_recovery_v1";
  const nodes = Object.fromEntries([
    "status", "browserSummary", "durableSummary", "outboxSummary", "legacySummary", "storageKey",
    "exportBundle", "exportRaw", "versionSelect", "previewVersion", "versionPreview", "recoverMissing",
  ].map((id) => [id, document.getElementById(id)]));
  let recoveryBundle = null;
  let versionsPayload = null;
  let activePreview = null;

  function summarize(value) {
    if (!value || typeof value !== "object") return "No readable copy found.";
    const weeks = Array.isArray(value.tracker?.weeks) ? value.tracker.weeks.length : 0;
    const semesters = Array.isArray(value.trackerSemesters) ? value.trackerSemesters.length : 0;
    const updated = Number(value.updatedAt || 0);
    return [
      `${Array.isArray(value.tasks) ? value.tasks.length : 0} tasks`,
      `${Array.isArray(value.notes) ? value.notes.length : 0} notes`,
      `${Array.isArray(value.fileLinks) ? value.fileLinks.length : 0} files`,
      `${Array.isArray(value.trips) ? value.trips.length : 0} trips`,
      `${weeks} Weekly weeks`, `${semesters} semesters`,
      updated ? `edited ${new Date(updated).toLocaleString()}` : "no edit timestamp",
    ].join(" · ");
  }

  function summaryObject(value) {
    const source = value || {};
    return `${Number(source.tasks || 0)} tasks · ${Number(source.notes || 0)} notes · ${Number(source.files || 0)} files · ${Number(source.trips || 0)} trips · ${Number(source.weeklyWeeks || 0)} Weekly weeks · ${Number(source.weeklySemesters || 0)} semesters`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
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
      request.onerror = () => databaseWasMissing && request.error?.name === "AbortError"
        ? resolve(null) : reject(request.error || new Error("IndexedDB could not be opened."));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
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

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials:"same-origin",
      cache:"no-store",
      headers:{ "Content-Type":"application/json", ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || "Recovery request failed.");
    return payload;
  }

  function renderVersionOptions() {
    const versions = versionsPayload?.versions || [];
    nodes.versionSelect.innerHTML = versions.map((version) => {
      const date = new Date(version.createdAt).toLocaleString([], { dateStyle:"medium", timeStyle:"short" });
      return `<option value="${escapeHtml(version.id)}">${escapeHtml(date)} · ${escapeHtml(summaryObject(version.summary))} · ${escapeHtml(version.sourceDevice || "saved version")}</option>`;
    }).join("") || "<option>No earlier saved versions found</option>";
    nodes.versionSelect.disabled = !versions.length;
    nodes.previewVersion.disabled = !versions.length;
  }

  function listItems(items, emptyText) {
    if (!items?.length) return `<p class="good">${escapeHtml(emptyText)}</p>`;
    return `<ul>${items.slice(0, 30).map((item) => `<li>${escapeHtml(item.label || item.key)}</li>`).join("")}</ul>${items.length > 30 ? `<p class="muted">And ${items.length - 30} more.</p>` : ""}`;
  }

  function renderPreview(preview) {
    const comparison = preview.comparison || {};
    const recoverable = comparison.recoverableMissing || [];
    nodes.versionPreview.hidden = false;
    nodes.versionPreview.innerHTML = `
      <strong>${recoverable.length ? `${recoverable.length} missing item${recoverable.length === 1 ? "" : "s"} can be recovered` : "Nothing is missing from this version"}</strong>
      <p class="muted">Current: ${escapeHtml(summaryObject(preview.current?.summary))}<br>After recovery: ${escapeHtml(summaryObject(preview.proposedSummary))}</p>
      <h3>Items that will be added</h3>${listItems(recoverable, "This earlier version has no records that are missing now.")}
      <details><summary>More details</summary>
        <p class="muted">Earlier revision ${Number(preview.source?.revision || 0)} · ${escapeHtml(preview.source?.stateHash || "No hash")}<br>
        Current revision ${Number(preview.current?.revision || 0)} · ${escapeHtml(preview.current?.stateHash || "No hash")}</p>
        <h3>Current-only items kept unchanged</h3>${listItems(comparison.currentOnly, "No current-only records.")}
        <h3>Same items with different values</h3>${listItems(comparison.changed, "No changed records.")}
      </details>`;
    nodes.recoverMissing.disabled = preview.unchanged || !recoverable.length;
  }

  async function previewSelectedVersion() {
    const id = nodes.versionSelect.value;
    if (!id) return;
    nodes.previewVersion.disabled = true;
    nodes.status.textContent = "Building a safe preview. Nothing is changing...";
    try {
      activePreview = await api(`/api/recovery/versions/${encodeURIComponent(id)}/preview`, { method:"POST", body:"{}" });
      renderPreview(activePreview);
      nodes.status.textContent = "Preview ready. Nothing changes until you approve recovery.";
    } catch (error) {
      nodes.status.textContent = String(error.message || error);
    } finally {
      nodes.previewVersion.disabled = false;
    }
  }

  async function recoverMissing() {
    if (!activePreview?.previewToken || !activePreview.source?.id) return;
    const count = Number(activePreview.comparison?.counts?.recoverableMissing || 0);
    if (!window.confirm(`Recover ${count} missing item${count === 1 ? "" : "s"}? Current records and settings will stay unchanged.`)) return;
    nodes.recoverMissing.disabled = true;
    nodes.status.textContent = "Creating a safety backup and recovering missing items...";
    try {
      const result = await api(`/api/recovery/versions/${encodeURIComponent(activePreview.source.id)}/recover-missing`, {
        method:"POST",
        body:JSON.stringify({ previewToken:activePreview.previewToken }),
      });
      nodes.status.textContent = result.unchanged
        ? "Nothing was missing. No data changed."
        : `Recovered ${result.additions?.length || count} missing items. Saved online is now revision ${result.revision}.`;
      activePreview = null;
      nodes.versionPreview.hidden = true;
      versionsPayload = await api("/api/recovery/versions");
      renderVersionOptions();
    } catch (error) {
      nodes.status.textContent = `Recovery stopped safely: ${String(error.message || error)}`;
      nodes.recoverMissing.disabled = false;
    }
  }

  async function initialize() {
    const response = await fetch("/api/me", { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) return window.location.replace("/app.html?next=data-recovery&stable=1");
    const payload = await response.json();
    const username = String(payload.user?.username || "").trim().toLowerCase();
    if (!username) throw new Error("Signed-in account could not be identified.");
    const storageKey = `studyquest_v3_${username}`;
    nodes.storageKey.textContent = storageKey;
    const browserRaw = localStorage.getItem(storageKey);
    const legacyRaw = username === "admin" ? localStorage.getItem("studyquest_v3") : null;
    let browserState = null;
    let legacyState = null;
    let browserError = null;
    let legacyError = null;
    try { browserState = browserRaw ? JSON.parse(browserRaw) : null; } catch (error) { browserError = String(error.message || error); }
    try { legacyState = legacyRaw ? JSON.parse(legacyRaw) : null; } catch (error) { legacyError = String(error.message || error); }
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
    } catch (error) { durableError = String(error.message || error); }

    nodes.browserSummary.textContent = browserError ? `JSON is damaged: ${browserError}` : summarize(browserState);
    nodes.durableSummary.textContent = durableError ? `Could not read device recovery: ${durableError}` : summarize(durable?.state);
    nodes.outboxSummary.textContent = durableError ? `Could not read pending upload: ${durableError}` : summarize(outbox?.state);
    nodes.legacySummary.textContent = username !== "admin"
      ? "Hidden for account safety because this old unscoped key has no verified owner."
      : legacyError ? `JSON is damaged: ${legacyError}` : summarize(legacyState);
    recoveryBundle = {
      format:"studyquest-device-recovery-v2", exportedAt:new Date().toISOString(), username, storageKey,
      browser:{ raw:browserRaw, state:browserState, parseError:browserError },
      legacy:{ raw:legacyRaw, state:legacyState, parseError:legacyError },
      indexedDb:{ accountState:durable, outbox, readError:durableError },
    };
    nodes.exportBundle.disabled = false;
    nodes.exportRaw.disabled = !browserRaw;
    nodes.exportBundle.onclick = () => download(`studyquest-${username}-device-recovery-${new Date().toISOString().slice(0,10)}.json`, recoveryBundle);
    nodes.exportRaw.onclick = () => download(`studyquest-${username}-browser-copy-${new Date().toISOString().slice(0,10)}.json`, browserRaw);
    nodes.previewVersion.onclick = previewSelectedVersion;
    nodes.recoverMissing.onclick = recoverMissing;
    nodes.versionSelect.onchange = () => { activePreview = null; nodes.versionPreview.hidden = true; nodes.recoverMissing.disabled = true; };

    versionsPayload = await api("/api/recovery/versions");
    renderVersionOptions();
    nodes.status.textContent = `Recovery copies ready for ${username}.`;
  }

  initialize().catch((error) => {
    nodes.status.textContent = `Recovery check failed safely: ${String(error.message || error)}`;
    nodes.browserSummary.textContent = "No data was changed.";
    nodes.durableSummary.textContent = "No data was changed.";
  });
})();
