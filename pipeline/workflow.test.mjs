import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { WorkflowManager, isPathInsideDir } from "./workflow.mjs";

const here = import.meta.dirname;
const OUT_DIR = path.join(here, "out");
const newTestWorkflowManager = (options = {}) => new WorkflowManager({ stateFile: false, ...options });

test("1 busy->free locks needs_clearing", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "test.gcode" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "busy");

  // Transition to free
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();

  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
});

test("2 terminal+filename is needs_clearing", async () => {
  const probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "finished.gcode" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
});

test("3 clear override survives stale terminal", async () => {
  const probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "finished.gcode" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");

  // Set clear override
  const clearRes = manager.clearBed("10.0.0.1");
  assert.equal(clearRes.ok, true);
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");

  // Stale terminal probe arrives
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");
});

test("4 new busy removes clear override", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "finished.gcode" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  manager.clearBed("10.0.0.1");
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");

  // New busy probe arrives
  probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "new_print.gcode" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "busy");

  // When print finishes (empty filename, device state 0), override is gone and locks needs_clearing
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
});

test("5 incomplete/error never eligible", async () => {
  const probeResult = {
    status: "unreachable",
    job: {}
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "error");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);
});

test("6 needs_clearing never eligible", async () => {
  const probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "finished.gcode" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);
});

test("7 free trusted printer is eligible", async () => {
  const probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), true);
});

test("8 FIFO add/remove/requeue and safe job lookup/download path containment", async () => {
  const manager = newTestWorkflowManager({ outDir: OUT_DIR });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const testGcode = path.join(OUT_DIR, "test_job_8.gcode");
  fs.writeFileSync(testGcode, "; test gcode");

  const job1 = manager.addJob({ name: "JOBONE", filename: "test_job_8.gcode", filepath: testGcode, seconds: 100, grams: 2 });
  const job2 = manager.addJob({ name: "JOBTWO", filename: "test_job_8.gcode", filepath: testGcode, seconds: 200, grams: 4 });

  assert.equal(manager.queue.length, 2);
  assert.equal(manager.queue[0].id, job1.id);
  assert.equal(manager.queue[1].id, job2.id);

  // DELETE job1
  const delRes = manager.deleteJob(job1.id);
  assert.equal(delRes.ok, true);
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, job2.id);

  // Simulate job2 failure
  const jobToFail = manager.queue.pop();
  jobToFail.status = "failed";
  jobToFail.error = "Simulated error";
  manager.failed.push(jobToFail);

  assert.equal(manager.failed.length, 1);

  // Requeue job2
  const requeueRes = manager.requeueJob(job2.id);
  assert.equal(requeueRes.ok, true);
  assert.equal(manager.failed.length, 0);
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, job2.id);

  // Safe job lookup
  const found = manager.getJobById(job2.id);
  assert.notEqual(found, null);
  assert.equal(found.id, job2.id);

  // Path containment tests
  assert.equal(isPathInsideDir(testGcode, OUT_DIR), true);
  assert.equal(isPathInsideDir(path.join(OUT_DIR, "../server.mjs"), OUT_DIR), false);
  assert.equal(isPathInsideDir("C:\\Windows\\System32\\cmd.exe", OUT_DIR), false);
});

test("9 dispatch success/failure using injected fake uploadAndPrint, ensuring no double dispatch and no real network.", async () => {
  const uploadCalls = [];
  const fakeUploader = async (ip, filepath) => {
    uploadCalls.push({ ip, filepath });
    if (ip === "10.0.0.FAIL") {
      throw new Error("Printer connection failed");
    }
    return { filename: path.basename(filepath), confirmed: true };
  };

  const probeResultFree = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };

  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: true,
    printers: [
      { id: "1", ip: "10.0.0.OK" },
      { id: "2", ip: "10.0.0.FAIL" }
    ],
    prober: async () => probeResultFree,
    uploader: fakeUploader
  });

  const testGcode = path.join(OUT_DIR, "test_job_9.gcode");
  fs.writeFileSync(testGcode, "; test gcode 9");

  const j1 = manager.addJob({ name: "JOBOK", filename: "test_job_9.gcode", filepath: testGcode });
  const j2 = manager.addJob({ name: "JOBFAIL", filename: "test_job_9.gcode", filepath: testGcode });

  await manager.updatePrinterStates();
  await manager.dispatchNextJobs();

  assert.equal(uploadCalls.length, 2);
  assert.equal(manager.queue.length, 0);

  // j1 should be active on 10.0.0.OK
  const active1 = manager.activeJobs.get("10.0.0.OK");
  assert.equal(active1.id, j1.id);
  assert.equal(active1.status, "active");

  // j2 should be failed on 10.0.0.FAIL
  assert.equal(manager.failed.length, 1);
  assert.equal(manager.failed[0].id, j2.id);
  assert.equal(manager.failed[0].error, "Printer connection failed");

  // Verify no double dispatch: while 10.0.0.OK has an active job, it's not eligible for another job
  assert.equal(manager.isEligibleForDispatch("10.0.0.OK"), false);
});

