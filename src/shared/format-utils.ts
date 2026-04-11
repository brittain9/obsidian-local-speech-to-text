export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }

  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function formatInstallProgress(update: {
  downloadedBytes: number | null;
  message: string | null;
  state: string;
  totalBytes: number | null;
}): string {
  let text = update.message ?? update.state;
  if (update.downloadedBytes !== null && update.totalBytes !== null) {
    text += ` (${formatBytes(update.downloadedBytes)} / ${formatBytes(update.totalBytes)})`;
  }
  return text;
}
