import {
  type AcceleratorAvailability,
  type AcceleratorId,
  type CatalogModelRecord,
  type EngineCapabilitiesRecord,
  getPrimaryArtifact,
  type InstalledModelRecord,
  type LanguageSupport,
  MODEL_FAMILY_IDS,
  type ModelCatalogRecord,
  type ModelCollectionRecord,
  type ModelFamilyCapabilitiesRecord,
  type ModelFamilyId,
  type ModelFamilyRecord,
  type ModelFormat,
  type ModelInstallState,
  type ModelInstallUpdateRecord,
  type ModelProbeResultRecord,
  type ModelRemovedRecord,
  type ModelStoreRecord,
  normalizeSelectedModel,
  type RequestWarning,
  RUNTIME_IDS,
  type RuntimeCapabilitiesRecord,
  type RuntimeId,
  type SelectedModel,
} from '../models/model-management-types';
import {
  STAGE_IDS,
  type StageId,
  type StageOutcome,
  type StageStatus,
  type UtteranceId,
} from '../session/session-journal';
import { PCM_BYTES_PER_FRAME } from '../shared/pcm-format';
import { isRecord } from '../shared/type-guards';

export const JSON_FRAME_KIND = 0x01;
export const AUDIO_FRAME_KIND = 0x02;
export const FRAME_HEADER_LENGTH = 5;

export type AccelerationPreference = 'auto' | 'cpu_only';
export type SpeakingStyle = 'responsive' | 'balanced' | 'patient';

export const LISTENING_MODES = ['always_on', 'one_sentence'] as const;
export type ListeningMode = (typeof LISTENING_MODES)[number];

