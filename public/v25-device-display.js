/* V25 presentation preference only. Never reads or writes account records. */
(function (root) {
  'use strict';
  const sizes = [75, 80, 90, 100, 110, 125];
  const prefix = 'studyquest_v25_device_display_v1:';
  let installed = false, key = '', current = 100, notice = '';
  const supported = !!root.CSS?.supports?.('zoom', '1');
  const byId = id => root.document.getElementById(id);

  function valid(value) {
    return sizes.includes(Number(value)) && String(Number(value)) === String(value);
  }

  function updateControls() {
    const select = byId('v25DeviceDisplaySize');
    if (select) { select.value = String(current); select.disabled = !supported || !key; }
    const reset = byId('v25DeviceDisplayReset');
    if (reset) reset.disabled = !supported || !key;
    const status = byId('v25DeviceDisplayStatus');
    if (status) status.textContent = !supported
      ? 'This browser cannot apply app display sizes. You can still use browser zoom.'
      : !key ? 'Display size will be available after your account is identified.'
      : notice || `${current}% — changes apply immediately and are remembered in this browser.`;
  }

  function viewport() {
    const html = root.document.documentElement;
    html.style.setProperty('--sq-v25-display-scale', String(current / 100));
    html.style.setProperty('--sq-v25-viewport-width', (root.innerWidth * 100 / current) + 'px');
    html.style.setProperty('--sq-v25-viewport-height', (root.innerHeight * 100 / current) + 'px');
  }

  function apply(value) {
    current = supported && valid(value) ? Number(value) : 100;
    const html = root.document.documentElement;
    html.classList.toggle('sq-v25-device-scaled', current !== 100);
    if (current === 100) html.style.removeProperty('zoom');
    else html.style.zoom = String(current / 100);
    viewport();
    updateControls();
  }

  function read() {
    notice = '';
    try {
      const saved = key && root.localStorage.getItem(key);
      apply(valid(saved) ? saved : 100);
    } catch {
      notice = '100% for this visit. This browser could not read your saved display size.';
      apply(100);
    }
  }

  function choose(value) {
    if (!supported || !key || !valid(value)) return;
    notice = '';
    apply(value);
    try {
      root.localStorage.setItem(key, String(current));
      if (root.localStorage.getItem(key) !== String(current)) throw new Error('Preference readback failed');
      notice = `${current}% — remembered for this account in this browser.`;
    } catch {
      notice = `${current}% applied for this visit only. This browser could not remember it.`;
    }
    updateControls();
  }

  function install(bridge) {
    if (installed || !root.document) return;
    installed = true;
    const account = String(bridge?.accountKey?.() || '').trim().toLowerCase();
    if (account) key = prefix + encodeURIComponent(account);
    const modal = byId('profileSettingsModal')?.querySelector('.modal');
    if (modal && !byId('v25DeviceDisplaySettings')) {
      const section = root.document.createElement('section');
      section.id = 'v25DeviceDisplaySettings';
      section.className = 'v25-device-display';
      section.setAttribute('aria-labelledby', 'v25DeviceDisplayTitle');
      section.innerHTML = '<h3 id="v25DeviceDisplayTitle">Display size on this device</h3>' +
        '<p>Only affects this browser on this device. Your other devices keep their own size.</p>' +
        '<div class="v25-device-display-controls"><label for="v25DeviceDisplaySize">App display size</label>' +
        '<select class="form-input" id="v25DeviceDisplaySize">' + sizes.map(size =>
          `<option value="${size}">${size}%${size === 100 ? ' (default)' : ''}</option>`).join('') +
        '</select><button type="button" class="btn btn-ghost btn-sm" id="v25DeviceDisplayReset">Reset to 100%</button></div>' +
        '<p id="v25DeviceDisplayStatus" role="status" aria-live="polite"></p>';
      const workspace = modal.querySelector('.v19-workspace-settings');
      if (workspace) workspace.after(section);
      else modal.append(section);
      byId('v25DeviceDisplaySize').addEventListener('change', event => choose(event.target.value));
      byId('v25DeviceDisplayReset').addEventListener('click', () => choose('100'));
    }
    read();
    root.addEventListener('resize', viewport);
    root.addEventListener('storage', event => { if (key && (event.key === key || event.key === null)) read(); });
    root.addEventListener('pageshow', event => { if (event.persisted) read(); });
  }

  root.StudyQuestV25DeviceDisplay = { install };
})(window);
