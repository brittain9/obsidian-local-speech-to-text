export const SIDECAR_EXECUTABLE_BASENAME = 'obsidian-local-stt-sidecar';

export function formatSidecarExecutableName(isWindows: boolean): string {
  return isWindows ? `${SIDECAR_EXECUTABLE_BASENAME}.exe` : SIDECAR_EXECUTABLE_BASENAME;
}
