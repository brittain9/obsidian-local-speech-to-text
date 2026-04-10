import { access, readFile } from 'node:fs/promises';

const MAIN_BUNDLE_PATH = 'main.js';
const RECORDER_WORKLET_PATH = 'assets/pcm-recorder.worklet.js';

async function main() {
  const mainBundle = await readFile(MAIN_BUNDLE_PATH, 'utf8');

  if (/\bimport\((['"])node:/.test(mainBundle)) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} still contains a dynamic node: import.`,
    );
  }

  await access(RECORDER_WORKLET_PATH);
  console.log('[verify-build-output] main bundle and recorder worklet look valid');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
