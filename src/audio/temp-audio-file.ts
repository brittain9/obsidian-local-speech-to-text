import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertAbsoluteDirectoryPath } from '../filesystem/path-validation';

export async function createTempWavFilePath(directoryOverride: string): Promise<string> {
  return join(await resolveTempAudioDirectory(directoryOverride), `dictation-${randomUUID()}.wav`);
}

export async function resolveTempAudioDirectory(directoryOverride: string): Promise<string> {
  const directoryPath =
    directoryOverride.trim().length > 0
      ? await assertAbsoluteDirectoryPath(directoryOverride, 'Temp audio directory override')
      : join(tmpdir(), 'obsidian-local-stt');

  try {
    await mkdir(directoryPath, { recursive: true });
  } catch (error) {
    throw asError(error, `Failed to create temp audio directory: ${directoryPath}`);
  }

  return directoryPath;
}

export async function deleteFileIfExists(filePath: string): Promise<void> {
  if (filePath.trim().length === 0) {
    return;
  }

  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
