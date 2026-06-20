// Grab the printer's stock web UI + its JS/CSS bundles to local files.
// This is how we get the upload + start-print syntax: the web UI's own code does both,
// so its JavaScript contains the exact calls we need to replicate.
//
//   node pipeline/grab-printer-ui.mjs 10.158.163.29
//
// IMPORTANT: run this while your laptop is on the PRINTER's network (the hotspot).
// It needs the printer reachable but NOT the internet — so the no-internet hotspot is fine.
// It saves everything to pipeline/printer-ui/. Afterwards switch back to wifi and tell the
// assistant to read pipeline/printer-ui/ — it'll pull out the upload + start commands.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ip = process.argv[2];
if (!ip) {
  console.error("usage: node pipeline/grab-printer-ui.mjs <printer-ip>");
  console.error("example: node pipeline/grab-printer-ui.mjs 10.158.163.29");
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

// collect referenced js/css assets from the HTML
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
console.log("now switch back to wifi and tell the assistant: read pipeline/printer-ui/");
