[CmdletBinding()]
param([switch]$Release)

$ErrorActionPreference = 'Stop'

foreach ($tool in 'cargo', 'nvcc') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "required tool not found on PATH: $tool"
  }
}

$cargoArgs = @(
  'build',
  '--manifest-path', 'native/Cargo.toml',
  '--target-dir', 'native/target-cuda',
  '--features', 'gpu-cuda,gpu-ort-cuda'
)
if ($Release) { $cargoArgs += '--release' }

$buildProfile = if ($Release) { 'release' } else { 'debug' }
Write-Host "Building CUDA sidecar ($buildProfile)..."

& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outDir = "native/target-cuda/$buildProfile"
$providers = (Get-Content native/cuda-artifacts.json -Raw | ConvertFrom-Json).providers.win32
$expected = @("$outDir/obsidian-local-stt-sidecar.exe") + ($providers | ForEach-Object { "$outDir/$_" })
foreach ($path in $expected) {
  if (-not (Test-Path $path)) {
    throw "expected build artifact missing: $path"
  }
}
Write-Host "Done: $outDir/obsidian-local-stt-sidecar.exe"
