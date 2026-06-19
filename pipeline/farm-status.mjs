// KeyForge farm status — NO ROOT, NO DEPENDENCIES.
// Connects to each printer's stock Creality WebSocket (port 9999) and reports free/busy.
// Node 22+ ships a global WebSocket, so this needs no npm packages and no Moonraker.
//
// Usage:
//   node pipeline/farm-status.mjs 10.158.163.29 10.158.163.30 10.158.163.31
//   node pipeline/farm-status.mjs --raw 10.158.163.29     (dump every field the printer sends)
//   or list printers in pipeline/printers.json: [{ "id": "A", "ip": "10.158.163.29" }, ...]
//
// The free/busy guess below is based on the ha_creality_ws integration's field names.
// If a printer reports wrong, run with --raw, paste the real fields, and we fix judge().

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const PRINTERS_JSON = path.join(here, "printers.json");
const PROBE_MS = 5000;

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const ipArgs = args.filter((a) => !a.startsWith("--"));

let printers = ipArgs.map((ip, i) => ({ id: String(i + 1), ip }));
if (printers.length === 0 && existsSync(PRINTERS_JSON)) {
  printers = JSON.parse(readFileSync(PRINTERS_JSON, "utf8"));
}
if (printers.length === 0) {
  console.error("usage: node pipeline/farm-status.mjs <ip> [ip...]   (or create printers.json)");
  process.exit(1);
}

if (typeof WebSocket === "undefined") {
  console.error("This Node has no global WebSocket. Use Node 22 or newer.");
  process.exit(1);
}

const results = await Promise.all(printers.map(probe));

if (raw) {
  for (const r of results) {
    console.log(`\n=== ${r.id} (${r.ip}) raw fields ===`);
    console.log(JSON.stringify(r.state, null, 2));
  }
}

console.log("");
console.log("id    ip                 status     job");
console.log("----  -----------------  ---------  ------------------------------");
for (const r of results) {
  console.log(`${r.id.padEnd(4)}  ${r.ip.padEnd(17)}  ${r.status.padEnd(9)}  ${r.job}`);
}
const free = results.filter((r) => r.status === "free").map((r) => r.id);
console.log("");
console.log(free.length ? `free printers: ${free.join(", ")}` : "no free printers right now");

function probe(printer) {
  return new Promise((resolve) => {
    const state = {};
    let settled = false;
    let ws;

    const done = (status, job) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({ ...printer, state, ...(status ? { status, job } : judge(state)) });
    };

    const timer = setTimeout(() => done(), PROBE_MS);

    try {
      ws = new WebSocket(`ws://${printer.ip}:9999/`);
    } catch {
      return done("unreachable", "could not open socket");
    }

    ws.addEventListener("open", () => {
      // nudge the printer to dump a full status object
      ws.send(JSON.stringify({ method: "get", params: { reqPrintObjects: 1 } }));
      ws.send(JSON.stringify({ method: "get", params: { ReqPrinterPara: 1 } }));
    });
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      if (!text || text === "ok") return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.ModeCode === "heart_beat") return;
      Object.assign(state, msg);
    });
    ws.addEventListener("error", () => done("unreachable", "connection failed"));
  });
}

function judge(s) {
  if (Object.keys(s).length === 0) return { status: "no data", job: "(silent — see --raw)" };
  const fname = s.printFileName || "";
  const prog = s.printProgress ?? s.dProgress;
  const ds = s.deviceState ?? s.state;
  if (ds === 5 || s.pause === 1 || s.paused === 1) return { status: "paused", job: fname || "?" };
  if (fname && prog != null && Number(prog) < 100) return { status: "busy", job: `${fname} ${prog}%` };
  return { status: "free", job: fname ? `${fname} (done)` : "-" };
}