export const SESSION_STATES = [
  'error',
  'idle',
  'listening',
  'paused',
  'speech_detected',
  'speech_ending',
  'transcribing',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_STOP_REASONS = [
  'sentence_complete',
  'session_replaced',
  'timeout',
  'user_cancel',
  'user_stop',
] as const;
export type SessionStopReason = (typeof SESSION_STOP_REASONS)[number];

export interface TranscriptSegment {
  endMs: number;
  startMs: number;
  text: string;
  timestampGranularity: TimestampGranularity;
  timestampSource: TimestampSource;
}

export type TimestampSource = 'engine' | 'interpolated' | 'none' | 'vad';
export type TimestampGranularity = 'segment' | 'utterance' | 'word';

export type ContextWindowSource =
  | {
      kind: 'note_glossary';
      text: string;
      truncated: boolean;
    }
  | {
      endRevision: number;
      kind: 'session_utterance';
      text: string;
      truncated: boolean;
      utteranceId: UtteranceId;
    };

export interface ContextWindow {
  budgetChars: number;
  sources: readonly ContextWindowSource[];
  text: string;
  truncated: boolean;
}

export interface CompiledRuntimeInfo {
  displayName: string;
  runtimeCapabilities: RuntimeCapabilitiesRecord;
  runtimeId: RuntimeId;
}

export interface CompiledAdapterInfo {
  displayName: string;
  familyCapabilities: ModelFamilyCapabilitiesRecord;
  familyId: ModelFamilyId;
  runtimeId: RuntimeId;
}

interface EnvelopeBase<TType extends string> {
  type: TType;
}

export interface HealthCommand extends EnvelopeBase<'health'> {}

export interface StartSessionCommand extends EnvelopeBase<'start_session'> {
  accelerationPreference: AccelerationPreference;
  language: 'en';
  mode: ListeningMode;
  modelSelection: SelectedModel;
  modelStorePathOverride?: string;
  pauseWhileProcessing: boolean;
  sessionStartUnixMs: number;
  sessionId: string;
  speakingStyle: SpeakingStyle;
}

export interface ContextResponseCommand extends EnvelopeBase<'context_response'> {
  context: ContextWindow | null;
  correlationId: string;
}

export interface GetModelStoreCommand extends EnvelopeBase<'get_model_store'> {
  modelStorePathOverride?: string;
}

export interface ListModelCatalogCommand extends EnvelopeBase<'list_model_catalog'> {}

export interface ListInstalledModelsCommand extends EnvelopeBase<'list_installed_models'> {
  modelStorePathOverride?: string;
}

export interface ProbeModelSelectionCommand extends EnvelopeBase<'probe_model_selection'> {
  modelSelection: SelectedModel;
  modelStorePathOverride?: string;
}

export interface RemoveModelCommand extends EnvelopeBase<'remove_model'> {
  familyId: ModelFamilyId;
  modelId: string;
  modelStorePathOverride?: string;
  runtimeId: RuntimeId;
}

export interface InstallModelCommand extends EnvelopeBase<'install_model'> {
  familyId: ModelFamilyId;
  installId: string;
  modelId: string;
  modelStorePathOverride?: string;
  runtimeId: RuntimeId;
}

export interface CancelModelInstallCommand extends EnvelopeBase<'cancel_model_install'> {
  installId: string;
}

export interface StopSessionCommand extends EnvelopeBase<'stop_session'> {}

export interface CancelSessionCommand extends EnvelopeBase<'cancel_session'> {}

export interface ShutdownCommand extends EnvelopeBase<'shutdown'> {}

export interface GetSystemInfoCommand extends EnvelopeBase<'get_system_info'> {}

export type SidecarCommand =
  | CancelModelInstallCommand
  | CancelSessionCommand
  | ContextResponseCommand
  | GetModelStoreCommand
  | GetSystemInfoCommand
  | HealthCommand
  | InstallModelCommand
  | ListInstalledModelsCommand
  | ListModelCatalogCommand
  | ProbeModelSelectionCommand
  | RemoveModelCommand
  | ShutdownCommand
  | StartSessionCommand
  | StopSessionCommand;

export interface HealthOkEvent extends EnvelopeBase<'health_ok'> {
  sidecarVersion: string;
  status: 'ready';
}

export interface SystemInfoEvent extends EnvelopeBase<'system_info'> {
  compiledAdapters: CompiledAdapterInfo[];
  compiledRuntimes: CompiledRuntimeInfo[];
  sidecarVersion: string;
  systemInfo: string;
}

export interface ModelStoreEvent extends EnvelopeBase<'model_store'>, ModelStoreRecord {}

export interface ModelCatalogEvent extends EnvelopeBase<'model_catalog'>, ModelCatalogRecord {}

export interface InstalledModelsEvent extends EnvelopeBase<'installed_models'> {
  models: InstalledModelRecord[];
}

export interface ModelProbeResultEvent
  extends EnvelopeBase<'model_probe_result'>,
    ModelProbeResultRecord {}

export interface ModelRemovedEvent extends EnvelopeBase<'model_removed'>, ModelRemovedRecord {}

export interface ModelInstallUpdateEvent
  extends EnvelopeBase<'model_install_update'>,
    ModelInstallUpdateRecord {}

export interface SessionStartedEvent extends EnvelopeBase<'session_started'> {
  mode: ListeningMode;
  sessionId: string;
}

export interface SessionStateChangedEvent extends EnvelopeBase<'session_state_changed'> {
  sessionId: string;
  state: SessionState;
}

export interface TranscriptReadyEvent extends EnvelopeBase<'transcript_ready'> {
  isFinal: boolean;
  processingDurationMs: number;
  revision: number;
  segments: TranscriptSegment[];
  sessionId: string;
  stageResults: StageOutcome[];
  text: string;
  utteranceDurationMs: number;
  utteranceEndMsInSession: number;
  utteranceId: UtteranceId;
  utteranceIndex: number;
  utteranceStartMsInSession: number;
  warnings: RequestWarning[];
}

export interface ContextRequestEvent extends EnvelopeBase<'context_request'> {
  budgetChars: number;
  correlationId: string;
  sessionId: string;
  utteranceId: UtteranceId;
}

export interface WarningEvent extends EnvelopeBase<'warning'> {
  code: string;
  details?: string;
  message: string;
  sessionId?: string;
}

export interface SessionStoppedEvent extends EnvelopeBase<'session_stopped'> {
  reason: SessionStopReason;
  sessionId: string;
}

export interface ErrorEvent extends EnvelopeBase<'error'> {
  code: string;
  details?: string;
  message: string;
  sessionId?: string;
}

export type SidecarEvent =
  | ContextRequestEvent
  | ErrorEvent
  | HealthOkEvent
  | InstalledModelsEvent
  | ModelCatalogEvent
  | ModelInstallUpdateEvent
  | ModelProbeResultEvent
  | ModelRemovedEvent
  | ModelStoreEvent
  | SessionStartedEvent
  | SessionStateChangedEvent
  | SessionStoppedEvent
  | SystemInfoEvent
  | TranscriptReadyEvent
  | WarningEvent;

export function createHealthCommand(): HealthCommand {
  return createEnvelope('health');
}

export function createGetSystemInfoCommand(): GetSystemInfoCommand {
  return createEnvelope('get_system_info');
}

export function createStartSessionCommand(
  payload: Omit<StartSessionCommand, 'type'>,
): StartSessionCommand {
  return {
    ...createEnvelope('start_session'),
    ...payload,
  };
}

export function createGetModelStoreCommand(modelStorePathOverride?: string): GetModelStoreCommand {
  return {
    ...createEnvelope('get_model_store'),
    ...(modelStorePathOverride !== undefined ? { modelStorePathOverride } : {}),
  };
}

export function createListModelCatalogCommand(): ListModelCatalogCommand {
  return createEnvelope('list_model_catalog');
}

export function createListInstalledModelsCommand(
  modelStorePathOverride?: string,
): ListInstalledModelsCommand {
  return {
    ...createEnvelope('list_installed_models'),
    ...(modelStorePathOverride !== undefined ? { modelStorePathOverride } : {}),
  };
}

export function createProbeModelSelectionCommand(
  payload: Omit<ProbeModelSelectionCommand, 'type'>,
): ProbeModelSelectionCommand {
  return {
    ...createEnvelope('probe_model_selection'),
    ...payload,
  };
}

export function createRemoveModelCommand(
  payload: Omit<RemoveModelCommand, 'type'>,
): RemoveModelCommand {
  return {
    ...createEnvelope('remove_model'),
    ...payload,
  };
}

export function createInstallModelCommand(
  payload: Omit<InstallModelCommand, 'type'>,
): InstallModelCommand {
  return {
    ...createEnvelope('install_model'),
    ...payload,
  };
}

export function createCancelModelInstallCommand(installId: string): CancelModelInstallCommand {
  return {
    ...createEnvelope('cancel_model_install'),
    installId,
  };
}

export function createStopSessionCommand(): StopSessionCommand {
  return createEnvelope('stop_session');
}

export function createCancelSessionCommand(): CancelSessionCommand {
  return createEnvelope('cancel_session');
}

export function createShutdownCommand(): ShutdownCommand {
  return createEnvelope('shutdown');
}

export function createContextResponseCommand(
  correlationId: string,
  context: ContextWindow | null,
): ContextResponseCommand {
  return {
    ...createEnvelope('context_response'),
    context,
    correlationId,
  };
}

export function encodeJsonFrame(envelope: SidecarCommand | SidecarEvent): Uint8Array {
  return encodeFrame(JSON_FRAME_KIND, textEncoder.encode(JSON.stringify(envelope)));
}

export function encodeAudioFrame(frameBytes: Uint8Array): Uint8Array {
  if (frameBytes.byteLength !== PCM_BYTES_PER_FRAME) {
    throw new Error(
      `Audio frames must be ${PCM_BYTES_PER_FRAME} bytes, received ${frameBytes.byteLength}.`,
    );
  }

  return encodeFrame(AUDIO_FRAME_KIND, frameBytes);
}

export interface JsonFrame<TEnvelope> {
  envelope: TEnvelope;
  kind: typeof JSON_FRAME_KIND;
}

export interface AudioFrame {
  kind: typeof AUDIO_FRAME_KIND;
  payload: Uint8Array<ArrayBufferLike>;
}

export type ParsedFrame<TEnvelope> = AudioFrame | JsonFrame<TEnvelope>;

export class FramedMessageParser<TEnvelope> {
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(private readonly parseJsonEnvelope: (jsonText: string) => TEnvelope) {}

  reset(): void {
    this.buffered = new Uint8Array(0);
  }

  pushChunk(chunk: Uint8Array<ArrayBufferLike>): ParsedFrame<TEnvelope>[] {
    this.buffered = concatBytes(this.buffered, chunk);

    const frames: ParsedFrame<TEnvelope>[] = [];
    let offset = 0;

    while (this.buffered.byteLength - offset >= FRAME_HEADER_LENGTH) {
      const kind = this.buffered[offset];

      if (kind === undefined) {
        break;
      }

      const payloadLength = readUint32LE(this.buffered, offset + 1);
      const frameLength = FRAME_HEADER_LENGTH + payloadLength;

      if (this.buffered.byteLength - offset < frameLength) {
        break;
      }

      const payload = this.buffered.slice(offset + FRAME_HEADER_LENGTH, offset + frameLength);

      if (kind === JSON_FRAME_KIND) {
        frames.push({
          envelope: this.parseJsonEnvelope(textDecoder.decode(payload)),
          kind,
        });
      } else if (kind === AUDIO_FRAME_KIND) {
        frames.push({
          kind,
          payload,
        });
      } else {
        throw new Error(`Unsupported sidecar frame kind: ${kind}`);
      }

      offset += frameLength;
    }

    this.buffered = this.buffered.slice(offset);
    return frames;
  }
}

export function parseEventFrame(jsonText: string): SidecarEvent {
  const parsedValue: unknown = JSON.parse(jsonText);

  if (!isRecord(parsedValue)) {
    throw new Error('Sidecar event must be a JSON object.');
  }

  const type = readString(parsedValue.type, 'event.type');

  switch (type) {
    case 'health_ok':
      return {
        sidecarVersion: readString(parsedValue.sidecarVersion, 'event.sidecarVersion'),
        status: readReadyStatus(parsedValue.status),
        type,
      };

    case 'model_store':
      return {
        overridePath: readNullableString(parsedValue.overridePath, 'event.overridePath'),
        path: readString(parsedValue.path, 'event.path'),
        type,
        usingDefaultPath: readBoolean(parsedValue.usingDefaultPath, 'event.usingDefaultPath'),
      };

    case 'model_catalog':
      return {
        catalogVersion: readPositiveInteger(parsedValue.catalogVersion, 'event.catalogVersion'),
        collections: readModelCollections(parsedValue.collections),
        families: readModelFamilies(parsedValue.families),
        models: readCatalogModels(parsedValue.models),
        type,
      };

    case 'installed_models':
      return {
        models: readInstalledModels(parsedValue.models),
        type,
      };

    case 'model_probe_result':
      return {
        available: readBoolean(parsedValue.available, 'event.available'),
        details: readNullableString(parsedValue.details, 'event.details'),
        displayName: readNullableString(parsedValue.displayName, 'event.displayName'),
        familyId: readModelFamilyId(parsedValue.familyId, 'event.familyId'),
        installed: readBoolean(parsedValue.installed, 'event.installed'),
        mergedCapabilities: readOptionalEngineCapabilities(
          parsedValue.mergedCapabilities,
          'event.mergedCapabilities',
        ),
        message: readString(parsedValue.message, 'event.message'),
        modelId: readNullableString(parsedValue.modelId, 'event.modelId'),
        resolvedPath: readNullableString(parsedValue.resolvedPath, 'event.resolvedPath'),
        runtimeId: readRuntimeId(parsedValue.runtimeId, 'event.runtimeId'),
        selection: readSelectedModel(parsedValue.selection, 'event.selection'),
        sizeBytes: readNullableNumber(parsedValue.sizeBytes, 'event.sizeBytes'),
        status: readModelProbeStatus(parsedValue.status, 'event.status'),
        type,
      };

    case 'model_removed':
      return {
        familyId: readModelFamilyId(parsedValue.familyId, 'event.familyId'),
        modelId: readString(parsedValue.modelId, 'event.modelId'),
        removed: readBoolean(parsedValue.removed, 'event.removed'),
        runtimeId: readRuntimeId(parsedValue.runtimeId, 'event.runtimeId'),
        type,
      };

    case 'model_install_update':
      return {
        details: readNullableString(parsedValue.details, 'event.details'),
        downloadedBytes: readNullableNumber(parsedValue.downloadedBytes, 'event.downloadedBytes'),
        familyId: readModelFamilyId(parsedValue.familyId, 'event.familyId'),
        installId: readString(parsedValue.installId, 'event.installId'),
        message: readNullableString(parsedValue.message, 'event.message'),
        modelId: readString(parsedValue.modelId, 'event.modelId'),
        runtimeId: readRuntimeId(parsedValue.runtimeId, 'event.runtimeId'),
        state: readModelInstallState(parsedValue.state, 'event.state'),
        totalBytes: readNullableNumber(parsedValue.totalBytes, 'event.totalBytes'),
        type,
      };

    case 'system_info':
      return {
        compiledAdapters: readCompiledAdapters(parsedValue.compiledAdapters),
        compiledRuntimes: readCompiledRuntimes(parsedValue.compiledRuntimes),
        sidecarVersion: readString(parsedValue.sidecarVersion, 'event.sidecarVersion'),
        systemInfo: readString(parsedValue.systemInfo, 'event.systemInfo'),
        type,
      };

    case 'session_started':
      return {
        mode: readListeningMode(parsedValue.mode, 'event.mode'),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        type,
      };

    case 'session_state_changed':
      return {
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        state: readSessionState(parsedValue.state, 'event.state'),
        type,
      };

    case 'transcript_ready':
      return {
        isFinal: readBoolean(parsedValue.isFinal, 'event.isFinal'),
        processingDurationMs: readNonNegativeNumber(
          parsedValue.processingDurationMs,
          'event.processingDurationMs',
        ),
        revision: readNonNegativeInteger(parsedValue.revision, 'event.revision'),
        segments: readTranscriptSegments(parsedValue.segments),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        stageResults: readStageOutcomes(parsedValue.stageResults),
        text: readString(parsedValue.text, 'event.text'),
        type,
        utteranceDurationMs: readNonNegativeNumber(
          parsedValue.utteranceDurationMs,
          'event.utteranceDurationMs',
        ),
        utteranceEndMsInSession: readNonNegativeNumber(
          parsedValue.utteranceEndMsInSession,
          'event.utteranceEndMsInSession',
        ),
        utteranceId: readString(parsedValue.utteranceId, 'event.utteranceId'),
        utteranceIndex: readNonNegativeInteger(parsedValue.utteranceIndex, 'event.utteranceIndex'),
        utteranceStartMsInSession: readNonNegativeNumber(
          parsedValue.utteranceStartMsInSession,
          'event.utteranceStartMsInSession',
        ),
        warnings: readRequestWarnings(parsedValue.warnings),
      };

    case 'context_request':
      return {
        budgetChars: readNonNegativeInteger(parsedValue.budgetChars, 'event.budgetChars'),
        correlationId: readString(parsedValue.correlationId, 'event.correlationId'),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        type,
        utteranceId: readString(parsedValue.utteranceId, 'event.utteranceId'),
      };

    case 'warning':
      return createWarningEvent(parsedValue);

    case 'session_stopped':
      return {
        reason: readSessionStopReason(parsedValue.reason, 'event.reason'),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        type,
      };

    case 'error':
      return createErrorEvent(parsedValue);

    default:
      throw new Error(`Unsupported sidecar event type: ${type}`);
  }
}

function createEnvelope<TType extends SidecarCommand['type']>(
  type: TType,
): Extract<SidecarCommand, { type: TType }> {
  return { type } as Extract<SidecarCommand, { type: TType }>;
}

function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.byteLength);
  const view = new DataView(frame.buffer);

  frame[0] = kind;
  view.setUint32(1, payload.byteLength, true);
  frame.set(payload, FRAME_HEADER_LENGTH);

  return frame;
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const concatenated = new Uint8Array(left.byteLength + right.byteLength);
  concatenated.set(left, 0);
  concatenated.set(right, left.byteLength);
  return concatenated;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) {
    throw new Error('Frame length header is truncated.');
  }

  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value;
}

