// HTTP-level tests for the KeyForge web interface.
//
// createKeyForgeServer accepts an injected WorkflowManager, so these boot a real
// server on an ephemeral port and talk to it with fetch. Nothing is stubbed at
// the route layer — what is asserted is what a browser would actually receive.
//
// POST /api/jobs is only exercised down its rejection paths on purpose: the
// success path shells out to print-name.mjs, which launches OpenSCAD and
// PrusaSlicer. A test suite must not need a 3D toolchain installed to run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createKeyForgeServer } from "./server.mjs";
import { WorkflowManager } from "./workflow.mjs";

const here = import.meta.dirname;
const OUT = path.join(here, "out");

// The server resolves downloads against its own pipeline/out, so a fixture job
// has to live there for the containment check to pass.
// `await` matters here: returning the promise from inside try{} would run the
// finally — deleting the fixture — before the request under test ever ran.
async function withFixtureGcode(name, run) {
  mkdirSync(OUT, { recursive: true });
  const filename = `kf_${name.toLowerCase()}__test.gcode`;
  const filepath = path.join(OUT, filename);
  writeFileSync(filepath, ";KEYFORGE_TEST\nG1 X10 Y10\n");
  try { return await run({ filename, filepath }); } finally { rmSync(filepath, { force: true }); }
}

async function withServer(run) {
  const manager = new WorkflowManager({ stateFile: false, printers: [], prober: async (p) => ({ ...p, status: "unreachable" }) });
  const { server } = createKeyForgeServer({ workflowManager: manager });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, manager);
  } finally {
    manager.stopPolling();
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ---------- static dashboard ---------- */

test("serves the dashboard and its assets with the right content types", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /KeyForge/);

    const css = await fetch(`${base}/ui/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const js = await fetch(`${base}/ui/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);

    assert.equal((await fetch(`${base}/ui/does-not-exist.css`)).status, 404);
  });
});

test("the static route cannot be walked out of pipeline/ui", async () => {
  await withServer(async (base) => {
    // Encoded traversal — the raw form is normalised away by the URL parser, so
    // this is the version that actually reaches decodeURIComponent.
    const escaped = await fetch(`${base}/ui/%2e%2e%2fworkflow.mjs`);
    assert.equal(escaped.status, 404);
    assert.doesNotMatch(await escaped.text(), /WorkflowManager/, "server source must never be served");

    const deeper = await fetch(`${base}/ui/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.equal(deeper.status, 404);

    // Extension allowlist: even inside ui/, only html/css/js/svg are served.
    assert.equal((await fetch(`${base}/ui/favicon.svg`)).status, 200, "svg is allowed");

    const badEncoding = await fetch(`${base}/ui/%ZZ`);
    assert.equal(badEncoding.status, 400, "malformed percent-encoding is rejected, not crashed on");
  });
});

/* ---------- status ---------- */

test("GET /api/status returns the shape the dashboard polls for", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);

    const body = await res.json();
    for (const key of ["queue", "printers", "autoDispatch", "completedTotal", "completedGrams"]) {
      assert.ok(key in body, `status is missing "${key}", which the dashboard reads`);
    }
    assert.ok(Array.isArray(body.queue));
  });
});

/* ---------- job creation guardrails ---------- */

test("POST /api/jobs rejects bad names before shelling out to the toolchain", async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    for (const [label, body] of [
      ["too short", { name: "A" }],
      ["too long", { name: "ELEVENCHARS" }],
      ["punctuation", { name: "AB-CD" }],
      ["spaces", { name: "A B" }],
      ["missing", {}],
      // The name is interpolated into an OpenSCAD -D argument, so quotes and
      // semicolons must never get past this check.
      ["injection", { name: '";cube(99);"' }]
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, `${label} should be rejected`);
      assert.match((await res.json()).error, /bad name/);
    }
  });
});

/* ---------- job lifecycle over HTTP ---------- */

test("a queued job can be downloaded and deleted through the API", async () => {
  await withServer(async (base, manager) => {
    await withFixtureGcode("DLTEST", async ({ filename, filepath }) => {
      const job = manager.addJob({ name: "DLTEST", filename, filepath, seconds: 600, grams: 2.5 });

      const dl = await fetch(`${base}/api/jobs/${job.id}/gcode`);
      assert.equal(dl.status, 200);
      assert.match(await dl.text(), /KEYFORGE_TEST/, "serves the real file from pipeline/out");

      const del = await fetch(`${base}/api/jobs/${job.id}`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.equal((await del.json()).ok, true);

      const after = await (await fetch(`${base}/api/status`)).json();
      assert.equal(after.queue.find((j) => j.id === job.id), undefined, "gone from the queue");
    });
  });
});

test("unknown job ids are 404s, not crashes", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/jobs/nope/gcode`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/nope`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/nope/requeue`, { method: "POST" })).status, 404);
  });
});

/* ---------- auto-dispatch ---------- */

test("POST /api/auto-dispatch toggles the flag and echoes fresh status", async () => {
  await withServer(async (base, manager) => {
    const set = (enabled) => fetch(`${base}/api/auto-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled })
    });

    assert.equal(manager.autoDispatch, false, "off by default — it starts real prints");

    const on = await set(true);
    assert.equal(on.status, 200);
    assert.equal((await on.json()).autoDispatch, true, "response carries the new status, so the UI need not re-poll");
    assert.equal(manager.autoDispatch, true);

    const off = await set(false);
    assert.equal((await off.json()).autoDispatch, false);
    assert.equal(manager.autoDispatch, false);
  });
});

/* ---------- routing ---------- */

test("unknown routes and wrong methods fall through to 404", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/nonsense`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs`)).status, 404, "GET /api/jobs is not a route; only POST is");
    assert.equal((await fetch(`${base}/api/status`, { method: "POST" })).status, 404);
  });
});

test("POST /api/clear-bed requires an ip", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/clear-bed`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /missing ip/);

    const unknown = await fetch(`${base}/api/clear-bed?ip=10.0.0.99`, { method: "POST" });
    assert.equal(unknown.status, 404, "an ip that is not on the farm");
  });
});
