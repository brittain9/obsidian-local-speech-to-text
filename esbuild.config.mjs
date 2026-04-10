import { builtinModules } from 'node:module';
import process from 'node:process';
import { build, context } from 'esbuild';

const args = new Set(process.argv.slice(2));
const isWatch = args.has('watch');
const isProduction = args.has('production');

const externalModules = [
  'electron',
  'obsidian',
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

const buildOptions = {
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

async function main() {
  if (isWatch) {
    const watcher = await context(buildOptions);
    await watcher.watch();
    console.log('[esbuild] watching for changes');
    return;
  }

  await build(buildOptions);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
