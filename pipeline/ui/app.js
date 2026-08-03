const byId = (id) => document.getElementById(id);

async function refreshStatus() {
  const indicator = byId('live-indicator');
  const label = byId('live-label');
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    const printers = status.printers || [];
    byId('stat-queued').textContent = String((status.queue || []).length);
    byId('stat-printing').textContent = String(Object.keys(status.activeJobs || {}).length);
    byId('stat-completed').textContent = String(status.completedTotal || 0);
    byId('stat-attention').textContent = String(printers.filter((p) =>
      ['error', 'offline', 'needs_clearing'].includes(p.status)).length);
    if (indicator) indicator.dataset.state = 'live';
    if (label) label.textContent = 'Live';
  } catch {
    if (indicator) indicator.dataset.state = 'offline';
    if (label) label.textContent = 'Disconnected';
  }
}

refreshStatus();
setInterval(refreshStatus, 4500);
