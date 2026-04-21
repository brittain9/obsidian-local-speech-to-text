[CmdletBinding()]
param([switch]$Release)

$ErrorActionPreference = 'Stop'

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
