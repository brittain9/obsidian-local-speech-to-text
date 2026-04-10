export async function createTempWavFilePath(directoryOverride: string): Promise<string> {
  const { randomUUID } = await import('node:crypto');
  const { join } = await import('node:path');

  return join(await resolveTempAudioDirectory(directoryOverride), `dictation-${randomUUID()}.wav`);
}

export async function resolveTempAudioDirectory(directoryOverride: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const directoryPath =
    directoryOverride.trim().length > 0
      ? resolve(directoryOverride.trim())
      : join(tmpdir(), 'obsidian-local-stt');

  await mkdir(directoryPath, { recursive: true });

  return directoryPath;
}

export async function deleteFileIfExists(filePath: string): Promise<void> {
  if (filePath.trim().length === 0) {
    return;
  }

  const { unlink } = await import('node:fs/promises');

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
