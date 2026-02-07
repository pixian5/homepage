@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
set DIST=%ROOT%dist
set SRC=%ROOT%src
set CHROME=%DIST%\chrome
set FIREFOX=%DIST%\firefox

if exist "%CHROME%" rmdir /s /q "%CHROME%"
if exist "%FIREFOX%" rmdir /s /q "%FIREFOX%"
if exist "%DIST%\chrome.zip" del /q "%DIST%\chrome.zip"
if exist "%DIST%\firefox.zip" del /q "%DIST%\firefox.zip"

mkdir "%CHROME%"
mkdir "%FIREFOX%"

xcopy "%SRC%" "%CHROME%" /E /I /H /Y >nul
xcopy "%SRC%" "%FIREFOX%" /E /I /H /Y >nul

copy /Y "%ROOT%manifest.chrome.json" "%CHROME%\manifest.json" >nul
copy /Y "%ROOT%manifest.firefox.json" "%FIREFOX%\manifest.json" >nul

where node >nul 2>nul
if %errorlevel%==0 (
  node "%ROOT%scripts\\bundle-firefox.mjs"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\\bundle-firefox.ps1" -RootDir "%ROOT%"
)
if errorlevel 1 (
  echo [build] Failed to generate Firefox bundle
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\zip-normalized.ps1" -SourceDir "%DIST%\firefox" -DestinationZip "%DIST%\firefox.zip"
if errorlevel 1 (
  echo [build] Failed to package firefox.zip
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\zip-normalized.ps1" -SourceDir "%DIST%\chrome" -DestinationZip "%DIST%\chrome.zip"
if errorlevel 1 (
  echo [build] Failed to package chrome.zip
  exit /b 1
)

echo Build done
endlocal
