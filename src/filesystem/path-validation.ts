import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type ExistingPathKind = 'directory' | 'file' | 'missing' | 'other';

export async function getExistingPathKind(path: string): Promise<ExistingPathKind> {
  try {
    const stats = await stat(path);

    if (stats.isFile()) {
      return 'file';
    }

    if (stats.isDirectory()) {
      return 'directory';
    }

    return 'other';
  } catch (error) {
    if (isMissingFileError(error)) {
      return 'missing';
    }

    throw error;
  }
}

export async function assertAbsoluteDirectoryPath(
  path: string,
  settingLabel: string,
): Promise<string> {
  const normalizedPath = path.trim();

  if (normalizedPath.length === 0) {
    throw new Error(`${settingLabel} is not configured.`);
  }

  if (!isAbsolute(normalizedPath)) {
    throw new Error(`${settingLabel} must be an absolute path.`);
  }

  const pathKind = await getExistingPathKind(normalizedPath);

  if (pathKind === 'file') {
    throw new Error(`${settingLabel} must be a directory, not a file: ${normalizedPath}`);
  }

  if (pathKind === 'other') {
    throw new Error(`${settingLabel} must point to a directory path: ${normalizedPath}`);
  }

  return normalizedPath;
}

export async function assertAbsoluteExistingFilePath(
  path: string,
  settingLabel: string,
): Promise<string> {
  const normalizedPath = path.trim();

  if (normalizedPath.length === 0) {
    throw new Error(`${settingLabel} is not configured.`);
  }

  if (!isAbsolute(normalizedPath)) {
    throw new Error(`${settingLabel} must be an absolute path.`);
  }

  const pathKind = await getExistingPathKind(normalizedPath);

  if (pathKind === 'missing') {
    throw new Error(`${settingLabel} does not exist: ${normalizedPath}`);
  }

  if (pathKind !== 'file') {
    throw new Error(`${settingLabel} must point to a file: ${normalizedPath}`);
  }

  return normalizedPath;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
