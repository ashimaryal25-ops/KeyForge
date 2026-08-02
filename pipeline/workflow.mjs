// KeyForge Farm & Queue Workflow State Machine (Node 22 built-ins, 0 external runtime deps).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { uploadAndPrint as defaultUploadAndPrint } from "./creality.mjs";

export function isPrinterPausedState(deviceState, payload = {}) {
  const normalized = String(deviceState ?? "").toLowerCase();
  const printState = payload.printState ?? payload.state;
  return Number(printState) === 5
    || Number(deviceState) === 5
    || normalized === "pause"
    || normalized === "paused"
    || Number(payload.pause) === 1
    || Number(payload.paused) === 1;
}

export function isPrinterPrintingState(deviceState, payload = {}) {
  const normalized = String(deviceState ?? "").toLowerCase();
  const printState = payload.printState ?? payload.state;
  return Number(printState) === 1
    || (Number(deviceState) === 1 && Number(printState) !== 5)
    || normalized === "print"
    || normalized === "printing";
}

export function isPrinterActiveState(deviceState, payload = {}) {
  return isPrinterPrintingState(deviceState, payload) || isPrinterPausedState(deviceState, payload);
}

const NUMERIC_TERMINAL_STATES = new Set([0, 2, 3, 4]);

export function isPrinterTerminalState(deviceState, payload = {}) {
  const printState = payload.printState ?? payload.state ?? deviceState;
  const normalized = String(printState ?? "").toLowerCase();
  if (Number(deviceState) === 1) return false;
  return NUMERIC_TERMINAL_STATES.has(Number(printState))
    || ["stopped", "complete", "completed", "failed", "abort", "aborted"].includes(normalized);
}

export function derivePrintProgress(printProgress, layer, totalLayer) {
  const reported = Number(printProgress);
  const currentLayer = Number(layer);
  const layerCount = Number(totalLayer);

  if (Number.isFinite(reported) && reported > 0) {
    return Math.max(0, Math.min(100, reported));
  }

  if (
    Number.isFinite(currentLayer)
    && Number.isFinite(layerCount)
    && currentLayer > 0
    && layerCount > 0
  ) {
    return Math.max(0, Math.min(100, Math.round((currentLayer / layerCount) * 100)));
  }

  return Number.isFinite(reported)
    ? Math.max(0, Math.min(100, reported))
    : 0;
}

export function isPathInsideDir(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const resolvedBase = path.resolve(baseDir).toLowerCase();
  const resolvedTarget = path.resolve(targetPath).toLowerCase();
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedTarget.startsWith(baseWithSep);
}

export function defaultProbe(printer, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const state = {};
    let settled = false, ws, collectTimer;
    const done = (status, job) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(collectTimer);
      try { ws?.close(); } catch {}
      resolve({ ...printer, status: status || "online", job: status ? job : state });
    };
    const timer = setTimeout(() => done("unreachable", "timeout"), timeoutMs);
    try { ws = new WebSocket(`ws://${printer.ip}:9999/`); }
    catch { return done("unreachable", "socket error"); }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ method: "get", params: { reqPrintObjects: 1 } }));
      ws.send(JSON.stringify({ method: "get", params: { ReqPrinterPara: 1 } }));
    });
    ws.addEventListener("message", (ev) => {
      const t = typeof ev.data === "string" ? ev.data : "";
      if (!t || t === "ok") return;
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.ModeCode === "heart_beat") return;
      Object.assign(state, m);
      if (!collectTimer) collectTimer = setTimeout(() => done(), 400);
    });
    ws.addEventListener("error", () => done("unreachable", "connection error"));
  });
}

let jobCounter = 0;

export function toPublicJob(job) {
  if (!job) return null;
  const pub = {
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    status: job.status,
    seconds: job.seconds ?? null,
    grams: job.grams ?? null,
    filename: job.filename,
    downloadUrl: `/api/jobs/${job.id}/gcode`
  };
  if (job.error) pub.error = job.error;
  if (job.printerIp) pub.printerIp = job.printerIp;
  if (job.completedAt) pub.completedAt = job.completedAt;
  return pub;
}

