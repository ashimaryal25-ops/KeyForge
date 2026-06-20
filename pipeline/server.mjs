// KeyForge web interface — NO new dependencies (Node built-in http + native WebSocket).
//
//   node pipeline/server.mjs
//   then open http://localhost:5180
//
// Kiosk: type a name -> live 3D preview (real OpenSCAD render) -> generate / print.
// Dashboard: live free/busy across the printers in printers.json (stock :9999 socket, no root).
//
// To actually start prints, set PRINTER_URL (Moonraker) — until the no-root start command is
// wired, the kiosk "Generate" makes the files; "Print" needs PRINTER_URL or the stock start cmd.

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { uploadAndPrint } from "./creality.mjs";

const here = import.meta.dirname;
const SCAD = path.join(here, "keychain.scad");
const PRINT_NAME = path.join(here, "print-name.mjs");
const PRINTERS_JSON = path.join(here, "printers.json");
const OUT = path.join(here, "out");
const OPENSCAD = process.env.OPENSCAD ?? String.raw`C:\Program Files\OpenSCAD\openscad.com`;
const PORT = Number(process.env.PORT ?? 5180);

mkdirSync(OUT, { recursive: true });

const NAME_RE = /^[A-Z0-9]{2,10}$/;
const cleanName = (v) => String(v ?? "").trim().toUpperCase();
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "_");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") return send(res, 200, "text/html", PAGE);
    if (url.pathname === "/api/preview") return apiPreview(url, res);
    if (url.pathname === "/api/print" && req.method === "POST") return apiPrint(req, res);
    if (url.pathname === "/api/farm") return apiFarm(url, res);
    if (url.pathname === "/api/discover") return apiDiscover(url, res);
    send(res, 404, "text/plain", "not found");
  } catch (err) {
    send(res, 500, "application/json", JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`KeyForge web interface: http://localhost:${PORT}`);
});

function apiPreview(url, res) {
  const name = cleanName(url.searchParams.get("name"));
  const style = url.searchParams.get("style") === "tag" ? "tag" : "letters";
  if (!NAME_RE.test(name)) return send(res, 400, "text/plain", "bad name");
  const png = path.join(os.tmpdir(), `kf_preview_${slugOf(name)}_${style}.png`);
  const r = spawnSync(OPENSCAD, ["-o", png, "-D", `name="${name}"`, "-D", `style="${style}"`,
    "--imgsize", "1000,1000", "--camera=0,0,0,24,0,0,0", "--viewall", "--autocenter", "--colorscheme=Tomorrow", SCAD], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(png)) return send(res, 500, "text/plain", "render failed");
  send(res, 200, "image/png", readFileSync(png));
}

