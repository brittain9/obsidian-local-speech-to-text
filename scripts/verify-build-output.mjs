import { access, readFile } from 'node:fs/promises';

const MAIN_BUNDLE_PATH = 'main.js';
const MODEL_CATALOG_PATH = 'config/model-catalog.json';
const RECORDER_WORKLET_PATH = 'assets/pcm-recorder.worklet.js';
const SIDECAR_BINARY_PATH =
  process.platform === 'win32'
    ? 'native/sidecar/target/debug/obsidian-local-stt-sidecar.exe'
    : 'native/sidecar/target/debug/obsidian-local-stt-sidecar';

async function main() {
  const mainBundle = await readFile(MAIN_BUNDLE_PATH, 'utf8');

  if (/\bimport\((['"])node:/.test(mainBundle)) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} still contains a dynamic node: import.`,
    );
  }

  await access(MODEL_CATALOG_PATH);
  await access(RECORDER_WORKLET_PATH);
  await access(SIDECAR_BINARY_PATH);
  console.log(
    '[verify-build-output] main bundle, model catalog, recorder worklet, and sidecar executable look valid',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
