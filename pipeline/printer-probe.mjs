// Probe a Creality/Klipper printer for local HTTP control.
//
// Usage:
//   node pipeline/printer-probe.mjs 192.168.1.50
//   node pipeline/printer-probe.mjs http://192.168.1.50:7125
//
// This does not upload or start a print. It only checks reachable HTTP endpoints.

const rawTarget = process.argv[2] ?? process.env.PRINTER_IP ?? process.env.PRINTER_URL;

if (!rawTarget) {
  console.error("usage: node pipeline/printer-probe.mjs <printer-ip-or-url>");
  console.error("example: node pipeline/printer-probe.mjs 192.168.1.50");
  process.exit(1);
}

const target = normalizeTarget(rawTarget);
const host = target.hostname;
const candidates = [
  { label: "Stock/Creality web UI", url: `http://${host}/` },
  { label: "Moonraker server info", url: `http://${host}:7125/server/info` },
  { label: "Moonraker printer info", url: `http://${host}:7125/printer/info` },
  {
    label: "Moonraker printer objects",
    url: `http://${host}:7125/printer/objects/query?print_stats&virtual_sdcard&webhooks`,
  },
  { label: "Moonraker file list", url: `http://${host}:7125/server/files/list?root=gcodes` },
];

console.log(`probing ${host}\n`);

let moonrakerOk = false;

for (const candidate of candidates) {
  const result = await check(candidate.url);
  const status = result.ok ? `OK ${result.status}` : `FAIL ${result.reason}`;
  console.log(`${status.padEnd(18)} ${candidate.label}`);
  console.log(`  ${candidate.url}`);

  if (result.body) {
    console.log(`  ${summarize(result.body)}`);
  }

  if (result.ok && candidate.url.includes(":7125/")) {
    moonrakerOk = true;
  }
}

console.log("");
if (moonrakerOk) {
  console.log("Moonraker is reachable. Use this when printing:");
  console.log(`  $env:PRINTER_URL="http://${host}:7125"`);
  console.log("  node pipeline/print-name.mjs ASHIM --start");
} else {
  console.log("Moonraker was not reachable on port 7125.");
  console.log("If the normal browser page works, the printer may only expose Creality's stock UI right now.");
  console.log("For direct HTTP upload/start from this project, enable Moonraker/Fluidd or verify the stock Creality upload API.");
}

function normalizeTarget(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return new URL(withScheme);
}

async function check(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("json") || contentType.includes("text") || contentType.includes("html")
      ? await res.text()
      : "";
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, reason: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(body) {
  return body.replace(/\s+/g, " ").slice(0, 180);
}
