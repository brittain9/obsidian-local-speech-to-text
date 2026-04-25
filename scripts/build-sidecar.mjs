import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = new Set(process.argv.slice(2));

const features =
  process.platform === 'darwin'
    ? 'engine-whisper,engine-cohere-transcribe,gpu-metal'
    : 'engine-whisper,engine-cohere-transcribe';

const cargoArgs = [
  'build',
  '--locked',
  '--manifest-path',
  'native/Cargo.toml',
  '--features',
  features,
];

if (args.has('--release')) cargoArgs.push('--release');
if (process.env.CARGO_TIMINGS === '1') cargoArgs.push('--timings');
if (process.env.CARGO_VERBOSE === '1') cargoArgs.push('-vv');

const profile = args.has('--release') ? 'release' : 'debug';
const gpu = process.platform === 'darwin' ? ' + Metal' : '';
console.log(`Building sidecar (${profile}, ${features}${gpu})...`);
console.log(`cargo ${cargoArgs.join(' ')}`);

execFileSync('cargo', cargoArgs, { stdio: 'inherit' });
