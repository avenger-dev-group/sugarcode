param(
  [ValidateSet("x64")]
  [string]$Architecture = "x64"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$makeDirectory = Join-Path $workspaceRoot "apps/desktop/out/make/squirrel.windows/$Architecture"

if (-not (Test-Path $makeDirectory -PathType Container)) {
  throw "Windows make directory was not generated: $makeDirectory"
}

$setupFiles = @(Get-ChildItem $makeDirectory -File -Filter "* Setup.exe")
$packageFiles = @(Get-ChildItem $makeDirectory -File -Filter "*-full.nupkg")
$releasesPath = Join-Path $makeDirectory "RELEASES"

if ($setupFiles.Count -ne 1) {
  throw "Expected one Windows Setup.exe, found $($setupFiles.Count)."
}
if ($packageFiles.Count -ne 1) {
  throw "Expected one full Squirrel package, found $($packageFiles.Count)."
}
if (-not (Test-Path $releasesPath -PathType Leaf)) {
  throw "Squirrel RELEASES manifest was not generated."
}

$releaseContents = Get-Content $releasesPath -Raw
if (-not $releaseContents.Contains($packageFiles[0].Name)) {
  throw "Squirrel RELEASES does not reference $($packageFiles[0].Name)."
}

if ($setupFiles[0].Length -lt 1MB -or $packageFiles[0].Length -lt 1MB) {
  throw "A generated Windows artifact is unexpectedly small."
}

Get-FileHash $setupFiles[0].FullName -Algorithm SHA256
Get-FileHash $packageFiles[0].FullName -Algorithm SHA256
Write-Host "Verified Windows $Architecture Squirrel artifacts."
