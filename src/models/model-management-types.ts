import { isRecord } from '../shared/type-guards';

export const ENGINE_IDS = ['cohere_onnx', 'whisper_cpp'] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

export interface CatalogModelSelection {
  engineId: EngineId;
  kind: 'catalog_model';
  modelId: string;
}

export interface ExternalFileModelSelection {
  engineId: EngineId;
  filePath: string;
  kind: 'external_file';
}

export type SelectedModel = CatalogModelSelection | ExternalFileModelSelection;

export type ModelArtifactRole = 'punctuation_model' | 'supporting_file' | 'transcription_model';

export interface ModelArtifactRecord {
  artifactId: string;
  downloadUrl: string;
  filename: string;
  required: boolean;
  role: ModelArtifactRole;
  sha256: string;
  sizeBytes: number;
}

export interface ModelEngineRecord {
  displayName: string;
  engineId: EngineId;
  summary: string;
}

export interface ModelCollectionRecord {
  collectionId: string;
  displayName: string;
  summary: string;
}

export interface CatalogModelRecord {
  artifacts: ModelArtifactRecord[];
  capabilityFlags: string[];
  collectionId: string;
  displayName: string;
  engineId: EngineId;
  languageTags: string[];
  licenseLabel: string;
  licenseUrl: string;
  modelCardUrl: string | null;
  modelId: string;
  notes: string[];
  recommended: boolean;
  sourceUrl: string;
  summary: string;
  uxTags: string[];
}

export interface ModelCatalogRecord {
  catalogVersion: number;
  collections: ModelCollectionRecord[];
  engines: ModelEngineRecord[];
  models: CatalogModelRecord[];
}

export interface InstalledModelRecord {
  catalogVersion: number;
  engineId: EngineId;
  installPath: string;
  installedAtUnixMs: number;
  modelId: string;
  runtimePath: string | null;
  totalSizeBytes: number;
}

export interface ModelStoreRecord {
  overridePath: string | null;
  path: string;
  usingDefaultPath: boolean;
}

export type ModelProbeStatus = 'invalid' | 'missing' | 'ready';

export interface ModelProbeResultRecord {
  available: boolean;
  details: string | null;
  displayName: string | null;
  engineId: EngineId;
  installed: boolean;
  message: string;
  modelId: string | null;
  resolvedPath: string | null;
  selection: SelectedModel;
  sizeBytes: number | null;
  status: ModelProbeStatus;
}

export type ModelInstallState =
  | 'cancelled'
  | 'completed'
  | 'downloading'
  | 'failed'
  | 'probing'
  | 'queued'
  | 'verifying';

export interface ModelInstallUpdateRecord {
  details: string | null;
  downloadedBytes: number | null;
  engineId: EngineId;
  installId: string;
  message: string | null;
  modelId: string;
  state: ModelInstallState;
  totalBytes: number | null;
}

export interface ModelRemovedRecord {
  engineId: EngineId;
  modelId: string;
  removed: boolean;
}

export function getEngineDisplayName(engineId: EngineId): string {
  switch (engineId) {
    case 'cohere_onnx':
      return 'Cohere Transcribe';
    case 'whisper_cpp':
      return 'Whisper.cpp';
  }
}

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value);
}

export function isSelectedModel(value: unknown): value is SelectedModel {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === 'catalog_model') {
    return (
      isEngineId(value.engineId) && typeof value.modelId === 'string' && value.modelId.length > 0
    );
  }

  if (value.kind === 'external_file') {
    return (
      isEngineId(value.engineId) &&
      typeof value.filePath === 'string' &&
      value.filePath.trim().length > 0
    );
  }

  return false;
}

export function normalizeSelectedModel(value: SelectedModel): SelectedModel {
  if (value.kind === 'catalog_model') {
    return {
      engineId: value.engineId,
      kind: value.kind,
      modelId: value.modelId.trim(),
    };
  }

  return {
    engineId: value.engineId,
    filePath: value.filePath.trim(),
    kind: value.kind,
  };
}

export function getPrimaryArtifact(model: CatalogModelRecord): ModelArtifactRecord | null {
  return (
    model.artifacts.find(
      (artifact) => artifact.required && artifact.role === 'transcription_model',
    ) ?? null
  );
}