export class WorkflowManager {
  constructor(options = {}) {
    this.outDir = options.outDir || path.join(import.meta.dirname, "out");
    this.printers = options.printers ? [...options.printers] : [];
    this.queue = [];
    this.failed = [];
    this.history = [];
    this.activeJobs = new Map(); // ip -> job
    this.dispatchingPrinters = new Set(); // ip
    this.probeHealth = new Map(); // ip -> health record
    this.trustedPriorState = new Map(); // ip -> snapshot
    this.manualOverrides = new Map(); // ip -> 'needs_clearing' | 'free'
    this.autoDispatch = Boolean(options.autoDispatch ?? false);
    this.stateFile = options.stateFile === false ? null : (options.stateFile || path.join(this.outDir, "workflow-state.json"));
    this.prober = options.prober || defaultProbe;
    this.uploader = options.uploader || defaultUploadAndPrint;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    // A printer unreachable for this long is dropped from the farm list — a
    // dead IP from an old scan shouldn't sit there forever pretending to be a
    // printer. Re-run discovery to bring it back.
    this.staleAfterMs = options.staleAfterMs ?? 180000;
    // Completed jobs are a bounded queue: newest in, oldest out. Lifetime
    // counters are kept separately so the summary tiles stay truthful.
    this.historyLimit = options.historyLimit ?? 5;
    this.completedCount = 0;
    this.completedGrams = 0;
    this.pollingTimer = null;
    this.pollingGeneration = 0;
    this.isSweeping = false;
    this.restoreState();
  }

  restoreState() {
    if (!this.stateFile) return;
    if (!existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      this.autoDispatch = Boolean(saved.autoDispatch);
      const restoreJob = (job, status) => {
        if (!job?.id || !job.filename || !isPathInsideDir(path.join(this.outDir, job.filename), this.outDir)) return null;
        return { ...job, filepath: path.join(this.outDir, job.filename), status };
      };
      this.queue = (saved.queue || []).map((job) => restoreJob(job, "queued")).filter(Boolean);
      this.failed = (saved.failed || []).map((job) => restoreJob(job, "failed")).filter(Boolean);
      // Printer IPs are not persisted, so a job that was mid-print cannot be
      // re-bound to its printer across a restart. Park it in failed rather
      // than silently dropping it — the dashboard can requeue it once a scan
      // has found the farm again.
      for (const job of Object.values(saved.activeJobs || {})) {
        const restored = restoreJob(job, "failed");
        if (restored) this.failed.push({ ...restored, printerIp: null, error: "server restarted mid-print; re-scan and requeue" });
      }
      this.history = (saved.history || []).map((job) => restoreJob(job, job.status || "completed")).filter(Boolean).slice(-this.historyLimit);
      // State files written before the counters existed only know what is still
      // in the (bounded) history, so fall back to that.
      this.completedCount = Number.isFinite(saved.completedCount) ? saved.completedCount : this.history.length;
      this.completedGrams = Number.isFinite(saved.completedGrams)
        ? saved.completedGrams
        : Number(this.history.reduce((sum, job) => sum + (job.grams || 0), 0).toFixed(2));
    } catch {
      // A corrupt local state file must never prevent the dashboard from starting.
    }
  }

  persistState() {
    if (!this.stateFile) return;
    const pack = (job) => ({ ...job, filepath: undefined });
    const activeJobs = Object.fromEntries(Array.from(this.activeJobs.entries(), ([ip, job]) => [ip, pack(job)]));
    const snapshot = {
      autoDispatch: this.autoDispatch,
      queue: this.queue.map(pack),
      failed: this.failed.map(pack),
      activeJobs,
      history: this.history.map(pack),
      completedCount: this.completedCount,
      completedGrams: this.completedGrams
    };
    const temporary = this.stateFile + ".tmp";
    writeFileSync(temporary, JSON.stringify(snapshot), "utf8");
    renameSync(temporary, this.stateFile);
  }

