// Probe a stock Creality printer for its local web UI.
// Does not upload or start a print.
//
// usage:  node pipeline/printer-probe.mjs 192.168.137.63

const rawTarget = process.argv[2] ?? process.env.PRINTER_IP;

if (!rawTarget) {
  console.error("usage: node pipeline/printer-probe.mjs <printer-ip>");
  console.error("example: node pipeline/printer-probe.mjs 192.168.137.63");
  process.exit(1);
}

const target = normalizeTarget(rawTarget);
const host = target.hostname;
const url = `http://${host}/`;

console.log(`probing ${host}\n`);

const result = await check(url);
if (result.ok) {
  console.log(`OK ${result.status}  stock Creality web UI`);
  console.log(`  ${url}`);
  if (result.body) console.log(`  ${summarize(result.body)}`);
} else {
  console.log(`FAIL ${result.reason}  stock Creality web UI`);
  console.log(`  ${url}`);
  process.exit(1);
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
