import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveSidecarExecutablePath,
  SidecarNotInstalledError,
} from '../src/sidecar/sidecar-paths';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('resolveSidecarExecutablePath', () => {
  it('returns the override path when set', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const overridePath = join(pluginDirectory, 'custom-sidecar');
    await writeFile(overridePath, 'binary');
    // Installed binaries present — override must win regardless.
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        sidecarPathOverride: overridePath,
        sidecarProjectDirectory: join(pluginDirectory, 'native'),
        supportsCuda: true,
      }),
    ).resolves.toEqual({ path: overridePath, source: 'override', variant: null });
  });

  it('throws when the override path does not exist', async () => {
    const pluginDirectory = await createPluginFixture();

    const rejection = resolveSidecarExecutablePath({
      accelerationPreference: 'auto',
      executableName: 'obsidian-local-stt-sidecar',
      pluginDirectory,
      sidecarPathOverride: join(pluginDirectory, 'does-not-exist'),
      sidecarProjectDirectory: join(pluginDirectory, 'native'),
      supportsCuda: true,
    });

    await expect(rejection).rejects.toThrow(/Sidecar path override does not exist/);
    await expect(rejection).rejects.not.toBeInstanceOf(SidecarNotInstalledError);
  });

  it('prefers the installed CUDA binary when auto mode can use it', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar.exe';
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);
    await writeInstalledBinary(pluginDirectory, 'cuda', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory: join(pluginDirectory, 'native'),
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: join(pluginDirectory, 'bin', 'cuda', executableName),
      source: 'installed',
      variant: 'cuda',
    });
  });

  it('picks the installed CPU binary when cpu_only is selected even if CUDA is installed', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);
    await writeInstalledBinary(pluginDirectory, 'cuda', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'cpu_only',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory: join(pluginDirectory, 'native'),
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: join(pluginDirectory, 'bin', 'cpu', executableName),
      source: 'installed',
      variant: 'cpu',
    });
  });

  it('prefers an installed binary over a dev build', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);
    await writeDevBinary(sidecarProjectDirectory, 'cpu', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory,
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: join(pluginDirectory, 'bin', 'cpu', executableName),
      source: 'installed',
      variant: 'cpu',
    });
  });

  it('falls back to the CUDA dev build when no installed binary is available', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    await writeDevBinary(sidecarProjectDirectory, 'cpu', executableName);
    await writeDevBinary(sidecarProjectDirectory, 'cuda', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory,
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: join(sidecarProjectDirectory, 'target-cuda', 'debug', executableName),
      source: 'dev',
      variant: 'cuda',
    });
  });

  it('falls back to the CPU dev build on macOS-style (no CUDA support)', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    await writeDevBinary(sidecarProjectDirectory, 'cpu', executableName);
    await writeDevBinary(sidecarProjectDirectory, 'cuda', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory,
        supportsCuda: false,
      }),
    ).resolves.toEqual({
      path: join(sidecarProjectDirectory, 'target', 'debug', executableName),
      source: 'dev',
      variant: 'cpu',
    });
  });

  it('throws a diagnostic error when nothing is found', async () => {
    const pluginDirectory = await createPluginFixture();
    const sidecarProjectDirectory = join(pluginDirectory, 'native');

    const rejection = resolveSidecarExecutablePath({
      accelerationPreference: 'auto',
      executableName: 'obsidian-local-stt-sidecar',
      pluginDirectory,
      sidecarPathOverride: '',
      sidecarProjectDirectory,
      supportsCuda: true,
    });

    await expect(rejection).rejects.toThrow(/Sidecar executable was not found/);
    await expect(rejection).rejects.toBeInstanceOf(SidecarNotInstalledError);
  });

  it('throws when cpu_only is selected and only a CUDA dev build exists', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    await writeDevBinary(sidecarProjectDirectory, 'cuda', executableName);

    const rejection = resolveSidecarExecutablePath({
      accelerationPreference: 'cpu_only',
      executableName,
      pluginDirectory,
      sidecarPathOverride: '',
      sidecarProjectDirectory,
      supportsCuda: true,
    });

    await expect(rejection).rejects.toThrow(/Sidecar executable was not found/);
    await expect(rejection).rejects.toBeInstanceOf(SidecarNotInstalledError);
  });
});

async function createPluginFixture(): Promise<string> {
  const pluginDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-plugin-'));
  tempDirectories.push(pluginDirectory);
  return pluginDirectory;
}

async function writeInstalledBinary(
  pluginDirectory: string,
  variant: 'cpu' | 'cuda',
  executableName: string,
): Promise<void> {
  const variantDirectory = join(pluginDirectory, 'bin', variant);
  await mkdir(variantDirectory, { recursive: true });
  await writeFile(join(variantDirectory, executableName), 'binary');
}

async function writeDevBinary(
  sidecarProjectDirectory: string,
  variant: 'cpu' | 'cuda',
  executableName: string,
): Promise<void> {
  const devDirectory = join(
    sidecarProjectDirectory,
    variant === 'cuda' ? 'target-cuda' : 'target',
    'debug',
  );
  await mkdir(devDirectory, { recursive: true });
  await writeFile(join(devDirectory, executableName), 'binary');
}
