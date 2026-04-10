import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempWavFilePath, resolveTempAudioDirectory } from '../src/audio/temp-audio-file';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('resolveTempAudioDirectory', () => {
  it('creates the override directory when it does not exist yet', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-audio-'));
    const overrideDirectory = join(tempDirectory, 'nested', 'temp-audio');
    tempDirectories.push(tempDirectory);

    await expect(resolveTempAudioDirectory(overrideDirectory)).resolves.toBe(overrideDirectory);
  });

  it('rejects an override that points to an existing file', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-audio-'));
    const tempFilePath = join(tempDirectory, 'not-a-directory');
    tempDirectories.push(tempDirectory);
    await writeFile(tempFilePath, 'bad path');

    await expect(resolveTempAudioDirectory(tempFilePath)).rejects.toThrow(
      `Temp audio directory override must be a directory, not a file: ${tempFilePath}`,
    );
  });

  it('creates temp wav paths under the resolved directory', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-audio-'));
    const overrideDirectory = join(tempDirectory, 'wav-output');
    tempDirectories.push(tempDirectory);

    const filePath = await createTempWavFilePath(overrideDirectory);

    expect(dirname(filePath)).toBe(overrideDirectory);
    expect(filePath.endsWith('.wav')).toBe(true);
  });
});
