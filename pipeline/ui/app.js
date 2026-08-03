// KeyForge production console — dashboard behaviour.
// No build step and no dependencies: this file is served straight from disk.
// The pure rules (name validation, duration and age formatting) live in lib.js
// so they can be unit tested without a browser.

import { validate, formatTime, relativeTime, plural, escapeHtml } from './lib.js';

const nameInput = document.getElementById('name-input');
const valMsg = document.getElementById('val-msg');
const submitBtn = document.getElementById('submit-btn');
const submitFeedback = document.getElementById('submit-feedback');
const dashboardFeedback = document.getElementById('dashboard-feedback');
const previewPanel = document.getElementById('preview-panel');
const previewImage = document.getElementById('preview-image');
const previewName = document.getElementById('preview-name');
const liveIndicator = document.getElementById('live-indicator');
const liveLabel = document.getElementById('live-label');

const POLL_MS = 4500;
let statusTimer = null;
let statusInFlight = false;
let statusRefreshRequested = false;
let lastSuccessAt = null;

/* ---------- theme ---------- */

// Dark is the console's default look; light is the alternate.
const themeToggle = document.getElementById('theme-toggle');

function activeTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function syncThemeButton() {
  themeToggle.setAttribute('aria-label', 'Switch to ' + (activeTheme() === 'dark' ? 'light' : 'dark') + ' theme');
}

try {
  if (localStorage.getItem('keyforge-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch {
  // Kiosk browsers can block storage; the default theme is a fine fallback.
}
syncThemeButton();

themeToggle.addEventListener('click', () => {
  const next = activeTheme() === 'dark' ? 'light' : 'dark';
  if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('keyforge-theme', next); } catch {}
  syncThemeButton();
});

/* ---------- status vocabulary ---------- */

// Every state ships an icon as well as a colour: red and green are the same
// colour under deuteranopia, so the glyph is what actually separates them.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  printing: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  offline: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  loader: '<path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  requeue: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z"/>'
};

function icon(name, size = 11, stroke = 2.4) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
}

// class -> the pill palette slot; glyph -> the redundant, non-colour cue.
const PRINTER_STATES = {
  free: { label: 'Available', cls: 'free', glyph: 'check' },
  sending: { label: 'Sending', cls: 'sending', glyph: 'loader' },
  preparing: { label: 'Preparing', cls: 'preparing', glyph: 'loader' },
  busy: { label: 'Printing', cls: 'busy', glyph: 'printing' },
  paused: { label: 'Paused', cls: 'paused', glyph: 'alert' },
  needs_clearing: { label: 'Clear bed', cls: 'needs_clearing', glyph: 'alert' }
};
const OFFLINE_STATE = { label: 'Offline', cls: 'offline', glyph: 'offline' };

function printerState(status) {
  return PRINTER_STATES[status] || OFFLINE_STATE;
}

function pill(cls, glyph, label) {
  return '<span class="pill ' + cls + '">' + icon(glyph) + escapeHtml(label) + '</span>';
}

// Row actions are labelled, not glyph-only. A bare trash can asks the operator
// to guess; the word does not. The icon stays as a scanning aid alongside it.
function actionLink(href, glyph, label) {
  return '<a href="' + href + '" class="btn btn-row" download>' + icon(glyph, 13, 2) +
    '<span>' + escapeHtml(label) + '</span></a>';
}

function actionButton(action, id, glyph, label, tone) {
  return '<button data-action="' + action + '" data-id="' + escapeHtml(id) + '" class="btn btn-row ' + (tone || '') +
    '">' + icon(glyph, 13, 2) + '<span>' + escapeHtml(label) + '</span></button>';
}

/* ---------- formatting ---------- */

// Discrete right-aligned cells rather than a dot-joined sentence, so duration,
// mass and age line up as columns down the list.
function meta(cells) {
  const kept = cells.filter((c) => c && c.value);
  if (!kept.length) return '';
  return '<span class="row-meta">' +
    kept.map((c) => '<span class="cell ' + c.cls + '">' + escapeHtml(c.value) + '</span>').join('') +
    '</span>';
}

const cellTime = (sec) => ({ cls: 'cell-time', value: formatTime(sec) });
const cellAge = (iso) => ({ cls: 'cell-age', value: relativeTime(iso) });

