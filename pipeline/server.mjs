// KeyForge web interface — NO new dependencies (Node built-in http + native WebSocket).
//
//   node pipeline/server.mjs
//   then open http://localhost:5180

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uploadAndPrint } from "./creality.mjs";
import { WorkflowManager, toPublicJob, isPathInsideDir } from "./workflow.mjs";
import { localSubnet, normalizeSubnetInput, scanSubnet, assignStablePrinterIds } from "./discovery.mjs";

const here = import.meta.dirname;
const SCAD = path.join(here, "keychain.scad");
const PRINT_NAME = path.join(here, "print-name.mjs");
const OUT = path.join(here, "out");
const UI_DIR = path.join(here, "ui");
const OPENSCAD = process.env.OPENSCAD ?? String.raw`C:\Program Files\OpenSCAD\openscad.com`;
const PORT = Number(process.env.PORT ?? 5180);

mkdirSync(OUT, { recursive: true });

// The farm list lives in memory only. Printers sit on a DHCP hotspot, so a
// saved IP is a lie the moment a printer reboots — a scan is the only source
// of truth, and the server starts with an empty farm until you run one.
let discoveredPrinters = [];

const NAME_RE = /^[A-Z0-9]{2,10}$/;
const cleanName = (v) => String(v ?? "").trim().toUpperCase();
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "_");

export function currentPrinters() {
  return discoveredPrinters;
}

export function createKeyForgeServer(options = {}) {
  const manager = options.workflowManager ?? new WorkflowManager({
    outDir: OUT,
    printers: currentPrinters(),
    staleAfterMs: Number(process.env.PRINTER_STALE_MS ?? 180000)
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/") return serveUi("index.html", res);
      if (url.pathname.startsWith("/ui/")) return serveUi(url.pathname.slice("/ui/".length), res);
      if (url.pathname === "/api/preview") return apiPreview(url, res);
      if (url.pathname === "/api/jobs" && req.method === "POST") return apiCreateJob(req, res, manager);
      if (url.pathname === "/api/status" && req.method === "GET") return apiStatus(req, res, manager);
      if (url.pathname === "/api/farm" && req.method === "GET") return apiFarm(url, res, manager);
      if (url.pathname === "/api/clear-bed" && req.method === "POST") return apiClearBed(url, res, manager);
      if (url.pathname === "/api/discover") return apiDiscover(url, res, manager);
      if (url.pathname === "/api/print" && req.method === "POST") return apiPrint(req, res, manager);
      if (url.pathname === "/api/auto-dispatch" && req.method === "POST") return apiAutoDispatch(req, res, manager);

      const assignMatch = url.pathname.match(/^\/api\/printers\/([^\/]+)\/assign$/);
      if (assignMatch && req.method === "POST") {
        return apiAssignJob(assignMatch[1], req, res, manager);
      }

      const requeueMatch = url.pathname.match(/^\/api\/jobs\/([^\/]+)\/requeue$/);
      if (requeueMatch && req.method === "POST") {
        return apiRequeueJob(requeueMatch[1], res, manager);
      }

      const gcodeMatch = url.pathname.match(/^\/api\/jobs\/([^\/]+)\/gcode$/);
      if (gcodeMatch && req.method === "GET") {
        return apiDownloadGcode(gcodeMatch[1], res, manager);
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^\/]+)$/);
      if (jobMatch && req.method === "DELETE") {
        return apiDeleteJob(jobMatch[1], res, manager);
      }

      send(res, 404, "text/plain", "not found");
    } catch (err) {
      send(res, 500, "application/json", JSON.stringify({ error: String(err) }));
    }
  });

  return { server, manager };
}

export function startServer(port = PORT) {
  const { server, manager } = createKeyForgeServer({ port });
  manager.startPolling();

  server.listen(port, () => {
    console.log(`KeyForge web interface: http://localhost:${port}`);
  });

  server.on("close", () => {
    manager.stopPolling();
  });

  return { server, manager };
}

const UI_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Serves pipeline/ui/ from disk. Read per request so an edit shows up on
// refresh; the extension allowlist plus isPathInsideDir keeps ../ walks and
// stray file types out.
function serveUi(relPath, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return send(res, 400, "text/plain", "bad path");
  }
  const file = path.join(UI_DIR, decoded);
  const type = UI_TYPES[path.extname(file).toLowerCase()];
  if (!type || !isPathInsideDir(file, UI_DIR) || !existsSync(file)) {
    return send(res, 404, "text/plain", "not found");
  }
  return send(res, 200, type, readFileSync(file));
}

