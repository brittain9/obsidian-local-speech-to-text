import {
  isSelectedModel,
  normalizeSelectedModel,
  type SelectedModel,
} from '../models/model-management-types';
import type { ListeningMode } from '../sidecar/protocol';

export const INSERTION_MODES = [
  'insert_at_cursor',
  'append_on_new_line',
  'append_as_new_paragraph',
] as const;

export type InsertionMode = (typeof INSERTION_MODES)[number];

export interface PluginSettings {
  insertionMode: InsertionMode;
  listeningMode: ListeningMode;
  modelStorePathOverride: string;
  pauseWhileProcessing: boolean;
  selectedModel: SelectedModel | null;
  sidecarPathOverride: string;
  sidecarRequestTimeoutMs: number;
  sidecarStartupTimeoutMs: number;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  insertionMode: 'insert_at_cursor',
  listeningMode: 'one_sentence',
  modelStorePathOverride: '',
  pauseWhileProcessing: true,
  selectedModel: null,
  sidecarPathOverride: '',
  sidecarRequestTimeoutMs: 300_000,
  sidecarStartupTimeoutMs: 4_000,
};

export function resolvePluginSettings(data: unknown): PluginSettings {
  const raw = isRecord(data) ? data : {};

  return {
    insertionMode: readInsertionMode(raw.insertionMode),
    listeningMode: readListeningMode(raw.listeningMode),
    modelStorePathOverride: readString(
      raw.modelStorePathOverride,
      DEFAULT_PLUGIN_SETTINGS.modelStorePathOverride,
    ),
    pauseWhileProcessing: readBoolean(
      raw.pauseWhileProcessing,
      DEFAULT_PLUGIN_SETTINGS.pauseWhileProcessing,
    ),
    selectedModel: readSelectedModel(raw.selectedModel, raw.modelFilePath),
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
  return isInsertionMode(value) ? value : DEFAULT_PLUGIN_SETTINGS.insertionMode;
}

function readSelectedModel(
  selectedModel: unknown,
  legacyModelFilePath: unknown,
): SelectedModel | null {
  if (isSelectedModel(selectedModel)) {
    return normalizeSelectedModel(selectedModel);
  }

  const migratedFilePath = readString(legacyModelFilePath, '');

  if (migratedFilePath.length === 0) {
    return DEFAULT_PLUGIN_SETTINGS.selectedModel;
  }

  return {
    engineId: 'whisper_cpp',
    filePath: migratedFilePath,
    kind: 'external_file',
  };
}

function isInsertionMode(value: unknown): value is InsertionMode {
  return typeof value === 'string' && (INSERTION_MODES as readonly string[]).includes(value);
}

function readListeningMode(value: unknown): ListeningMode {
  return value === 'always_on' || value === 'press_and_hold' || value === 'one_sentence'
    ? value
    : DEFAULT_PLUGIN_SETTINGS.listeningMode;
}