function readEnumValue<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  fieldName: string,
): TValue {
  const candidate = readString(value, fieldName);

  if ((allowed as readonly string[]).includes(candidate)) {
    return candidate as TValue;
  }

  throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}; received "${candidate}".`);
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readString(value, fieldName);
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean.`);
  }

  return value;
}

function readNonNegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }

  return value;
}

function readNullableNumber(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  return readNonNegativeNumber(value, fieldName);
}

function readPositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}

function readReadyStatus(value: unknown): 'ready' {
  return readEnumValue(value, ['ready'] as const, 'event.status');
}

function readListeningMode(value: unknown, fieldName: string): ListeningMode {
  return readEnumValue(value, LISTENING_MODES, fieldName);
}

function readSessionState(value: unknown, fieldName: string): SessionState {
  return readEnumValue(value, SESSION_STATES, fieldName);
}

function readSessionStopReason(value: unknown, fieldName: string): SessionStopReason {
  return readEnumValue(value, SESSION_STOP_REASONS, fieldName);
}

function readTimestampSource(value: unknown, fieldName: string): TimestampSource {
  return readEnumValue(value, ['engine', 'interpolated', 'none', 'vad'] as const, fieldName);
}

function readTimestampGranularity(value: unknown, fieldName: string): TimestampGranularity {
  return readEnumValue(value, ['segment', 'utterance', 'word'] as const, fieldName);
}

