// Stock Creality printer control (NO ROOT) — decoded from the Ender 3 V3 KE web UI's own JS.
//
//   Upload:  POST http://<ip>/upload/<filename>   (multipart form, field "file")
//   Start:   ws://<ip>:9999  ->  {method:"set",params:{opGcodeFile:"printprt:<dir>/<filename>"}}
//
// The web UI builds the start path from each file's reported path; uploaded files land in
// /usr/data/printer_data/gcodes (confirmed from a live print). Override with GCODE_DIR if needed.
//
// Run directly to upload + start a print (test the protocol on real hardware):
//   node pipeline/creality.mjs <printer-ip> pipeline/out/kf_ashim_letters.gcode
//
// Zero dependencies — native fetch / FormData / Blob / WebSocket (Node 22+).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GCODE_DIR = process.env.GCODE_DIR ?? "/usr/data/printer_data/gcodes";

export async function uploadGcode(ip, filePath) {
  if (!existsSync(filePath)) throw new Error(`no such file: ${filePath}`);
  const filename = path.basename(filePath);
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filePath)]), filename);
  const res = await fetch(`http://${ip}/upload/${filename}`, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return filename;
}

export function startPrint(ip, filename, gcodeDir = GCODE_DIR) {
  return new Promise((resolve, reject) => {
    let settled = false, ws;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      err ? reject(err) : resolve(`printprt:${gcodeDir}/${filename}`);
    };
    const timer = setTimeout(() => done(new Error("start timeout (no socket response)")), 8000);
    try { ws = new WebSocket(`ws://${ip}:9999/`); } catch (e) { return done(e); }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ method: "set", params: { opGcodeFile: `printprt:${gcodeDir}/${filename}` } }));
      // give the firmware a moment to accept the command, then resolve
      setTimeout(() => done(), 1500);
    });
    ws.addEventListener("error", () => done(new Error("socket error (wrong IP or not on the printer network?)")));
  });
}

// optional: poll status to confirm the print actually started (printFileName matches)
export function confirmPrinting(ip, filename, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false, ws;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    try { ws = new WebSocket(`ws://${ip}:9999/`); } catch { return done(false); }
    ws.addEventListener("message", (ev) => {
      const t = typeof ev.data === "string" ? ev.data : "";
      if (!t || t === "ok") return;
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.printFileName && String(m.printFileName).includes(filename)) done(true);
    });
    ws.addEventListener("error", () => done(false));
  });
}

export async function uploadAndPrint(ip, filePath) {
  const filename = await uploadGcode(ip, filePath);
  await startPrint(ip, filename);
  const confirmed = await confirmPrinting(ip, filename);
  return { filename, confirmed };
}

// run directly = test on real hardware
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ip, file] = process.argv.slice(2);
  if (!ip || !file) {
    console.error("usage: node pipeline/creality.mjs <printer-ip> <gcode-file>");
    process.exit(1);
  }
  console.log(`uploading ${path.basename(file)} to ${ip} ...`);
  try {
    const filename = await uploadGcode(ip, file);
    console.log(`uploaded. starting print: printprt:${GCODE_DIR}/${filename}`);
    await startPrint(ip, filename);
    console.log("start command sent. confirming via status ...");
    const ok = await confirmPrinting(ip, filename);
    console.log(ok ? "CONFIRMED: printer reports it is printing this file." : "sent, but could not confirm from status within timeout (check the printer screen).");
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
}
