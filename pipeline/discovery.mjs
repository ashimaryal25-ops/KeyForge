// KeyForge network discovery — ported from PrintFarm's lib/discovery.mjs.
//
// The scan strategy is the whole point of this file: Creality's status socket
// is slow and stingy, so a single quick pass silently misses printers. Two
// passes with a generous timeout is what makes one scan find the whole farm.

import os from "node:os";

/**
 * Validates a /24 IPv4 subnet prefix (e.g. "192.168.137").
 * Restricted to RFC1918 private ranges so a scan can never touch the internet.
 */
export function isValidSubnet(subnet) {
  if (!subnet || typeof subnet !== "string") return false;
  const parts = subnet.split(".");
  if (parts.length !== 3) return false;
  if (!parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) return false;

  const a = Number(parts[0]);
  const b = Number(parts[1]);

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  return false;
}

const NOT_PRIVATE = "Not a private network. Please enter a private network like 192.168.1, or paste a printer/router IP like 192.168.1.42.";

/**
 * Normalizes an input string to a /24 prefix, accepting a full IP
 * ("192.168.137.10" -> "192.168.137"). Rejects public addresses.
 */
export function normalizeSubnetInput(input) {
  if (!input || typeof input !== "string") throw new Error(NOT_PRIVATE);

  const parts = input.trim().split(".");
  if (parts.length !== 3 && parts.length !== 4) throw new Error(NOT_PRIVATE);
  if (!parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) throw new Error(NOT_PRIVATE);
  if (parts.length === 4) parts.pop();

  const subnet = parts.join(".");
  if (!isValidSubnet(subnet)) throw new Error(NOT_PRIVATE);
  return subnet;
}

/** Candidate local IPv4 /24 subnets, one per non-internal interface. */
export function localSubnets() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const p = ni.address.split(".");
      const subnet = `${p[0]}.${p[1]}.${p[2]}`;
      candidates.push({ iface, address: ni.address, subnet, cidr: `${subnet}.0/24`, preferred: isValidSubnet(subnet) });
    }
  }
  return candidates;
}

/** Best guess at the subnet the printers are on. */
export function localSubnet() {
  const subnets = localSubnets();
  if (!subnets.length) return null;

  // The farm runs off a Windows mobile hotspot, which always hands out
  // 192.168.137.x — prefer it over a wired LAN the printers aren't on.
  const hotspot = subnets.find((s) => s.subnet === "192.168.137");
  if (hotspot) return hotspot.subnet;

  return subnets.find((s) => s.preferred)?.subnet ?? null;
}

/**
 * Probe one printer over the stock Creality status socket (ws :9999).
 * Resolves { ...printer, status, job } — job is the accumulated telemetry.
 */
export function probe(printer, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const state = {};
    let settled = false, gotData = false, ws, collectTimer;
    const done = (status, job) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(collectTimer);
      try { ws?.close(); } catch {}
      resolve({ ...printer, ...(status ? { status, job } : { status: "online", job: state }) });
    };
    // A printer that already sent telemetry counts as online even if the
    // collect window hadn't closed yet.
    const timer = setTimeout(() => done(gotData ? undefined : "unreachable", "-"), timeoutMs);
    try { ws = new WebSocket(`ws://${printer.ip}:9999/`); }
    catch { return done("unreachable", "-"); }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ method: "get", params: { reqPrintObjects: 1 } }));
      ws.send(JSON.stringify({ method: "get", params: { ReqPrinterPara: 1 } }));
    });
    ws.addEventListener("message", (ev) => {
      const t = typeof ev.data === "string" ? ev.data : "";
      if (!t) return;
      gotData = true;
      if (t === "ok") return;
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.ModeCode === "heart_beat") return;
      Object.assign(state, m);
      // Telemetry arrives in fragments; collect briefly so late temperature
      // and progress fields aren't thrown away.
      if (!collectTimer) collectTimer = setTimeout(() => done(), 400);
    });
    ws.addEventListener("error", () => done("unreachable", "-"));
  });
}

/**
 * Scans a /24 subnet for stock Creality printers on ws :9999.
 *
 * @returns {Promise<{ subnet, found, scanned, durationMs }>}
 */
export async function scanSubnet(subnet, options = {}) {
  if (!isValidSubnet(subnet)) {
    throw new Error(`Invalid or unsupported subnet: ${subnet}. Must be RFC1918 /24 (e.g. 192.168.1).`);
  }

  // Real printers on a Windows hotspot can take just over 1.5 seconds to
  // accept the status socket. Give them enough time while using wider batches
  // so the two-pass scan stays reasonably quick.
  const timeoutMs = options.timeoutMs || 2500;
  const concurrency = options.concurrency || 64;
  const attempts = options.attempts || 2;
  const start = options.start || 1;
  const end = options.end || 254;
  const probeFn = options.probeFn || probe;

  const targets = [];
  for (let i = start; i <= end; i++) targets.push({ id: `scan_${i}`, ip: `${subnet}.${i}` });

  const foundByIp = new Map();
  const startTime = Date.now();
  let pending = targets;

  for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
    const retry = [];

    for (let i = 0; i < pending.length; i += concurrency) {
      const chunk = pending.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map((t) => probeFn(t, timeoutMs)));

      for (const r of results) {
        if (r.status === "online") foundByIp.set(r.ip, r);
        else retry.push({ id: r.id, ip: r.ip });
      }
    }

    pending = retry;
  }

  const found = [...foundByIp.values()].sort(
    (a, b) => Number(a.ip.split(".").pop()) - Number(b.ip.split(".").pop())
  );

  return { subnet, found, scanned: end - start + 1, durationMs: Date.now() - startTime };
}

const letterAt = (n) => String.fromCharCode(65 + (n % 26));

/**
 * Labels printers A, B, C… keeping a printer's letter across scans by matching
 * its hostname, so a re-scan doesn't shuffle the dashboard.
 */
export function assignStablePrinterIds(found, priorPrinters = []) {
  const priorByHostname = new Map(
    priorPrinters.filter((p) => p.hostname).map((p) => [p.hostname, p.id])
  );
  const used = new Set();

  return found.map((printer) => {
    const hostname = printer.hostname || printer.job?.hostname || "";
    let id = priorByHostname.get(hostname);
    if (!id || used.has(id)) {
      let n = 0;
      while (used.has(letterAt(n))) n += 1;
      id = letterAt(n);
    }
    used.add(id);
    return { ...printer, id, hostname };
  });
}