function apiPreview(url, res) {
  const name = cleanName(url.searchParams.get("name"));
  if (!NAME_RE.test(name)) return send(res, 400, "text/plain", "bad name");
  const png = path.join(os.tmpdir(), `kf_preview_${slugOf(name)}.png`);
  const r = spawnSync(OPENSCAD, ["-o", png, "-D", `name="${name}"`,
    "--imgsize", "1000,1000", "--camera=0,0,0,24,0,0,0", "--viewall", "--autocenter", "--colorscheme=Tomorrow", SCAD], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(png)) return send(res, 500, "text/plain", "render failed");
  send(res, 200, "image/png", readFileSync(png));
}

async function apiCreateJob(req, res, manager) {
  const body = JSON.parse(await readBody(req) || "{}");
  const name = cleanName(body.name);
  if (!NAME_RE.test(name)) {
    return send(res, 400, "application/json", JSON.stringify({ error: "bad name (2-10 letters/digits)" }));
  }

  const args = [PRINT_NAME, name, "--dry-run"];

  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const gcodeName = `kf_${slugOf(name)}.gcode`;
  const gcodePath = path.join(OUT, gcodeName);
  const ok = r.status === 0;

  if (!ok || !existsSync(gcodePath)) {
    const log = (r.stdout ?? "") + (r.stderr ?? "");
    return send(res, 500, "application/json", JSON.stringify({ error: "dry-run generation failed", log }));
  }

  const text = readFileSync(gcodePath, "utf8");
  const seconds = parseTime(text.match(/; estimated printing time \(normal mode\) = ([^\r\n]+)/)?.[1]);
  const grams = Number(text.match(/; total filament used \[g\] = ([\d.]+)/)?.[1]) || null;

  const job = manager.addJob({
    name,
    filename: gcodeName,
    filepath: gcodePath,
    seconds,
    grams
  });

  return send(res, 201, "application/json", JSON.stringify(toPublicJob(job)));
}

function apiStatus(req, res, manager) {
  return send(res, 200, "application/json", JSON.stringify(manager.getStatusPublic()));
}

async function apiAutoDispatch(req, res, manager) {
  const body = JSON.parse(await readBody(req) || "{}");
  manager.setAutoDispatch(Boolean(body.enabled));
  return send(res, 200, "application/json", JSON.stringify(manager.getStatusPublic()));
}

async function apiAssignJob(rawIp, req, res, manager) {
  let ip;
  try {
    ip = decodeURIComponent(rawIp);
  } catch {
    return send(res, 400, "application/json", JSON.stringify({ error: "invalid ip encoding" }));
  }
  const body = JSON.parse(await readBody(req) || "{}");
  const jobId = body.jobId;
  if (!jobId) {
    return send(res, 404, "application/json", JSON.stringify({ error: "missing jobId" }));
  }
  const result = await manager.assignJobToPrinter(ip, jobId);
  if (result.notFound) {
    return send(res, 404, "application/json", JSON.stringify({ error: result.error }));
  }
  if (result.conflict) {
    return send(res, 409, "application/json", JSON.stringify({ error: result.error }));
  }
  if (!result.ok) {
    return send(res, 500, "application/json", JSON.stringify({ error: result.error || "assignment failed" }));
  }
  return send(res, 200, "application/json", JSON.stringify(manager.getStatusPublic()));
}

function apiFarm(url, res, manager) {
  const ips = url.searchParams.get("ips");
  if (ips) {
    const customList = ips.split(",").map((ip, i) => ({ id: String(i + 1), ip: ip.trim() }));
    manager.setPrinters(customList);
  }
  return send(res, 200, "application/json", JSON.stringify(manager.getPrintersStatusPublic()));
}

function apiClearBed(url, res, manager) {
  const ip = url.searchParams.get("ip");
  if (!ip) {
    return send(res, 400, "application/json", JSON.stringify({ error: "missing ip parameter" }));
  }
  const result = manager.clearBed(ip);
  if (result.notFound) {
    return send(res, 404, "application/json", JSON.stringify({ error: result.error }));
  }
  if (result.conflict) {
    return send(res, 409, "application/json", JSON.stringify({ error: result.error }));
  }
  return send(res, 200, "application/json", JSON.stringify({ ok: true, ip: result.ip, status: result.status }));
}

function apiDeleteJob(id, res, manager) {
  const result = manager.deleteJob(id);
  if (result.notFound) {
    return send(res, 404, "application/json", JSON.stringify({ error: result.error }));
  }
  if (result.conflict) {
    return send(res, 409, "application/json", JSON.stringify({ error: result.error }));
  }
  return send(res, 200, "application/json", JSON.stringify({ ok: true, id: result.id }));
}

function apiRequeueJob(id, res, manager) {
  const result = manager.requeueJob(id);
  if (result.notFound) {
    return send(res, 404, "application/json", JSON.stringify({ error: result.error }));
  }
  if (result.conflict) {
    return send(res, 409, "application/json", JSON.stringify({ error: result.error }));
  }
  return send(res, 200, "application/json", JSON.stringify({ ok: true, job: toPublicJob(result.job) }));
}

