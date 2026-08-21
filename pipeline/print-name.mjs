// KeyForge pipeline: name -> STL (OpenSCAD) -> G-code (PrusaSlicer)
//
// usage:  node print-name.mjs MAYA
//
// To upload to a stock printer after slicing:
//   node pipeline/creality.mjs <printer-ip> pipeline/out/kf_maya.gcode
//
// config via env vars, or edit the defaults below:
//   OPENSCAD, SLICER

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENSCAD = process.env.OPENSCAD ?? String.raw`C:\Program Files\OpenSCAD\openscad.com`;
const SLICER = process.env.SLICER ?? String.raw`C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe`;

const here = import.meta.dirname;
const SCAD = path.join(here, "keychain.scad");

// Everything below runs only when this file is the command being run. Without
// it, importing this module to reach the parsing helpers underneath would spawn
// OpenSCAD and call process.exit() as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const name = args.filter((a) => !a.startsWith("--")).join(" ").trim().toUpperCase();

  // Letters and digits only. This keeps the OpenSCAD -D argument injection-safe and
  // prevents floating disconnected separators in letters style.
  if (!/^[A-Z0-9]{2,10}$/.test(name)) {
    console.error(`bad name "${name}" - use 2-10 letters/digits, nothing else`);
    process.exit(1);
  }

  const PROFILE = path.join(here, "keyforge.ini");

  if (!existsSync(PROFILE)) {
    console.error(`missing ${PROFILE}`);
    console.error("Open PrusaSlicer, set up the Ender 3 V3 KE profile once, then File > Export > Export Config to this path.");
    process.exit(1);
  }

  const outDir = path.join(here, "out");
  mkdirSync(outDir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const stl = path.join(outDir, `${slug}.stl`);
  const gcode = path.join(outDir, `kf_${slug}.gcode`);
  console.log(`[1/2] OpenSCAD: "${name}" -> ${path.basename(stl)}`);
  const scad = spawnSync(OPENSCAD, ["-o", stl, "-D", `name="${name}"`, SCAD], {
    encoding: "utf8",
  });
  const scadLog = (scad.stdout ?? "") + (scad.stderr ?? "");
  process.stdout.write(scadLog);
  if (scad.status !== 0) process.exit(scad.status ?? 1);

  // "Volumes: 2" = inside + outside = one connected solid. More means loose pieces.
  const volumes = Number(scadLog.match(/Volumes:\s*(\d+)/)?.[1] ?? NaN);
  if (volumes !== 2) {
    console.error(`geometry check FAILED: "${name}" renders as ${volumes - 1} separate pieces.`);
    console.error("letters in this name do not touch - try a different name");
    process.exit(1);
  }
  console.log("geometry check passed: one connected solid");

  console.log(`[2/2] slicing -> ${path.basename(gcode)}`);
  execFileSync(SLICER, ["--export-gcode", "--load", PROFILE, "--center", "110,110", "--output", gcode, stl], {
    stdio: "inherit",
  });
  addCrealityMetadata(gcode);
  console.log(`done - ${gcode}`);
  console.log(`upload with: node pipeline/creality.mjs <printer-ip> ${gcode}`);
}

export function addCrealityMetadata(filePath) {
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

export function parsePrusaTimeSeconds(gcodeText) {
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

export function calculateBounds(gcodeText) {
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

export function updateAxis(bounds, axis, line) {
  const value = Number(line.match(new RegExp(`\\b${axis}(-?\\d+(?:\\.\\d+)?)`))?.[1] ?? NaN);
  if (!Number.isFinite(value)) return;

  bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], value);
  bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], value);
}