  setAutoDispatch(enabled) {
    this.autoDispatch = Boolean(enabled);
    this.persistState();
    return this.autoDispatch;
  }

  setPrinters(nextPrinters) {
    this.printers = [...nextPrinters];
    // A fresh list is fresh evidence: an IP that was pruned as stale gets a
    // clean slate rather than inheriting the old countdown.
    for (const printer of this.printers) {
      const health = this.probeHealth.get(printer.ip);
      if (!health) this.probeHealth.set(printer.ip, { isOnline: false, telemetryComplete: false, status: "unknown", firstProbedAt: Date.now(), lastSeenAt: null });
    }
  }

  // Newest completion in, oldest out. The lifetime counters are what the
  // summary tiles read, so popping the list never loses the totals.
  recordCompletion(job) {
    this.completedCount += 1;
    this.completedGrams = Number((this.completedGrams + (job.grams || 0)).toFixed(2));
    this.history.push(job);
    while (this.history.length > this.historyLimit) this.history.shift();
  }

  // Drops printers that have been unreachable past staleAfterMs. A printer
  // holding an active job or mid-dispatch is never dropped — losing it would
  // orphan the job.
  pruneStalePrinters(now = Date.now()) {
    if (!this.staleAfterMs || !this.printers.length) return [];

    const dropped = [];
    const kept = this.printers.filter((printer) => {
      if (this.activeJobs.has(printer.ip) || this.dispatchingPrinters.has(printer.ip)) return true;
      const health = this.probeHealth.get(printer.ip);
      if (!health || health.isOnline) return true;
      const since = health.lastSeenAt ?? health.firstProbedAt;
      if (!since || now - since <= this.staleAfterMs) return true;
      dropped.push(printer);
      return false;
    });

    if (!dropped.length) return [];

    this.printers = kept;
    for (const printer of dropped) {
      this.probeHealth.delete(printer.ip);
      this.trustedPriorState.delete(printer.ip);
      this.manualOverrides.delete(printer.ip);
    }
    this.persistState();
    return dropped;
  }

  addJob({ name, filename, filepath, seconds = null, grams = null }) {
    const id = `job_${Date.now()}_${++jobCounter}_${Math.random().toString(36).slice(2, 7)}`;
    const job = {
      id,
      name,
      createdAt: new Date().toISOString(),
      status: "queued",
      seconds,
      grams,
      filename,
      filepath,
      error: null,
      printerIp: null
    };
    this.queue.push(job);
    this.persistState();
    return job;
  }

  getJobById(id) {
    if (!id) return null;
    const inQueue = this.queue.find((j) => j.id === id);
    if (inQueue) return inQueue;
    const inFailed = this.failed.find((j) => j.id === id);
    if (inFailed) return inFailed;
    for (const job of this.activeJobs.values()) {
      if (job.id === id) return job;
    }
    const inHistory = this.history.find((j) => j.id === id);
    if (inHistory) return inHistory;
    return null;
  }

  deleteJob(id) {
    const activeJob = Array.from(this.activeJobs.values()).find((j) => j.id === id);
    if (activeJob || this.queue.find((j) => j.id === id && j.status === "sending")) {
      return { ok: false, conflict: true, error: "cannot delete active or sending job" };
    }
    const qIdx = this.queue.findIndex((j) => j.id === id);
    if (qIdx !== -1) {
      this.queue.splice(qIdx, 1);
      this.persistState();
      return { ok: true, id };
    }
    const fIdx = this.failed.findIndex((j) => j.id === id);
    if (fIdx !== -1) {
      this.failed.splice(fIdx, 1);
      this.persistState();
      return { ok: true, id };
    }
    return { ok: false, notFound: true, error: "job not found" };
  }