function readRuntimeId(value: unknown, fieldName: string): RuntimeId {
  return readEnumValue(value, RUNTIME_IDS, fieldName);
}

function readModelFamilyId(value: unknown, fieldName: string): ModelFamilyId {
  return readEnumValue(value, MODEL_FAMILY_IDS, fieldName);
}

function readSelectedModel(value: unknown, fieldName: string): SelectedModel {
  const record = readRecord(value, fieldName);
  const kind = readEnumValue(
    record.kind,
    ['catalog_model', 'external_file'] as const,
    `${fieldName}.kind`,
  );
  const runtimeId = readRuntimeId(record.runtimeId, `${fieldName}.runtimeId`);
  const familyId = readModelFamilyId(record.familyId, `${fieldName}.familyId`);

  if (kind === 'catalog_model') {
    return normalizeSelectedModel({
      familyId,
      kind,
      modelId: readString(record.modelId, `${fieldName}.modelId`),
      runtimeId,
    });
  }

  return normalizeSelectedModel({
    familyId,
    filePath: readString(record.filePath, `${fieldName}.filePath`),
    kind,
    runtimeId,
  });
}

function readModelProbeStatus(value: unknown, fieldName: string): ModelProbeResultRecord['status'] {
  return readEnumValue(value, ['invalid', 'missing', 'ready'] as const, fieldName);
}

