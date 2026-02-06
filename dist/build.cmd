@echo off
setlocal enabledelayedexpansion

set DIST=%~dp0
set ROOT=%DIST%..
set SRC=%ROOT%\src
set CHROME=%DIST%chrome
set FIREFOX=%DIST%firefox

if exist "%ROOT%\logo.png" (
  echo [build] Found logo.png, generating extension icons...
  powershell -NoProfile -Command ^
    "$ErrorActionPreference='Stop';" ^
    "Add-Type -AssemblyName System.Drawing;" ^
    "$root=[IO.Path]::GetFullPath('%ROOT%');" ^
    "$logo=Join-Path $root 'logo.png';" ^
    "$assets=Join-Path $root 'src\assets';" ^
    "$sizes=@(16,32,48,128);" ^
    "$src=[System.Drawing.Image]::FromFile($logo);" ^
    "try {" ^
    "  foreach($size in $sizes){" ^
    "    $bmp=New-Object System.Drawing.Bitmap $size,$size;" ^
    "    $gfx=[System.Drawing.Graphics]::FromImage($bmp);" ^
    "    try {" ^
    "      $gfx.Clear([System.Drawing.Color]::Transparent);" ^
    "      $gfx.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;" ^
    "      $gfx.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality;" ^
    "      $gfx.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;" ^
    "      $gfx.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality;" ^
    "      $scale=[Math]::Min($size / [double]$src.Width, $size / [double]$src.Height);" ^
    "      $w=[int][Math]::Round($src.Width * $scale);" ^
    "      $h=[int][Math]::Round($src.Height * $scale);" ^
    "      $x=[int][Math]::Floor(($size - $w) / 2);" ^
    "      $y=[int][Math]::Floor(($size - $h) / 2);" ^
    "      $gfx.DrawImage($src, $x, $y, $w, $h);" ^
    "      $out=Join-Path $assets ('icon-' + $size + '.png');" ^
    "      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png);" ^
    "    } finally { $gfx.Dispose(); $bmp.Dispose(); }" ^
    "  }" ^
    "} finally { $src.Dispose(); }"
  if errorlevel 1 (
    echo [build] Failed to generate icons from logo.png
    exit /b 1
  )
)

if exist "%CHROME%" rmdir /s /q "%CHROME%"
if exist "%FIREFOX%" rmdir /s /q "%FIREFOX%"
if exist "%DIST%chrome.zip" del /q "%DIST%chrome.zip"
if exist "%DIST%firefox.zip" del /q "%DIST%firefox.zip"

mkdir "%CHROME%"
mkdir "%FIREFOX%"

xcopy "%SRC%" "%CHROME%" /E /I /H /Y >nul
xcopy "%SRC%" "%FIREFOX%" /E /I /H /Y >nul

copy /Y "%ROOT%\manifest.chrome.json" "%CHROME%\manifest.json" >nul
copy /Y "%ROOT%\manifest.firefox.json" "%FIREFOX%\manifest.json" >nul

pushd "%ROOT%"
node "%ROOT%\scripts\bundle-firefox.mjs"
popd

powershell -NoProfile -Command "Compress-Archive -Path '%CHROME%\*' -DestinationPath '%DIST%chrome.zip' -Force"
powershell -NoProfile -Command "Compress-Archive -Path '%FIREFOX%\*' -DestinationPath '%DIST%firefox.zip' -Force"

echo Build done
endlocal
