// Pure helpers for the dashboard — no DOM, no fetch, no globals.
//
// Split out of app.js so they can be imported by a Node test without a browser
// or a DOM library. app.js keeps everything that touches the page; this file is
// the part with actual rules in it: what counts as a valid name, and how raw
// seconds and timestamps become the text on a queue row.

// Mirrors the server's NAME_RE (/^[A-Z0-9]{2,10}$/ in server.mjs). The browser
// check exists to give an instant message, not to be the gate — the server
// re-validates because the name is interpolated into an OpenSCAD argument.
export function validate(raw) {
  const cleaned = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return { ok: false, msg: 'Enter 2 to 10 letters or numbers', type: 'hint' };
  if (/[^A-Z0-9]/i.test(raw)) return { ok: false, msg: 'Only letters A-Z and digits 0-9 allowed', type: 'invalid' };
  if (cleaned.length < 2) return { ok: false, msg: 'Name must be at least 2 characters', type: 'invalid' };
  if (cleaned.length > 10) return { ok: false, msg: 'Name cannot exceed 10 characters', type: 'invalid' };
  return { ok: true, msg: 'Ready for geometry check', type: 'valid', cleaned };
}

export function formatTime(sec) {
  if (!sec) return null;
  const mins = Math.round(sec / 60);
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

export function relativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
