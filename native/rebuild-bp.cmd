@echo off
REM Rebuild bp-output native module (Windows).
REM Usage: rebuild-bp.cmd [--target=<electron version>] [--arch=x64] [--nodedir=<dir>]
REM Loads MSVC env via vcvars64 (works with VS at non-standard paths).
REM NOTE: keep this file pure ASCII - cmd.exe parses batch files in the system
REM codepage and non-ASCII bytes can break parsing.
setlocal

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSROOT="
if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VSROOT=%%i"
)
if not defined VSROOT (
  echo [rebuild-bp] Visual Studio not found
  exit /b 1
)

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
  echo [rebuild-bp] vcvars64.bat failed
  exit /b 1
)

REM Locate the real Windows SDK on disk. The registry may point at a stale/moved
REM install (e.g. E:\Windows Kits\10), which breaks MSBuild with MSB8036, so find
REM the SDK directly and override WindowsSdkDir/WindowsSDKVersion.
set "SDKROOT="
set "SDKVER="
REM NOTE: avoid backtick-for/f here - the (x86) parentheses break cmd's
REM bracket matching and silently truncate the command. for /d with a quoted
REM glob skips brackets correctly.
for /d %%D in ("%ProgramFiles(x86)%\Windows Kits\10\Include\10.*") do set "SDKVER=%%~nxD"
if defined SDKVER set "SDKROOT=%ProgramFiles(x86)%\Windows Kits\10"
if not defined SDKROOT (
  for /d %%D in ("E:\Windows Kits\10\Include\10.*") do set "SDKVER=%%~nxD"
  if defined SDKVER set "SDKROOT=E:\Windows Kits\10"
)
if defined SDKROOT (
  set "WindowsSdkDir=%SDKROOT%\"
  set "WindowsSDKVersion=%SDKVER%\"
  set "UCRTVersion=%SDKVER%\"
  REM Override the stale registry value (Microsoft SDKs\Windows\v10.0
  REM InstallationFolder may point at an old/moved SDK) - MSBuild's
  REM WindowsSdkDir_10 property only reads the registry when unset.
  set "WindowsSdkDir_10=%SDKROOT%\"
  set "UniversalCRTSdkDir_10=%SDKROOT%\"
)

cd /d "%~dp0"
call ..\node_modules\.bin\node-gyp.cmd rebuild %*
if errorlevel 1 (
  echo [rebuild-bp] build failed
  exit /b 1
)
echo [rebuild-bp] build OK
endlocal
