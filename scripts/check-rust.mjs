import { execFileSync } from 'node:child_process';

function run(command, args, env = process.env) {
  execFileSync(command, args, {
    stdio: 'inherit',
    env,
  });
}

run(process.execPath, ['scripts/build-sidecar.mjs']);
run('cargo', ['fmt', '--manifest-path', 'native/Cargo.toml', '--check']);
run(
  'cargo',
  [
    'clippy',
    '--manifest-path',
    'native/Cargo.toml',
    '--all-targets',
    '--features',
    'engine-cohere-transcribe,engine-whisper',
    '--',
    '-D',
    'warnings',
  ],
  {
    ...process.env,
    DOCS_RS: '1',
  },
);
run('cargo', [
  'test',
  '--manifest-path',
  'native/Cargo.toml',
  '--features',
  'engine-cohere-transcribe,engine-whisper',
]);
