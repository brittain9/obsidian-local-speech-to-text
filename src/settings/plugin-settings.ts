export type InsertionMode = 'insert_at_cursor';

export interface PluginSettings {
  insertionMode: InsertionMode;
  modelFilePath: string;
  sidecarPathOverride: string;
  sidecarStartupTimeoutMs: number;
  sidecarRequestTimeoutMs: number;
  tempAudioDirectoryOverride: string;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  insertionMode: 'insert_at_cursor',
  modelFilePath: '',
  sidecarPathOverride: '',
  sidecarStartupTimeoutMs: 4_000,
  sidecarRequestTimeoutMs: 10_000,
  tempAudioDirectoryOverride: '',
};

export function resolvePluginSettings(data: unknown): PluginSettings {
  const raw = isRecord(data) ? data : {};

  return {
    insertionMode: readInsertionMode(raw.insertionMode),
    modelFilePath: readString(raw.modelFilePath, DEFAULT_PLUGIN_SETTINGS.modelFilePath),
    sidecarPathOverride: readString(
      raw.sidecarPathOverride,
      DEFAULT_PLUGIN_SETTINGS.sidecarPathOverride,
    ),
    sidecarStartupTimeoutMs: readPositiveInteger(
      raw.sidecarStartupTimeoutMs,
      DEFAULT_PLUGIN_SETTINGS.sidecarStartupTimeoutMs,
    ),
    sidecarRequestTimeoutMs: readPositiveInteger(
      raw.sidecarRequestTimeoutMs,
      DEFAULT_PLUGIN_SETTINGS.sidecarRequestTimeoutMs,
    ),
    tempAudioDirectoryOverride: readString(
      raw.tempAudioDirectoryOverride,
      DEFAULT_PLUGIN_SETTINGS.tempAudioDirectoryOverride,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readInsertionMode(value: unknown): InsertionMode {
  return value === 'insert_at_cursor' ? value : DEFAULT_PLUGIN_SETTINGS.insertionMode;
}