function apiDownloadGcode(id, res, manager) {
  const job = manager.getJobById(id);
  if (!job) {
    return send(res, 404, "text/plain", "job not found");
  }
  if (!isPathInsideDir(job.filepath, OUT)) {
    return send(res, 403, "text/plain", "access denied");
  }
  if (!existsSync(job.filepath)) {
    return send(res, 404, "text/plain", "gcode file not found");
  }

  const filename = path.basename(job.filepath);
  const content = readFileSync(job.filepath);
  res.writeHead(200, {
    "content-type": "text/x-gcode",
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`
  });
  res.end(content);
}

async function apiPrint(req, res, manager) {
  const body = JSON.parse(await readBody(req) || "{}");
  const name = cleanName(body.name);
  if (!NAME_RE.test(name)) return send(res, 400, "application/json", JSON.stringify({ ok: false, log: "bad name (2-10 letters/digits)" }));

  const args = [PRINT_NAME, name, "--dry-run"];

  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const log = (r.stdout ?? "") + (r.stderr ?? "");
  const ok = r.status === 0;

  let seconds = null, grams = null;
  const gcode = path.join(OUT, `kf_${slugOf(name)}.gcode`);
  if (ok && existsSync(gcode)) {
    const text = readFileSync(gcode, "utf8");
    seconds = parseTime(text.match(/; estimated printing time \(normal mode\) = ([^\r\n]+)/)?.[1]);
    grams = Number(text.match(/; total filament used \[g\] = ([\d.]+)/)?.[1]) || null;
  }
  let printed = null;
  if (ok && body.start && existsSync(gcode)) {
    try {
      const candidates = parsePrinterCandidates(body.printers);
      const printers = candidates.length ? candidates : currentPrinters();
      const freePrinter = printers.find((p) => manager.isEligibleForDispatch(p.ip));
      const target = body.printer ? { ip: body.printer, id: "manual" } : freePrinter;
      if (!target) printed = { ok: false, error: "no free printer" };
      else {
        const r2 = await uploadAndPrint(target.ip, gcode);
        printed = { ok: true, printer: target.id, ip: target.ip, confirmed: r2.confirmed };
      }
    } catch (e) {
      printed = { ok: false, error: String(e.message || e) };
    }
  }

  send(res, 200, "application/json", JSON.stringify({ ok, log, seconds, grams, printed }));
}

async function apiDiscover(url, res, manager) {
  const raw = url.searchParams.get("subnet") || localSubnet();
  if (!raw) {
    return send(res, 200, "application/json", JSON.stringify({ error: "could not detect subnet; pass ?subnet=192.168.137", found: [] }));
  }

  let base;
  try {
    base = normalizeSubnetInput(raw);
  } catch (err) {
    return send(res, 400, "application/json", JSON.stringify({ error: err.message, found: [] }));
  }

  // Creality's status socket accepts very few simultaneous connections. Pause
  // the regular sweep so it cannot race the discovery probe.
  const wasPolling = manager.isPolling;
  if (wasPolling) manager.stopPolling();

  try {
    const result = await scanSubnet(base);

    // Only replace the farm list when the scan actually found something — a
    // partial or empty scan must not delete printers we already know about.
    if (result.found.length) {
      result.found = assignStablePrinterIds(result.found, currentPrinters());
      discoveredPrinters = result.found.map(({ id, ip, hostname }) => ({ id, ip, hostname }));
      manager.setPrinters(currentPrinters());
    }

    send(res, 200, "application/json", JSON.stringify(result));
  } catch (err) {
    send(res, 400, "application/json", JSON.stringify({ error: String(err.message || err), found: [] }));
  } finally {
    // Discovery paused the sweep above; always resume it, even after a failure.
    if (wasPolling) manager.startPolling();
  }
}

function parsePrinterCandidates(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item, i) => typeof item === "string" ? { id: String(i + 1), ip: item.trim() } : item)
      .filter((item) => item?.ip);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((ip, i) => ({ id: String(i + 1), ip: ip.trim() }))
      .filter((item) => item.ip);
  }
  return [];
}

function parseTime(str) {
  if (!str) return null;
  let s = 0;
  const h = str.match(/(\d+)\s*h/), m = str.match(/(\d+)\s*m/), x = str.match(/(\d+)\s*s/);
  if (h) s += +h[1] * 3600;
  if (m) s += +m[1] * 60;
  if (x) s += +x[1];
  return s;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function send(res, code, type, body) {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}

const isDirectRun = Boolean(
  process.argv[1] && (
    import.meta.url === pathToFileURL(process.argv[1]).href ||
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  )
);

if (isDirectRun) {
  startServer(PORT);
}
