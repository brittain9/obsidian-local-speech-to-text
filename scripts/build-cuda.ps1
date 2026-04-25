[CmdletBinding()]
param([switch]$Release)

$ErrorActionPreference = 'Stop'

function Read-PositiveInt($Name, $Fallback) {
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $Fallback
  }

  $value = 0
  if (-not [int]::TryParse($raw, [ref]$value) -or $value -le 0) {
    throw "$Name must be a positive integer, got: $raw"
  }
  return $value
}

function Invoke-TimedStep($Name, [scriptblock]$Action) {
  Write-Host "::group::$Name"
  Write-Host "$Name started: $((Get-Date).ToUniversalTime().ToString('o'))"
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Action
  } finally {
    $timer.Stop()
    Write-Host "$Name finished: $((Get-Date).ToUniversalTime().ToString('o'))"
    Write-Host "$Name duration: $($timer.Elapsed.ToString())"
    Write-Host "::endgroup::"
  }
}

foreach ($tool in 'cargo', 'nvcc') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "required tool not found on PATH: $tool"
  }
}

$jobs = Read-PositiveInt 'BUILD_JOBS' ([Environment]::ProcessorCount)
$env:CARGO_BUILD_JOBS = "$jobs"
$env:CMAKE_BUILD_PARALLEL_LEVEL = "$jobs"

$cargoArgs = @(
  'build',
  '--locked',
  '--manifest-path', 'native/Cargo.toml',
  '--target-dir', 'native/target-cuda',
  '--features', 'gpu-cuda,gpu-ort-cuda',
  '-j', "$jobs"
)
if ($Release) { $cargoArgs += '--release' }
if ($env:CARGO_TIMINGS -eq '1') { $cargoArgs += '--timings' }
if ($env:CARGO_VERBOSE -eq '1') { $cargoArgs += '-vv' }

$buildProfile = if ($Release) { 'release' } else { 'debug' }

Invoke-TimedStep "CUDA sidecar preflight" {
  Write-Host "profile: $buildProfile"
  Write-Host "jobs: $jobs"
  Write-Host "CUDA_PATH: $env:CUDA_PATH"
  Write-Host "CMAKE_CUDA_ARCHITECTURES: $env:CMAKE_CUDA_ARCHITECTURES"
  Write-Host "CARGO_TIMINGS: $env:CARGO_TIMINGS"
  Write-Host "CARGO_VERBOSE: $env:CARGO_VERBOSE"
  & cargo --version
  & rustc --version
  & nvcc --version
}

Invoke-TimedStep "Build CUDA sidecar ($buildProfile)" {
  Write-Host "cargo $($cargoArgs -join ' ')"
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$outDir = "native/target-cuda/$buildProfile"
$providers = (& node scripts/list-cuda-artifacts.mjs providers win32) -split "`r?`n" | Where-Object { $_ -ne '' }
$expected = @("$outDir/local-transcript-sidecar.exe") + ($providers | ForEach-Object { "$outDir/$_" })
Invoke-TimedStep "Verify CUDA sidecar artifacts" {
  foreach ($path in $expected) {
    if (-not (Test-Path $path)) {
      throw "expected build artifact missing: $path"
    }
    $item = Get-Item $path
    Write-Host "$path $([Math]::Round($item.Length / 1MB, 2)) MiB"
  }
}
Write-Host "Done: $outDir/local-transcript-sidecar.exe"
