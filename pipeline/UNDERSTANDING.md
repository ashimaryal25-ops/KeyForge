# Understanding KeyForge — dissect it one piece at a time

The whole pipeline is "type a name → get a printed keychain." That one sentence hides
a bunch of mechanisms, in two parts (Part 1 makes the keychain, Part 2 prints it on a real farm with no root). Read them in order. After each, do the **Prove it** step yourself — that's
what turns "somehow it works" into actually understanding it.

Two files do almost everything:
- `keychain.scad` — the recipe that turns a name into a 3D model (OpenSCAD runs it)
- `print-name.mjs` — the conductor: runs OpenSCAD, runs the slicer, sends to the printer
- `keyforge.ini` / `keyforge-eject.ini` — slicer settings (speeds, temps, the eject sweep)

---

## 1. How a string becomes a 3D shape
**File:** `keychain.scad`

`text("MAYA")` doesn't *draw* letters — it reads the actual curve outlines out of the
Arial Black font file installed on Windows. Those are flat 2D outlines.
`linear_extrude(5)` lifts them into 5mm-thick 3D. `difference()` subtracts a cylinder to
punch the keyring hole. That's the STL: font outlines → extrude → subtract.

**Prove it:** open `keychain.scad`, find the `text(...)` line. Change the font to
`"Consolas:style=Bold"`, regenerate, look at the model. Different font = different curves,
no other change.

---

## 2. The rail trick
**File:** `keychain.scad`, the `l_rail_core()` module

OpenSCAD can't tell you how wide the text is. So the underline is built by *intersecting*
the text with a thin horizontal strip (everything at the baseline height) and wrapping a
`hull()` (a shrink-wrap) around whatever that catches. The strip + hull automatically span
from the first letter to the last, for any name. A second lowered copy makes the line
stick out below the letters.

**Prove it:** in `l_rail_core()`, the `square([600, 1.4])` is the strip. Make it taller
and you grab more of each letter; the underline gets fatter. Try it.

---

## 3. The `Volumes: 2` connectivity check
**File:** `print-name.mjs`, the block after `// "Volumes: 2"`

OpenSCAD's engine splits *all of space* into sealed regions. One solid keychain = the
outside air (1) + the inside of the solid (1) = **2**. If two letters don't touch, there's
now a second separate interior → **3**. So the rule is: pieces = Volumes − 1. The script
reads that number from OpenSCAD's output and refuses to slice anything that isn't 2 — it
*proves* the keychain is one connected piece before any plastic is used. No human inspects
anything.

**Prove it:** run `node pipeline\print-name.mjs TI --dry-run`. Watch a tight name pass.
The check is what printed "geometry check passed."

---

## 4. What slicing actually is
**File:** `print-name.mjs` (the `execFileSync(SLICER, ...)` call) + any `.gcode` in `out\`

An STL is only a *surface* — a shell of triangles. It has no idea what a layer is. The
slicer (PrusaSlicer) cuts the shell into 0.28mm-thick horizontal slices and writes a long
list of "move to X,Y / extrude this much" commands. That list is the G-code.

**Prove it:** open any `kf_*.gcode` in Notepad. It's plain text. Lines like `G1 X75 Y102
E.8` mean "move there while pushing 0.8mm of filament." That's all a print is.

---

## 5. Why there's no pendrive
**File:** `print-name.mjs`, the `fetch(... /server/files/upload ...)` block

The printer runs a tiny web server (Moonraker, on port 7125). The script sends the G-code
to it as an HTTP multipart POST — the same kind of request a website file-upload form
makes — with a `print=true` flag to start it. That's the entire "beam it over WiFi." No
USB stick because the file travels over the network instead.

**Prove it:** the `PRINTER_URL` line is the printer's address. On the local network, run
`Invoke-RestMethod http://<printer-ip>:7125/printer/info` — JSON back means the web server
answered.

---

## 6. The eject is just appended text
**File:** `keyforge-eject.ini`, the `end_gcode = ...` line

No special hardware. After the print, these extra G-code lines turn off the heaters, dwell
15 minutes (`G4 P900000`) so the plate cools and the part's bond cracks loose, then drop
the nozzle to 1.6mm and drive the bed so the part is swept off the front edge — three times
at different X positions in case it pivots.

**Prove it:** read the `end_gcode` line and match each command to the motion: `M140 S0` =
bed heater off, `G4 P900000` = wait 900000ms = 15 min, `G1 Y2` = push toward the front.

---

## 7. Why it's 5mm thick (the snap fix)
**File:** `keychain.scad` (`l_height`) + `keyforge.ini` (`perimeters`)

The first real print was 4mm thick and snapped too easily in the hand. Bending strength grows
with thickness *cubed*, so going 4mm → 5mm roughly **doubled** it ((5/4)³ ≈ 2), and the
underline became a deeper "spine" that carries the bending load. Walls also went to 3 perimeters.

