import { access, readFile } from 'node:fs/promises';

import { listCudaArtifacts } from './lib/cuda-artifacts.mjs';

const args = new Set(process.argv.slice(2));
const profile = args.has('--release') ? 'release' : 'debug';
const SIDECAR_BINARY_SUFFIX = process.platform === 'win32' ? '.exe' : '';

const MAIN_BUNDLE_PATH = 'main.js';
const SIDECAR_BINARY_PATH = `native/target/${profile}/local-transcript-sidecar${SIDECAR_BINARY_SUFFIX}`;
const CUDA_SIDECAR_BINARY_PATH = `native/target-cuda/${profile}/local-transcript-sidecar${SIDECAR_BINARY_SUFFIX}`;
const CUDA_PROVIDER_PATHS =
  process.platform === 'linux' || process.platform === 'win32'
    ? (await listCudaArtifacts('providers', process.platform)).map(
        (name) => `native/target-cuda/${profile}/${name}`,
      )
    : [];

async function main() {
  const mainBundle = await readFile(MAIN_BUNDLE_PATH, 'utf8');

  if (/\bimport\((['"])node:/.test(mainBundle)) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} still contains a dynamic node: import.`,
    );
  }

  if (mainBundle.includes('pcm-recorder.worklet.js')) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} still references an external recorder worklet asset.`,
    );
  }

  // Use the AudioWorklet's registered name as the canary: it's a string
  // literal that survives minification, unlike the class symbol.
  if (!mainBundle.includes('obsidian-local-stt-pcm-recorder')) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} is missing the inlined recorder worklet source (registerProcessor name marker).`,
    );
  }

  await access(SIDECAR_BINARY_PATH);

  const cudaBuildVerified = await verifyOptionalCudaBuild();
  console.log(
    `[verify-build-output] ${profile} profile: main bundle, inlined recorder worklet, sidecar executable, and ${cudaBuildVerified ? 'CUDA runtime artifacts' : 'optional CUDA build path'} look valid`,
  );
}

async function verifyOptionalCudaBuild() {
  try {
    await access(CUDA_SIDECAR_BINARY_PATH);
  } catch {
    return false;
  }

  for (const providerPath of CUDA_PROVIDER_PATHS) {
    await access(providerPath);
  }

  return true;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
