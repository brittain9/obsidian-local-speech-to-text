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
  plugins: [pcmRecorderWorkletSourcePlugin()],
};

async function buildAll() {
  await build(mainBuildOptions);
}

async function main() {
  if (isWatch) {
    const watcher = await context(mainBuildOptions);

    await watcher.watch();
    console.log('[esbuild] watching for changes');
    return;
  }

  await buildAll();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function pcmRecorderWorkletSourcePlugin() {
  const workletSourceId = 'virtual:pcm-recorder-worklet-source';

  return {
    name: 'pcm-recorder-worklet-source',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^virtual:pcm-recorder-worklet-source$/ }, () => ({
        namespace: 'pcm-recorder-worklet-source',
        path: workletSourceId,
      }));

      buildContext.onLoad(
        {
          filter: /^virtual:pcm-recorder-worklet-source$/,
          namespace: 'pcm-recorder-worklet-source',
        },
        async () => {
          const bundledWorklet = await build({
            bundle: true,
            entryPoints: ['src/audio/pcm-recorder.worklet.ts'],
            format: 'esm',
            logLevel: 'silent',
            platform: 'browser',
            sourcemap: false,
            target: 'es2022',
            treeShaking: true,
            write: false,
          });
          const workletSource = bundledWorklet.outputFiles[0]?.text;

          if (workletSource === undefined) {
            throw new Error('Failed to bundle the recorder worklet source.');
          }

          return {
            contents: `export const PCM_RECORDER_WORKLET_SOURCE = ${JSON.stringify(workletSource)};`,
            loader: 'js',
          };
        },
      );
    },
  };
}
