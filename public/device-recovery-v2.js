(() => {
  "use strict";

  const core = window.StudyQuestRecoveryV2;
  const nodes = Object.fromEntries([
    "status", "cloudSummary", "computerSummary", "copyRecommendation", "copyDifferences", "cloudCard", "cloudTag", "cloudHeading", "loadAccountBackup",
    "browserSummary", "durableSummary", "outboxSummary", "legacySummary", "storageKey",
    "exportBundle", "exportRaw", "versionSelect", "previewVersion", "versionPreview",
    "recoverMissing", "recoverDisabledReason",
  ].map((id) => [id, document.getElementById(id)]));
  let username = "";
  let cloudEnvelope = null;
  let deviceBundle = null;
  let versionsPayload = null;
  let activePreview = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    }[character]));
  }

  function summaryWithTime(value) {
    if (!value || typeof value !== "object") return "No readable copy found.";
    const time = Number(value.updatedAt || 0);
    return `${core.summaryText(value)}${time ? ` · last edited ${new Date(time).toLocaleString()}` : " · no reliable edit time"}`;
  }

  function summaryObject(value) {
    const source = value || {};
    return `${Number(source.tasks || 0)} tasks · ${Number(source.notes || 0)} notes · ${Number(source.files || 0)} files · ${Number(source.trips || 0)} trips · ${Number(source.weeklyWeeks || 0)} Weekly weeks · ${Number(source.weeklySemesters || 0)} semesters`;
  }

  function download(filename, value) {
    const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  function listItems(items, emptyText) {
    if (!items?.length) return `<p class="good">${escapeHtml(emptyText)}</p>`;
    return `<ul>${items.slice(0, 30).map((item) => `<li>${escapeHtml(item.label || item.key)}</li>`).join("")}</ul>${items.length > 30 ? `<p class="muted">And ${items.length - 30} more.</p>` : ""}`;
  }

  function selectedDeviceState() {
    return deviceBundle?.outbox?.state || deviceBundle?.durable?.state || deviceBundle?.browserState || null;
  }

  function renderCopyComparison() {
    const device = selectedDeviceState();
    nodes.cloudSummary.textContent = cloudEnvelope?.state ? summaryWithTime(cloudEnvelope.state) : "No readable Account backup found.";
    nodes.computerSummary.textContent = summaryWithTime(device);
    if (!cloudEnvelope?.state) {
      nodes.copyRecommendation.textContent = "The Account backup cannot be verified right now. Nothing can be loaded until it is available.";
      nodes.loadAccountBackup.disabled = true;
      return;
    }
    const comparison = core.compareStates(cloudEnvelope.state, device || {});
    const removed = comparison.removed.length;
    const deviceOnly = comparison.deviceOnly.length;
    nodes.cloudCard.classList.toggle("recommended", removed > 0);
    nodes.cloudTag.hidden = removed <= 0;
    nodes.cloudHeading.textContent = removed > 0 ? "Account backup — recommended" : "Account backup";
    nodes.copyRecommendation.textContent = removed
      ? `Recommended: load the Account backup because replacing it with this computer's copy would remove ${removed} saved record${removed === 1 ? "" : "s"}. ${deviceOnly ? `${deviceOnly} device-only record${deviceOnly === 1 ? " remains" : "s remain"} recoverable in the archive.` : ""}`.trim()
      : deviceOnly
        ? `This computer has ${deviceOnly} record${deviceOnly === 1 ? "" : "s"} not in the Account backup. Loading online information will archive those records first.`
        : comparison.changed.length
          ? `${comparison.changed.length} shared record${comparison.changed.length === 1 ? " has" : "s have"} different values. No copy is recommended from time alone; download the copies before choosing.`
          : "The record lists and values match. Loading the Account backup simply refreshes this computer.";
    nodes.copyDifferences.innerHTML = `
      <p class="muted">Identified records: ${comparison.accountRecordCount} in the Account backup; ${comparison.deviceRecordCount} on this computer.</p>
      <h3>In the Account backup but missing from this computer (${removed})</h3>
      ${listItems(comparison.removed, "None.")}
      <h3>Only on this computer (${deviceOnly})</h3>
      ${listItems(comparison.deviceOnly, "None.")}
      <h3>Same record with different values (${comparison.changed.length})</h3>
      ${listItems(comparison.changed, "None.")}`;
    nodes.loadAccountBackup.disabled = false;
  }

  function renderVersionOptions() {
    const versions = versionsPayload?.versions || [];
    nodes.versionSelect.innerHTML = versions.map((version) => {
      const date = new Date(version.createdAt).toLocaleString([], { dateStyle:"medium", timeStyle:"short" });
      return `<option value="${escapeHtml(version.id)}">${escapeHtml(date)} · ${escapeHtml(summaryObject(version.summary))} · ${escapeHtml(version.sourceDevice || "saved version")}</option>`;
    }).join("") || "<option>No earlier account backups found</option>";
    nodes.versionSelect.disabled = !versions.length;
    nodes.previewVersion.disabled = !versions.length;
  }

  function renderPreview(preview) {
    const comparison = preview.comparison || {};
    const recoverable = comparison.recoverableMissing || [];
    nodes.versionPreview.hidden = false;
    nodes.versionPreview.innerHTML = `
      <strong>${recoverable.length ? `${recoverable.length} missing record${recoverable.length === 1 ? "" : "s"} can be added safely` : "No records are missing from the current Account backup"}</strong>
      <p class="muted">Current Account backup: ${escapeHtml(summaryObject(preview.current?.summary))}<br>After recovery: ${escapeHtml(summaryObject(preview.proposedSummary))}</p>
      <h3>Records that would be added</h3>${listItems(recoverable, "This earlier backup contains no records absent from the current Account backup.")}
      <details><summary>Comparison details</summary>
        <p class="muted">Earlier revision ${Number(preview.source?.revision || 0)} · ${escapeHtml(preview.source?.stateHash || "No hash")}<br>
        Current revision ${Number(preview.current?.revision || 0)} · ${escapeHtml(preview.current?.stateHash || "No hash")}</p>
        <h3>Current-only records kept unchanged</h3>${listItems(comparison.currentOnly, "No current-only records.")}
        <h3>Same records with different values</h3>${listItems(comparison.changed, "No differing values.")}
      </details>`;
    nodes.recoverMissing.disabled = preview.unchanged || !recoverable.length;
    nodes.recoverMissing.classList.toggle("primary", Boolean(recoverable.length && !preview.unchanged));
    nodes.recoverDisabledReason.textContent = recoverable.length && !preview.unchanged
      ? "Recovery is available. Nothing changes until you select Recover Missing Items and confirm."
      : "No recovery is needed—the current account backup already contains everything from this earlier version.";
  }

  async function previewSelectedVersion() {
    const id = nodes.versionSelect.value;
    if (!id) return;
    nodes.previewVersion.disabled = true;
    nodes.status.textContent = "Building an additive preview. Nothing is changing...";
    try {
      activePreview = await api(`/api/recovery/versions/${encodeURIComponent(id)}/preview`, { method:"POST", body:"{}" });
      renderPreview(activePreview);
      nodes.status.textContent = "Preview ready. The Account backup has not changed.";
    } catch (error) {
      nodes.status.textContent = `Preview stopped safely: ${String(error.message || error)}`;
    } finally {
      nodes.previewVersion.disabled = false;
    }
  }

  async function recoverMissing() {
    if (!activePreview?.previewToken || !activePreview.source?.id) return;
    const count = Number(activePreview.comparison?.counts?.recoverableMissing || 0);
    if (!window.confirm(`Add ${count} missing record${count === 1 ? "" : "s"} to the Account backup? Existing records and settings stay unchanged.`)) return;
    nodes.recoverMissing.disabled = true;
    nodes.status.textContent = "Creating a safety backup and adding missing records...";
    try {
      const result = await api(`/api/recovery/versions/${encodeURIComponent(activePreview.source.id)}/recover-missing`, {
        method:"POST",
        body:JSON.stringify({ previewToken:activePreview.previewToken }),
      });
      nodes.status.textContent = result.unchanged
        ? "Nothing was missing. No data changed."
        : `Recovered ${result.additions?.length || count} missing record${(result.additions?.length || count) === 1 ? "" : "s"}. The Account backup is now revision ${result.revision}.`;
      activePreview = null;
      nodes.versionPreview.hidden = true;
      nodes.recoverDisabledReason.textContent = "Preview an earlier account backup to check whether anything else is missing.";
      cloudEnvelope = await core.fetchAccountBackup();
      versionsPayload = await api("/api/recovery/versions");
      renderVersionOptions();
      renderCopyComparison();
    } catch (error) {
      nodes.status.textContent = `Recovery stopped safely: ${String(error.message || error)}`;
      nodes.recoverMissing.disabled = false;
    }
  }

  async function loadAccountBackup() {
    nodes.loadAccountBackup.disabled = true;
    nodes.status.textContent = "Fetching the latest Account backup and archiving this computer's copies...";
    let loadedLocally = false;
    try {
      const latest = await core.fetchAccountBackup();
      const comparison = core.compareStates(latest.state, selectedDeviceState() || {});
      const message = [
        "Load the Account backup on this computer?",
        "",
        "This changes only browser and IndexedDB storage on this computer.",
        `${comparison.removed.length} account record${comparison.removed.length === 1 ? " is" : "s are"} absent from the current computer copy.`,
        `${comparison.deviceOnly.length} device-only record${comparison.deviceOnly.length === 1 ? " will" : "s will"} remain archived for recovery.`,
        "The online revision will not change.",
      ].join("\n");
      if (!window.confirm(message)) {
        nodes.status.textContent = "Cancelled. No copies were changed.";
        return;
      }
      const verifiedCloud = await core.fetchAccountBackup();
      if (Number(verifiedCloud.revision) !== Number(latest.revision) || String(verifiedCloud.stateHash) !== String(latest.stateHash)) {
        cloudEnvelope = verifiedCloud;
        renderCopyComparison();
        nodes.status.textContent = "The Account backup changed during review. Nothing was loaded. Review the refreshed counts and choose again.";
        return;
      }
      const loaded = await core.archiveAndLoadAccountBackup({ username, envelope:verifiedCloud });
      loadedLocally = true;
      cloudEnvelope = verifiedCloud;
      deviceBundle.browserState = loaded.state;
      deviceBundle.durable = { state:loaded.state, storageMode:loaded.activeStorage, localStorageAvailable:loaded.localStorageAvailable };
      deviceBundle.outbox = null;
      nodes.browserSummary.textContent = summaryWithTime(loaded.state);
      nodes.durableSummary.textContent = summaryWithTime(loaded.state);
      nodes.outboxSummary.textContent = "No pending upload. Loading the Account backup did not create one.";
      renderCopyComparison();
      nodes.status.textContent = `Account backup loaded on this computer. ${loaded.archivedCount} previous device cop${loaded.archivedCount === 1 ? "y remains" : "ies remain"} in recovery. Online revision ${loaded.revision} was not changed.${loaded.localStorageAvailable === false ? " Browser localStorage is unavailable (full or blocked); the verified IndexedDB recovery copy will be used on reload." : ""}`;
    } catch (error) {
      nodes.status.textContent = loadedLocally
        ? `The Account backup was safely loaded on this computer, but this page could not refresh: ${String(error.message || error)} Reload the page. The online Account backup was not changed.`
        : `Stopped safely: ${String(error.message || error)} The Account backup was not changed.`;
    } finally {
      nodes.loadAccountBackup.disabled = !cloudEnvelope?.state;
    }
  }

  async function initialize() {
    if (!core) throw new Error("Recovery safety tools did not load.");
    const response = await fetch("/api/me", { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) return window.location.replace("/app.html?next=data-recovery");
    const payload = await response.json();
    username = core.normalizeUsername(payload.user?.username);
    if (!username) throw new Error("The signed-in account could not be identified.");
    const key = core.storageKey(username);
    nodes.storageKey.textContent = key;
    const browserRaw = localStorage.getItem(key);
    const legacyRaw = username === "admin" ? localStorage.getItem("studyquest_v3") : null;
    let browserState = null;
    let legacyState = null;
    let browserError = "";
    let legacyError = "";
    try { browserState = browserRaw ? JSON.parse(browserRaw) : null; } catch (error) { browserError = String(error.message || error); }
    try { legacyState = legacyRaw ? JSON.parse(legacyRaw) : null; } catch (error) { legacyError = String(error.message || error); }

    const db = await core.openExistingDatabase();
    let records = { account:null, outbox:null };
    if (db) {
      try { records = await core.readCurrentDeviceRecords(db, username); }
      finally { db.close(); }
    }
    deviceBundle = { browserRaw, browserState, browserError, legacyRaw, legacyState, legacyError, durable:records.account, outbox:records.outbox };
    cloudEnvelope = await core.fetchAccountBackup();
    nodes.browserSummary.textContent = browserError ? `Browser JSON is unreadable: ${browserError}` : summaryWithTime(browserState);
    nodes.durableSummary.textContent = summaryWithTime(records.account?.state);
    nodes.outboxSummary.textContent = records.outbox?.state ? summaryWithTime(records.outbox.state) : "No pending upload.";
    nodes.legacySummary.textContent = username !== "admin"
      ? "Hidden because this old unscoped key has no verified account owner."
      : legacyError ? `Legacy JSON is unreadable: ${legacyError}` : summaryWithTime(legacyState);
    renderCopyComparison();

    const recoveryBundle = () => ({
      format:"studyquest-recovery-ux-v2-export",
      exportedAt:new Date().toISOString(),
      username,
      accountBackup:{ revision:cloudEnvelope.revision, stateHash:cloudEnvelope.stateHash, state:cloudEnvelope.state },
      device:{ browser:{ raw:browserRaw, state:browserState, parseError:browserError }, indexedDb:{ accountState:records.account, outbox:records.outbox }, legacy:{ raw:legacyRaw, state:legacyState, parseError:legacyError } },
    });
    nodes.exportBundle.disabled = false;
    nodes.exportRaw.disabled = !browserRaw;
    nodes.exportBundle.onclick = () => {
      download(`studyquest-${username}-all-preserved-copies-${new Date().toISOString().slice(0, 10)}.json`, recoveryBundle());
      nodes.status.textContent = "Account and device copies downloaded. No StudyQuest information was changed.";
    };
    nodes.exportRaw.onclick = () => download(`studyquest-${username}-browser-copy-${new Date().toISOString().slice(0, 10)}.json`, browserRaw);
    nodes.loadAccountBackup.onclick = loadAccountBackup;
    nodes.previewVersion.onclick = previewSelectedVersion;
    nodes.recoverMissing.onclick = recoverMissing;
    nodes.versionSelect.onchange = () => {
      activePreview = null;
      nodes.versionPreview.hidden = true;
      nodes.recoverMissing.disabled = true;
      nodes.recoverMissing.classList.remove("primary");
      nodes.recoverDisabledReason.textContent = "Preview this earlier account backup to check whether anything is missing.";
    };
    versionsPayload = await api("/api/recovery/versions");
    renderVersionOptions();
    nodes.status.textContent = `Recovery copies ready for ${username}. Opening this page changed nothing.`;
  }

  initialize().catch((error) => {
    nodes.status.textContent = `Recovery check stopped safely: ${String(error.message || error)} No data was changed.`;
    nodes.loadAccountBackup.disabled = true;
  });
})();