// Which machine ran the job — a fact about the job, so it sits beside the name.
function chip(text) {
  return text ? '<span class="row-chip">' + escapeHtml(text) + '</span>' : '';
}

function empty(title, hint) {
  return '<div class="empty">' + icon('inbox', 20, 1.8) +
    '<strong>' + escapeHtml(title) + '</strong>' +
    (hint ? '<span>' + escapeHtml(hint) + '</span>' : '') + '</div>';
}

/* ---------- submit form ---------- */

function renderInputState() {
  const v = validate(nameInput.value);
  valMsg.className = 'val-msg ' + v.type;
  valMsg.textContent = v.msg;
  // The primary action stays live even before a valid name. A button that is
  // greyed out the moment the page loads reads as broken chrome rather than as
  // "not yet" — invalid input is caught on submit and pointed back at the field.
  submitBtn.disabled = false;
}

// Banners clear themselves. Nothing else ever hid this one, so "Auto-dispatch
// enabled." sat at the top of the page until a manual refresh. Errors linger
// longer than confirmations, and the poll re-raises a connection error every
// few seconds while it is still down, so a real outage stays on screen and only
// clears once it recovers.
let dashboardFeedbackTimer = null;

function showDashboardFeedback(msg, type = 'error') {
  clearTimeout(dashboardFeedbackTimer);
  dashboardFeedback.hidden = !msg;
  dashboardFeedback.className = 'feedback ' + type;
  dashboardFeedback.textContent = msg || '';
  if (!msg) return;
  dashboardFeedbackTimer = setTimeout(() => {
    dashboardFeedback.hidden = true;
    dashboardFeedback.textContent = '';
  }, type === 'error' ? 8000 : 4000);
}

function showPreview(name) {
  previewPanel.hidden = false;
  previewName.textContent = name + ' keychain';
  previewImage.alt = '3D preview of the ' + name + ' keychain';
  previewImage.src = '/api/preview?name=' + encodeURIComponent(name) + '&t=' + Date.now();
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const v = validate(nameInput.value);
  if (!v.ok) {
    valMsg.className = 'val-msg invalid';
    valMsg.textContent = v.type === 'hint' ? 'Enter a name first — 2 to 10 letters or numbers' : v.msg;
    nameInput.focus();
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  submitFeedback.hidden = false;
  submitFeedback.className = 'feedback info';
  submitFeedback.textContent = 'Generating model and checking geometry…';
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: v.cleaned })
    });
    const data = await res.json();
    if (!res.ok) {
      submitFeedback.className = 'feedback error';
      submitFeedback.textContent = (data.error || 'Generation failed') + (data.log ? '\n' + data.log : '');
    } else {
      submitFeedback.className = 'feedback success';
      submitFeedback.textContent = 'Geometry passed. Job added to the queue.';
      showPreview(data.name || v.cleaned);
      nameInput.value = '';
      renderInputState();
      refreshStatus();
    }
  } catch (err) {
    submitFeedback.className = 'feedback error';
    submitFeedback.textContent = 'Submission error: ' + err.message;
  } finally {
    submitBtn.textContent = 'Submit job';
    submitBtn.disabled = false;
  }
}

/* ---------- polling ---------- */

function setLiveState(state, label) {
  liveIndicator.dataset.state = state;
  liveLabel.textContent = label;
}

function scheduleStatusRefresh(delay = POLL_MS) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, delay);
}

async function refreshStatus() {
  if (statusInFlight) {
    statusRefreshRequested = true;
    return;
  }
  statusInFlight = true;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Status request failed');
    const data = await res.json();
    applyStatus(data);
    lastSuccessAt = Date.now();
    setLiveState('live', 'Live');
  } catch (err) {
    setLiveState('down', 'Reconnecting…');
    showDashboardFeedback('Could not refresh dashboard: ' + err.message);
  } finally {
    statusInFlight = false;
    const runImmediately = statusRefreshRequested;
    statusRefreshRequested = false;
    scheduleStatusRefresh(runImmediately ? 0 : POLL_MS);
  }
}

function applyStatus(data) {
  const autoCheck = document.getElementById('auto-dispatch-check');
  if (autoCheck && data.autoDispatch !== undefined) {
    autoCheck.checked = Boolean(data.autoDispatch);
  }
  renderQueueAndHistory(data);
  renderPrinters(data.printers || [], data.queue || []);
  renderStats(data);
}

