// Download the printer's stock web UI and its JS/CSS so the upload and
// start-print calls can be read from the same code the printer already runs.
//
//   node pipeline/grab-printer-ui.mjs 192.168.137.63
//
// Run this on the printer network (laptop hotspot is fine). Files land in
// pipeline/printer-ui/, which is gitignored.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ip = process.argv[2];
if (!ip) {
  console.error("usage: node pipeline/grab-printer-ui.mjs <printer-ip>");
  console.error("example: node pipeline/grab-printer-ui.mjs 192.168.137.63");
  process.exit(1);
}

const baseUrl = `http://${ip}`;
const outDir = path.join(import.meta.dirname, "printer-ui");
mkdirSync(outDir, { recursive: true });

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

console.log(`fetching ${baseUrl}/ ...`);
let html;
try {
  html = await (await get(`${baseUrl}/`)).text();
} catch (e) {
  console.error(`could not reach ${baseUrl} - are you on the printer's network? (${e.message})`);
  process.exit(1);
}
writeFileSync(path.join(outDir, "index.html"), html);
console.log(`saved index.html (${html.length} bytes)`);

const assets = new Set();
for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi)) {
  assets.add(m[1].split("?")[0]);
}
console.log(`found ${assets.size} referenced asset(s)`);

let saved = 0;
for (const a of assets) {
  const url = /^https?:\/\//.test(a) ? a : `${baseUrl}/${a.replace(/^\//, "")}`;
  try {
    const body = await (await get(url)).text();
    const safe = a.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || `asset_${saved}.txt`;
    writeFileSync(path.join(outDir, safe), body);
    saved++;
    console.log(`  saved ${safe} (${body.length} bytes)`);
  } catch (e) {
    console.log(`  skipped ${a}: ${e.message}`);
  }
}

console.log(`\ndone - ${saved} asset(s) in pipeline/printer-ui/`);
