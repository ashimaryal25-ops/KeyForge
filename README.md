# KeyForge

KeyForge is a local production console for making name keychains across a small 3D-printer farm. An operator enters a name, KeyForge builds and validates the model, slices it, adds the job to a queue, finds available printers, and starts the print from the same dashboard.

It was built around stock Creality Ender 3 V3 KE printers. Printer control works over the local network without rooting the machines, replacing their firmware, or carrying G-code around on a USB drive.

![KeyForge creating, assigning, and starting a print](docs/keyforge-demo.gif)

```text
name → OpenSCAD model → geometry check → STL → PrusaSlicer → G-code → queue → printer
```

## What KeyForge handles

- Generates a parametric keychain from a 2–10 character name or identifier.
- Rejects models that do not form one connected printable solid.
- Slices valid models with the included Ender 3 V3 KE profile.
- Shows an OpenSCAD preview after the job is prepared.
- Keeps waiting, active, failed, and recently completed jobs in one queue.
- Discovers printers on the local private network and polls their live state.
- Supports manual assignment or automatic dispatch to an eligible printer.
- Uploads G-code to stock Creality firmware and confirms that printing started.
- Tracks print progress, estimated time, and filament use.
- Holds a finished printer until an operator confirms that its bed is clear.
- Lets an operator download G-code, retry failed jobs, or remove unwanted jobs.
- Restores queue and history state after a server restart.

## Operator workflow

1. Start KeyForge and open the dashboard.
2. Select **Scan network** to find the printers on the current private subnet.
3. Enter a name and select **Submit job**. KeyForge validates, slices, and queues it.
4. Either choose the job beside a free printer and select **Assign**, or enable **Auto-dispatch**.
5. Watch the printer state and progress from the dashboard.
6. When a print finishes, remove it from the bed and select **Mark bed clear**. The printer can then accept another job.

Failed jobs stay visible under **Needs attention**. They can be requeued after the problem is fixed, downloaded for inspection, or deleted.

## Quick start

### Requirements