**Prove it:** the math — a 25% thicker part is twice as stiff. Set `l_height` back to 4, print,
and try to snap it against the 5mm one. You'll feel the cube law with your hands.

---

# Part 2 — getting it onto real printers (no root, no pendrive)

Everything above makes a *file*. Part 2 is how that file becomes a print on the stock
Ender 3 V3 KE printers, automatically, from a web page. New files:
- `server.mjs` — the web kiosk + live farm dashboard (a tiny web server on your laptop)
- `creality.mjs` — talks to a stock printer over the network: upload a file, start a print
- `farm-status.mjs` — prints each printer's free/busy from the terminal
- `grab-printer-ui.mjs` / `printer-probe.mjs` — tools we used to figure the printer out

---

## 8. Why the kiosk needs a server (a browser can't run a printer)
**File:** `server.mjs`

A web page in a browser is sandboxed — it can't run OpenSCAD, run the slicer, or open a socket
to a printer. So `server.mjs` is a tiny web server on your laptop. The browser page just sends
requests (`/api/print`, `/api/farm`); the server does the real work and sends results back. The
kiosk is the face; the server is the hands.

**Prove it:** with the server running, open `http://localhost:5180/api/farm` in the browser —
you see the raw JSON the dashboard is drawn from.

---

## 9. Reading printer status with no root (the :9999 socket)
**File:** `server.mjs` (`probe()`), `farm-status.mjs`

The printer constantly broadcasts its state — temperature, progress, current file — over a
WebSocket on **port 9999**. We connect, listen, and read fields like `printFileName` and
`printProgress`. No file = free; a file under 100% = busy. That's the whole free/busy detection,
and it needs no rooting because the printer's *own* app reads the same socket.

**Prove it:** on the hotspot, `node pipeline/farm-status.mjs 10.158.163.29` — it prints free/busy
straight from that socket.

---

## 10. Finding printers on the network (the scan)
**File:** `server.mjs` (`apiDiscover`)

A network is just numbered addresses (`10.158.163.1` … `.254`). To find printers we try opening
the :9999 socket on every address; the ones that answer are printers, the rest time out and get
dropped. We prefer the private hotspot range over campus wifi so it scans the right network.

**Prove it:** this is literally why `.53` timed out and `.29` didn't — nothing's at `.53`. Click
**Scan hotspot for printers** and only the live ones show up.

---

## 11. Cracking the print protocol from the printer's own code (the big one)
**File:** `grab-printer-ui.mjs` → `printer-ui/static_js_app.*.js`

Creality publishes no API. But the printer serves its own web app, and that app *does* upload and
start prints — so its JavaScript contains the exact calls. We downloaded that JS
(`grab-printer-ui.mjs`) and read it. It revealed **`POST /upload/<name>`** for uploading, and a
socket message **`{method:"set",params:{opGcodeFile:"printprt:<path>"}}`** for starting. The
answer was hiding in plain sight, in the printer's own code.

**Prove it:** open `pipeline/printer-ui/static_js_app.*.js` and search for `printprt` — that's the
exact start command, lifted straight from Creality's code.

---

## 12. Actually printing: upload + start
**File:** `creality.mjs`

Two steps, both from #11: (1) POST the G-code to `http://<ip>/upload/<name>` as a multipart form;
(2) send the start message over the :9999 socket with `printprt:<path>`. Then we poll the socket
to confirm the printer reports *our* file — so we know it really started, not just "sent and hoped."

**Prove it:** on the hotspot, `node pipeline/creality.mjs 10.158.163.29 <a-gcode-file>` — uploads,
starts, confirms. This is the exact command that proved the whole vision works.

---

## 13. The Forge button doing the whole thing
**File:** `server.mjs` (`apiPrint`)

Click Forge → the server generates the files (`print-name.mjs`), picks the first free printer
(`pickFreePrinter`, reading the :9999 status), calls `creality.mjs` to upload + start on it, and
tells the page what happened. Type a name → a printer prints it, end to end, no human between.

**Prove it:** in the kiosk, Forge a name and watch the farm dashboard flip that printer to BUSY
with your file's name.

---

## Gotchas we hit (debugging these taught more than any explanation)
- **The empty preview box** — a global `var name = ...` collided with the browser's built-in
  `window.name`, which is *forced* to be a string. It silently killed the whole script. Lesson:
  never name a global `name` in browser JS. (Fixed by renaming to `nameEl`.)
- **The silent no-op CLI** — `creality.mjs` ran but printed nothing, because the "am I being run
  directly?" check compared `file://` paths that don't match on Windows (drive-letter slashes).
  Fixed with Node's `pathToFileURL`. Lesson: use the platform's own path↔URL helper, don't hand-build it.
- **254 garbage rows in the scan** — a timeout was being treated as "maybe a printer." Fixed by
  only counting addresses that actually sent data. Lesson: "no answer" is not "yes."

---

