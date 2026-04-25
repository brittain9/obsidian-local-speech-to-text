#!/usr/bin/env node
// Stage and archive a release sidecar build. Replaces the duplicated bash and
// pwsh "Package release archive" steps in .github/workflows/release.yml so the
// per-OS jobs only differ in build setup, not in packaging logic.
//
// Required env: ARCHIVE_NAME, ASSET_NAME, BINARY_PATH
// Optional env: CUDA=true to copy CUDA provider+runtime libs alongside

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { listCudaArtifacts } from './lib/cuda-artifacts.mjs';

const archiveName = requiredEnv('ARCHIVE_NAME');
const assetName = requiredEnv('ASSET_NAME');
const binaryPath = requiredEnv('BINARY_PATH');
const isCuda = process.env.CUDA === 'true';

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

const platformKey = isWindows ? 'win32' : 'linux';
const binaryName = isWindows ? 'obsidian-local-stt-sidecar.exe' : 'obsidian-local-stt-sidecar';
const distDir = 'dist';
const artifactDir = join(distDir, assetName);
const buildDir = dirname(binaryPath);

await mkdir(artifactDir, { recursive: true });
await copyFile(binaryPath, join(artifactDir, binaryName));

if (isCuda) {
  // ORT provider .so/.dll files land next to the binary during the build.
  const providers = await listCudaArtifacts('providers', platformKey);
  for (const provider of providers) {
    const dest = join(artifactDir, provider);
    await copyFile(join(buildDir, provider), dest);
    if (isLinux) {
      // Strip unneeded ELF symbols from provider shared libs to trim the
      // archive. --strip-unneeded keeps dynamic symbols that runtime
      // dlopen/dlsym chains need.
      runStrip(dest);
    }
  }

  // CUDA runtime libs aren't provided by the user's system in a
  // version-compatible form (cudart is major-versioned and not
  // forward-compatible), so ship them next to the binary. On Linux the lib
  // dir is derived from nvcc's location, on Windows it lives under CUDA_PATH.
  const runtimeFiles = await listCudaArtifacts('runtime', platformKey);
  const runtimeSourceDir = isWindows ? join(requiredEnv('CUDA_PATH'), 'bin') : linuxCudaLibDir();

  for (const runtimeFile of runtimeFiles) {
    const src = join(runtimeSourceDir, runtimeFile);
    const dest = join(artifactDir, runtimeFile);
    if (isLinux) {
      // Dereference symlinks (cudart, cublas etc. are usually shipped as
      // libfoo.so.MAJOR -> libfoo.so.MAJOR.MINOR.PATCH).
      await copyFile(await realpath(src), dest);
    } else {
      await copyFile(src, dest);
    }
  }
}

if (isLinux) {
  // Linux-only: strip the sidecar ELF. The Rust release profile strips
  // Rust-owned symbols, but bundled C++/CUDA objects (ggml, whisper.cpp,
  // ORT kernels) can still carry debug sections. macOS binaries are ad-hoc
  // codesigned earlier in the workflow; do not strip them (both signature
  // and `strip` semantics differ).
  runStrip(join(artifactDir, binaryName));
}

await createArchive(artifactDir, join(distDir, archiveName));

console.log(`Packaged ${archiveName} from ${artifactDir}`);

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function linuxCudaLibDir() {
  const which = spawnSync('which', ['nvcc'], { encoding: 'utf8' });
  if (which.status !== 0 || which.stdout.trim().length === 0) {
    throw new Error('Could not locate nvcc on PATH for CUDA runtime lib lookup.');
  }
  const cudaRoot = dirname(dirname(which.stdout.trim()));
  const machine = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim() || 'x86_64';
  return join(cudaRoot, 'targets', `${machine}-linux`, 'lib');
}

function runStrip(path) {
  const result = spawnSync('strip', ['--strip-unneeded', path], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`strip --strip-unneeded ${path} failed with exit code ${result.status}.`);
  }
}

async function createArchive(sourceDir, archivePath) {
  if (archivePath.endsWith('.tar.gz')) {
    runOrThrow('tar', ['-czf', archivePath, '-C', sourceDir, '.']);
    return;
  }

  if (archivePath.endsWith('.zip')) {
    if (isWindows) {
      // PowerShell's Compress-Archive is the only zero-dependency zipper on
      // Windows runners. Star-glob to keep entries at archive root.
      runOrThrow('powershell', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path "${sourceDir}/*" -DestinationPath "${archivePath}" -Force`,
      ]);
    } else {
      runOrThrow('zip', ['-r', '-q', archivePath, '.'], sourceDir);
    }
    return;
  }

  throw new Error(`Unsupported archive extension for ${archivePath}.`);
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}
