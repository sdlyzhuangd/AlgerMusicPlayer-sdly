@echo off
REM Bit-Perfect native module one-click build (dev).
REM Auto-resolves Electron version and headers dir; no hardcoded machine paths.
REM NOTE: keep this file pure ASCII - cmd.exe parses batch files in the system
REM codepage and non-ASCII bytes can break parsing.
setlocal
cd /d "%~dp0"

REM Resolve nodedir (prints hint and exits 1 if not found)
for /f "usebackq delims=" %%i in (`node "%~dp0find-nodedir.cjs"`) do set "NODEDIR=%%i"
if not defined NODEDIR (
  echo [rebuild-bp] nodedir resolution failed, run: npx electron-rebuild -f
  exit /b 1
)

REM Resolve Electron version from node_modules/electron/package.json
for /f "usebackq delims=" %%v in (`node -e "console.log(require('electron/package.json').version || '40.10.6')"`) do set "ETARGET=%%v"
if not defined ETARGET set "ETARGET=40.10.6"

call "%~dp0rebuild-bp.cmd" --target=%ETARGET% --arch=x64 --nodedir=%NODEDIR%
endlocal