function readAcceleratorId(value: unknown, fieldName: string): AcceleratorId {
  return readEnumValue(value, ['cpu', 'cuda', 'direct_ml', 'metal'] as const, fieldName);
}

function readModelFormat(value: unknown, fieldName: string): ModelFormat {
  return readEnumValue(value, ['ggml', 'gguf', 'onnx'] as const, fieldName);
}

function readAcceleratorAvailability(value: unknown, fieldName: string): AcceleratorAvailability {
  const record = readRecord(value, fieldName);

  return {
    available: readBoolean(record.available, `${fieldName}.available`),
    unavailableReason: readNullableString(
      record.unavailableReason,
      `${fieldName}.unavailableReason`,
    ),
  };
}

function readAcceleratorDetails(
  value: unknown,
  fieldName: string,
): Partial<Record<AcceleratorId, AcceleratorAvailability>> {
  const record = readRecord(value, fieldName);
  const result: Partial<Record<AcceleratorId, AcceleratorAvailability>> = {};

  for (const [key, entry] of Object.entries(record)) {
    const acceleratorId = readAcceleratorId(key, `${fieldName}[key]`);
    result[acceleratorId] = readAcceleratorAvailability(entry, `${fieldName}[${key}]`);
  }

  return result;
}

function readRuntimeCapabilities(value: unknown, fieldName: string): RuntimeCapabilitiesRecord {
  const record = readRecord(value, fieldName);

  return {
    acceleratorDetails: readAcceleratorDetails(
      record.acceleratorDetails,
      `${fieldName}.acceleratorDetails`,
    ),
    availableAccelerators: readArray(
      record.availableAccelerators,
      `${fieldName}.availableAccelerators`,
    ).map((entry, index) =>
      readAcceleratorId(entry, `${fieldName}.availableAccelerators[${index}]`),
    ),
    supportedModelFormats: readArray(
      record.supportedModelFormats,
      `${fieldName}.supportedModelFormats`,
    ).map((entry, index) => readModelFormat(entry, `${fieldName}.supportedModelFormats[${index}]`)),
  };
}

