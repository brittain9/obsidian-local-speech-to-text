import { access, readFile } from 'node:fs/promises';

const args = new Set(process.argv.slice(2));
const profile = args.has('--release') ? 'release' : 'debug';

const MAIN_BUNDLE_PATH = 'main.js';
const RECORDER_WORKLET_PATH = 'assets/pcm-recorder.worklet.js';
const SIDECAR_BINARY_PATH =
  process.platform === 'win32'
    ? `native/target/${profile}/obsidian-local-stt-sidecar.exe`
    : `native/target/${profile}/obsidian-local-stt-sidecar`;

async function main() {
  const mainBundle = await readFile(MAIN_BUNDLE_PATH, 'utf8');

  if (/\bimport\((['"])node:/.test(mainBundle)) {
    throw new Error(
      `Build output regression: ${MAIN_BUNDLE_PATH} still contains a dynamic node: import.`,
    );
  }

  await access(RECORDER_WORKLET_PATH);
  await access(SIDECAR_BINARY_PATH);
  console.log(
    `[verify-build-output] ${profile} profile: main bundle, recorder worklet, and sidecar executable look valid`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