async function apiPrint(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const name = cleanName(body.name);
  const style = body.style === "tag" ? "tag" : "letters";
  if (!NAME_RE.test(name)) return send(res, 400, "application/json", JSON.stringify({ ok: false, log: "bad name (2-10 letters/digits)" }));

  const args = [PRINT_NAME, name];
  if (style === "tag") args.push("--tag");
  if (body.eject) args.push("--eject");
  args.push("--dry-run"); // generation only; printing is handled below via the stock protocol

  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const log = (r.stdout ?? "") + (r.stderr ?? "");
  const ok = r.status === 0;

  let seconds = null, grams = null;
  const gcode = path.join(OUT, `kf_${slugOf(name)}_${style}${body.eject ? "_eject" : ""}.gcode`);
  if (ok && existsSync(gcode)) {
    const text = readFileSync(gcode, "utf8");
    seconds = parseTime(text.match(/; estimated printing time \(normal mode\) = ([^\r\n]+)/)?.[1]);
    grams = Number(text.match(/; total filament used \[g\] = ([\d.]+)/)?.[1]) || null;
  }
  let printed = null;
  if (ok && body.start && existsSync(gcode)) {
    try {
      const target = body.printer ? { ip: body.printer, id: "manual" } : await pickFreePrinter();
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

async function pickFreePrinter() {
  const printers = existsSync(PRINTERS_JSON) ? JSON.parse(readFileSync(PRINTERS_JSON, "utf8")) : [];
  const statuses = await Promise.all(printers.map((p) => probe(p)));
  return statuses.find((p) => p.status === "free") || null;
}

async function apiFarm(url, res) {
  let printers = [];
  const ips = url.searchParams.get("ips");
  if (ips) printers = ips.split(",").map((ip, i) => ({ id: String(i + 1), ip: ip.trim() }));
  else if (existsSync(PRINTERS_JSON)) printers = JSON.parse(readFileSync(PRINTERS_JSON, "utf8"));
  const statuses = await Promise.all(printers.map(probe));
  send(res, 200, "application/json", JSON.stringify(statuses));
}

async function apiDiscover(url, res) {
  const base = url.searchParams.get("subnet") || localSubnet();
  if (!base) return send(res, 200, "application/json", JSON.stringify({ error: "could not detect subnet; pass ?subnet=10.158.163", found: [] }));
  const targets = [];
  for (let i = 1; i <= 254; i++) targets.push({ id: String(i), ip: base + "." + i });
  const found = [];
  for (let i = 0; i < targets.length; i += 40) {
    const slice = targets.slice(i, i + 40);
    const results = await Promise.all(slice.map((t) => probe(t, 1500)));
    for (const r of results) if (r.status !== "unreachable") found.push(r);
  }
  found.forEach((p, i) => { p.id = String.fromCharCode(65 + (i % 26)); });
  send(res, 200, "application/json", JSON.stringify({ subnet: base, found }));
}

function localSubnet() {
  const ifaces = os.networkInterfaces();
  let fallback = null;
  for (const key of Object.keys(ifaces)) {
    for (const ni of ifaces[key]) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const p = ni.address.split(".");
      const base = p[0] + "." + p[1] + "." + p[2];
      const a = +p[0], b = +p[1];
      // prefer private ranges (the printer hotspot) over public campus wifi
      if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return base;
      if (!fallback) fallback = base;
    }
  }
  return fallback;
}

function probe(printer, timeoutMs) {
  return new Promise((resolve) => {
    const state = {};
    let settled = false, gotData = false, ws, collectTimer;
    const done = (status, job) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(collectTimer);
      try { ws?.close(); } catch {}
      resolve({ ...printer, ...(status ? { status, job } : judge(state)) });
    };
    const timer = setTimeout(() => done(gotData ? undefined : "unreachable", "-"), timeoutMs || 4000);
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
      // got real status — collect briefly then close, so we don't hog the printer's
      // scarce :9999 connection slots (it often allows only one client at a time)
      if (!collectTimer) collectTimer = setTimeout(() => done(), 400);
    });
    ws.addEventListener("error", () => done("unreachable", "-"));
  });
}