  requeueJob(id) {
    const fIdx = this.failed.findIndex((j) => j.id === id);
    if (fIdx === -1) {
      return { ok: false, notFound: true, error: "failed job not found" };
    }
    const job = this.failed[fIdx];
    if (!job.filepath || !existsSync(job.filepath) || !isPathInsideDir(job.filepath, this.outDir)) {
      return { ok: false, conflict: true, error: "G-code file no longer exists" };
    }
    this.failed.splice(fIdx, 1);
    job.status = "queued";
    job.error = null;
    job.printerIp = null;
    this.queue.push(job);
    this.persistState();
    return { ok: true, job };
  }

  clearBed(ip) {
    const printer = this.printers.find((p) => p.ip === ip);
    if (!printer) {
      return { ok: false, notFound: true, error: "unknown printer IP" };
    }
    const currentStatus = this.getPrinterStatus(ip);
    if (currentStatus.status !== "needs_clearing") {
      return { ok: false, conflict: true, error: "printer bed does not need clearing" };
    }
    this.manualOverrides.set(ip, "free");
    this.persistState();
    const updatedStatus = this.getPrinterStatus(ip);
    return { ok: true, ip, status: updatedStatus.status };
  }

  getPrinterStatus(ip) {
    const printer = this.printers.find((p) => p.ip === ip) || { id: "unknown", ip };
    const trusted = this.trustedPriorState.get(ip);
    const health = this.probeHealth.get(ip);
    const isDispatching = this.dispatchingPrinters.has(ip);
    const override = this.manualOverrides.get(ip);

    if (isDispatching) {
      return {
        id: printer.id,
        ip: printer.ip,
        filament: printer.filament,
        status: "sending",
        job: "Sending...",
        telemetryComplete: trusted?.telemetryComplete ?? false
      };
    }

    if (!health || !health.isOnline || !health.telemetryComplete) {
      return {
        id: printer.id,
        ip: printer.ip,
        filament: printer.filament,
        status: "error",
        job: (!health || !health.isOnline) ? "unreachable" : "incomplete telemetry",
        telemetryComplete: false
      };
    }

    if (!trusted || !trusted.telemetryComplete) {
      return {
        id: printer.id,
        ip: printer.ip,
        filament: printer.filament,
        status: "error",
        job: "incomplete telemetry",
        telemetryComplete: false
      };
    }

    let effectiveState = trusted.rawState;
    if (override === "needs_clearing") {
      effectiveState = "needs_clearing";
    } else if (override === "free" && (trusted.rawState === "free" || trusted.rawState === "needs_clearing")) {
      effectiveState = "free";
    }

    if (this.activeJobs.has(ip)) {
      const activeJob = this.activeJobs.get(ip);
      if (!activeJob.seenBusy && (effectiveState === "free" || effectiveState === "needs_clearing")) {
        effectiveState = "preparing";
      }
    }

    let displayJob = "-";
    if (effectiveState === "preparing") {
      const activeJob = this.activeJobs.get(ip);
      const fn = activeJob?.filename || trusted.filename;
      displayJob = fn ? `${fn} (Preparing)` : "Preparing";
    } else if (effectiveState === "paused") {
      displayJob = trusted.filename ? `${trusted.filename} (Paused)` : "Paused";
    } else if (effectiveState === "busy") {
      displayJob = trusted.filename ? `${trusted.filename} ${trusted.progress}%` : "Printing";
    } else if (effectiveState === "needs_clearing") {
      displayJob = trusted.filename ? trusted.filename : "Needs Clearing";
    } else if (effectiveState === "free") {
      displayJob = trusted.filename ? `${trusted.filename} (done)` : "-";
    }

    return {
      id: printer.id,
      ip: printer.ip,
      filament: printer.filament,
      status: effectiveState,
      job: displayJob,
      telemetryComplete: true,
      printFileName: trusted.filename || undefined,
      printProgress: trusted.progress
    };
  }

