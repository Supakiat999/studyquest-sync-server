(() => {
  "use strict";

  const REQUIRED_PHRASE = "REPLACE ACCOUNT BACKUP";
  const core = window.StudyQuestRecoveryV2;
  if (!core) return;

  function eligibleForUx() {
    const mode = String(window.__STUDYQUEST_RECOVERY_UX_MODE__ || "off").toLowerCase();
    const username = core.normalizeUsername(window.__STUDYQUEST_AUTH_USER__?.username);
    return Boolean(username && (mode === "all" || (mode === "admin" && username === "admin")));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    }[character]));
  }

  function formattedTime(value, fallback) {
    const timestamp = Number(value?.updatedAt || 0);
    return timestamp ? `Last edited ${new Date(timestamp).toLocaleString()}` : fallback;
  }

  function changeSetFromComparison(comparison) {
    return {
      deletes:(comparison?.removed || []).map((item) => ({ key:item.key, label:item.label || item.key })),
      generatedAt:new Date().toISOString(),
      source:"recovery-ux-v2-reviewed-replacement",
    };
  }

  function setButtonsDisabled(disabled) {
    ["accountRecoveryCloudBtn", "accountRecoveryExportBtn", "accountRecoveryAdvancedStart", "accountRecoveryAdvancedConfirm"]
      .forEach((id) => {
        const button = document.getElementById(id);
        if (!button) return;
        const phraseReady = document.getElementById("accountRecoveryAdvancedPhrase")?.value.trim().toUpperCase() === REQUIRED_PHRASE;
        button.disabled = disabled
          || (id === "accountRecoveryAdvancedStart" && !accountStateRecovery?.v2?.exported)
          || (id === "accountRecoveryAdvancedConfirm" && !phraseReady);
      });
  }

  function installStyles() {
    if (document.getElementById("studyquestRecoveryUxV2Styles")) return;
    const style = document.createElement("style");
    style.id = "studyquestRecoveryUxV2Styles";
    style.textContent = `
      .account-recovery-modal.v2 { width:min(920px,96vw); max-height:92vh; overflow:auto; }
      .account-recovery-modal.v2 .account-recovery-lead { font-size:14px; line-height:1.65; color:var(--text-dim); margin-bottom:18px; }
      .account-recovery-grid.v2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .account-recovery-copy.v2 { display:flex; flex-direction:column; gap:7px; min-width:0; padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--surface2); }
      .account-recovery-copy.v2.recommended { border-color:rgba(106,247,176,.55); box-shadow:inset 0 0 0 1px rgba(106,247,176,.12); }
      .account-recovery-copy.v2 strong { font-size:16px; color:var(--text); }
      .account-recovery-copy.v2 span { color:var(--text-dim); line-height:1.5; overflow-wrap:anywhere; }
      .recovery-v2-tag { align-self:flex-start; padding:3px 8px; border-radius:999px; font-size:10px; font-weight:800; letter-spacing:.04em; color:#6af7b0; background:rgba(106,247,176,.12); border:1px solid rgba(106,247,176,.35); }
      .recovery-v2-tag[hidden] { display:none !important; }
      .recovery-v2-explainer { font-size:12px; color:var(--text-muted); }
      .account-recovery-note.v2 { margin-top:14px; padding:13px 14px; border-left:3px solid var(--accent); border-radius:8px; background:rgba(124,106,247,.08); color:var(--text-dim); line-height:1.55; }
      .account-recovery-note.v2.warning { border-left-color:#f7c06a; background:rgba(247,192,106,.08); }
      .account-recovery-status.v2 { min-height:24px; margin:12px 0; color:var(--text-dim); line-height:1.5; }
      .recovery-v2-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:9px; }
      .recovery-v2-actions .recommended-action { background:#6af7b0; border-color:#6af7b0; color:#10131f; }
      .recovery-v2-advanced { margin-top:15px; padding:12px 14px; border:1px solid rgba(247,106,106,.3); border-radius:10px; background:rgba(247,106,106,.04); }
      .recovery-v2-advanced > summary { cursor:pointer; color:#f7c06a; font-weight:800; }
      .recovery-v2-danger { margin-top:12px; color:var(--text-dim); line-height:1.55; }
      .recovery-v2-danger strong { color:#f76a6a; }
      .recovery-v2-confirm { display:grid; gap:9px; margin-top:12px; }
      .recovery-v2-confirm input { width:100%; min-height:42px; border:1px solid var(--border); border-radius:8px; padding:9px 11px; background:var(--surface2); color:var(--text); font:inherit; }
      .recovery-v2-confirm button { justify-self:end; }
      @media (max-width:700px) {
        .account-recovery-grid.v2 { grid-template-columns:1fr; }
        .recovery-v2-actions .btn { width:100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function installMarkup() {
    const modal = document.querySelector("#accountStateRecoveryModal .account-recovery-modal");
    if (!modal || modal.dataset.recoveryUxVersion === "2") return;
    modal.dataset.recoveryUxVersion = "2";
    modal.classList.add("v2");
    modal.innerHTML = `
      <div class="modal-title" id="accountStateRecoveryTitle">Choose what to show on this computer</div>
      <div class="account-recovery-lead">StudyQuest found two different saved copies. Nothing has been replaced. The labels below explain where each copy is stored and what each action changes.</div>
      <div class="account-recovery-grid v2">
        <section class="account-recovery-copy v2" id="accountRecoveryCloudCard" aria-labelledby="accountRecoveryCloudHeading">
          <span class="recovery-v2-tag" id="accountRecoveryCloudTag" hidden>RECOMMENDED — KEEPS MORE RECORDS</span>
          <strong id="accountRecoveryCloudHeading">Account backup</strong>
          <span class="recovery-v2-explainer">Protected online under your signed-in account and available on your other signed-in devices.</span>
          <span id="accountRecoveryCloudSummary">Checking...</span>
          <span id="accountRecoveryCloudTime"></span>
        </section>
        <section class="account-recovery-copy v2" aria-labelledby="accountRecoveryBrowserHeading">
          <strong id="accountRecoveryBrowserHeading">This computer's saved copy</strong>
          <span class="recovery-v2-explainer">Stored in this browser and device recovery storage. It may include work that has not uploaded yet.</span>
          <span id="accountRecoveryBrowserSummary">Checking...</span>
          <span id="accountRecoveryBrowserTime"></span>
        </section>
      </div>
      <div class="account-recovery-note v2" id="accountRecoveryRecommendation"></div>
      <details class="account-recovery-note v2"><summary>Compare exact differences</summary><div id="accountRecoveryRemovalDetails" style="margin-top:8px;white-space:pre-wrap;"></div></details>
      <div class="account-recovery-status v2" id="accountRecoveryStatus" role="status" aria-live="polite"></div>
      <div class="recovery-v2-actions">
        <button class="btn btn-ghost" type="button" id="accountRecoveryLaterBtn">Decide later</button>
        <button class="btn btn-ghost" type="button" id="accountRecoveryExportBtn">Download both copies</button>
        <button class="btn recommended-action" type="button" id="accountRecoveryCloudBtn">Load account backup on this computer</button>
      </div>
      <details class="recovery-v2-advanced" id="accountRecoveryAdvanced">
        <summary>Advanced Recovery</summary>
        <div class="recovery-v2-danger">
          <strong id="accountRecoveryAdvancedImpact">Preparing impact...</strong>
          <p>This is the only option that can change your account backup. Download both copies first, then review and type the confirmation phrase. A fresh signed server preview is required.</p>
          <button class="btn btn-ghost" type="button" id="accountRecoveryAdvancedStart" disabled>Prepare replacement review</button>
          <div id="accountRecoveryAdvancedReview"></div>
        </div>
      </details>`;
    document.getElementById("accountRecoveryLaterBtn").addEventListener("click", () => closeAccountStateRecovery());
    document.getElementById("accountRecoveryExportBtn").addEventListener("click", exportBothCopiesV2);
    document.getElementById("accountRecoveryCloudBtn").addEventListener("click", loadAccountBackupOnComputerV2);
    document.getElementById("accountRecoveryAdvancedStart").addEventListener("click", prepareAdvancedReplacementV2);
  }

  function resetReviewState() {
    if (!accountStateRecovery) return;
    accountStateRecovery.v2 = { exported:false, review:null, mutationId:null };
    const advanced = document.getElementById("accountRecoveryAdvanced");
    if (advanced) advanced.open = false;
    const review = document.getElementById("accountRecoveryAdvancedReview");
    if (review) review.innerHTML = "";
    const start = document.getElementById("accountRecoveryAdvancedStart");
    if (start) {
      start.disabled = true;
      start.textContent = "Prepare replacement review";
    }
    setButtonsDisabled(false);
  }

  function renderRecoveryV2() {
    if (!accountStateRecovery) return;
    const browser = accountStateRecovery.browserState;
    const cloud = accountStateRecovery.cloudState;
    const comparison = core.compareStates(cloud, browser);
    const cloudSummary = document.getElementById("accountRecoveryCloudSummary");
    const browserSummary = document.getElementById("accountRecoveryBrowserSummary");
    if (cloudSummary) cloudSummary.textContent = core.summaryText(cloud);
    if (browserSummary) browserSummary.textContent = core.summaryText(browser);
    document.getElementById("accountRecoveryCloudTime").textContent = formattedTime(cloud, "No reliable account-backup edit time");
    document.getElementById("accountRecoveryBrowserTime").textContent = formattedTime(browser, "No reliable computer-copy edit time");

    const recommendation = document.getElementById("accountRecoveryRecommendation");
    const deviceOnly = comparison.deviceOnly.length;
    const removed = comparison.removed.length;
    const cloudCard = document.getElementById("accountRecoveryCloudCard");
    const cloudTag = document.getElementById("accountRecoveryCloudTag");
    const cloudHeading = document.getElementById("accountRecoveryCloudHeading");
    cloudCard?.classList.toggle("recommended", removed > 0);
    if (cloudTag) cloudTag.hidden = removed <= 0;
    if (cloudHeading) cloudHeading.textContent = removed > 0 ? "Account backup — recommended" : "Account backup";
    if (removed > 0) {
      recommendation.textContent = `Recommended: load the Account backup on this computer because replacing it with this computer's copy would remove ${removed} saved record${removed === 1 ? "" : "s"}. ${deviceOnly ? `This computer also has ${deviceOnly} device-only record${deviceOnly === 1 ? "" : "s"}; those remain archived for later recovery.` : ""}`.trim();
      recommendation.classList.add("warning");
    } else if (deviceOnly > 0) {
      recommendation.textContent = `This computer has ${deviceOnly} record${deviceOnly === 1 ? "" : "s"} not present in the Account backup. Download both copies and use Advanced Recovery only after reviewing those differences.`;
      recommendation.classList.add("warning");
    } else if (comparison.changed.length > 0) {
      recommendation.textContent = `${comparison.changed.length} shared record${comparison.changed.length === 1 ? " has" : "s have"} different values in the two copies. No copy is recommended from time alone; compare the differences before choosing.`;
      recommendation.classList.add("warning");
    } else {
      recommendation.textContent = "The record lists match. Loading the Account backup only refreshes this computer and does not change the online account.";
      recommendation.classList.remove("warning");
    }

    const details = document.getElementById("accountRecoveryRemovalDetails");
    if (details) {
      const removedList = comparison.removed.slice(0, 20).map((item) => `• ${item.label || item.key}`).join("\n");
      const deviceList = comparison.deviceOnly.slice(0, 20).map((item) => `• ${item.label || item.key}`).join("\n");
      const changedList = comparison.changed.slice(0, 20).map((item) => `• ${item.label || item.key}`).join("\n");
      details.textContent = [
        `Identified records: ${comparison.accountRecordCount} in the Account backup; ${comparison.deviceRecordCount} on this computer.`,
        `If the computer copy replaced the Account backup: ${removed} account record${removed === 1 ? "" : "s"} would be removed.`,
        removedList,
        removed > 20 ? `• and ${removed - 20} more` : "",
        `\nDevice-only records: ${deviceOnly}.`,
        deviceList,
        deviceOnly > 20 ? `• and ${deviceOnly - 20} more` : "",
        `\nShared records with different values: ${comparison.changed.length}.`,
        changedList,
        comparison.changed.length > 20 ? `• and ${comparison.changed.length - 20} more` : "",
      ].filter(Boolean).join("\n");
    }
    const impact = document.getElementById("accountRecoveryAdvancedImpact");
    if (impact) impact.textContent = `Replace Account backup with this computer's copy — would remove ${removed} saved record${removed === 1 ? "" : "s"}.`;
    const status = document.getElementById("accountRecoveryStatus");
    if (status && !status.textContent) status.textContent = accountStateRecovery.reason || "Both copies are preserved.";
  }

  async function exportBothCopiesV2() {
    if (!accountStateRecovery) return;
    const original = window.__studyquestRecoveryV2OriginalExport;
    if (typeof original !== "function") {
      document.getElementById("accountRecoveryStatus").textContent = "The export could not start. Both copies are still preserved.";
      return;
    }
    try { original(); }
    catch (error) {
      document.getElementById("accountRecoveryStatus").textContent = `The export could not finish: ${String(error?.message || error)} Both copies are still preserved.`;
      return;
    }
    accountStateRecovery.v2 = accountStateRecovery.v2 || {};
    accountStateRecovery.v2.exported = true;
    const start = document.getElementById("accountRecoveryAdvancedStart");
    if (start) start.disabled = false;
    document.getElementById("accountRecoveryStatus").textContent = "Both copies were downloaded. No StudyQuest information was changed.";
  }

  async function refreshAfterCloudChange(recovery, latest, message) {
    openAccountStateRecovery(recovery.browserState, latest.state, latest.revision, message, latest.stateHash || null);
    document.getElementById("accountRecoveryStatus").textContent = `${message} Choose again using the refreshed counts.`;
  }

  async function loadAccountBackupOnComputerV2() {
    if (!accountStateRecovery) return;
    const recovery = accountStateRecovery;
    const status = document.getElementById("accountRecoveryStatus");
    let loadedLocally = false;
    setButtonsDisabled(true);
    if (status) status.textContent = "Checking the latest Account backup and archiving this computer's copies...";
    try {
      const latest = await core.fetchAccountBackup();
      if (Number(latest.revision) !== Number(recovery.revision) || String(latest.stateHash || "") !== String(recovery.stateHash || "")) {
        await refreshAfterCloudChange(recovery, latest, "The Account backup changed during review. Nothing was replaced.");
        return;
      }
      const verifiedLatest = await core.fetchAccountBackup();
      if (Number(verifiedLatest.revision) !== Number(latest.revision) || String(verifiedLatest.stateHash || "") !== String(latest.stateHash || "")) {
        await refreshAfterCloudChange(recovery, verifiedLatest, "The Account backup changed during the final safety check. Nothing was replaced.");
        return;
      }
      const username = core.normalizeUsername(window.__STUDYQUEST_AUTH_USER__?.username);
      const loaded = await core.archiveAndLoadAccountBackup({ username, envelope:verifiedLatest });
      loadedLocally = true;
      state = normalizeState(loaded.state);
      storeServerRevision(loaded.revision);
      serverStateHash = loaded.stateHash;
      confirmedServerState = cloneAccountState(state);
      pendingCloudMutation = null;
      cloudOutboxPending = false;
      ensureTrackerSemesters();
      ensureTravelState();
      renderAll();
      accountStateRecovery = null;
      closeModal("accountStateRecoveryModal");
      setSaveStatus("saved", "Account backup loaded on this computer");
      showToast(`Account backup loaded. ${loaded.archivedCount} previous device cop${loaded.archivedCount === 1 ? "y remains" : "ies remain"} in recovery.`, "#6af7b0");
    } catch (error) {
      if (status) status.textContent = loadedLocally
        ? `The Account backup was safely loaded on this computer, but the screen could not refresh: ${String(error?.message || error)} Reload the page. Nothing was replaced online.`
        : `Stopped safely: ${String(error?.message || error)} Nothing was replaced online.`;
    } finally {
      if (accountStateRecovery) setButtonsDisabled(false);
    }
  }

  async function prepareAdvancedReplacementV2() {
    if (!accountStateRecovery?.v2?.exported) {
      document.getElementById("accountRecoveryStatus").textContent = "Download both copies before preparing an Account-backup replacement.";
      return;
    }
    const recovery = accountStateRecovery;
    const status = document.getElementById("accountRecoveryStatus");
    const start = document.getElementById("accountRecoveryAdvancedStart");
    setButtonsDisabled(true);
    if (start) start.textContent = "Building signed review...";
    if (status) status.textContent = "Creating a protected review copy. The Account backup is not changing.";
    try {
      const latest = await core.fetchAccountBackup();
      if (Number(latest.revision) !== Number(recovery.revision) || String(latest.stateHash || "") !== String(recovery.stateHash || "")) {
        await refreshAfterCloudChange(recovery, latest, "The Account backup changed before Advanced Recovery started. Nothing was replaced.");
        return;
      }
      const comparison = core.compareStates(latest.state, recovery.browserState);
      const mutationId = `recovery-v2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const response = await fetch("/api/recovery/device-copy-review", {
        method:"POST",
        credentials:"same-origin",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          state:recovery.browserState,
          expectedRevision:Number(latest.revision),
          expectedHash:String(latest.stateHash),
          mutationId,
          changeSet:changeSetFromComparison(comparison),
        }),
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(created.message || created.error || "The protected review could not be created.");
      const detailResponse = await fetch(`/api/v2/state/conflicts/${encodeURIComponent(created.conflictCopyId)}`, { credentials:"same-origin", cache:"no-store" });
      const detail = await detailResponse.json().catch(() => ({}));
      if (!detailResponse.ok || !detail.ok) throw new Error(detail.message || detail.error || "The signed comparison could not be loaded.");
      recovery.v2.review = detail;
      recovery.v2.mutationId = mutationId;
      const removed = Array.isArray(detail.comparison?.removed) ? detail.comparison.removed : [];
      const review = document.getElementById("accountRecoveryAdvancedReview");
      review.innerHTML = `
        <div class="recovery-v2-confirm">
          <p><strong>${removed.length} saved record${removed.length === 1 ? "" : "s"} would be removed.</strong> A server backup and conflict copy will remain recoverable. Type <code>${REQUIRED_PHRASE}</code> to approve exactly this signed preview.</p>
          <input id="accountRecoveryAdvancedPhrase" autocomplete="off" aria-label="Type ${REQUIRED_PHRASE} to confirm" placeholder="${REQUIRED_PHRASE}">
          <button class="btn btn-primary" type="button" id="accountRecoveryAdvancedConfirm" disabled>Replace Account backup</button>
        </div>`;
      const input = document.getElementById("accountRecoveryAdvancedPhrase");
      const confirm = document.getElementById("accountRecoveryAdvancedConfirm");
      input.addEventListener("input", () => { confirm.disabled = input.value.trim().toUpperCase() !== REQUIRED_PHRASE; });
      confirm.addEventListener("click", confirmAdvancedReplacementV2);
      input.focus();
      if (status) status.textContent = "Signed review ready. Nothing changes until the exact confirmation phrase is entered.";
    } catch (error) {
      if (status) status.textContent = `Advanced Recovery stopped safely: ${String(error?.message || error)}`;
    } finally {
      if (accountStateRecovery) {
        setButtonsDisabled(false);
        if (start) start.textContent = "Rebuild replacement review";
      }
    }
  }

  async function confirmAdvancedReplacementV2() {
    const recovery = accountStateRecovery;
    const review = recovery?.v2?.review;
    const phrase = document.getElementById("accountRecoveryAdvancedPhrase")?.value.trim().toUpperCase();
    if (!recovery || !review || phrase !== REQUIRED_PHRASE) return;
    const status = document.getElementById("accountRecoveryStatus");
    let accountReplacementAccepted = false;
    setButtonsDisabled(true);
    if (status) status.textContent = "Applying the signed review with revision and hash protection...";
    try {
      const comparison = core.compareStates(review.cloudState, review.candidateState);
      const response = await fetch(`/api/v2/state/conflicts/${encodeURIComponent(review.conflict.id)}/resolve`, {
        method:"POST",
        credentials:"same-origin",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({
          state:review.candidateState,
          expectedRevision:Number(review.current.revision),
          expectedHash:String(review.current.stateHash),
          mutationId:recovery.v2.mutationId,
          previewToken:review.previewToken,
          changeSet:changeSetFromComparison(comparison),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        if (["PREVIEW_EXPIRED", "PREVIEW_STALE"].includes(result.error)) {
          const latest = await core.fetchAccountBackup();
          await refreshAfterCloudChange(recovery, latest, "The Account backup changed or the signed review expired. Nothing was replaced.");
          return;
        }
        throw new Error(result.message || result.error || "The signed replacement was not accepted.");
      }
      accountReplacementAccepted = true;
      const username = core.normalizeUsername(window.__STUDYQUEST_AUTH_USER__?.username);
      const loaded = await core.archiveAndLoadAccountBackup({
        username,
        envelope:{ state:review.candidateState, revision:Number(result.revision), stateHash:String(result.stateHash) },
      });
      state = normalizeState(loaded.state);
      storeServerRevision(loaded.revision);
      serverStateHash = loaded.stateHash;
      confirmedServerState = cloneAccountState(state);
      pendingCloudMutation = null;
      cloudOutboxPending = false;
      ensureTrackerSemesters();
      ensureTravelState();
      renderAll();
      accountStateRecovery = null;
      closeModal("accountStateRecoveryModal");
      setSaveStatus("saved", "Reviewed computer copy saved to account");
      showToast("The reviewed computer copy is now the Account backup. Safety and conflict copies were retained.", "#6af7b0");
    } catch (error) {
      if (accountReplacementAccepted) {
        const latest = await core.fetchAccountBackup().catch(() => null);
        if (latest && accountStateRecovery) {
          await refreshAfterCloudChange(recovery, latest, "The signed Account-backup replacement completed, but this computer could not finish loading it.");
        }
        const activeStatus = document.getElementById("accountRecoveryStatus");
        if (activeStatus) activeStatus.textContent = `The Account backup was updated through the signed review, but this computer needs to load it again: ${String(error?.message || error)} The exported and recovery copies remain preserved.`;
      } else if (status) {
        status.textContent = `Replacement stopped safely: ${String(error?.message || error)} Both copies remain preserved.`;
      }
      setButtonsDisabled(false);
    }
  }

  function install() {
    if (!eligibleForUx()) return false;
    if (typeof window.openAccountStateRecovery !== "function" || typeof window.renderAccountStateRecovery !== "function") return false;
    if (window.__STUDYQUEST_RECOVERY_UX_V2_INSTALLED__) return true;
    window.__STUDYQUEST_RECOVERY_UX_V2_INSTALLED__ = true;
    installStyles();
    installMarkup();
    const originalOpen = window.openAccountStateRecovery;
    const originalExport = window.exportAccountStateCopies;
    window.__studyquestRecoveryV2OriginalExport = originalExport;
    window.renderAccountStateRecovery = renderRecoveryV2;
    window.openAccountStateRecovery = function openAccountStateRecoveryV2(...args) {
      originalOpen(...args);
      installMarkup();
      resetReviewState();
      renderRecoveryV2();
    };
    window.exportAccountStateCopies = exportBothCopiesV2;
    window.useAccountCloudCopy = loadAccountBackupOnComputerV2;
    window.useAccountBrowserCopy = prepareAdvancedReplacementV2;
    if (typeof accountStateRecovery !== "undefined" && accountStateRecovery) {
      resetReviewState();
      renderRecoveryV2();
    }
    return true;
  }

  if (!install()) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 240) clearInterval(timer);
    }, 250);
  }
})();
