#!/usr/bin/env node
// Print the filenames from native/cuda-artifacts.json for one kind+platform,
// one per line. Consumed by the release workflow and the CUDA build scripts
// because shells can't import ESM directly; Node consumers should import
// listCudaArtifacts from ./lib/cuda-artifacts.mjs instead.
//
// Usage: node scripts/list-cuda-artifacts.mjs <providers|runtime> <linux|win32>

import process from 'node:process';

import { listCudaArtifacts } from './lib/cuda-artifacts.mjs';

const [kind, platform] = process.argv.slice(2);

if (!kind || !platform) {
  console.error('Usage: node scripts/list-cuda-artifacts.mjs <providers|runtime> <linux|win32>');
  process.exit(2);
}

try {
  const files = await listCudaArtifacts(kind, platform);
  for (const name of files) {
    console.log(name);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
