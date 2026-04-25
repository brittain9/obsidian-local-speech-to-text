import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import { listCudaArtifacts } from './lib/cuda-artifacts.mjs';

const PLUGIN_ID = 'local-transcript';
const PLUGIN_FILES = ['manifest.json', 'main.js', 'styles.css'];
const SIDECAR_BASENAME = 'local-transcript-sidecar';
const SIDECAR_SUFFIX = process.platform === 'win32' ? '.exe' : '';
const SIDECAR_EXECUTABLE = `${SIDECAR_BASENAME}${SIDECAR_SUFFIX}`;

const args = parseArgs(process.argv.slice(2));

if (args.help || args.vault === null) {
  printUsage();
  process.exitCode = args.help ? 0 : 1;
} else {
  await main(args);
}

async function main(options) {
  const profile = options.release ? 'release' : 'debug';
  const vaultPath = resolve(options.vault);
  const obsidianDirectory = join(vaultPath, '.obsidian');
  const pluginDirectory = join(obsidianDirectory, 'plugins', PLUGIN_ID);

  await mkdir(pluginDirectory, { recursive: true });

  for (const file of PLUGIN_FILES) {
    await cp(file, join(pluginDirectory, file), { force: true });
  }

  if (options.sidecars) {
    await installSidecarVariant({
      artifacts: [SIDECAR_EXECUTABLE],
      destination: join(pluginDirectory, 'bin', 'cpu'),
      profile,
      sourceDirectory: join('native', 'target', profile),
      variant: 'cpu',
    });

    await installSidecarVariant({
      allowMissingArtifacts: true,
      artifacts: [SIDECAR_EXECUTABLE, ...(await getCudaArtifacts())],
      destination: join(pluginDirectory, 'bin', 'cuda'),
      optional: true,
      profile,
      sourceDirectory: join('native', 'target-cuda', profile),
      variant: 'cuda',
    });
  }

  if (options.enable) {
    await enablePlugin(obsidianDirectory);
  }

  console.log(`Installed dev plugin output to ${pluginDirectory}`);
}

async function installSidecarVariant(options) {
  const executablePath = join(options.sourceDirectory, SIDECAR_EXECUTABLE);

  if (!(await fileExists(executablePath))) {
    if (options.optional) return;
    throw new Error(
      `Missing ${options.variant} sidecar at ${executablePath}. Build it before using --sidecars.`,
    );
  }

  await rm(options.destination, { force: true, recursive: true });
  await mkdir(options.destination, { recursive: true });

  for (const artifact of options.artifacts) {
    const sourcePath = join(options.sourceDirectory, artifact);
    if (!(await fileExists(sourcePath))) {
      if (options.allowMissingArtifacts) {
        console.warn(`Skipping missing ${options.variant} sidecar artifact: ${sourcePath}`);
        continue;
      }

      throw new Error(`Missing ${options.variant} sidecar artifact at ${sourcePath}.`);
    }

    await cp(sourcePath, join(options.destination, basename(artifact)), { force: true });
  }

  await writeInstallManifest({
    destination: options.destination,
    executablePath,
    profile: options.profile,
    variant: options.variant,
  });
}

async function writeInstallManifest(options) {
  const executable = await readFile(options.executablePath);
  const manifest = {
    installedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(executable).digest('hex'),
    variant: options.variant,
    version: `dev-${options.profile}`,
  };

  await writeFile(
    join(options.destination, 'install.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function enablePlugin(obsidianDirectory) {
  await mkdir(obsidianDirectory, { recursive: true });

  const communityPluginsPath = join(obsidianDirectory, 'community-plugins.json');
  let enabledPlugins = [];

  try {
    enabledPlugins = JSON.parse(await readFile(communityPluginsPath, 'utf8'));
    if (!Array.isArray(enabledPlugins)) enabledPlugins = [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!enabledPlugins.includes(PLUGIN_ID)) {
    enabledPlugins.push(PLUGIN_ID);
    await writeFile(communityPluginsPath, `${JSON.stringify(enabledPlugins, null, 2)}\n`);
  }

  const appConfigPath = join(obsidianDirectory, 'app.json');
  let appConfig = {};

  try {
    appConfig = JSON.parse(await readFile(appConfigPath, 'utf8'));
    if (appConfig === null || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
      appConfig = {};
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (appConfig.safeMode !== false) {
    appConfig.safeMode = false;
    await writeFile(appConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`);
  }
}

async function getCudaArtifacts() {
  if (process.platform !== 'linux' && process.platform !== 'win32') return [];

  const [providers, runtime] = await Promise.all([
    listCudaArtifacts('providers', process.platform),
    listCudaArtifacts('runtime', process.platform),
  ]);
  return [...providers, ...runtime];
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {
    enable: false,
    help: false,
    release: false,
    sidecars: false,
    vault: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--enable') {
      parsed.enable = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--release') {
      parsed.release = true;
    } else if (arg === '--sidecars') {
      parsed.sidecars = true;
    } else if (arg === '--vault') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--vault requires a path.');
      }
      parsed.vault = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage: npm run install:dev -- --vault <vault-path> [--sidecars] [--release] [--enable]

Copies built plugin output into <vault>/.obsidian/plugins/${PLUGIN_ID}.

Options:
  --vault <path>  Obsidian vault path.
  --sidecars      Also copy built CPU sidecar, plus CUDA sidecar if present.
  --release       Copy release-profile sidecars instead of debug-profile sidecars.
  --enable        Add ${PLUGIN_ID} to the vault's community-plugins.json and disable safe mode.
`);
}
