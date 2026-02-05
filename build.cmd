@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
set DIST=%ROOT%dist
set SRC=%ROOT%src
set CHROME=%DIST%\chrome
set FIREFOX=%DIST%\firefox

if exist "%CHROME%" rmdir /s /q "%CHROME%"
if exist "%FIREFOX%" rmdir /s /q "%FIREFOX%"
if exist "%DIST%\firefox.zip" del /q "%DIST%\firefox.zip"

mkdir "%CHROME%"
mkdir "%FIREFOX%"

xcopy "%SRC%" "%CHROME%" /E /I /H /Y >nul
xcopy "%SRC%" "%FIREFOX%" /E /I /H /Y >nul

copy /Y "%ROOT%manifest.chrome.json" "%CHROME%\manifest.json" >nul
copy /Y "%ROOT%manifest.firefox.json" "%FIREFOX%\manifest.json" >nul

node "%ROOT%scripts\\bundle-firefox.mjs"

powershell -NoProfile -Command "Compress-Archive -Path '%DIST%\firefox\*' -DestinationPath '%DIST%\firefox.zip' -Force"

echo Build done
endlocal
