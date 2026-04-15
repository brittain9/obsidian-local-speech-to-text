import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertSidecarExecutableIsFresh } from '../src/sidecar/sidecar-build-state';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('assertSidecarExecutableIsFresh', () => {
  it('accepts an executable that is newer than its Rust sources', async () => {
    const { executablePath, projectDirectory } = await createSidecarProjectFixture();
    await setFileTime(join(projectDirectory, 'src', 'main.rs'), 1_000);
    await setFileTime(executablePath, 2_000);

    await expect(
      assertSidecarExecutableIsFresh(executablePath, projectDirectory),
    ).resolves.toBeUndefined();
  });

  it('rejects an executable that is older than its Rust sources', async () => {
    const { executablePath, projectDirectory } = await createSidecarProjectFixture();
    await setFileTime(executablePath, 1_000);
    await setFileTime(join(projectDirectory, 'src', 'main.rs'), 2_000);

    await expect(assertSidecarExecutableIsFresh(executablePath, projectDirectory)).rejects.toThrow(
      'native/src/main.rs is newer',
    );
  });
});

async function createSidecarProjectFixture(): Promise<{
  executablePath: string;
  projectDirectory: string;
}> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-sidecar-'));
  const projectDirectory = join(rootDirectory, 'native', 'sidecar');
  const sourceDirectory = join(projectDirectory, 'src');
  const targetDirectory = join(projectDirectory, 'target', 'debug');
  const executablePath = join(targetDirectory, 'obsidian-local-stt-sidecar');

  tempDirectories.push(rootDirectory);

  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(projectDirectory, 'Cargo.toml'), '[package]\nname = "fixture"\n');
  await writeFile(join(projectDirectory, 'Cargo.lock'), '');
  await writeFile(join(sourceDirectory, 'main.rs'), 'fn main() {}\n');
  await writeFile(executablePath, 'binary');
  await setFileTime(join(projectDirectory, 'Cargo.toml'), 1_000);
  await setFileTime(join(projectDirectory, 'Cargo.lock'), 1_000);
  await setFileTime(join(sourceDirectory, 'main.rs'), 1_000);
  await setFileTime(executablePath, 1_000);

  return {
    executablePath,
    projectDirectory,
  };
}

async function setFileTime(path: string, unixTimeSeconds: number): Promise<void> {
  await utimes(path, unixTimeSeconds, unixTimeSeconds);
}