function readLanguageSupport(value: unknown, fieldName: string): LanguageSupport {
  const record = readRecord(value, fieldName);
  const kind = readEnumValue(
    record.kind,
    ['all', 'english_only', 'list', 'unknown'] as const,
    `${fieldName}.kind`,
  );

  if (kind === 'list') {
    return {
      kind,
      tags: readArray(record.tags, `${fieldName}.tags`).map((entry, index) =>
        readString(entry, `${fieldName}.tags[${index}]`),
      ),
    };
  }

  return { kind };
}

function readModelFamilyCapabilities(
  value: unknown,
  fieldName: string,
): ModelFamilyCapabilitiesRecord {
  const record = readRecord(value, fieldName);

  return {
    maxAudioDurationSecs: readNullableNumber(
      record.maxAudioDurationSecs,
      `${fieldName}.maxAudioDurationSecs`,
    ),
    producesPunctuation: readBoolean(
      record.producesPunctuation,
      `${fieldName}.producesPunctuation`,
    ),
    supportedLanguages: readLanguageSupport(
      record.supportedLanguages,
      `${fieldName}.supportedLanguages`,
    ),
    supportsInitialPrompt: readBoolean(
      record.supportsInitialPrompt,
      `${fieldName}.supportsInitialPrompt`,
    ),
    supportsLanguageSelection: readBoolean(
      record.supportsLanguageSelection,
      `${fieldName}.supportsLanguageSelection`,
    ),
    supportsSegmentTimestamps: readBoolean(
      record.supportsSegmentTimestamps,
      `${fieldName}.supportsSegmentTimestamps`,
    ),
    supportsWordTimestamps: readBoolean(
      record.supportsWordTimestamps,
      `${fieldName}.supportsWordTimestamps`,
    ),
  };
}

function readOptionalEngineCapabilities(
  value: unknown,
  fieldName: string,
): EngineCapabilitiesRecord | null {
  if (value === undefined || value === null) {
    return null;
  }

  const record = readRecord(value, fieldName);

  return {
    family: readModelFamilyCapabilities(record.family, `${fieldName}.family`),
    familyId: readModelFamilyId(record.familyId, `${fieldName}.familyId`),
    runtime: readRuntimeCapabilities(record.runtime, `${fieldName}.runtime`),
    runtimeId: readRuntimeId(record.runtimeId, `${fieldName}.runtimeId`),
  };
}

function readCompiledRuntimes(value: unknown): CompiledRuntimeInfo[] {
  return readArray(value, 'event.compiledRuntimes').map((entry, index) => {
    const record = readRecord(entry, `event.compiledRuntimes[${index}]`);
    return {
      displayName: readString(record.displayName, `event.compiledRuntimes[${index}].displayName`),
      runtimeCapabilities: readRuntimeCapabilities(
        record.runtimeCapabilities,
        `event.compiledRuntimes[${index}].runtimeCapabilities`,
      ),
      runtimeId: readRuntimeId(record.runtimeId, `event.compiledRuntimes[${index}].runtimeId`),
    };
  });
}