  isEligibleForDispatch(ip) {
    if (this.dispatchingPrinters.has(ip)) return false;
    if (this.activeJobs.has(ip)) return false;

    const health = this.probeHealth.get(ip);
    if (!health || !health.isOnline || !health.telemetryComplete) return false;

    const trusted = this.trustedPriorState.get(ip);
    if (!trusted || !trusted.telemetryComplete) return false;

    const override = this.manualOverrides.get(ip);
    if (override === "needs_clearing") return false;

    const current = this.getPrinterStatus(ip);
    return current.status === "free";
  }

  async updatePrinterStates() {
    for (const printer of this.printers) {
      let rawResult;
      try {
        rawResult = await this.prober(printer);
      } catch (err) {
        rawResult = { id: printer.id, ip: printer.ip, status: "unreachable", job: {} };
      }
      this.evaluatePrinterProbe(printer, rawResult);
    }
    this.pruneStalePrinters();
  }

  evaluatePrinterProbe(printer, rawResult) {
    const isOnline = rawResult.status === "online";
    const telemetry = rawResult.job || {};
    const telemetryComplete = isOnline && (telemetry.deviceState !== undefined || telemetry.printState !== undefined || telemetry.state !== undefined);

    const previousHealth = this.probeHealth.get(printer.ip);
    const now = Date.now();
    this.probeHealth.set(printer.ip, {
      isOnline,
      telemetryComplete,
      status: rawResult.status || (isOnline ? "online" : "unreachable"),
      // firstProbedAt starts the staleness clock for an IP that has never once
      // answered; lastSeenAt restarts it every time one does.
      firstProbedAt: previousHealth?.firstProbedAt ?? now,
      lastSeenAt: isOnline ? now : (previousHealth?.lastSeenAt ?? null)
    });

    if (!telemetryComplete) {
      // Incomplete/unreachable telemetry cannot make a printer dispatchable
      // and cannot overwrite the last trusted state transition evidence.
      return;
    }

    const filename = String(telemetry.printFileName || telemetry.filename || "").split(/[\\/]/).pop();
    const progress = derivePrintProgress(telemetry.printProgress ?? telemetry.dProgress, telemetry.layer, telemetry.totalLayer ?? telemetry.TotalLayer);

    let rawState = "free";
    if (isPrinterPausedState(telemetry.deviceState ?? telemetry.state, telemetry)) {
      rawState = "paused";
    } else if (isPrinterActiveState(telemetry.deviceState ?? telemetry.state, telemetry)) {
      rawState = "busy";
    } else if (filename && isPrinterTerminalState(telemetry.deviceState ?? telemetry.state, telemetry)) {
      rawState = "needs_clearing";
    } else {
      rawState = "free";
    }

    const previous = this.trustedPriorState.get(printer.ip);

    // 1. Busy/paused -> free transition locks needs_clearing
    if (previous && (previous.rawState === "busy" || previous.rawState === "paused") && rawState === "free") {
      this.manualOverrides.set(printer.ip, "needs_clearing");
    }

    // 2. Real busy or paused observation removes the clear override
    if (this.manualOverrides.get(printer.ip) === "free" && (rawState === "busy" || rawState === "paused")) {
      this.manualOverrides.delete(printer.ip);
    }

    // 3. Retire active job association when printer reaches needs_clearing/free after having printed (seenBusy === true)
    if (this.activeJobs.has(printer.ip)) {
      const activeJob = this.activeJobs.get(printer.ip);
      if (rawState === "busy" || rawState === "paused") {
        activeJob.seenBusy = true;
      }
      if (activeJob.seenBusy) {
        const effectiveOverride = this.manualOverrides.get(printer.ip);
        const effectiveNow = effectiveOverride === "needs_clearing" ? "needs_clearing" : (effectiveOverride === "free" ? "free" : rawState);
        if (effectiveNow === "needs_clearing" || effectiveNow === "free") {
          activeJob.status = "completed";
          activeJob.completedAt = new Date().toISOString();
          this.recordCompletion(activeJob);
          this.activeJobs.delete(printer.ip);
          this.persistState();
        }
      }
    }

    this.trustedPriorState.set(printer.ip, {
      rawState,
      telemetryComplete: true,
      filename,
      progress,
      telemetry
    });
  }

