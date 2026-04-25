// Single source of truth for parsing native/cuda-artifacts.json. The release
// workflow, the build-cuda scripts, the dev installer, and the build-output
// verifier all read this manifest; loading it from one place keeps the schema
// (providers/runtime keyed by linux/win32) defined once.

import { readFile } from 'node:fs/promises';

export const CUDA_ARTIFACTS_PATH = 'native/cuda-artifacts.json';

const VALID_KINDS = new Set(['providers', 'runtime']);
const VALID_PLATFORMS = new Set(['linux', 'win32']);

export async function loadCudaArtifacts(path = CUDA_ARTIFACTS_PATH) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function listCudaArtifacts(kind, platform, path = CUDA_ARTIFACTS_PATH) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid kind '${kind}'. Expected one of: ${[...VALID_KINDS].join(', ')}.`);
  }

  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(
      `Invalid platform '${platform}'. Expected one of: ${[...VALID_PLATFORMS].join(', ')}.`,
    );
  }

  const manifest = await loadCudaArtifacts(path);
  const files = manifest[kind]?.[platform];

  if (!Array.isArray(files)) {
    throw new Error(`${path} has no ${kind}.${platform} entry.`);
  }

  return files;
}
