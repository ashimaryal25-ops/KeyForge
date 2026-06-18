# KeyForge Printer HTTP Path

The current physical printer in the knowledge base is the **Creality Ender 3 V3 KE**.

The existing lab workflow uses USB. To skip the pendrive, KeyForge needs a local network API.

## Important Reality

There are two different situations:

1. **Stock Creality network page only**
   - You may be able to open `http://<printer-ip>` in a browser.
   - This does not guarantee a clean public upload/start API.
   - Creality Print may work because it knows Creality's protocol.

2. **Moonraker/Fluidd/Mainsail enabled**
   - Moonraker usually listens on port `7125`.
   - KeyForge can upload G-code with HTTP.
   - KeyForge can optionally start the print after upload.

For this project, Moonraker is the clean route.

## First Probe

Find the printer IP on the printer screen:

```text
Settings / gear icon -> Network -> IP address
```

Then run:

```bash
node pipeline/printer-probe.mjs 192.168.1.50
```

Replace `192.168.1.50` with the real printer IP.

## What Success Looks Like

If Moonraker is reachable, the probe should show OK for URLs like:

```text
http://<printer-ip>:7125/server/info
http://<printer-ip>:7125/printer/info
```

Then set:

```powershell
$env:PRINTER_URL="http://<printer-ip>:7125"
```

Generate, slice, upload only:

```bash
node pipeline/print-name.mjs ASHIM
```

Generate, slice, upload, and start:

```bash
node pipeline/print-name.mjs ASHIM --start
```

Only use `--start` after a human confirms:

- printer is on
- correct filament is loaded
- bed is clear
- magnetic plate is seated flat
- first layer will be watched

## If Probe Fails

If `http://<printer-ip>` works but `http://<printer-ip>:7125/server/info` fails, then the printer is network-visible but Moonraker is not available.

At that point there are only three practical paths:

1. Keep USB/manual start.
2. Use Creality Print's network workflow manually.
3. Enable/install Moonraker/Fluidd/Mainsail on the printer, then use KeyForge HTTP upload.

Do not build KeyForge around an unverified Creality private endpoint until the probe proves what the printer exposes.