// Keep the "Live" badge honest between polls.
setInterval(() => {
  if (!lastSuccessAt || liveIndicator.dataset.state === 'down') return;
  const secs = Math.round((Date.now() - lastSuccessAt) / 1000);
  if (secs > 20) setLiveState('stale', 'Updated ' + secs + 's ago');
  else setLiveState('live', 'Live');
}, 1000);

/* ---------- stat tiles ---------- */

function renderStats(data) {
  const queue = data.queue || [];
  const failed = data.failed || [];
  const printers = data.printers || [];
  const active = Object.values(data.activeJobs || {});

  // completed[] is a capped recent strip; lifetime totals come from the server.
  const completedTotal = data.completedTotal ?? (data.completed || []).length;
  const totalGrams = data.completedGrams ?? 0;

  const online = printers.filter((p) => p.status && p.status !== 'error' && p.status !== 'offline' && p.status !== 'unreachable');
  const needsHand = printers.filter((p) => p.status === 'needs_clearing' || p.status === 'paused');
  const attention = failed.length + needsHand.length;
  const queueSeconds = queue.reduce((sum, job) => sum + (job.seconds || 0), 0);

  setStat('queued', queue.length, queue.length ? (formatTime(queueSeconds) || '—') + ' of work' : 'nothing waiting');
  setStat('printing', active.length, active.length ? 'on ' + active.length + ' ' + plural(active.length, 'printer', 'printers') : 'farm is idle');
  setStat('completed', completedTotal, totalGrams ? totalGrams.toFixed(1) + ' g filament used' : 'keychains printed');
  setStat('attention', attention, attention ? failed.length + ' failed · ' + needsHand.length + ' need a hand' : 'all clear');
  document.getElementById('stat-attention-tile').dataset.alert = attention > 0 ? 'true' : 'false';
  setStat('online', printers.length ? online.length + '/' + printers.length : '0', printers.length ? 'reachable now' : 'run a network scan');
}

function setStat(key, value, sub) {
  document.getElementById('stat-' + key).textContent = String(value);
  document.getElementById('stat-' + key + '-sub').textContent = sub;
}

/* ---------- queue, active, failed, completed ---------- */

function rows(html) {
  return '<div class="rows">' + html + '</div>';
}

function renderQueueAndHistory(data) {
  const activeObj = data.activeJobs || {};
  const activeList = Object.keys(activeObj).map((ip) => ({ ...activeObj[ip], printerIp: ip }));
  const queueList = data.queue || [];
  const failedList = data.failed || [];
  const completedList = data.completed || [];

  document.getElementById('active-count').textContent = activeList.length;
  document.getElementById('queue-count').textContent = queueList.length;
  document.getElementById('failed-count').textContent = failedList.length;
  document.getElementById('completed-count').textContent = completedList.length;
  document.getElementById('active-section').hidden = activeList.length === 0;
  document.getElementById('failed-section').hidden = failedList.length === 0;
  document.getElementById('completed-section').hidden = completedList.length === 0;

  document.getElementById('active-jobs-list').innerHTML = activeList.length === 0
    ? empty('Nothing printing', 'Assign a queued job to a free printer.')
    : rows(activeList.map((j) => {
      const state = printerState(j.status === 'sending' ? 'sending' : 'busy');
      return '<div class="row">' +
        '<span class="row-lead">' +
          '<span class="row-name">' + escapeHtml(j.name) + '</span>' +
          chip(j.printerIp) +
        '</span>' +
        pill(state.cls, state.glyph, state.label) +
        meta([cellTime(j.seconds)]) +
        '<span class="row-actions">' + actionLink(j.downloadUrl, 'download', 'Download G-code') + '</span>' +
      '</div>';
    }).join(''));

  document.getElementById('queued-jobs-list').innerHTML = queueList.length === 0
    ? empty('Queue is empty', 'Submit a name on the left to forge a keychain.')
    // No "Queued" pill here — the section is titled Waiting, so the pill would
    // say the same thing on every row. Pills stay where the state actually varies.
    : rows(queueList.map((j, idx) => '<div class="row">' +
        '<span class="row-lead">' +
          '<span class="row-ordinal">' + (idx + 1) + '</span>' +
          '<span class="row-name">' + escapeHtml(j.name) + '</span>' +
        '</span>' +
        meta([cellTime(j.seconds), cellAge(j.createdAt)]) +
        '<span class="row-actions">' +
          actionLink(j.downloadUrl, 'download', 'Download G-code') +
          actionButton('cancel', j.id, 'trash', 'Delete', 'danger') +
        '</span>' +
      '</div>').join(''));

  document.getElementById('failed-jobs-list').innerHTML = rows(failedList.map((j) =>
    '<div class="row">' +
      '<span class="row-lead"><span class="row-name">' + escapeHtml(j.name) + '</span></span>' +
      pill('failed', 'alert', 'Failed') +
      meta([cellTime(j.seconds), cellAge(j.createdAt)]) +
      '<span class="row-actions">' +
        actionLink(j.downloadUrl, 'download', 'Download G-code') +
        actionButton('requeue', j.id, 'requeue', 'Requeue', 'warn') +
        actionButton('delete', j.id, 'trash', 'Delete', 'danger') +
      '</span>' +
    '</div>' +
    (j.error ? '<div class="row-error">' + escapeHtml(j.error) + '</div>' : '')
  ).join(''));

  // A single green tick instead of a "Done" pill on every row.
  document.getElementById('completed-jobs-list').innerHTML = rows(completedList.map((j) =>
    '<div class="row">' +
      '<span class="row-lead">' +
        '<span class="row-tick">' + icon('check', 12) + '</span>' +
        '<span class="row-name">' + escapeHtml(j.name) + '</span>' +
        chip(j.printerIp) +
      '</span>' +
      meta([cellTime(j.seconds), cellAge(j.createdAt)]) +
    '</div>'
  ).join(''));
}

