# KeyForge

An automated name-keychain vending pipeline for a 3D-printer farm. A visitor types their
name at a kiosk; the system generates a 3D model, validates it, slices it, picks a free
printer, uploads the job, and starts the print — **no manual modeling, no slicer, no USB
stick, and no rooting the printers.**

```
name → OpenSCAD model → STL → PrusaSlicer → G-code → pick a free printer → upload + start
```

## What makes it interesting

- **Type-to-object.** A name becomes a manufacturable 3D model in ~1 second (parametric
  OpenSCAD), with no human in the CAD step.
- **Geometry self-validation.** Before slicing, it proves the keychain is one connected
  solid using OpenSCAD's volume count — so a name whose letters don't touch is rejected
  automatically, never printed as loose pieces.
- **No-root printer control.** Stock Creality Ender 3 V3 KE printers expose no
  official API. KeyForge drives them anyway by speaking their own protocol —
  reverse-engineered from the printer's built-in web app: file upload over HTTP, print start
  over the printer's WebSocket (port 9999). No firmware modification.
- **Self-discovering farm.** Scans the local network, finds every printer, and reads each
  one's live free/busy status — all over that same stock socket.
- **Unattended-ready.** An eject G-code profile sweeps the finished keychain off the bed
  after cooldown, so the farm can run without a person clearing beds.

## Files

| File | Role |
|------|------|
| `pipeline/keychain.scad` | Parametric model. Letters joined by an underline spine so any name prints as one piece. `style="tag"` is a solid-tag fallback. |
| `pipeline/print-name.mjs` | Name → STL → G-code. Validates the name, runs OpenSCAD, checks one-connected-solid, slices. |
| `pipeline/creality.mjs` | Drives a stock printer: upload a G-code file, start the print, confirm it began. |
| `pipeline/server.mjs` | Web interface — kiosk (type a name → forge) + live farm dashboard + network discovery. Zero dependencies. |
| `pipeline/farm-status.mjs` | Command-line free/busy across printers. |
| `pipeline/printer-probe.mjs` | Inspect what a printer exposes (stock UI vs Moonraker). |
| `pipeline/grab-printer-ui.mjs` | Downloads a printer's own web app — how the protocol was reverse-engineered. |
| `pipeline/keyforge.ini` / `keyforge-eject.ini` | Slicer profiles. The eject variant appends the cooldown + bed-sweep. |
| `pipeline/printers.json` | The farm's printer list (id, ip, filament). |
| `pipeline/UNDERSTANDING.md` | Section-by-section walkthrough of every mechanism. Start here to read the code. |

## Prerequisites

- [OpenSCAD](https://openscad.org) — model generation (override path with `OPENSCAD`)
- [PrusaSlicer](https://www.prusa3d.com/prusaslicer/) — slicing (override path with `SLICER`)
- Node 22+ — for the built-in `fetch` and `WebSocket` (the pipeline has **no npm dependencies**)

## Quick start

Generate files for a name (no printer needed):

```bash
node pipeline/print-name.mjs ASHIM --dry-run
```

`--eject` uses the auto-eject profile, `--tag` uses the solid-tag style. Output lands in
`pipeline/out/`.

Run the kiosk + dashboard:

```bash
node pipeline/server.mjs
# open http://localhost:5180
```

Find printers / check status on the farm network:

```bash
node pipeline/farm-status.mjs            # reads printers.json
node pipeline/farm-status.mjs 10.0.0.42  # or an explicit IP
```

Print to a real printer (upload + start + confirm):

```bash
node pipeline/creality.mjs <printer-ip> pipeline/out/kf_ashim_letters.gcode
```

## Status

- Name → STL → G-code, with geometry self-validation: **working, verified.**
- No-root printer control (upload + start + status) over the stock protocol: **working,
  confirmed on real hardware** ("printer reports it is printing this file").
- Farm: network discovery + live free/busy status: **working.**
- Kiosk end-to-end (type name → printer starts → keychain comes out): **working** — physical
  keychains printed and confirmed.
- Remaining (physical, not software): auto-eject sweep reliability run, and longevity testing
  across the farm.

