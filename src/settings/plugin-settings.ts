import type { ListeningMode } from '../sidecar/protocol';

export type InsertionMode = 'insert_at_cursor';

export interface PluginSettings {
  insertionMode: InsertionMode;
  listeningMode: ListeningMode;
  modelFilePath: string;
  pauseWhileProcessing: boolean;
  sidecarPathOverride: string;
  sidecarRequestTimeoutMs: number;
  sidecarStartupTimeoutMs: number;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  insertionMode: 'insert_at_cursor',
  listeningMode: 'one_sentence',
  modelFilePath: '',
  pauseWhileProcessing: true,
  sidecarPathOverride: '',
  sidecarRequestTimeoutMs: 300_000,
  sidecarStartupTimeoutMs: 4_000,
};

export function resolvePluginSettings(data: unknown): PluginSettings {
  const raw = isRecord(data) ? data : {};

  return {
    insertionMode: readInsertionMode(raw.insertionMode),
    listeningMode: readListeningMode(raw.listeningMode),
    modelFilePath: readString(raw.modelFilePath, DEFAULT_PLUGIN_SETTINGS.modelFilePath),
    pauseWhileProcessing: readBoolean(
      raw.pauseWhileProcessing,
      DEFAULT_PLUGIN_SETTINGS.pauseWhileProcessing,
    ),
    sidecarPathOverride: readString(
      raw.sidecarPathOverride,
      DEFAULT_PLUGIN_SETTINGS.sidecarPathOverride,
    ),
    sidecarRequestTimeoutMs: readPositiveInteger(
      raw.sidecarRequestTimeoutMs,
      DEFAULT_PLUGIN_SETTINGS.sidecarRequestTimeoutMs,
    ),
    sidecarStartupTimeoutMs: readPositiveInteger(
      raw.sidecarStartupTimeoutMs,
      DEFAULT_PLUGIN_SETTINGS.sidecarStartupTimeoutMs,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readInsertionMode(value: unknown): InsertionMode {
  return value === 'insert_at_cursor' ? value : DEFAULT_PLUGIN_SETTINGS.insertionMode;
}

function readListeningMode(value: unknown): ListeningMode {
  return value === 'always_on' || value === 'press_and_hold' || value === 'one_sentence'
    ? value
    : DEFAULT_PLUGIN_SETTINGS.listeningMode;
}