test("10 BUG 1 regression: unreachable probe preserves trusted transition history, sets status error, and later online probe restores eligibility", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult
  });

  // Step 1: Initial online free probe
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), true);
  assert.equal(manager.trustedPriorState.get("10.0.0.1").rawState, "free");

  // Step 2: Unreachable probe
  probeResult = { status: "unreachable", job: {} };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "error");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);
  // Old trusted snapshot remains stored
  assert.equal(manager.trustedPriorState.get("10.0.0.1").rawState, "free");

  // Step 3: Later complete online free probe restores eligibility
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), true);

  // Transition evidence preservation test across unreachable probes:
  // Step 4: Printer goes busy
  probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "busy.gcode" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "busy");

  // Step 5: Printer becomes unreachable during print
  probeResult = { status: "unreachable", job: {} };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "error");
  assert.equal(manager.trustedPriorState.get("10.0.0.1").rawState, "busy");

  // Step 6: Printer comes back online as free -> busy->free transition locks needs_clearing
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);
});

test("11 BUG 2 regression: dispatch receives stale free, confirms active remains preparing, busy marks seenBusy, terminal completes and retires", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: true,
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult,
    uploader: async () => ({ confirmed: true })
  });

  const testGcode = path.join(OUT_DIR, "test_job_11.gcode");
  fs.writeFileSync(testGcode, "; test 11");

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "free");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), true);

  const job = manager.addJob({ name: "STALE_FREE_TEST", filename: "test_job_11.gcode", filepath: testGcode });
  await manager.dispatchNextJobs();

  assert.equal(manager.activeJobs.has("10.0.0.1"), true);
  assert.equal(job.status, "active");
  assert.equal(job.seenBusy, false);

  // Stale free probe arrives after dispatch
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();
  // Active job remains, state is preparing, not free or eligible
  assert.equal(manager.activeJobs.has("10.0.0.1"), true);
  assert.equal(job.seenBusy, false);
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "preparing");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);

  // Printer reports busy
  probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "test_job_11.gcode" }
  };
  await manager.updatePrinterStates();
  assert.equal(manager.activeJobs.has("10.0.0.1"), true);
  assert.equal(job.seenBusy, true);
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "busy");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);

  // Terminal / free probe arrives after print completes
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();
  // Active job is retired to completed history
  assert.equal(manager.activeJobs.has("10.0.0.1"), false);
  assert.equal(job.status, "completed");
  assert.equal(manager.history.some((j) => j.id === job.id), true);
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "needs_clearing");
});

test("12 getPrinterStatus exposes Offline/Error vs Preparing distinctly and dispatch eligibility respects both", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: true,
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult,
    uploader: async () => ({ confirmed: true })
  });

  // Free printer status
  await manager.updatePrinterStates();
  const freeStatus = manager.getPrinterStatus("10.0.0.1");
  assert.equal(freeStatus.status, "free");
  assert.equal(freeStatus.telemetryComplete, true);
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), true);

  // Dispatch job -> enters Preparing state when stale free probe arrives
  const testGcode = path.join(OUT_DIR, "test_job_12.gcode");
  fs.writeFileSync(testGcode, "; test 12");
  manager.addJob({ name: "PREPARING_TEST", filename: "test_job_12.gcode", filepath: testGcode });
  await manager.dispatchNextJobs();
  await manager.updatePrinterStates();

  const preparingStatus = manager.getPrinterStatus("10.0.0.1");
  assert.equal(preparingStatus.status, "preparing");
  assert.equal(preparingStatus.telemetryComplete, true);
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);

  // Unreachable probe -> enters Error state
  probeResult = { status: "unreachable", job: {} };
  await manager.updatePrinterStates();

  const errorStatus = manager.getPrinterStatus("10.0.0.1");
  assert.equal(errorStatus.status, "error");
  assert.equal(errorStatus.telemetryComplete, false);
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);
});

