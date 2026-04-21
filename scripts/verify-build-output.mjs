import { access, readFile } from 'node:fs/promises';

const args = new Set(process.argv.slice(2));
const profile = args.has('--release') ? 'release' : 'debug';
const SIDECAR_BINARY_SUFFIX = process.platform === 'win32' ? '.exe' : '';

const MAIN_BUNDLE_PATH = 'main.js';
const SIDECAR_BINARY_PATH = `native/target/${profile}/obsidian-local-stt-sidecar${SIDECAR_BINARY_SUFFIX}`;
const CUDA_SIDECAR_BINARY_PATH = `native/target-cuda/${profile}/obsidian-local-stt-sidecar${SIDECAR_BINARY_SUFFIX}`;
const CUDA_PROVIDER_NAMES_BY_PLATFORM = {
  win32: ['onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll'],
  linux: ['libonnxruntime_providers_shared.so', 'libonnxruntime_providers_cuda.so'],
};
const CUDA_PROVIDER_PATHS = (CUDA_PROVIDER_NAMES_BY_PLATFORM[process.platform] ?? []).map(
  (name) => `native/target-cuda/${profile}/${name}`,
);

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

  if (!mainBundle.includes('PcmRecorderProcessor')) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} is missing the inlined recorder worklet source (PcmRecorderProcessor marker).`,
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
