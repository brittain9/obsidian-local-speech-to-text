import {
  isSelectedModel,
  normalizeSelectedModel,
  type SelectedModel,
} from '../models/model-management-types';
import { isRecord } from '../shared/type-guards';
import type { AccelerationPreference, ListeningMode, SpeakingStyle } from '../sidecar/protocol';

export const INSERTION_MODES = [
  'insert_at_cursor',
  'append_on_new_line',
  'append_as_new_paragraph',
] as const;

export type InsertionMode = (typeof INSERTION_MODES)[number];

export const SPEAKING_STYLES = [
  'responsive',
  'balanced',
  'patient',
] as const satisfies readonly SpeakingStyle[];

export interface PluginSettings {
  accelerationPreference: AccelerationPreference;
  cudaLibraryPath: string;
  developerMode: boolean;
  insertionMode: InsertionMode;
  listeningMode: ListeningMode;
  modelStorePathOverride: string;
  pauseWhileProcessing: boolean;
  selectedModel: SelectedModel | null;
  sidecarPathOverride: string;
  sidecarRequestTimeoutMs: number;
  sidecarStartupTimeoutMs: number;
  speakingStyle: SpeakingStyle;
}

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  accelerationPreference: 'auto',
  cudaLibraryPath: '',
  developerMode: false,
  insertionMode: 'insert_at_cursor',
  listeningMode: 'one_sentence',
  modelStorePathOverride: '',
  pauseWhileProcessing: true,
  selectedModel: null,
  sidecarPathOverride: '',
  sidecarRequestTimeoutMs: 300_000,
  sidecarStartupTimeoutMs: 4_000,
  speakingStyle: 'balanced',
};

export function resolvePluginSettings(data: unknown): PluginSettings {
  const raw = isRecord(data) ? data : {};

  return {
    accelerationPreference: readAccelerationPreference(raw.accelerationPreference),
    cudaLibraryPath: readString(raw.cudaLibraryPath, DEFAULT_PLUGIN_SETTINGS.cudaLibraryPath),
    developerMode: readBoolean(raw.developerMode, DEFAULT_PLUGIN_SETTINGS.developerMode),
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
    selectedModel: readSelectedModel(raw.selectedModel),
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
    speakingStyle: isSpeakingStyle(raw.speakingStyle)
      ? raw.speakingStyle
      : DEFAULT_PLUGIN_SETTINGS.speakingStyle,
  };
}

function readAccelerationPreference(value: unknown): AccelerationPreference {
  if (value === 'auto' || value === 'cpu_only') {
    return value;
  }

  return DEFAULT_PLUGIN_SETTINGS.accelerationPreference;
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

export function isSpeakingStyle(value: unknown): value is SpeakingStyle {
  return typeof value === 'string' && (SPEAKING_STYLES as readonly string[]).includes(value);
}

function readSelectedModel(selectedModel: unknown): SelectedModel | null {
  if (isSelectedModel(selectedModel)) {
    return normalizeSelectedModel(selectedModel);
  }

  return DEFAULT_PLUGIN_SETTINGS.selectedModel;
}

export function isInsertionMode(value: unknown): value is InsertionMode {
  return typeof value === 'string' && (INSERTION_MODES as readonly string[]).includes(value);
}

function readListeningMode(value: unknown): ListeningMode {
  return value === 'always_on' || value === 'one_sentence'
    ? value
    : DEFAULT_PLUGIN_SETTINGS.listeningMode;
}
