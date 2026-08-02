// Unit tests for the pure helpers workflow.mjs exports.
//
// workflow.test.mjs drives the WorkflowManager end to end; these go the other
// way and pin the small functions it is built out of. They are where the
// printer's raw telemetry gets turned into a decision, so the interesting
// cases here are the contradictory payloads a real Creality box actually
// sends — deviceState and printState disagreeing, fields missing entirely,
// states arriving as strings on one firmware and numbers on another.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  isPrinterPausedState,
  isPrinterPrintingState,
  isPrinterActiveState,
  isPrinterTerminalState,
  derivePrintProgress,
  isPathInsideDir,
  toPublicJob
} from "./workflow.mjs";

test("paused is detected from every field the firmware might use", () => {
  assert.equal(isPrinterPausedState(0, { printState: 5 }), true, "printState 5");
  assert.equal(isPrinterPausedState(0, { state: 5 }), true, "state is the older alias");
  assert.equal(isPrinterPausedState(5, {}), true, "deviceState 5");
  assert.equal(isPrinterPausedState("pause", {}), true);
  assert.equal(isPrinterPausedState("PAUSED", {}), true, "matching is case-insensitive");
  assert.equal(isPrinterPausedState(0, { pause: 1 }), true);
  assert.equal(isPrinterPausedState(0, { paused: 1 }), true);

  assert.equal(isPrinterPausedState(1, { printState: 1 }), false, "printing is not paused");
  assert.equal(isPrinterPausedState(0, {}), false, "idle is not paused");
  assert.equal(isPrinterPausedState(undefined, {}), false, "missing telemetry is not paused");
});

test("printing is detected, and a paused printer never counts as printing", () => {
  assert.equal(isPrinterPrintingState(0, { printState: 1 }), true);
  assert.equal(isPrinterPrintingState(1, {}), true, "deviceState alone is enough");
  assert.equal(isPrinterPrintingState("printing", {}), true);
  assert.equal(isPrinterPrintingState("PRINT", {}), true);

  // The contradiction that matters: the box reports deviceState 1 (a job is
  // loaded) while printState says 5 (paused). Pause has to win, or the farm
  // would read a paused machine as mid-print and never flag it for a human.
  assert.equal(isPrinterPrintingState(1, { printState: 5 }), false);
  assert.equal(isPrinterPausedState(1, { printState: 5 }), true);

  assert.equal(isPrinterPrintingState(0, {}), false);
});

test("active covers printing and paused, because both hold the bed", () => {
  assert.equal(isPrinterActiveState(1, { printState: 1 }), true, "printing");
  assert.equal(isPrinterActiveState(1, { printState: 5 }), true, "paused still occupies the printer");
  assert.equal(isPrinterActiveState(0, { printState: 0 }), false, "idle");
});

test("terminal states, and deviceState 1 vetoes all of them", () => {
  for (const code of [0, 2, 3, 4]) {
    assert.equal(isPrinterTerminalState(0, { printState: code }), true, `printState ${code}`);
  }
  for (const word of ["stopped", "complete", "completed", "failed", "abort", "aborted"]) {
    assert.equal(isPrinterTerminalState(0, { printState: word }), true, word);
  }
  assert.equal(isPrinterTerminalState(0, {}), true, "falls back to deviceState when payload is empty");

  // A live job outranks any terminal-looking code underneath it. Getting this
  // backwards would retire a job that is still printing.
  assert.equal(isPrinterTerminalState(1, { printState: 0 }), false);
  assert.equal(isPrinterTerminalState(1, {}), false);
  assert.equal(isPrinterTerminalState(0, { printState: 1 }), false, "1 is not terminal");
});

test("progress prefers the reported percentage, then layers, then zero", () => {
  assert.equal(derivePrintProgress(42, 10, 100), 42, "reported wins when it is usable");
  assert.equal(derivePrintProgress(0, 25, 100), 25, "falls back to the layer ratio");
  assert.equal(derivePrintProgress(null, 1, 3), 33, "ratio is rounded");
  assert.equal(derivePrintProgress(undefined, undefined, undefined), 0, "nothing usable is 0, not NaN");
  assert.equal(derivePrintProgress(0, 0, 0), 0, "a zero layer count never divides");

  assert.equal(derivePrintProgress(150, null, null), 100, "clamped high");
  assert.equal(derivePrintProgress(-5, null, null), 0, "clamped low");
  assert.equal(derivePrintProgress("60", null, null), 60, "numeric strings are accepted");
});

test("isPathInsideDir contains G-code downloads to the output directory", () => {
  const base = path.join(path.sep === "\\" ? "C:\\srv" : "/srv", "keyforge", "out");

  assert.equal(isPathInsideDir(path.join(base, "kf_ashim.gcode"), base), true);
  assert.equal(isPathInsideDir(path.join(base, "nested", "kf_a.gcode"), base), true);

  // The traversal this function exists to stop.
  assert.equal(isPathInsideDir(path.join(base, "..", "..", "secrets.env"), base), false);

  // A sibling directory that merely starts with the same characters. This is
  // why the check appends a separator before comparing — a bare startsWith
  // would let "out-public" pass as being inside "out".
  assert.equal(isPathInsideDir(base + "-public" + path.sep + "leak.gcode", base), false);

  assert.equal(isPathInsideDir(base, base), false, "the directory is not inside itself");
  assert.equal(isPathInsideDir("", base), false);
  assert.equal(isPathInsideDir(path.join(base, "a.gcode"), ""), false);
});

test("toPublicJob is a whitelist, so internal bookkeeping cannot reach the API", () => {
  const internal = {
    id: "job_1",
    name: "ASHIM",
    createdAt: "2026-08-01T10:00:00.000Z",
    status: "queued",
    seconds: 730,
    grams: 2.71,
    filename: "kf_ashim.gcode",
    // None of the below should ever be served to the browser.
    filepath: "C:\\srv\\keyforge\\out\\kf_ashim.gcode",
    seenBusy: true,
    dispatchAttempts: 2
  };

  const pub = toPublicJob(internal);

  assert.deepEqual(Object.keys(pub).sort(), [
    "createdAt", "downloadUrl", "filename", "grams", "id", "name", "seconds", "status"
  ], "exactly the public shape — no filepath, no internal flags");
  assert.equal(pub.downloadUrl, "/api/jobs/job_1/gcode", "download URL is derived from the id");
});

test("toPublicJob defaults missing figures to null and adds optionals only when set", () => {
  const bare = toPublicJob({ id: "job_2", name: "WW", status: "queued", filename: "kf_ww.gcode" });
  assert.equal(bare.seconds, null, "an unsliced job reports null, not undefined");
  assert.equal(bare.grams, null);
  assert.equal("error" in bare, false);
  assert.equal("printerIp" in bare, false);
  assert.equal("completedAt" in bare, false);

  const finished = toPublicJob({
    id: "job_3", name: "MIKE", status: "failed", filename: "kf_mike.gcode",
    error: "upload refused", printerIp: "192.168.137.44", completedAt: "2026-08-02T09:00:00.000Z"
  });
  assert.equal(finished.error, "upload refused");
  assert.equal(finished.printerIp, "192.168.137.44");
  assert.equal(finished.completedAt, "2026-08-02T09:00:00.000Z");

  assert.equal(toPublicJob(null), null, "a missing job is null, never a throw");
});
