import {
  isSelectedModel,
  normalizeSelectedModel,
  type SelectedModel,
} from '../models/model-management-types';
import { isRecord } from '../shared/type-guards';
import type { AccelerationPreference, ListeningMode, SpeakingStyle } from '../sidecar/protocol';

export const DICTATION_ANCHORS = ['at_cursor', 'end_of_note'] as const;

export type DictationAnchor = (typeof DICTATION_ANCHORS)[number];

export const PHRASE_SEPARATORS = ['space', 'new_line', 'new_paragraph'] as const;

export type PhraseSeparator = (typeof PHRASE_SEPARATORS)[number];

export const SPEAKING_STYLES = [
  'responsive',
  'balanced',
  'patient',
] as const satisfies readonly SpeakingStyle[];

export interface StagePipelineSettings {
  hallucinationFilter: boolean;
  punctuation: boolean;
}

export interface PluginSettings {
  accelerationPreference: AccelerationPreference;
  cudaLibraryPath: string;
  developerMode: boolean;
  dictationAnchor: DictationAnchor;
  listeningMode: ListeningMode;
  modelStorePathOverride: string;
  pauseWhileProcessing: boolean;
  phraseSeparator: PhraseSeparator;
  selectedModel: SelectedModel | null;
  sidecarPathOverride: string;
  sidecarRequestTimeoutMs: number;
  sidecarStartupTimeoutMs: number;
  speakingStyle: SpeakingStyle;
  stages: StagePipelineSettings;
  useNoteAsContext: boolean;
}

export const DEFAULT_STAGE_PIPELINE_SETTINGS: StagePipelineSettings = {
  hallucinationFilter: true,
  punctuation: true,
};

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  accelerationPreference: 'auto',
  cudaLibraryPath: '',
  developerMode: false,
  dictationAnchor: 'at_cursor',
  listeningMode: 'one_sentence',
  modelStorePathOverride: '',
  pauseWhileProcessing: true,
  phraseSeparator: 'space',
  selectedModel: null,
  sidecarPathOverride: '',
  sidecarRequestTimeoutMs: 300_000,
  sidecarStartupTimeoutMs: 4_000,
  speakingStyle: 'balanced',
  stages: { ...DEFAULT_STAGE_PIPELINE_SETTINGS },
  useNoteAsContext: true,
};

export function resolvePluginSettings(data: unknown): PluginSettings {
  const raw = isRecord(data) ? data : {};

  return {
    accelerationPreference: readAccelerationPreference(raw.accelerationPreference),
    cudaLibraryPath: readString(raw.cudaLibraryPath, DEFAULT_PLUGIN_SETTINGS.cudaLibraryPath),
    developerMode: readBoolean(raw.developerMode, DEFAULT_PLUGIN_SETTINGS.developerMode),
    dictationAnchor: isDictationAnchor(raw.dictationAnchor)
      ? raw.dictationAnchor
      : DEFAULT_PLUGIN_SETTINGS.dictationAnchor,
    listeningMode: readListeningMode(raw.listeningMode),
    modelStorePathOverride: readString(
      raw.modelStorePathOverride,
      DEFAULT_PLUGIN_SETTINGS.modelStorePathOverride,
    ),
    pauseWhileProcessing: readBoolean(
      raw.pauseWhileProcessing,
      DEFAULT_PLUGIN_SETTINGS.pauseWhileProcessing,
    ),
    phraseSeparator: isPhraseSeparator(raw.phraseSeparator)
      ? raw.phraseSeparator
      : DEFAULT_PLUGIN_SETTINGS.phraseSeparator,
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
    stages: readStagePipelineSettings(raw.stages),
    useNoteAsContext: readBoolean(raw.useNoteAsContext, DEFAULT_PLUGIN_SETTINGS.useNoteAsContext),
  };
}

function readStagePipelineSettings(value: unknown): StagePipelineSettings {
  const raw = isRecord(value) ? value : {};
  return {
    hallucinationFilter: readBoolean(
      raw.hallucinationFilter,
      DEFAULT_STAGE_PIPELINE_SETTINGS.hallucinationFilter,
    ),
    punctuation: readBoolean(raw.punctuation, DEFAULT_STAGE_PIPELINE_SETTINGS.punctuation),
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

export function isSpeakingStyle(value: unknown): value is SpeakingStyle {
  return typeof value === 'string' && (SPEAKING_STYLES as readonly string[]).includes(value);
}

export function isDictationAnchor(value: unknown): value is DictationAnchor {
  return typeof value === 'string' && (DICTATION_ANCHORS as readonly string[]).includes(value);
}

export function isPhraseSeparator(value: unknown): value is PhraseSeparator {
  return typeof value === 'string' && (PHRASE_SEPARATORS as readonly string[]).includes(value);
}

function readSelectedModel(selectedModel: unknown): SelectedModel | null {
  if (isSelectedModel(selectedModel)) {
    return normalizeSelectedModel(selectedModel);
  }

  return DEFAULT_PLUGIN_SETTINGS.selectedModel;
}

function readListeningMode(value: unknown): ListeningMode {
  return value === 'always_on' || value === 'one_sentence'
    ? value
    : DEFAULT_PLUGIN_SETTINGS.listeningMode;
}
