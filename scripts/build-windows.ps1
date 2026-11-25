# Builds AutoBrowser for Windows:
#   desktop\release\AutoBrowser Setup <ver>.exe   (installer)
#   desktop\release\AutoBrowser-<ver>-portable.exe (single portable exe)
# Requirements: Python 3.11+ and Node.js 20+ on PATH.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> Backend (FastAPI -> autobrowser-backend.exe)"
Push-Location "$root\backend"
if (-not (Test-Path .venv)) { python -m venv .venv }
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\pip install -r requirements-dev.txt pywin32
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\pyinstaller --noconfirm autobrowser-backend.spec
Pop-Location

Write-Host "==> Frontend (Next.js static export)"
Push-Location "$root\frontend"
npm ci
npm run build
Pop-Location

Write-Host "==> Desktop (Electron -> .exe)"
Push-Location "$root\desktop"
npm ci
npm run dist
Pop-Location

Write-Host "Done. See desktop\release\"
