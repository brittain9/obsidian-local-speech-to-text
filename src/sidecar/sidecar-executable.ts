export const SIDECAR_EXECUTABLE_BASENAME = 'local-transcript-sidecar';

export function formatSidecarExecutableName(isWindows: boolean): string {
  return isWindows ? `${SIDECAR_EXECUTABLE_BASENAME}.exe` : SIDECAR_EXECUTABLE_BASENAME;
}
