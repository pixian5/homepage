param(
  [string]$RootDir = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

function Remove-ImportsAndExports {
  param([string]$Code)
  $withoutImports = [System.Text.RegularExpressions.Regex]::Replace(
    $Code,
    "^\s*import[\s\S]*?;\s*",
    "",
    [System.Text.RegularExpressions.RegexOptions]::Multiline
  )
  return [System.Text.RegularExpressions.Regex]::Replace(
    $withoutImports,
    "\bexport\s+(?=async|function|const|let|var|class)",
    ""
  )
}

$srcDir = Join-Path $RootDir "src\js"
$firefoxDir = Join-Path $RootDir "dist\firefox"
$outDir = Join-Path $firefoxDir "js"
$outFile = Join-Path $outDir "app.ff.js"
$htmlPath = Join-Path $firefoxDir "newtab.html"
$manifestPath = Join-Path $firefoxDir "manifest.json"

$files = @(
  "storage.js",
  "icons.js",
  "bing-wallpaper.js",
  "app.js"
)

if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

$chunks = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
  $fullPath = Join-Path $srcDir $file
  $code = [System.IO.File]::ReadAllText($fullPath, [System.Text.Encoding]::UTF8)
  if ($code.Length -gt 0 -and $code[0] -eq [char]0xFEFF) {
    $code = $code.Substring(1)
  }
  $code = Remove-ImportsAndExports -Code $code
  $chunks.Add($code.TrimEnd())
}

$output = "/* Firefox bundle (no ESM imports) */`n`n" + ($chunks -join "`n`n") + "`n"
[System.IO.File]::WriteAllText($outFile, $output, [System.Text.Encoding]::UTF8)

$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8)
$js = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)
$js = [System.Text.RegularExpressions.Regex]::Replace($js, "</script>", "<\/script>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$js = $js.TrimEnd()
$scriptBody = "`n$js`n"
$inlineScript = "<script>$scriptBody</script>"

$updated = [System.Text.RegularExpressions.Regex]::Replace(
  $html,
  '<script\s+src="js\/app\.ff\.js"\s*><\/script>',
  [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $inlineScript },
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if ($updated -eq $html) {
  $updated = [System.Text.RegularExpressions.Regex]::Replace(
    $html,
    '<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>',
    [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $inlineScript },
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
}

if ($updated -eq $html) {
  throw "newtab.html missing app script tag"
}

[System.IO.File]::WriteAllText($htmlPath, $updated, [System.Text.Encoding]::UTF8)

$manifestRaw = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
if ($manifestRaw.Length -gt 0 -and $manifestRaw[0] -eq [char]0xFEFF) {
  $manifestRaw = $manifestRaw.Substring(1)
}

$manifest = $manifestRaw | ConvertFrom-Json
$normalized = $scriptBody -replace "`r`n", "`n"
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
  $hashBytes = $sha.ComputeHash($bytes)
} finally {
  $sha.Dispose()
}
$hash = [Convert]::ToBase64String($hashBytes)
$manifest.content_security_policy = "script-src 'self' 'sha256-$hash'; object-src 'self'; img-src 'self' data: https: http:;"

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, ($json + "`n"), [System.Text.Encoding]::UTF8)

Write-Output "Firefox bundle generated (PowerShell)"

