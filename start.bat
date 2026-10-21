@echo off
rem Opens Muse Console as its own desktop window (not in a browser).
cd /d "%~dp0"

if exist "release\win-unpacked\Plenum.exe" (
  start "" "release\win-unpacked\Plenum.exe"
  exit /b
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b
)

echo Plenum has not been built yet. In this folder, run:
echo   npm install
echo   npm run pack
pause
