import { builtinModules } from 'node:module';
import process from 'node:process';
import { build, context } from 'esbuild';

const args = new Set(process.argv.slice(2));
const isWatch = args.has('watch');
const isProduction = args.has('production');

const externalModules = [
  '@codemirror/state',
  '@codemirror/view',
  'electron',
  'obsidian',
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

const mainBuildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: isProduction ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  external: externalModules,
};

const recorderWorkletBuildOptions = {
  entryPoints: ['src/audio/pcm-recorder.worklet.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: isProduction ? false : 'inline',
  treeShaking: true,
  outfile: 'assets/pcm-recorder.worklet.js',
};

async function buildAll() {
  await Promise.all([build(mainBuildOptions), build(recorderWorkletBuildOptions)]);
}

async function main() {
  if (isWatch) {
    const watchers = await Promise.all([
      context(mainBuildOptions),
      context(recorderWorkletBuildOptions),
    ]);

    await Promise.all(watchers.map((watcher) => watcher.watch()));
    console.log('[esbuild] watching for changes');
    return;
  }

  await buildAll();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