  async _executeJobUpload(printer, job) {
    this.dispatchingPrinters.add(printer.ip);
    job.status = "sending";
    job.printerIp = printer.ip;

    try {
      const res = await this.uploader(printer.ip, job.filepath);
      if (res && res.confirmed === false) {
        throw new Error("Print start unconfirmed by printer");
      }
      job.status = "active";
      job.seenBusy = false;
      this.activeJobs.set(printer.ip, job);
      this.persistState();
      return { ok: true, job };
    } catch (err) {
      job.status = "failed";
      job.error = err.message || String(err);
      job.printerIp = null;
      this.failed.push(job);
      this.persistState();
      return { ok: false, error: job.error };
    } finally {
      this.dispatchingPrinters.delete(printer.ip);
    }
  }

  async dispatchNextJobs() {
    return;
  }

  async assignJobToPrinter(ip, jobId) {
    const printer = this.printers.find((p) => p.ip === ip);
    if (!printer) {
      return { ok: false, notFound: true, error: "Printer not found" };
    }

    if (!this.isEligibleForDispatch(ip)) {
      return { ok: false, conflict: true, error: "Printer is not eligible for job assignment" };
    }

    const qIdx = this.queue.findIndex((j) => j.id === jobId);
    if (qIdx === -1) {
      const existingJob = this.getJobById(jobId);
      if (existingJob) {
        return { ok: false, conflict: true, error: "Job is not currently queued" };
      }
      return { ok: false, notFound: true, error: "Job not found" };
    }

    const [job] = this.queue.splice(qIdx, 1);
    this.persistState();
    return await this._executeJobUpload(printer, job);
  }

  async runSweep() {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      await this.updatePrinterStates();
    } catch (err) {
      // sweep error must not crash background polling
    } finally {
      this.isSweeping = false;
    }
  }

  startPolling() {
    this.stopPolling();
    this.isPolling = true;
    const gen = ++this.pollingGeneration;

    const loop = async () => {
      if (!this.isPolling || gen !== this.pollingGeneration) return;
      await this.runSweep();
      if (this.isPolling && gen === this.pollingGeneration) {
        this.pollingTimer = setTimeout(loop, this.pollIntervalMs);
      }
    };

    loop();
  }

  stopPolling() {
    this.isPolling = false;
    this.pollingGeneration++;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  getQueuePublic() {
    return this.queue.map(toPublicJob);
  }

  getFailedPublic() {
    return this.failed.map(toPublicJob);
  }

  getActiveJobsPublic() {
    const result = {};
    for (const [ip, job] of this.activeJobs.entries()) {
      result[ip] = toPublicJob(job);
    }
    return result;
  }

  getPrintersStatusPublic() {
    return this.printers.map((p) => this.getPrinterStatus(p.ip));
  }

  // Newest first. history is already capped at historyLimit.
  getCompletedPublic() {
    return this.history.slice().reverse().map(toPublicJob);
  }

  getStatusPublic() {
    return {
      autoDispatch: this.autoDispatch,
      queue: this.getQueuePublic(),
      failed: this.getFailedPublic(),
      activeJobs: this.getActiveJobsPublic(),
      completed: this.getCompletedPublic(),
      // Lifetime totals, so the summary tiles stay correct even though the
      // completed list above only keeps the last few.
      completedTotal: this.completedCount,
      completedGrams: this.completedGrams,
      printers: this.getPrintersStatusPublic()
    };
  }
}