function judge(s) {
  if (Object.keys(s).length === 0) return { status: "no data", job: "-" };
  const fname = (s.printFileName || "").split("/").pop();
  const prog = s.printProgress ?? s.dProgress;
  const ds = s.deviceState ?? s.state;
  if (ds === 5 || s.pause === 1 || s.paused === 1) return { status: "paused", job: fname || "?" };
  if (fname && prog != null && Number(prog) < 100) return { status: "busy", job: `${fname} ${prog}%` };
  return { status: "free", job: fname ? "(done)" : "-" };
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KeyForge</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#f4f2ec;--panel:#ffffff;--panel2:#faf8f2;--line:#e4e0d6;--text:#1b1c20;--muted:#6c707a;--faint:#a6aab2;--forge:#e8480f;--free:#0f9d6b;--busy:#2563eb;--warn:#b45309;--dead:#dc2626}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--ink);color:var(--text);font-family:'Space Grotesk',system-ui,sans-serif;
background-image:linear-gradient(rgba(0,0,0,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.035) 1px,transparent 1px);background-size:46px 46px}
.wrap{max-width:1060px;margin:0 auto;padding:40px 28px}
.eyebrow{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:var(--faint)}
.brand{font-weight:700;font-size:32px;letter-spacing:-1px;margin:6px 0 30px}.brand .k{color:var(--forge)}
.grid{display:grid;grid-template-columns:1.5fr 1fr;gap:22px}@media(max-width:780px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:26px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.lab{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:10px}
#name{width:100%;padding:14px 16px;font-family:'Space Grotesk';font-weight:500;font-size:24px;letter-spacing:3px;text-transform:uppercase;background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--text);outline:none}
#name:focus{border-color:var(--forge)}
.stamp{margin-top:20px;background:var(--panel2);border:1px dashed var(--forge);border-radius:12px;min-height:230px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
.ring{width:16px;height:16px;border-radius:50%;border:3px solid var(--faint)}
.stampname{font-weight:700;font-size:clamp(32px,8vw,62px);line-height:.95;letter-spacing:2px;word-break:break-all}
.accent{width:54px;height:4px;border-radius:3px;background:var(--forge)}
.cap{font-family:'Space Mono',monospace;font-size:12px;letter-spacing:1px;color:var(--muted)}
.row{display:flex;align-items:center;gap:11px;margin-top:20px}
.row input{accent-color:var(--forge);width:17px;height:17px}.row label{font-size:14px;color:var(--muted)}
.go{margin-top:20px;width:100%;padding:16px;font-family:'Space Grotesk';font-weight:700;font-size:16px;letter-spacing:.5px;background:var(--forge);color:#fff;border:0;border-radius:11px;cursor:pointer;transition:filter .15s}
.go:hover{filter:brightness(1.08)}.go:disabled{opacity:.45;cursor:not-allowed}
.result{margin-top:16px;font-family:'Space Mono',monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;color:var(--free)}
.trow{display:grid;grid-template-columns:26px 1fr auto;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid var(--line)}
.pid{font-family:'Space Mono',monospace;font-weight:700;color:var(--text)}
.pmid{display:flex;flex-direction:column;gap:2px;min-width:0}
.pip{font-family:'Space Mono',monospace;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pjob{font-family:'Space Mono',monospace;font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border-radius:7px;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle;background:var(--faint)}
.free{background:rgba(21,163,74,.12);color:var(--free)}.free .dot{background:var(--free);animation:pulse 1.8s ease-in-out infinite}
.busy{background:rgba(37,99,235,.12);color:var(--busy)}.busy .dot{background:var(--busy)}
.paused{background:rgba(180,83,9,.12);color:var(--warn)}.paused .dot{background:var(--warn)}
.dead{background:rgba(220,38,38,.1);color:var(--dead)}.dead .dot{background:var(--dead)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body><div class="wrap">
<div class="brand"><span class="k">Key</span>Forge</div>
<div class="grid">
<div class="panel">
<span class="lab">Your name</span>
<input id="name" maxlength="10" placeholder="ASHIM" value="ASHIM" autocomplete="off" spellcheck="false">
<div class="stamp" id="stamp"></div>
<div class="row"><input type="checkbox" id="eject"><label for="eject">Auto-eject — sweep off the bed once it cools</label></div>
<button class="go" id="go">Forge keychain</button>
<div class="result" id="result"></div>
</div>
<div class="panel">
<span class="lab">Printer farm</span>
<button id="scan" style="width:100%;margin-bottom:14px;padding:13px;font-family:'Space Mono',monospace;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;background:var(--panel2);color:var(--forge);border:1px solid var(--forge);border-radius:9px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06)">Scan hotspot for printers</button><div id="farm"></div>
</div></div></div><script>
var style='letters';
var nameEl=document.getElementById('name'),stamp=document.getElementById('stamp'),go=document.getElementById('go'),result=document.getElementById('result');
function valid(v){return /^[A-Z0-9]{2,10}$/.test(v.toUpperCase())}
function render(){var v=nameEl.value.toUpperCase();
 if(!valid(v)){stamp.innerHTML='<div class="cap">Enter 2 to 10 letters or digits</div>';go.disabled=true;return}
 go.disabled=false;
 if(location.search.indexOf('demo')>=0){stamp.style.border='none';stamp.style.background='transparent';stamp.style.minHeight='0';stamp.style.padding='0';stamp.innerHTML='<img style="width:100%;aspect-ratio:2/1;object-fit:cover;object-position:center;display:block;border-radius:8px" src="/api/preview?name='+encodeURIComponent(v)+'&style='+style+'&_='+Date.now()+'">'}else{stamp.innerHTML='<div class="stampname">'+v+'</div>'}}
nameEl.addEventListener('input',render);
go.onclick=function(){var orig=go.textContent;go.disabled=true;go.textContent='Forging…';result.textContent='';
 fetch('/api/print',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:nameEl.value,style:style,eject:document.getElementById('eject').checked,start:true})})
 .then(function(r){return r.json()}).then(function(d){go.disabled=false;go.textContent=orig;
  if(!d.ok){result.style.color='var(--dead)';result.textContent='Could not generate:\\n'+d.log;return}
  var info=(d.seconds?Math.round(d.seconds/60)+' min':'')+(d.grams?' - '+d.grams+' g':'');
  if(d.printed&&d.printed.ok){result.style.color='var(--free)';result.textContent='Printing on '+d.printed.printer+' ('+d.printed.ip+')'+(d.printed.confirmed?' - confirmed':' - sent')+'  '+info}
  else{result.style.color='var(--warn)';result.textContent='Files ready ('+info+') but not sent: '+((d.printed&&d.printed.error)||'no printer')+'. Free a printer and retry.'}})};
function farm(){fetch(window.__ips?'/api/farm?ips='+window.__ips:'/api/farm').then(function(r){return r.json()}).then(function(d){var t=document.getElementById('farm');
 if(!d.length){t.innerHTML='<div class="cap" style="padding-top:8px">No printers connected — add one in pipeline/printers.json</div>';return}
 var h='';for(var i=0;i<d.length;i++){var p=d[i];var c=p.status==='free'?'free':p.status==='busy'?'busy':p.status==='paused'?'paused':'dead';
  h+='<div class="trow"><span class="pid">'+p.id+'</span><span class="pmid"><span class="pip">'+p.ip+'</span>'+(p.job&&p.job!=='-'?'<span class="pjob">'+p.job+'</span>':'')+'</span><span class="pill '+c+'"><span class="dot"></span>'+p.status+'</span></div>'}
 t.innerHTML=h}).catch(function(){})}
function renderRows(d){var t=document.getElementById('farm');var h='';for(var i=0;i<d.length;i++){var p=d[i];var c=p.status==='free'?'free':p.status==='busy'?'busy':p.status==='paused'?'paused':'dead';h+='<div class="trow"><span class="pid">'+p.id+'</span><span class="pmid"><span class="pip">'+p.ip+'</span>'+(p.job&&p.job!=='-'?'<span class="pjob">'+p.job+'</span>':'')+'</span><span class="pill '+c+'"><span class="dot"></span>'+p.status+'</span></div>'}t.innerHTML=h}
render();
if(location.search.indexOf('demo')>=0){renderRows([{id:'A',ip:'10.158.163.29',status:'free',job:'-'},{id:'B',ip:'10.158.163.31',status:'busy',job:'MAYA 47%'},{id:'C',ip:'10.158.163.34',status:'free',job:'-'},{id:'D',ip:'10.158.163.42',status:'busy',job:'ZANE 12%'}]);}else{farm();setInterval(farm,8000);}
document.getElementById('scan').onclick=function(){var b=this;b.disabled=true;b.textContent='Scanning…';fetch('/api/discover').then(function(r){return r.json()}).then(function(d){b.disabled=false;b.textContent='Scan hotspot for printers';window.__ips=(d.found||[]).map(function(p){return p.ip}).join(',')||null;farm()}).catch(function(){b.disabled=false;b.textContent='Scan hotspot for printers'})};
</script></body></html>`;