function readCompiledAdapters(value: unknown): CompiledAdapterInfo[] {
  return readArray(value, 'event.compiledAdapters').map((entry, index) => {
    const record = readRecord(entry, `event.compiledAdapters[${index}]`);
    return {
      displayName: readString(record.displayName, `event.compiledAdapters[${index}].displayName`),
      familyCapabilities: readModelFamilyCapabilities(
        record.familyCapabilities,
        `event.compiledAdapters[${index}].familyCapabilities`,
      ),
      familyId: readModelFamilyId(record.familyId, `event.compiledAdapters[${index}].familyId`),
      runtimeId: readRuntimeId(record.runtimeId, `event.compiledAdapters[${index}].runtimeId`),
    };
  });
}

function readRequestWarnings(value: unknown): RequestWarning[] {
  if (value === undefined || value === null) {
    return [];
  }

  return readArray(value, 'event.warnings').map((entry, index) => {
    const record = readRecord(entry, `event.warnings[${index}]`);
    return {
      field: readString(record.field, `event.warnings[${index}].field`),
      reason: readString(record.reason, `event.warnings[${index}].reason`),
    };
  });
}

function readModelInstallState(value: unknown, fieldName: string): ModelInstallState {
  return readEnumValue(
    value,
    ['cancelled', 'completed', 'downloading', 'failed', 'probing', 'queued', 'verifying'] as const,
    fieldName,
  );
}

function readNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }

  return value;
}

function readStageOutcomes(value: unknown): StageOutcome[] {
  return readArray(value, 'event.stageResults').map((entry, index) =>
    readStageOutcome(entry, `event.stageResults[${index}]`),
  );
}

function readStageOutcome(value: unknown, fieldName: string): StageOutcome {
  const record = readRecord(value, fieldName);
  const outcome: StageOutcome = {
    durationMs: readNonNegativeNumber(record.durationMs, `${fieldName}.durationMs`),
    revisionIn: readNonNegativeInteger(record.revisionIn, `${fieldName}.revisionIn`),
    stageId: readStageId(record.stageId, `${fieldName}.stageId`),
    status: readStageStatus(record.status, `${fieldName}.status`),
  };

  if (record.payload !== undefined && record.payload !== null) {
    outcome.payload = readRecord(record.payload, `${fieldName}.payload`);
  }

  if (record.revisionOut !== undefined && record.revisionOut !== null) {
    outcome.revisionOut = readNonNegativeInteger(record.revisionOut, `${fieldName}.revisionOut`);
  }

  return outcome;
}

function readStageId(value: unknown, fieldName: string): StageId {
  return readEnumValue(value, STAGE_IDS, fieldName);
}

function readStageStatus(value: unknown, fieldName: string): StageStatus {
  const record = readRecord(value, fieldName);
  const kind = readString(record.kind, `${fieldName}.kind`);

  if (kind === 'ok') {
    return { kind };
  }

  if (kind === 'skipped') {
    return { kind, reason: readString(record.reason, `${fieldName}.reason`) };
  }

  if (kind === 'failed') {
    return { error: readString(record.error, `${fieldName}.error`), kind };
  }

  throw new Error(`Unsupported stage status kind: ${kind}`);
}

function readTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('event.segments must be an array.');
  }

  return value.map((segment, index) => {
    if (!isRecord(segment)) {
      throw new Error(`event.segments[${index}] must be an object.`);
    }

    return {
      endMs: readNonNegativeNumber(segment.endMs, `event.segments[${index}].endMs`),
      startMs: readNonNegativeNumber(segment.startMs, `event.segments[${index}].startMs`),
      text: readString(segment.text, `event.segments[${index}].text`),
      timestampGranularity: readTimestampGranularity(
        segment.timestampGranularity,
        `event.segments[${index}].timestampGranularity`,
      ),
      timestampSource: readTimestampSource(
        segment.timestampSource,
        `event.segments[${index}].timestampSource`,
      ),
    };
  });
}

function readModelFamilies(value: unknown): ModelFamilyRecord[] {
  return readArray(value, 'event.families').map((entry, index) => {
    const record = readRecord(entry, `event.families[${index}]`);

    return {
      displayName: readString(record.displayName, `event.families[${index}].displayName`),
      familyId: readModelFamilyId(record.familyId, `event.families[${index}].familyId`),
      runtimeId: readRuntimeId(record.runtimeId, `event.families[${index}].runtimeId`),
      summary: readString(record.summary, `event.families[${index}].summary`),
    };
  });
}

function readModelCollections(value: unknown): ModelCollectionRecord[] {
  return readArray(value, 'event.collections').map((collection, index) => {
    const record = readRecord(collection, `event.collections[${index}]`);

    return {
      collectionId: readString(record.collectionId, `event.collections[${index}].collectionId`),
      displayName: readString(record.displayName, `event.collections[${index}].displayName`),
      summary: readString(record.summary, `event.collections[${index}].summary`),
    };
  });
}

