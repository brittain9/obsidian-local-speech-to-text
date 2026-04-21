import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDevSidecarExecutablePath,
  getInstalledSidecarExecutablePath,
  pickSidecarVariant,
  resolveInstalledSidecarExecutablePath,
  resolveSidecarExecutablePath,
} from '../src/sidecar/sidecar-paths';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('pickSidecarVariant', () => {
  it('prefers CUDA when auto mode has an installed CUDA variant', () => {
    expect(
      pickSidecarVariant('auto', {
        hasCpu: true,
        hasCuda: true,
        supportsCuda: true,
      }),
    ).toBe('cuda');
  });

  it('falls back to CPU when auto mode has no installed CUDA variant', () => {
    expect(
      pickSidecarVariant('auto', {
        hasCpu: true,
        hasCuda: false,
        supportsCuda: true,
      }),
    ).toBe('cpu');
  });

  it('requires an installed CPU binary when cpu_only is selected', () => {
    expect(
      pickSidecarVariant('cpu_only', {
        hasCpu: false,
        hasCuda: true,
        supportsCuda: true,
      }),
    ).toBeNull();
  });

  it('does not select CUDA in cpu_only mode for dev fallback either', () => {
    expect(
      pickSidecarVariant('cpu_only', {
        hasCpu: true,
        hasCuda: true,
        supportsCuda: true,
      }),
    ).toBe('cpu');
  });
});

describe('resolveInstalledSidecarExecutablePath', () => {
  it('returns the installed CUDA binary when auto mode can use it', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar.exe';
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);
    await writeInstalledBinary(pluginDirectory, 'cuda', executableName);

    await expect(
      resolveInstalledSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName,
        pluginDirectory,
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: getInstalledSidecarExecutablePath(pluginDirectory, 'cuda', executableName),
      variant: 'cuda',
    });
  });

  it('returns the installed CPU binary when cpu_only is selected', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    await writeInstalledBinary(pluginDirectory, 'cpu', executableName);
    await writeInstalledBinary(pluginDirectory, 'cuda', executableName);

    await expect(
      resolveInstalledSidecarExecutablePath({
        accelerationPreference: 'cpu_only',
        executableName,
        pluginDirectory,
        supportsCuda: true,
      }),
    ).resolves.toEqual({
      path: getInstalledSidecarExecutablePath(pluginDirectory, 'cpu', executableName),
      variant: 'cpu',
    });
  });

  it('returns null when no installed binary matches the requested mode', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    await writeInstalledBinary(pluginDirectory, 'cuda', executableName);

    await expect(
      resolveInstalledSidecarExecutablePath({
        accelerationPreference: 'cpu_only',
        executableName,
        pluginDirectory,
        supportsCuda: true,
      }),
    ).resolves.toBeNull();
  });
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

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName: 'obsidian-local-stt-sidecar',
        pluginDirectory,
        sidecarPathOverride: join(pluginDirectory, 'does-not-exist'),
        sidecarProjectDirectory: join(pluginDirectory, 'native'),
        supportsCuda: true,
      }),
    ).rejects.toThrow(/Sidecar path override does not exist/);
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
      path: getInstalledSidecarExecutablePath(pluginDirectory, 'cpu', executableName),
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
      path: getDevSidecarExecutablePath(sidecarProjectDirectory, 'cuda', executableName),
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
      path: getDevSidecarExecutablePath(sidecarProjectDirectory, 'cpu', executableName),
      source: 'dev',
      variant: 'cpu',
    });
  });

  it('throws a diagnostic error when nothing is found', async () => {
    const pluginDirectory = await createPluginFixture();
    const sidecarProjectDirectory = join(pluginDirectory, 'native');

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'auto',
        executableName: 'obsidian-local-stt-sidecar',
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory,
        supportsCuda: true,
      }),
    ).rejects.toThrow(/Sidecar executable was not found/);
  });

  it('throws when cpu_only is selected and only a CUDA dev build exists', async () => {
    const pluginDirectory = await createPluginFixture();
    const executableName = 'obsidian-local-stt-sidecar';
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    await writeDevBinary(sidecarProjectDirectory, 'cuda', executableName);

    await expect(
      resolveSidecarExecutablePath({
        accelerationPreference: 'cpu_only',
        executableName,
        pluginDirectory,
        sidecarPathOverride: '',
        sidecarProjectDirectory,
        supportsCuda: true,
      }),
    ).rejects.toThrow(/Sidecar executable was not found/);
  });
});

describe('sidecar path helpers', () => {
  it('builds the expected dev fallback paths', () => {
    expect(getDevSidecarExecutablePath(join('plugin', 'native'), 'cpu', 'sidecar')).toBe(
      join('plugin', 'native', 'target', 'debug', 'sidecar'),
    );
    expect(getDevSidecarExecutablePath(join('plugin', 'native'), 'cuda', 'sidecar')).toBe(
      join('plugin', 'native', 'target-cuda', 'debug', 'sidecar'),
    );
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
