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
  # 与 Node 入口统一处理再导出和默认导出，避免经典脚本残留 ESM 语法。
  $withoutImports = [regex]::Replace($withoutImports, '\bexport\s+\{[^}]*\}\s*(from\s+[''"][^''"]+[''"])?\s*;?', '')
  $withoutImports = [regex]::Replace($withoutImports, '\bexport\s+\*\s*(?:as\s+\w+\s+)?from\s+[''"][^''"]+[''"]\s*;?', '')
  $withoutImports = [regex]::Replace($withoutImports, '\bexport\s+default\s+', '')
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

# 两个平台读取同一份模块顺序，新增模块后不再遗漏 Windows 后备构建。
$modules = Get-Content -LiteralPath (Join-Path $RootDir "scripts/firefox-modules.json") -Raw | ConvertFrom-Json

if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

function Write-Bundle {
param($files, [string]$target)
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

$output = "/* Firefox bundle (no ESM imports) */`n`n" + ($chunks -join "`n`n") + "`n`n"
[System.IO.File]::WriteAllText($target, $output, [System.Text.UTF8Encoding]::new($false))
}
Write-Bundle $modules.app $outFile
Write-Bundle $modules.background (Join-Path $outDir "background.ff.js")

$html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8)
$externalScript = "<script src=`"js/app.ff.js`"></script>"

$updated = [System.Text.RegularExpressions.Regex]::Replace(
  $html,
  '<script\s+src="js\/app\.ff\.js"\s*><\/script>',
  [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $externalScript },
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if ($updated -eq $html) {
  $updated = [System.Text.RegularExpressions.Regex]::Replace(
    $html,
    '<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>',
    [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $externalScript },
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
}

if ($updated -eq $html -and $html -notmatch '<script\s+src="js/app\.ff\.js"\s*></script>') {
  throw "newtab.html missing app script tag"
}

[System.IO.File]::WriteAllText($htmlPath, $updated, [System.Text.UTF8Encoding]::new($false))

Write-Output "Firefox bundle generated (PowerShell)"