function readCatalogModels(value: unknown): CatalogModelRecord[] {
  return readArray(value, 'event.models').map((model, index) => {
    const record = readRecord(model, `event.models[${index}]`);
    const artifacts = readModelArtifacts(record.artifacts, `event.models[${index}].artifacts`);
    const parsedModel: CatalogModelRecord = {
      artifacts,
      collectionId: readString(record.collectionId, `event.models[${index}].collectionId`),
      displayName: readString(record.displayName, `event.models[${index}].displayName`),
      familyId: readModelFamilyId(record.familyId, `event.models[${index}].familyId`),
      languageTags: readStringArray(record.languageTags, `event.models[${index}].languageTags`),
      licenseLabel: readString(record.licenseLabel, `event.models[${index}].licenseLabel`),
      licenseUrl: readString(record.licenseUrl, `event.models[${index}].licenseUrl`),
      modelCardUrl: readNullableString(record.modelCardUrl, `event.models[${index}].modelCardUrl`),
      modelId: readString(record.modelId, `event.models[${index}].modelId`),
      notes: readStringArray(record.notes, `event.models[${index}].notes`),
      runtimeId: readRuntimeId(record.runtimeId, `event.models[${index}].runtimeId`),
      sourceUrl: readString(record.sourceUrl, `event.models[${index}].sourceUrl`),
      summary: readString(record.summary, `event.models[${index}].summary`),
      uxTags: readStringArray(record.uxTags, `event.models[${index}].uxTags`),
    };

    if (getPrimaryArtifact(parsedModel) === null) {
      throw new Error(`event.models[${index}] is missing a required transcription artifact.`);
    }

    return parsedModel;
  });
}

function readModelArtifacts(value: unknown, fieldName: string): CatalogModelRecord['artifacts'] {
  return readArray(value, fieldName).map((artifact, index) => {
    const record = readRecord(artifact, `${fieldName}[${index}]`);
    const role = readEnumValue(
      record.role,
      ['supporting_file', 'transcription_model'] as const,
      `${fieldName}[${index}].role`,
    );

    return {
      artifactId: readString(record.artifactId, `${fieldName}[${index}].artifactId`),
      downloadUrl: readString(record.downloadUrl, `${fieldName}[${index}].downloadUrl`),
      filename: readString(record.filename, `${fieldName}[${index}].filename`),
      required: readBoolean(record.required, `${fieldName}[${index}].required`),
      role,
      sha256: readString(record.sha256, `${fieldName}[${index}].sha256`),
      sizeBytes: readPositiveInteger(record.sizeBytes, `${fieldName}[${index}].sizeBytes`),
    };
  });
}

function readInstalledModels(value: unknown): InstalledModelRecord[] {
  return readArray(value, 'event.models').map((model, index) => {
    const record = readRecord(model, `event.models[${index}]`);

    return {
      catalogVersion: readPositiveInteger(
        record.catalogVersion,
        `event.models[${index}].catalogVersion`,
      ),
      familyId: readModelFamilyId(record.familyId, `event.models[${index}].familyId`),
      installPath: readString(record.installPath, `event.models[${index}].installPath`),
      installedAtUnixMs: readNonNegativeNumber(
        record.installedAtUnixMs,
        `event.models[${index}].installedAtUnixMs`,
      ),
      modelId: readString(record.modelId, `event.models[${index}].modelId`),
      runtimeId: readRuntimeId(record.runtimeId, `event.models[${index}].runtimeId`),
      runtimePath: readNullableString(record.runtimePath, `event.models[${index}].runtimePath`),
      totalSizeBytes: readNonNegativeNumber(
        record.totalSizeBytes,
        `event.models[${index}].totalSizeBytes`,
      ),
    };
  });
}

function readArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }

  return value;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  return readArray(value, fieldName).map((entry, index) =>
    readString(entry, `${fieldName}[${index}]`),
  );
}

function readRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  return value;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createWarningEvent(value: Record<string, unknown>): WarningEvent {
  return {
    code: readString(value.code, 'event.code'),
    ...readOptionalEventFields(value),
    message: readString(value.message, 'event.message'),
    type: 'warning',
  };
}

function createErrorEvent(value: Record<string, unknown>): ErrorEvent {
  return {
    code: readString(value.code, 'event.code'),
    ...readOptionalEventFields(value),
    message: readString(value.message, 'event.message'),
    type: 'error',
  };
}

function readOptionalEventFields(value: Record<string, unknown>): {
  details?: string;
  sessionId?: string;
} {
  const result: { details?: string; sessionId?: string } = {};
  const details = readOptionalString(value.details, 'event.details');
  const sessionId = readOptionalString(value.sessionId, 'event.sessionId');

  if (details !== undefined) {
    result.details = details;
  }

  if (sessionId !== undefined) {
    result.sessionId = sessionId;
  }

  return result;
}
