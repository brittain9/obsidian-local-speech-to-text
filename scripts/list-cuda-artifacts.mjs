#!/usr/bin/env node
// Print the filenames from native/cuda-artifacts.json for one kind+platform,
// one per line. Consumed by the release workflow and the CUDA build scripts
// so there is a single source of truth for which provider/runtime DLLs ship.
//
// Usage: node scripts/list-cuda-artifacts.mjs <providers|runtime> <linux|win32>

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const VALID_KINDS = new Set(['providers', 'runtime']);
const VALID_PLATFORMS = new Set(['linux', 'win32']);

const [kind, platform] = process.argv.slice(2);

if (!kind || !platform || !VALID_KINDS.has(kind) || !VALID_PLATFORMS.has(platform)) {
  console.error('Usage: node scripts/list-cuda-artifacts.mjs <providers|runtime> <linux|win32>');
  process.exit(2);
}

const manifest = JSON.parse(await readFile('native/cuda-artifacts.json', 'utf8'));
const files = manifest[kind]?.[platform];

if (!Array.isArray(files)) {
  console.error(`cuda-artifacts.json has no ${kind}.${platform} entry`);
  process.exit(1);
}

for (const name of files) {
  console.log(name);
}
