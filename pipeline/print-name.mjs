// KeyForge pipeline: name -> STL (OpenSCAD) -> G-code (PrusaSlicer) -> printer (Moonraker HTTP upload)
//
// usage:  node print-name.mjs MAYA --start    generate + slice + upload + start print
//         node print-name.mjs MAYA            generate + slice + upload only
//         node print-name.mjs MAYA --dry-run  generate + slice only (no printer needed)
//
// config via env vars, or edit the defaults below:
//   PRINTER_URL=http://192.168.1.50:7125

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const OPENSCAD = process.env.OPENSCAD ?? String.raw`C:\Program Files\OpenSCAD\openscad.com`;
const SLICER = process.env.SLICER ?? String.raw`C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe`;
const PRINTER_URL = process.env.PRINTER_URL ?? "http://192.168.1.50:7125";

const here = import.meta.dirname;
const SCAD = path.join(here, "keychain.scad");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const startPrint = args.includes("--start");
const style = args.includes("--tag") ? "tag" : "letters";
const eject = args.includes("--eject");
const name = args.filter((a) => !a.startsWith("--")).join(" ").trim().toUpperCase();

// Letters and digits only. This keeps the OpenSCAD -D argument injection-safe and
// prevents floating disconnected separators in letters style.
if (!/^[A-Z0-9]{2,10}$/.test(name)) {
  console.error(`bad name "${name}" - use 2-10 letters/digits, nothing else`);
  process.exit(1);
}

const PROFILE = path.join(here, eject ? "keyforge-eject.ini" : "keyforge.ini");

if (!existsSync(PROFILE)) {
  console.error(`missing ${PROFILE}`);
  console.error("Open PrusaSlicer, set up the Ender 3 V3 KE profile once, then File > Export > Export Config to this path.");
  process.exit(1);
}

const outDir = path.join(here, "out");
mkdirSync(outDir, { recursive: true });
const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
const stl = path.join(outDir, `${slug}_${style}.stl`);
const gcode = path.join(outDir, `kf_${slug}_${style}${eject ? "_eject" : ""}.gcode`);
if (eject) console.log("eject profile: after printing, the printer waits 15 min for cooldown, then sweeps the part off the front edge — keep the area in front of the bed clear");

console.log(`[1/3] OpenSCAD: "${name}" (${style}) -> ${path.basename(stl)}`);
const scad = spawnSync(OPENSCAD, ["-o", stl, "-D", `name="${name}"`, "-D", `style="${style}"`, SCAD], {
  encoding: "utf8",
});
const scadLog = (scad.stdout ?? "") + (scad.stderr ?? "");
process.stdout.write(scadLog);
if (scad.status !== 0) process.exit(scad.status ?? 1);

// "Volumes: 2" = inside + outside = one connected solid. More means loose pieces.
const volumes = Number(scadLog.match(/Volumes:\s*(\d+)/)?.[1] ?? NaN);
if (volumes !== 2) {
  console.error(`geometry check FAILED: "${name}" renders as ${volumes - 1} separate pieces in ${style} style.`);
  console.error("letters in this name do not touch - print it as a solid tag instead: add --tag");
  process.exit(1);
}
console.log("geometry check passed: one connected solid");

console.log(`[2/3] slicing -> ${path.basename(gcode)}`);
execFileSync(SLICER, ["--export-gcode", "--load", PROFILE, "--center", "110,110", "--output", gcode, stl], {
  stdio: "inherit",
});
addCrealityMetadata(gcode);

if (dryRun) {
  console.log(`dry run done - open ${gcode} in the slicer GUI to preview before trusting it`);
  process.exit(0);
}

console.log(`[3/3] uploading to ${PRINTER_URL}${startPrint ? " and starting print" : ""}`);
const info = await fetch(`${PRINTER_URL}/server/info`).catch((error) => error);
if (info instanceof Error || !info.ok) {
  const detail = info instanceof Error ? info.message : `HTTP ${info.status} - ${await info.text()}`;
  console.error(`printer preflight failed: ${detail}`);
  console.error(`check the IP, then run: node pipeline/printer-probe.mjs ${PRINTER_URL}`);
  process.exit(1);
}

