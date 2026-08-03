// Unit tests for the G-code parsing helpers in print-name.mjs.
//
// These four functions are what turn PrusaSlicer's output into the numbers the
// rest of KeyForge trusts: the "17 min" on a queue row, the filament total on
// the dashboard, and the time/bounds header the Creality screen reads while it
// prints. They are pure text-in / number-out, so they are cheap to pin down —
// the fixtures below are trimmed real slicer output, not invented syntax.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parsePrusaTimeSeconds,
  calculateBounds,
  updateAxis,
  addCrealityMetadata
} from "./print-name.mjs";

test("parsePrusaTimeSeconds reads every shape of the slicer's estimate", () => {
  const est = (v) => `; estimated printing time (normal mode) = ${v}\n`;

  assert.equal(parsePrusaTimeSeconds(est("17m 3s")), 1023, "the common case: a keychain");
  assert.equal(parsePrusaTimeSeconds(est("1h 30m 5s")), 5405);
  assert.equal(parsePrusaTimeSeconds(est("2h")), 7200, "hours alone");
  assert.equal(parsePrusaTimeSeconds(est("45m")), 2700, "minutes alone");
  assert.equal(parsePrusaTimeSeconds(est("30s")), 30, "seconds alone");

  // "2h 5s" has no minutes at all — the minute match must not latch onto some
  // other digit and silently add 120 seconds of imaginary print time.
  assert.equal(parsePrusaTimeSeconds(est("2h 5s")), 7205);
});

test("parsePrusaTimeSeconds returns 0 rather than NaN when the header is absent", () => {
  assert.equal(parsePrusaTimeSeconds("G1 X10 Y10\n"), 0, "no estimate line");
  assert.equal(parsePrusaTimeSeconds(""), 0, "empty file");
  // A NaN here would reach the dashboard and render as "NaN min".
  assert.equal(Number.isNaN(parsePrusaTimeSeconds("")), false);
});

test("calculateBounds measures the print from its movement lines only", () => {
  const gcode = [
    "; estimated printing time (normal mode) = 5m",
    "M104 S200 X999",          // a heater command — X999 must be ignored
    ";G1 X500 Y500",           // a comment — must be ignored
    "G1 X10.5 Y20.25 Z0.2 E1",
    "G0 X40 Y60 Z0.2",
    "G1 X25 Y30 Z2.6 E9"
  ].join("\n");

  const b = calculateBounds(gcode);
  assert.deepEqual(b, {
    minX: 10.5, maxX: 40,
    minY: 20.25, maxY: 60,
    minZ: 0.2, maxZ: 2.6
  }, "only G0/G1 lines count toward the bounding box");
});

test("calculateBounds handles negative coordinates and an empty print", () => {
  const negative = calculateBounds("G1 X-5 Y-12.5 Z0.2\nG1 X5 Y12.5 Z0.2");
  assert.equal(negative.minX, -5);
  assert.equal(negative.minY, -12.5);
  assert.equal(negative.maxX, 5);

  // With no moves the running min/max are still Infinity. They must be flushed
  // to 0, or the header would carry ";MINX:Infinity" to the printer.
  const empty = calculateBounds("; nothing but comments\nM104 S200");
  assert.deepEqual(empty, { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  for (const v of Object.values(empty)) assert.equal(Number.isFinite(v), true);
});

test("updateAxis widens the box only when the axis is actually on the line", () => {
  const bounds = { minX: Infinity, maxX: -Infinity };

  updateAxis(bounds, "X", "G1 X10 Y20");
  assert.deepEqual(bounds, { minX: 10, maxX: 10 }, "first value sets both ends");

  updateAxis(bounds, "X", "G1 X30 Y20");
  assert.deepEqual(bounds, { minX: 10, maxX: 30 });

  updateAxis(bounds, "X", "G1 Y50");
  assert.deepEqual(bounds, { minX: 10, maxX: 30 }, "a line without X leaves the box alone");

  updateAxis(bounds, "X", "G1 X-4.5 Y50");
  assert.equal(bounds.minX, -4.5, "negative decimals parse");
});

test("addCrealityMetadata prepends the header the printer screen reads, exactly once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keyforge-test-"));
  const file = path.join(dir, "kf_test.gcode");

  try {
    writeFileSync(file, [
      "; estimated printing time (normal mode) = 17m 3s",
      "; filament used [mm] = 1084.5",
      "; layer_height = 0.2",
      ";LAYER_CHANGE",
      "G1 X10 Y10 Z0.2 E1",
      ";LAYER_CHANGE",
      "G1 X30 Y40 Z0.4 E2"
    ].join("\n"));

    addCrealityMetadata(file);
    const once = readFileSync(file, "utf8");

    assert.match(once, /^;KEYFORGE_META:1/, "header goes first so the screen finds it");
    assert.match(once, /;TIME:1023/, "17m 3s converted to seconds");
    assert.match(once, /;Filament used: 1\.08m/, "mm converted to metres");
    assert.match(once, /;Layer height: 0\.2/);
    assert.match(once, /;LAYER_COUNT:2/, "counts ;LAYER_CHANGE markers");
    assert.match(once, /;MINX:10\.000/);
    assert.match(once, /;MAXY:40\.000/);
    assert.match(once, /G1 X10 Y10 Z0\.2 E1/, "the original G-code survives underneath");

    // Re-running must be a no-op. server.mjs can slice and post-process the same
    // file more than once; a second header would push the real one out of the
    // window the printer reads.
    addCrealityMetadata(file);
    assert.equal(readFileSync(file, "utf8"), once, "second call changes nothing");
    assert.equal((readFileSync(file, "utf8").match(/;KEYFORGE_META:1/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
