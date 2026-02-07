param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDir,
  [Parameter(Mandatory = $true)]
  [string]$DestinationZip
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceFull = [IO.Path]::GetFullPath($SourceDir)
$zipFull = [IO.Path]::GetFullPath($DestinationZip)

if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
  throw "Source directory not found: $sourceFull"
}

if (Test-Path -LiteralPath $zipFull) {
  Remove-Item -LiteralPath $zipFull -Force
}

$zipDir = Split-Path -Parent $zipFull
if ($zipDir -and -not (Test-Path -LiteralPath $zipDir)) {
  New-Item -ItemType Directory -Path $zipDir | Out-Null
}

$sourcePrefix = $sourceFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$files = Get-ChildItem -LiteralPath $sourceFull -Recurse -File

$zipStream = [IO.File]::Open($zipFull, [IO.FileMode]::Create)
try {
  $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($file in $files) {
      $fullPath = $file.FullName
      if (-not $fullPath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $entryName = $fullPath.Substring($sourcePrefix.Length) -replace '\\', '/'
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $fullPath,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $zipStream.Dispose()
}

