$ErrorActionPreference = "Stop"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is required. Install App Installer from the Microsoft Store, then run this script again."
}

@(
  "OpenJS.NodeJS.LTS",
  "OpenSCAD.OpenSCAD",
  "Prusa3D.PrusaSlicer"
) | ForEach-Object {
  winget install --exact --id $_ --accept-package-agreements --accept-source-agreements
}

Write-Host "Setup complete. Open a new PowerShell window, then run: node pipeline/server.mjs"