const form = new FormData();
form.append("file", new Blob([readFileSync(gcode)]), path.basename(gcode));
form.append("print", startPrint ? "true" : "false");

const res = await fetch(`${PRINTER_URL}/server/files/upload`, { method: "POST", body: form });
if (!res.ok) {
  console.error(`upload failed: HTTP ${res.status} - ${await res.text()}`);
  process.exit(1);
}

const payload = await res.json();
console.log("accepted:", JSON.stringify(payload));
if (!startPrint) {
  console.log("uploaded only. To start automatically, rerun with --start after confirming the bed is clear.");
}

function addCrealityMetadata(filePath) {
  const original = readFileSync(filePath, "utf8");
  if (original.startsWith(";KEYFORGE_META:1")) return;

  const seconds = parsePrusaTimeSeconds(original);
  const filamentMm = Number(original.match(/; filament used \[mm\] = ([\d.]+)/)?.[1] ?? 0);
  const layerHeight = Number(original.match(/; layer_height = ([\d.]+)/)?.[1] ?? original.match(/;HEIGHT:([\d.]+)/)?.[1] ?? 0.2);
  const bounds = calculateBounds(original);
  const layerCount = (original.match(/^;LAYER_CHANGE/gm) ?? []).length;

  const meta = [
    ";KEYFORGE_META:1",
    ";Generated with KeyForge + PrusaSlicer",
    ";FLAVOR:Marlin",
    `;TIME:${seconds}`,
    `;Filament used: ${(filamentMm / 1000).toFixed(2)}m`,
    `;Layer height: ${layerHeight}`,
    `;MINX:${bounds.minX.toFixed(3)}`,
    `;MINY:${bounds.minY.toFixed(3)}`,
    `;MINZ:${bounds.minZ.toFixed(3)}`,
    `;MAXX:${bounds.maxX.toFixed(3)}`,
    `;MAXY:${bounds.maxY.toFixed(3)}`,
    `;MAXZ:${bounds.maxZ.toFixed(3)}`,
    `;LAYER_COUNT:${layerCount}`,
    "",
  ].join("\n");

  writeFileSync(filePath, `${meta}${original}`);
  console.log(`Creality metadata added: ${seconds}s, ${layerCount} layers`);
}

function parsePrusaTimeSeconds(gcodeText) {
  const estimate = gcodeText.match(/; estimated printing time \(normal mode\) = ([^\r\n]+)/)?.[1];
  if (!estimate) return 0;

  let seconds = 0;
  const hours = estimate.match(/(\d+)\s*h/);
  const minutes = estimate.match(/(\d+)\s*m/);
  const secs = estimate.match(/(\d+)\s*s/);
  if (hours) seconds += Number(hours[1]) * 3600;
  if (minutes) seconds += Number(minutes[1]) * 60;
  if (secs) seconds += Number(secs[1]);
  return seconds;
}

function calculateBounds(gcodeText) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };

  for (const line of gcodeText.split(/\r?\n/)) {
    if (!/^G[01]\b/.test(line)) continue;
    updateAxis(bounds, "X", line);
    updateAxis(bounds, "Y", line);
    updateAxis(bounds, "Z", line);
  }

  for (const axis of ["X", "Y", "Z"]) {
    const minKey = `min${axis}`;
    const maxKey = `max${axis}`;
    if (!Number.isFinite(bounds[minKey])) bounds[minKey] = 0;
    if (!Number.isFinite(bounds[maxKey])) bounds[maxKey] = 0;
  }

  return bounds;
}

function updateAxis(bounds, axis, line) {
  const value = Number(line.match(new RegExp(`\\b${axis}(-?\\d+(?:\\.\\d+)?)`))?.[1] ?? NaN);
  if (!Number.isFinite(value)) return;

  bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], value);
  bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], value);
}
