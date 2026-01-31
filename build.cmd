@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
pushd "%ROOT_DIR%" >nul

call npm run build:chrome
if errorlevel 1 goto :error

call npm run build:firefox
if errorlevel 1 goto :error

set "OUT_DIR=%ROOT_DIR%dist"
set "FIREFOX_ZIP=%OUT_DIR%\homepage-firefox.zip"
if exist "%FIREFOX_ZIP%" del /f /q "%FIREFOX_ZIP%"
tar -a -c -f "%FIREFOX_ZIP%" -C "%OUT_DIR%\firefox" *
if errorlevel 1 goto :error

echo Done:
echo   Chrome: %OUT_DIR%\chrome
echo   Firefox: %OUT_DIR%\firefox
echo   Firefox package: %FIREFOX_ZIP%

popd >nul
exit /b 0

:error
popd >nul
exit /b 1
