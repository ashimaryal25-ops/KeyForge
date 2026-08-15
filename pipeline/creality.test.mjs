// Unit tests for the stock Creality printer protocol.
//
// This module is the only thing that talks to real hardware, so the point of
// these tests is to pin the wire format exactly: the upload URL, and the
// `printprt:<dir>/<file>` command the printer expects on its :9999 socket. Get
// a character wrong there and the printer silently ignores the job.
//
// fetch and WebSocket are Node 22 globals, so they are stubbed rather than
// mocked through a library — no dependencies, same as the rest of the project.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadGcode, startPrint, confirmPrinting, uploadAndPrint } from "./creality.mjs";

// A stand-in for the printer's socket. Tests drive it by hand: `emit("open")`
// is the printer accepting the connection, `emit("message", …)` is telemetry.
class FakeWebSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = {};
    FakeWebSocket.last = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

// `await run(...)`, not `return run(...)` — the latter fires the finally (and
// deletes the file) while the request is still in flight.
async function withGcodeFile(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "keyforge-creality-"));
  const file = path.join(dir, "kf_ashim.gcode");
  writeFileSync(file, "G1 X10 Y10\n");
  try { return await run(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ---------- uploadGcode ---------- */

test("uploadGcode POSTs the file to the printer's own upload endpoint", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "" };
  };

  try {
    const filename = await withGcodeFile((file) => uploadGcode("10.0.0.5", file));
    assert.equal(filename, "kf_ashim.gcode", "returns the basename for the start command");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://10.0.0.5/upload/kf_ashim.gcode", "exact URL the stock firmware serves");
    assert.equal(calls[0].init.method, "POST");
    assert.ok(calls[0].init.body instanceof FormData, "multipart body");
    assert.ok(calls[0].init.signal, "carries an abort signal so a dead printer cannot hang the queue");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("uploadGcode surfaces an HTTP failure instead of reporting success", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 507, text: async () => "disk full" });

  try {
    await assert.rejects(
      () => withGcodeFile((file) => uploadGcode("10.0.0.5", file)),
      /upload failed: HTTP 507/,
      "a swallowed failure here would queue a print of a file that never landed"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("uploadGcode refuses a missing file before touching the network", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };

  try {
    await assert.rejects(() => uploadGcode("10.0.0.5", "/nope/missing.gcode"), /no such file/);
    assert.equal(called, false, "no request is made for a file that does not exist");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- startPrint ---------- */

test("startPrint sends the exact opGcodeFile command the firmware expects", async (t) => {
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    const promise = startPrint("10.0.0.5", "kf_ashim.gcode");
    const ws = FakeWebSocket.last;
    assert.equal(ws.url, "ws://10.0.0.5:9999/", "control socket, not the HTTP port");

    ws.emit("open");
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      method: "set",
      params: { opGcodeFile: "printprt:/usr/data/printer_data/gcodes/kf_ashim.gcode" }
    }, "the printprt: prefix and gcode directory are what make the printer act");

    // The module waits 1.5s after sending before it calls the start good.
    t.mock.timers.tick(1500);
    assert.equal(await promise, "printprt:/usr/data/printer_data/gcodes/kf_ashim.gcode");
    assert.equal(ws.closed, true, "socket is closed rather than left open per job");
  } finally {
    t.mock.timers.reset();
    globalThis.WebSocket = realWs;
  }
});

test("startPrint honours a custom gcode directory", async (t) => {
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    const promise = startPrint("10.0.0.5", "kf_ww.gcode", "/mnt/udisk");
    FakeWebSocket.last.emit("open");
    t.mock.timers.tick(1500);
    assert.equal(await promise, "printprt:/mnt/udisk/kf_ww.gcode");
  } finally {
    t.mock.timers.reset();
    globalThis.WebSocket = realWs;
  }
});

test("startPrint rejects on socket error and on timeout, never resolves silently", async (t) => {
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;

  try {
    const errored = startPrint("10.0.0.5", "kf_a.gcode");
    FakeWebSocket.last.emit("error");
    await assert.rejects(() => errored, /socket error/, "wrong IP or wrong network");

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = startPrint("10.0.0.5", "kf_b.gcode");
    t.mock.timers.tick(8000); // printer accepted the connection but never opened
    await assert.rejects(() => stalled, /start timeout/);
    t.mock.timers.reset();
  } finally {
    globalThis.WebSocket = realWs;
  }
});

/* ---------- confirmPrinting ---------- */

test("confirmPrinting polls status and confirms the expected file is actually printing", async () => {
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;

  try {
    const promise = confirmPrinting("10.0.0.5", "kf_ashim.gcode", 2000);
    const ws = FakeWebSocket.last;
    ws.emit("open");
    assert.deepEqual(JSON.parse(ws.sent[0]), { method: "get", params: { reqPrintObjects: {} } });

    // Noise the socket really sends, none of which is a confirmation.
    ws.emit("message", { data: "ok" });
    ws.emit("message", { data: "not json at all" });
    ws.emit("message", { data: JSON.stringify({ ModeCode: "heart_beat" }) });
    ws.emit("message", { data: JSON.stringify({ printFileName: "someone_elses.gcode", deviceState: 1 }) });

    ws.emit("message", { data: JSON.stringify({ printFileName: "/usr/data/printer_data/gcodes/kf_ashim.gcode", deviceState: 0 }) });
    ws.emit("message", { data: JSON.stringify({ deviceState: 1 }) });
    assert.equal(await promise, true, "combines split telemetry and requires the printing state");
    assert.equal(ws.closed, true);
  } finally {
    globalThis.WebSocket = realWs;
  }
});

test("confirmPrinting resolves false on timeout rather than hanging the dispatch", async () => {
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;

  try {
    // Real short timeout: this path must resolve, not reject, or a printer that
    // is mid-print but quiet would fail the whole job.
    assert.equal(await confirmPrinting("10.0.0.5", "kf_ashim.gcode", 30), false);
  } finally {
    globalThis.WebSocket = realWs;
  }
});

/* ---------- uploadAndPrint ---------- */

test("uploadAndPrint runs upload -> start -> confirm in order and reports both results", async (t) => {
  const order = [];
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;

  globalThis.fetch = async () => { order.push("upload"); return { ok: true, status: 200, text: async () => "" }; };
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url) {
      super(url);
      order.push(order.includes("start") ? "confirm" : "start");
      // Answer on the next tick so the awaits in uploadAndPrint actually run.
      setImmediate(() => {
        this.emit("open");
        this.emit("message", { data: JSON.stringify({ printFileName: "kf_ashim.gcode", deviceState: 1 }) });
      });
    }
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // startPrint's 1.5s settle timer has to be advanced once the socket opens.
  const ticker = setInterval(() => t.mock.timers.tick(1500), 1);

  try {
    const result = await withGcodeFile((file) => uploadAndPrint("10.0.0.5", file));
    assert.deepEqual(result, { filename: "kf_ashim.gcode", confirmed: true });
    assert.deepEqual(order, ["upload", "start", "confirm"], "upload must complete before the start command");
  } finally {
    clearInterval(ticker);
    t.mock.timers.reset();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
  }
});
