// Unit tests for the dashboard's pure helpers (pipeline/ui/lib.js).
//
// The rest of app.js is DOM wiring and is verified against a running page. This
// file covers the part with rules in it — and lives in pipeline/ rather than
// pipeline/ui/ so the existing `pipeline/*.test.mjs` glob picks it up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, formatTime, relativeTime, plural, escapeHtml } from "./ui/lib.js";

// The gate that actually matters, copied from server.mjs. If the browser check
// ever drifts looser than this, users get "Ready for geometry check" followed by
// a 400 from the server.
const SERVER_NAME_RE = /^[A-Z0-9]{2,10}$/;

test("validate accepts nothing the server would reject", () => {
  const candidates = [
    "AS", "ASHIM", "MIKE99", "0123456789", "A1", "ZZZZZZZZZZ",
    "A", "", "ELEVENCHARS", "AB-CD", "A B", "ashim", "Ashim1",
    "AB!", "  ", "ÅSHIM", '";cube(99);"', "AB\nCD"
  ];

  for (const raw of candidates) {
    const result = validate(raw);
    if (result.ok) {
      assert.match(result.cleaned, SERVER_NAME_RE, `client accepted "${raw}" but the server would 400 it`);
    }
  }
});

test("validate reports why, not just that, a name is wrong", () => {
  assert.deepEqual(validate(""), {
    ok: false, msg: "Enter 2 to 10 letters or numbers", type: "hint"
  }, "an empty field is a hint, not an error — nothing is wrong yet");

  assert.equal(validate("A").type, "invalid");
  assert.match(validate("A").msg, /at least 2/);

  assert.equal(validate("ELEVENCHAR").ok, true, "10 characters is the boundary and is allowed");
  assert.equal(validate("ELEVENCHARS").ok, false, "11 is not");
  assert.match(validate("ELEVENCHARS").msg, /exceed 10/);

  assert.match(validate("AB-CD").msg, /Only letters/, "punctuation is named specifically");
  assert.match(validate("A B").msg, /Only letters/);
});

test("validate uppercases, and lowercase input is accepted rather than rejected", () => {
  const result = validate("ashim");
  assert.equal(result.ok, true);
  assert.equal(result.cleaned, "ASHIM", "the printer only ever prints uppercase");
});

test("formatTime turns slicer seconds into the queue row's duration", () => {
  assert.equal(formatTime(1023), "17 min", "the common keychain");
  assert.equal(formatTime(3600), "1h");
  assert.equal(formatTime(5400), "1h 30m");
  assert.equal(formatTime(3660), "1h 1m");
  assert.equal(formatTime(59), "1 min", "under a minute still rounds to a printable figure");

  // null, not "0 min" — meta() drops empty cells, so an unsliced job shows a
  // blank column instead of claiming it takes no time.
  assert.equal(formatTime(0), null);
  assert.equal(formatTime(null), null);
  assert.equal(formatTime(undefined), null);
});

test("relativeTime describes age at the granularity a farm operator cares about", () => {
  const ago = (ms) => relativeTime(new Date(Date.now() - ms).toISOString());

  assert.equal(ago(5 * 1000), "just now");
  assert.equal(ago(5 * 60 * 1000), "5m ago");
  assert.equal(ago(3 * 60 * 60 * 1000), "3h ago");
  assert.equal(ago(6 * 24 * 60 * 60 * 1000), "6d ago");

  assert.equal(relativeTime(null), null, "a missing timestamp renders nothing");
  assert.equal(relativeTime("not a date"), null, "an unparseable one does too, rather than NaN");

  // Clock skew between the server and the kiosk must not produce "-3m ago".
  assert.equal(relativeTime(new Date(Date.now() + 60_000).toISOString()), "just now");
});

test("plural picks the right word for the printing tile", () => {
  assert.equal(plural(1, "printer", "printers"), "printer");
  assert.equal(plural(2, "printer", "printers"), "printers");
  assert.equal(plural(0, "printer", "printers"), "printers");
});

test("escapeHtml neutralises a name before it is concatenated into a row", () => {
  // Job names reach the DOM through string concatenation, so this is the only
  // thing standing between a crafted name and script execution on the kiosk.
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
  );
  assert.equal(escapeHtml("A&B"), "A&amp;B");
  assert.equal(escapeHtml(null), "", "null renders as empty, not the text 'null'");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});