test("13 default-off autoDispatch does not dispatch during runSweep", async () => {
  const probeResultFree = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResultFree,
    uploader: async () => ({ confirmed: true })
  });

  const testGcode = path.join(OUT_DIR, "test_job_13.gcode");
  fs.writeFileSync(testGcode, "; test 13");

  const job = manager.addJob({ name: "DEFAULT_OFF_TEST", filename: "test_job_13.gcode", filepath: testGcode });

  assert.equal(manager.autoDispatch, false);
  await manager.runSweep();

  // Job remains in queue, not dispatched
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, job.id);
  assert.equal(manager.activeJobs.size, 0);

  // When autoDispatch is enabled, runSweep dispatches it
  manager.setAutoDispatch(true);
  assert.equal(manager.autoDispatch, true);
  await manager.runSweep();

  assert.equal(manager.queue.length, 0);
  assert.equal(manager.activeJobs.has("10.0.0.1"), true);
  assert.equal(manager.activeJobs.get("10.0.0.1").id, job.id);
});

test("14 manual assignment only targets the selected eligible printer and job", async () => {
  const probeResultFree = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const uploadCalls = [];
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: false,
    printers: [
      { id: "1", ip: "10.0.0.1" },
      { id: "2", ip: "10.0.0.2" }
    ],
    prober: async () => probeResultFree,
    uploader: async (ip, filepath) => {
      uploadCalls.push({ ip, filepath });
      return { confirmed: true };
    }
  });

  await manager.updatePrinterStates();

  const testGcode = path.join(OUT_DIR, "test_job_14.gcode");
  fs.writeFileSync(testGcode, "; test 14");

  const j1 = manager.addJob({ name: "JOB_A", filename: "test_job_14.gcode", filepath: testGcode });
  const j2 = manager.addJob({ name: "JOB_B", filename: "test_job_14.gcode", filepath: testGcode });

  // Manually assign J2 specifically to printer 2 (10.0.0.2)
  const assignRes = await manager.assignJobToPrinter("10.0.0.2", j2.id);

  assert.equal(assignRes.ok, true);
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].ip, "10.0.0.2");

  // J2 is active on printer 2
  assert.equal(manager.activeJobs.has("10.0.0.2"), true);
  assert.equal(manager.activeJobs.get("10.0.0.2").id, j2.id);

  // Printer 1 remains untouched with no active job
  assert.equal(manager.activeJobs.has("10.0.0.1"), false);

  // J1 is still in queue as the sole queued job
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, j1.id);
});

test("15 busy printer cannot be assigned", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "running.gcode" }
  };
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: false,
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult,
    uploader: async () => ({ confirmed: true })
  });

  await manager.updatePrinterStates();
  assert.equal(manager.getPrinterStatus("10.0.0.1").status, "busy");
  assert.equal(manager.isEligibleForDispatch("10.0.0.1"), false);

  const testGcode = path.join(OUT_DIR, "test_job_15.gcode");
  fs.writeFileSync(testGcode, "; test 15");
  const job = manager.addJob({ name: "BUSY_ASSIGN_TEST", filename: "test_job_15.gcode", filepath: testGcode });

  const assignRes = await manager.assignJobToPrinter("10.0.0.1", job.id);
  assert.equal(assignRes.ok, false);
  assert.equal(assignRes.conflict, true);

  // Job remains queued
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, job.id);
});

