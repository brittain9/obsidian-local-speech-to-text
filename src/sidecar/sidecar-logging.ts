type SidecarLogLevel = 'debug' | 'warn';

interface SidecarLogEntry {
  level: SidecarLogLevel;
  message: string;
}

const SIDECAR_ERROR_PATTERNS = [/panic/i, /\berror:/i, /\bfailed\b/i, /\bexception\b/i];

export function createSidecarStderrLogEntry(line: string): SidecarLogEntry | null {
  const message = line.trim();

  if (message.length === 0) {
    return null;
  }

  return {
    level: isWarningLine(message) ? 'warn' : 'debug',
    message: `sidecar: ${message}`,
  };
}

function isWarningLine(message: string): boolean {
  return SIDECAR_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