/* ---------- printer farm ---------- */

function renderPrinters(printers, queue = []) {
  document.getElementById('printers-count').textContent = printers.length;
  const el = document.getElementById('printers-list');
  if (!printers || printers.length === 0) {
    el.className = '';
    el.innerHTML = empty('No printers yet', 'Run a scan to find printers on your network.');
    return;
  }
  el.className = 'rows';
  el.innerHTML = printers.map((p) => {
    const st = p.status || 'error';
    const state = printerState(st);
    const progress = p.printProgress !== undefined && p.printProgress !== null
      ? Math.min(100, Math.max(0, p.printProgress))
      : null;

    return '<div class="printer">' +
      '<div class="printer-head">' +
        '<span class="printer-avatar">' + escapeHtml(p.id) + '</span>' +
        '<span class="printer-id">' +
          '<span class="printer-name">Printer ' + escapeHtml(p.id) + '</span>' +
          '<span class="printer-ip">' + escapeHtml(p.ip) + '</span>' +
        '</span>' +
        pill(state.cls, state.glyph, state.label) +
      '</div>' +
      // When a printer is offline the "job" field is just the probe's excuse
      // ("unreachable"); the pill already says that, so don't repeat it.
      (p.job && p.job !== '-' && state !== OFFLINE_STATE
        ? '<div class="printer-job">' + escapeHtml(p.job) + '</div>'
        : '') +
      (progress !== null && st === 'busy'
        ? '<div class="progress-row">' +
            '<div class="progress-track" role="progressbar" aria-valuenow="' + Math.round(progress) + '" aria-valuemin="0" aria-valuemax="100">' +
              '<div class="progress-fill" style="width: ' + progress + '%"></div>' +
            '</div>' +
            '<span class="progress-value">' + Math.round(progress) + '%</span>' +
          '</div>'
        : '') +
      (st === 'needs_clearing'
        ? '<div class="assign-row"><button data-action="clear-bed" data-ip="' + escapeHtml(p.ip) + '" class="btn btn-warn" style="flex:1">Mark bed clear</button></div>'
        : '') +
      (st === 'free'
        ? '<div class="assign-row">' +
            '<select class="assign-select" data-ip="' + escapeHtml(p.ip) + '" aria-label="Job to assign to printer ' + escapeHtml(p.id) + '"' + (queue.length === 0 ? ' disabled' : '') + '>' +
              (queue.length === 0
                ? '<option value="">No queued jobs</option>'
                : queue.map((j) => '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.name) + '</option>').join('')) +
            '</select>' +
            '<button data-action="assign" data-ip="' + escapeHtml(p.ip) + '" class="btn btn-outline"' + (queue.length === 0 ? ' disabled' : '') + '>Assign</button>' +
          '</div>'
        : '') +
    '</div>';
  }).join('');
}

/* ---------- actions ---------- */

async function withButton(button, busyLabel, fn) {
  const label = button.innerHTML;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

async function assignJob(ip, button) {
  const card = button.closest('.printer');
  const select = card ? card.querySelector('.assign-select') : null;
  const jobId = select ? select.value : '';
  if (!jobId) {
    showDashboardFeedback('Please select a job to assign.');
    return;
  }
  await withButton(button, 'Assigning…', async () => {
    try {
      const res = await fetch('/api/printers/' + encodeURIComponent(ip) + '/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assignment failed');
      showDashboardFeedback('Job assigned to printer ' + ip + '.', 'success');
      applyStatus(data);
    } catch (err) {
      showDashboardFeedback('Could not assign job: ' + err.message);
      refreshStatus();
    }
  });
}

async function cancelJob(id, button) {
  await withButton(button, 'Working…', async () => {
    try {
      const res = await fetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Unknown error');
      showDashboardFeedback('Job removed.', 'success');
      refreshStatus();
    } catch (err) {
      showDashboardFeedback('Could not remove job: ' + err.message);
    }
  });
}

async function requeueJob(id, button) {
  await withButton(button, 'Working…', async () => {
    try {
      const res = await fetch('/api/jobs/' + encodeURIComponent(id) + '/requeue', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Unknown error');
      showDashboardFeedback('Job returned to the queue.', 'success');
      refreshStatus();
    } catch (err) {
      showDashboardFeedback('Could not requeue job: ' + err.message);
    }
  });
}

async function clearBed(ip, button) {
  await withButton(button, 'Clearing…', async () => {
    try {
      const res = await fetch('/api/clear-bed?ip=' + encodeURIComponent(ip), { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Unknown error');
      showDashboardFeedback('Bed marked clear. Printer is available.', 'success');
      refreshStatus();
    } catch (err) {
      showDashboardFeedback('Could not mark bed clear: ' + err.message);
    }
  });
}

async function scanNetwork(button) {
  await withButton(button, 'Scanning…', async () => {
    try {
      const res = await fetch('/api/discover');
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Scan failed');
      showDashboardFeedback('Printer scan complete.', 'success');
      refreshStatus();
    } catch (err) {
      showDashboardFeedback('Could not scan for printers: ' + err.message);
    }
  });
}

/* ---------- wiring ---------- */

nameInput.addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  renderInputState();
});

document.getElementById('submit-form').addEventListener('submit', handleFormSubmit);
document.getElementById('scan-btn').addEventListener('click', function () { scanNetwork(this); });

const autoDispatchCheck = document.getElementById('auto-dispatch-check');
autoDispatchCheck.addEventListener('change', async function () {
  const enabled = this.checked;
  if (enabled && !window.confirm('Enable auto-dispatch? Any waiting job may start immediately on an eligible free printer.')) {
    this.checked = false;
    return;
  }
  try {
    const res = await fetch('/api/auto-dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error('Failed to update auto-dispatch setting');
    showDashboardFeedback('Auto-dispatch ' + (enabled ? 'enabled' : 'disabled') + '.', 'success');
    applyStatus(await res.json());
  } catch (err) {
    showDashboardFeedback('Could not toggle auto-dispatch: ' + err.message);
    refreshStatus();
  }
});

function delegate(listId, handler) {
  document.getElementById(listId).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) handler(btn.getAttribute('data-action'), btn);
  });
}

delegate('queued-jobs-list', (action, btn) => {
  if (action === 'cancel' || action === 'delete') cancelJob(btn.getAttribute('data-id'), btn);
});

delegate('failed-jobs-list', (action, btn) => {
  const id = btn.getAttribute('data-id');
  if (action === 'requeue') requeueJob(id, btn);
  else if (action === 'cancel' || action === 'delete') cancelJob(id, btn);
});

delegate('printers-list', (action, btn) => {
  const ip = btn.getAttribute('data-ip');
  if (action === 'clear-bed') clearBed(ip, btn);
  else if (action === 'assign') assignJob(ip, btn);
});

renderInputState();
refreshStatus();
