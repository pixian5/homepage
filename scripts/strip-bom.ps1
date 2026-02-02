$files = @('package.json','manifest.chrome.json','manifest.firefox.json')
foreach ($f in $files) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path (Get-Location) $f))
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length-1)]
  }
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) $f), $bytes)
}