test("16 completed active job is retired to history and absent from queue", async () => {
  let probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  const manager = newTestWorkflowManager({
    outDir: OUT_DIR,
    autoDispatch: false,
    printers: [{ id: "1", ip: "10.0.0.1" }],
    prober: async () => probeResult,
    uploader: async () => ({ confirmed: true })
  });

  await manager.updatePrinterStates();
  const testGcode = path.join(OUT_DIR, "test_job_16.gcode");
  fs.writeFileSync(testGcode, "; test 16");
  const job = manager.addJob({ name: "COMPLETED_JOB_TEST", filename: "test_job_16.gcode", filepath: testGcode });

  // Manually assign job to printer
  const assignRes = await manager.assignJobToPrinter("10.0.0.1", job.id);
  assert.equal(assignRes.ok, true);
  assert.equal(manager.queue.length, 0);

  // Printer becomes busy
  probeResult = {
    status: "online",
    job: { deviceState: 1, printState: 1, printFileName: "test_job_16.gcode" }
  };
  await manager.updatePrinterStates();
  assert.equal(job.seenBusy, true);

  // Printer finishes print
  probeResult = {
    status: "online",
    job: { deviceState: 0, printState: 0, printFileName: "" }
  };
  await manager.updatePrinterStates();

  // Job is retired to history as completed and absent from queue
  assert.equal(job.status, "completed");
  assert.equal(manager.activeJobs.has("10.0.0.1"), false);
  assert.equal(manager.history.some((j) => j.id === job.id), true);
  assert.equal(manager.queue.some((j) => j.id === job.id), false);
  assert.equal(manager.queue.length, 0);

  // Subsequent runSweep with autoDispatch true does not re-add job to queue
  manager.setAutoDispatch(true);
  await manager.runSweep();
  assert.equal(manager.queue.length, 0);
});

test("17 stale unreachable printers are pruned, but never one holding a job", async () => {
  let probeResult = { status: "online", job: { deviceState: 0, printState: 0, printFileName: "" } };
  const manager = newTestWorkflowManager({
    printers: [{ id: "A", ip: "10.0.0.1" }, { id: "B", ip: "10.0.0.2" }],
    prober: async () => probeResult,
    staleAfterMs: 60000
  });

  // Both seen online: nothing is stale yet.
  await manager.updatePrinterStates();
  assert.equal(manager.printers.length, 2);

  // Both go dark. Still inside the window, so both stay.
  probeResult = { status: "unreachable", job: {} };
  await manager.updatePrinterStates();
  assert.equal(manager.printers.length, 2);

  // Age the evidence past the window without waiting on the clock.
  for (const ip of ["10.0.0.1", "10.0.0.2"]) {
    const health = manager.probeHealth.get(ip);
    manager.probeHealth.set(ip, { ...health, lastSeenAt: Date.now() - 120000, firstProbedAt: Date.now() - 120000 });
  }

  // A printer holding an active job is exempt — pruning it would orphan the job.
  manager.activeJobs.set("10.0.0.2", { id: "job_x", name: "X", status: "active" });

  const dropped = manager.pruneStalePrinters();
  assert.deepEqual(dropped.map((p) => p.ip), ["10.0.0.1"]);
  assert.deepEqual(manager.printers.map((p) => p.ip), ["10.0.0.2"]);
  assert.equal(manager.probeHealth.has("10.0.0.1"), false);

  // A rescan brings a pruned printer back with a clean staleness clock.
  manager.setPrinters([{ id: "A", ip: "10.0.0.1" }, { id: "B", ip: "10.0.0.2" }]);
  assert.equal(manager.pruneStalePrinters().length, 0);
  assert.equal(manager.printers.length, 2);
});

test("18 completed history is a bounded queue while lifetime totals keep counting", async () => {
  const manager = newTestWorkflowManager({ historyLimit: 5 });

  for (let i = 1; i <= 7; i++) {
    manager.recordCompletion({ id: `job_${i}`, name: `NAME${i}`, status: "completed", grams: 2 });
  }

  // Oldest two popped off, newest five kept.
  assert.equal(manager.history.length, 5);
  assert.deepEqual(manager.history.map((j) => j.id), ["job_3", "job_4", "job_5", "job_6", "job_7"]);

  // Totals survive the pop, and the public list is newest-first.
  const status = manager.getStatusPublic();
  assert.equal(status.completedTotal, 7);
  assert.equal(status.completedGrams, 14);
  assert.deepEqual(status.completed.map((j) => j.id), ["job_7", "job_6", "job_5", "job_4", "job_3"]);
});
