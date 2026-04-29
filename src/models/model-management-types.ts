import { isRecord } from '../shared/type-guards';

export const RUNTIME_IDS = ['onnx_runtime', 'whisper_cpp'] as const;

export type RuntimeId = (typeof RUNTIME_IDS)[number];

export const MODEL_FAMILY_IDS = ['cohere_transcribe', 'whisper'] as const;

export type ModelFamilyId = (typeof MODEL_FAMILY_IDS)[number];

export type AcceleratorId = 'cpu' | 'cuda' | 'direct_ml' | 'metal';

export type ModelFormat = 'ggml' | 'gguf' | 'onnx';

export type LanguageSupport =
  | { kind: 'all' }
  | { kind: 'english_only' }
  | { kind: 'list'; tags: string[] }
  | { kind: 'unknown' };

export interface AcceleratorAvailability {
  available: boolean;
  unavailableReason: string | null;
}

export interface RuntimeCapabilitiesRecord {
  availableAccelerators: AcceleratorId[];
  acceleratorDetails: Partial<Record<AcceleratorId, AcceleratorAvailability>>;
  supportedModelFormats: ModelFormat[];
}

export interface ModelFamilyCapabilitiesRecord {
  supportsSegmentTimestamps: boolean;
  supportsWordTimestamps: boolean;
  supportsInitialPrompt: boolean;
  supportsLanguageSelection: boolean;
  supportedLanguages: LanguageSupport;
  maxAudioDurationSecs: number | null;
  producesPunctuation: boolean;
}

export interface EngineCapabilitiesRecord {
  familyId: ModelFamilyId;
  family: ModelFamilyCapabilitiesRecord;
  runtime: RuntimeCapabilitiesRecord;
  runtimeId: RuntimeId;
}

export interface RequestWarning {
  field: string;
  reason: string;
}

export interface CatalogModelSelection {
  familyId: ModelFamilyId;
  kind: 'catalog_model';
  modelId: string;
  runtimeId: RuntimeId;
}

export interface ExternalFileModelSelection {
  familyId: ModelFamilyId;
  filePath: string;
  kind: 'external_file';
  runtimeId: RuntimeId;
}

export type SelectedModel = CatalogModelSelection | ExternalFileModelSelection;

type ModelArtifactRole = 'supporting_file' | 'transcription_model';

export interface ModelArtifactRecord {
  artifactId: string;
  downloadUrl: string;
  filename: string;
  required: boolean;
  role: ModelArtifactRole;
  sha256: string;
  sizeBytes: number;
}

export interface ModelFamilyRecord {
  displayName: string;
  familyId: ModelFamilyId;
  runtimeId: RuntimeId;
  summary: string;
}

export interface ModelCollectionRecord {
  collectionId: string;
  displayName: string;
  summary: string;
}

export interface CatalogModelRecord {
  artifacts: ModelArtifactRecord[];
  collectionId: string;
  displayName: string;
  familyId: ModelFamilyId;
  languageTags: string[];
  licenseLabel: string;
  licenseUrl: string;
  modelCardUrl: string | null;
  modelId: string;
  notes: string[];
  runtimeId: RuntimeId;
  sourceUrl: string;
  summary: string;
  uxTags: string[];
}

export interface ModelCatalogRecord {
  catalogVersion: number;
  collections: ModelCollectionRecord[];
  families: ModelFamilyRecord[];
  models: CatalogModelRecord[];
}

export interface InstalledModelRecord {
  catalogVersion: number;
  familyId: ModelFamilyId;
  installPath: string;
  installedAtUnixMs: number;
  modelId: string;
  runtimeId: RuntimeId;
  runtimePath: string | null;
  totalSizeBytes: number;
}

export interface ModelStoreRecord {
  overridePath: string | null;
  path: string;
  usingDefaultPath: boolean;
}

type ModelProbeStatus = 'invalid' | 'missing' | 'ready';

export interface ModelProbeResultRecord {
  available: boolean;
  details: string | null;
  displayName: string | null;
  familyId: ModelFamilyId;
  installed: boolean;
  mergedCapabilities: EngineCapabilitiesRecord | null;
  message: string;
  modelId: string | null;
  resolvedPath: string | null;
  runtimeId: RuntimeId;
  selection: SelectedModel;
  sizeBytes: number | null;
  status: ModelProbeStatus;
}

export type SelectedModelCapabilities =
  | { status: 'none' }
  | { status: 'pending'; selection: SelectedModel }
  | {
      status: 'unavailable';
      selection: SelectedModel;
      reason: 'invalid' | 'missing' | 'probe_failed';
      details?: string;
    }
  | {
      status: 'ready';
      selection: SelectedModel;
      capabilities: EngineCapabilitiesRecord;
    };

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
  familyId: ModelFamilyId;
  installId: string;
  message: string | null;
  modelId: string;
  runtimeId: RuntimeId;
  state: ModelInstallState;
  totalBytes: number | null;
}

export interface ModelRemovedRecord {
  familyId: ModelFamilyId;
  modelId: string;
  removed: boolean;
  runtimeId: RuntimeId;
}

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && (RUNTIME_IDS as readonly string[]).includes(value);
}

export function isModelFamilyId(value: unknown): value is ModelFamilyId {
  return typeof value === 'string' && (MODEL_FAMILY_IDS as readonly string[]).includes(value);
}

export function isSelectedModel(value: unknown): value is SelectedModel {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRuntimeId(value.runtimeId) || !isModelFamilyId(value.familyId)) {
    return false;
  }

  if (value.kind === 'catalog_model') {
    return typeof value.modelId === 'string' && value.modelId.length > 0;
  }

  if (value.kind === 'external_file') {
    return typeof value.filePath === 'string' && value.filePath.trim().length > 0;
  }

  return false;
}

export function normalizeSelectedModel(value: SelectedModel): SelectedModel {
  if (value.kind === 'catalog_model') {
    return {
      familyId: value.familyId,
      kind: value.kind,
      modelId: value.modelId.trim(),
      runtimeId: value.runtimeId,
    };
  }

  return {
    familyId: value.familyId,
    filePath: value.filePath.trim(),
    kind: value.kind,
    runtimeId: value.runtimeId,
  };
}

export function getTotalModelSize(model: CatalogModelRecord): number {
  return model.artifacts.reduce((sum, a) => sum + a.sizeBytes, 0);
}

export function matchesModelTriple(
  record: { familyId: ModelFamilyId; modelId: string; runtimeId: RuntimeId },
  runtimeId: RuntimeId,
  familyId: ModelFamilyId,
  modelId: string,
): boolean {
  return (
    record.runtimeId === runtimeId && record.familyId === familyId && record.modelId === modelId
  );
}

export function selectedModelEquals(left: SelectedModel, right: SelectedModel): boolean {
  if (
    left.kind !== right.kind ||
    left.runtimeId !== right.runtimeId ||
    left.familyId !== right.familyId
  ) {
    return false;
  }

  if (left.kind === 'catalog_model' && right.kind === 'catalog_model') {
    return left.modelId === right.modelId;
  }

  if (left.kind === 'external_file' && right.kind === 'external_file') {
    return left.filePath === right.filePath;
  }

  return false;
}

export function getPrimaryArtifact(model: CatalogModelRecord): ModelArtifactRecord | null {
  return (
    model.artifacts.find(
      (artifact) => artifact.required && artifact.role === 'transcription_model',
    ) ?? null
  );
}