- Windows 10 or 11 for the provided setup script
- [Node.js 22 or newer](https://nodejs.org/)
- [OpenSCAD](https://openscad.org/)
- [PrusaSlicer](https://www.prusa3d.com/page/prusaslicer_424/)
- A computer and the printers connected to the same private `/24` network

The dashboard server and printer workflow use Node's built-in APIs and have no runtime npm dependencies.

### Install the tools on Windows

From PowerShell in the repository:

```powershell
.\setup-windows.ps1
```

The script installs Node.js LTS, OpenSCAD, and PrusaSlicer through `winget`. Open a new PowerShell window after it finishes.

If PowerShell blocks the script, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

### Start KeyForge

```powershell
node pipeline\server.mjs
```

Open [http://localhost:5180](http://localhost:5180), then select **Scan network**. KeyForge prefers the standard Windows Mobile Hotspot subnet (`192.168.137.x`) when it is available; otherwise it uses a private subnet detected from the computer's active network interfaces.

Generated STL and G-code files are written to `pipeline/out/`. Queue state is stored in `pipeline/out/workflow-state.json`.

## Dashboard guide

| Area | Purpose |
| --- | --- |
| Summary | Waiting jobs, active prints, lifetime completions, jobs needing attention, and reachable printers. |
| Submit keychain | Validates a name, generates the model and G-code, and adds the job to the queue. |
| 3D preview | Displays the generated keychain model. |
| Print queue | Shows waiting, printing, failed, and the five most recent completed jobs. |
| Auto-dispatch | Sends waiting jobs to printers that are online, idle, and cleared. |
| Printer farm | Shows live printer state and provides manual assignment or bed-clear controls. |
| Scan network | Searches the current private `/24` subnet for printers exposing the Creality status socket. |

Printer addresses are not saved. The farm usually runs on DHCP (often a laptop hotspot), so a stored IP can be wrong after a printer or hotspot restarts. Scan again when the network changes.

## Run the pipeline without a printer

This generates an STL and G-code file but does not upload anything:

```powershell
node pipeline\print-name.mjs NOVA
```

Names must contain 2–10 letters or digits. Output is placed in `pipeline/out/`.

To upload an existing G-code file to a stock printer:

```powershell
node pipeline\creality.mjs 192.168.137.63 pipeline\out\kf_nova.gcode
```

That last command starts a real print. Check that the target printer and its bed are ready first.

## Printer utilities

Check one or more stock printers directly:

```powershell
node pipeline\farm-status.mjs 192.168.137.63 192.168.137.86
```

Add `--raw` to inspect the telemetry returned by the printer:

```powershell
node pipeline\farm-status.mjs --raw 192.168.137.63
```

## Configuration

The default paths match a standard Windows installation. Override them for a different installation or operating system.

| Variable | Default | Used for |
| --- | --- | --- |
| `OPENSCAD` | `C:\Program Files\OpenSCAD\openscad.com` | OpenSCAD command-line executable. |
| `SLICER` | `C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe` | PrusaSlicer command-line executable. |
| `PORT` | `5180` | Dashboard HTTP port. |
| `PRINTER_STALE_MS` | `180000` | Time before an unreachable, inactive printer is removed from the farm view. |
| `GCODE_DIR` | `/usr/data/printer_data/gcodes` | G-code directory used by stock Creality firmware. |
| `HTTP_PORT` | empty | Optional nonstandard printer upload port. |

Example for the current PowerShell session:

```powershell
$env:PORT = "8080"
$env:OPENSCAD = "D:\Apps\OpenSCAD\openscad.com"
node pipeline\server.mjs
```

## How printer control works

The dashboard talks to the same local interfaces used by the printer's stock web application:

1. G-code is uploaded over HTTP.
2. A print-start command is sent over the printer's WebSocket on port `9999`.
3. KeyForge polls telemetry until the printer reports the expected filename in a printing state.
4. Live telemetry drives the dashboard and determines whether a printer is safe to dispatch.

Incomplete or stale telemetry never makes a printer eligible for automatic dispatch. After a completed print, KeyForge requires an explicit bed-clear acknowledgement before it considers that printer available again.

The protocol has been verified on stock Ender 3 V3 KE hardware. Other Creality models may expose different paths or telemetry fields.

## Development

Run the test suite:

```powershell
npm test
```

The tests cover model metadata, discovery, server endpoints, queue persistence, dispatch rules, printer-state transitions, and stock printer control.

### Project map

| Path | Responsibility |
| --- | --- |
| `pipeline/server.mjs` | Local HTTP server, dashboard API, preview rendering, and network discovery. |
| `pipeline/workflow.mjs` | Persistent queue, printer state machine, dispatch, completion, failure, and bed-clear logic. |
| `pipeline/print-name.mjs` | Name validation, OpenSCAD generation, geometry validation, and slicing. |
| `pipeline/keychain.scad` | Parametric keychain model. |
| `pipeline/keyforge.ini` | PrusaSlicer profile for the Ender 3 V3 KE. |
| `pipeline/creality.mjs` | Stock firmware upload, print start, and start confirmation. |
| `pipeline/discovery.mjs` | Safe private-subnet scanning and stable printer labels. |
| `pipeline/farm-status.mjs` | Command-line printer status utility. |
| `pipeline/printer-probe.mjs` | Read-only check that the stock web UI answers. |
| `pipeline/ui/` | Dependency-free dashboard interface. |

## Current scope

KeyForge is working end to end on the hardware it was built for: a name can be submitted, validated, sliced, assigned, uploaded, confirmed as printing, tracked to completion, and cleared for the next job.

It is still a local-network tool rather than a hosted service. The Node process must remain running, the host needs OpenSCAD and PrusaSlicer, and printer discovery should be repeated after network changes.
