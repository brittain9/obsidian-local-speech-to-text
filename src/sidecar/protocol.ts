import {
  type CatalogModelRecord,
  type EngineId,
  getPrimaryArtifact,
  type InstalledModelRecord,
  isEngineId,
  type ModelCatalogRecord,
  type ModelCollectionRecord,
  type ModelEngineRecord,
  type ModelInstallState,
  type ModelInstallUpdateRecord,
  type ModelProbeResultRecord,
  type ModelRemovedRecord,
  type ModelStoreRecord,
  normalizeSelectedModel,
  type SelectedModel,
} from '../models/model-management-types';
import { PCM_BYTES_PER_FRAME } from '../shared/pcm-format';
import { isRecord } from '../shared/type-guards';

export const SIDECAR_PROTOCOL_VERSION = 'v3' as const;

export const JSON_FRAME_KIND = 0x01;
export const AUDIO_FRAME_KIND = 0x02;
export const FRAME_HEADER_LENGTH = 5;

export type AccelerationPreference = 'auto' | 'cpu_only';
export type ListeningMode = 'always_on' | 'press_and_hold' | 'one_sentence';
export type SessionState =
  | 'error'
  | 'idle'
  | 'listening'
  | 'paused'
  | 'speech_detected'
  | 'transcribing';

export type SessionStopReason =
  | 'sentence_complete'
  | 'session_replaced'
  | 'timeout'
  | 'user_cancel'
  | 'user_stop';

export interface TranscriptSegment {
  endMs: number;
  startMs: number;
  text: string;
}

interface EnvelopeBase<TType extends string> {
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
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
  sessionId: string;
}

export interface RuntimeCapability {
  available: boolean;
  backend: string;
  engine: string;
  reason: string | null;
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
  engineId: EngineId;
  modelId: string;
  modelStorePathOverride?: string;
}

export interface InstallModelCommand extends EnvelopeBase<'install_model'> {
  engineId: EngineId;
  installId: string;
  modelId: string;
  modelStorePathOverride?: string;
}

export interface CancelModelInstallCommand extends EnvelopeBase<'cancel_model_install'> {
  installId: string;
}

export interface SetGateCommand extends EnvelopeBase<'set_gate'> {
  open: boolean;
}

export interface StopSessionCommand extends EnvelopeBase<'stop_session'> {}

export interface CancelSessionCommand extends EnvelopeBase<'cancel_session'> {}

export interface ShutdownCommand extends EnvelopeBase<'shutdown'> {}

export interface GetSystemInfoCommand extends EnvelopeBase<'get_system_info'> {}

export type SidecarCommand =
  | CancelModelInstallCommand
  | CancelSessionCommand
  | GetModelStoreCommand
  | GetSystemInfoCommand
  | HealthCommand
  | InstallModelCommand
  | ListInstalledModelsCommand
  | ListModelCatalogCommand
  | ProbeModelSelectionCommand
  | RemoveModelCommand
  | SetGateCommand
  | ShutdownCommand
  | StartSessionCommand
  | StopSessionCommand;

export interface HealthOkEvent extends EnvelopeBase<'health_ok'> {
  sidecarVersion: string;
  status: 'ready';
}

export interface SystemInfoEvent extends EnvelopeBase<'system_info'> {
  compiledBackends: string[];
  compiledEngines: string[];
  runtimeCapabilities: RuntimeCapability[];
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
  processingDurationMs: number;
  segments: TranscriptSegment[];
  sessionId: string;
  text: string;
  utteranceDurationMs: number;
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
  payload: Omit<StartSessionCommand, 'protocolVersion' | 'type'>,
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
  payload: Omit<ProbeModelSelectionCommand, 'protocolVersion' | 'type'>,
): ProbeModelSelectionCommand {
  return {
    ...createEnvelope('probe_model_selection'),
    ...payload,
  };
}

export function createRemoveModelCommand(
  payload: Omit<RemoveModelCommand, 'protocolVersion' | 'type'>,
): RemoveModelCommand {
  return {
    ...createEnvelope('remove_model'),
    ...payload,
  };
}

export function createInstallModelCommand(
  payload: Omit<InstallModelCommand, 'protocolVersion' | 'type'>,
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

export function createSetGateCommand(open: boolean): SetGateCommand {
  return {
    ...createEnvelope('set_gate'),
    open,
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

  const protocolVersion = readProtocolVersion(parsedValue.protocolVersion);
  const type = readString(parsedValue.type, 'event.type');

  switch (type) {
    case 'health_ok':
      return {
        protocolVersion,
        sidecarVersion: readString(parsedValue.sidecarVersion, 'event.sidecarVersion'),
        status: readReadyStatus(parsedValue.status),
        type,
      };

    case 'model_store':
      return {
        overridePath: readNullableString(parsedValue.overridePath, 'event.overridePath'),
        path: readString(parsedValue.path, 'event.path'),
        protocolVersion,
        type,
        usingDefaultPath: readBoolean(parsedValue.usingDefaultPath, 'event.usingDefaultPath'),
      };

    case 'model_catalog':
      return {
        catalogVersion: readPositiveInteger(parsedValue.catalogVersion, 'event.catalogVersion'),
        collections: readModelCollections(parsedValue.collections),
        engines: readModelEngines(parsedValue.engines),
        models: readCatalogModels(parsedValue.models),
        protocolVersion,
        type,
      };

    case 'installed_models':
      return {
        models: readInstalledModels(parsedValue.models),
        protocolVersion,
        type,
      };

    case 'model_probe_result':
      return {
        available: readBoolean(parsedValue.available, 'event.available'),
        details: readNullableString(parsedValue.details, 'event.details'),
        displayName: readNullableString(parsedValue.displayName, 'event.displayName'),
        engineId: readEngineId(parsedValue.engineId, 'event.engineId'),
        installed: readBoolean(parsedValue.installed, 'event.installed'),
        message: readString(parsedValue.message, 'event.message'),
        modelId: readNullableString(parsedValue.modelId, 'event.modelId'),
        protocolVersion,
        resolvedPath: readNullableString(parsedValue.resolvedPath, 'event.resolvedPath'),
        selection: readSelectedModel(parsedValue.selection, 'event.selection'),
        sizeBytes: readNullableNumber(parsedValue.sizeBytes, 'event.sizeBytes'),
        status: readModelProbeStatus(parsedValue.status, 'event.status'),
        type,
      };

    case 'model_removed':
      return {
        engineId: readEngineId(parsedValue.engineId, 'event.engineId'),
        modelId: readString(parsedValue.modelId, 'event.modelId'),
        protocolVersion,
        removed: readBoolean(parsedValue.removed, 'event.removed'),
        type,
      };

    case 'model_install_update':
      return {
        details: readNullableString(parsedValue.details, 'event.details'),
        downloadedBytes: readNullableNumber(parsedValue.downloadedBytes, 'event.downloadedBytes'),
        engineId: readEngineId(parsedValue.engineId, 'event.engineId'),
        installId: readString(parsedValue.installId, 'event.installId'),
        message: readNullableString(parsedValue.message, 'event.message'),
        modelId: readString(parsedValue.modelId, 'event.modelId'),
        protocolVersion,
        state: readModelInstallState(parsedValue.state, 'event.state'),
        totalBytes: readNullableNumber(parsedValue.totalBytes, 'event.totalBytes'),
        type,
      };

    case 'system_info':
      return {
        compiledBackends: readStringArray(parsedValue.compiledBackends, 'event.compiledBackends'),
        compiledEngines: readStringArray(parsedValue.compiledEngines, 'event.compiledEngines'),
        protocolVersion,
        runtimeCapabilities: readRuntimeCapabilities(parsedValue.runtimeCapabilities),
        systemInfo: readString(parsedValue.systemInfo, 'event.systemInfo'),
        type,
      };

    case 'session_started':
      return {
        mode: readListeningMode(parsedValue.mode, 'event.mode'),
        protocolVersion,
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        type,
      };

    case 'session_state_changed':
      return {
        protocolVersion,
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        state: readSessionState(parsedValue.state, 'event.state'),
        type,
      };

    case 'transcript_ready':
      return {
        processingDurationMs: readNonNegativeNumber(
          parsedValue.processingDurationMs,
          'event.processingDurationMs',
        ),
        protocolVersion,
        segments: readTranscriptSegments(parsedValue.segments),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        text: readString(parsedValue.text, 'event.text'),
        type,
        utteranceDurationMs: readNonNegativeNumber(
          parsedValue.utteranceDurationMs,
          'event.utteranceDurationMs',
        ),
      };

    case 'warning':
      return createWarningEvent(parsedValue, protocolVersion);

    case 'session_stopped':
      return {
        protocolVersion,
        reason: readSessionStopReason(parsedValue.reason, 'event.reason'),
        sessionId: readString(parsedValue.sessionId, 'event.sessionId'),
        type,
      };

    case 'error':
      return createErrorEvent(parsedValue, protocolVersion);

    default:
      throw new Error(`Unsupported sidecar event type: ${type}`);
  }
}

function createEnvelope<TType extends SidecarCommand['type']>(
  type: TType,
): Extract<SidecarCommand, { type: TType }> {
  return {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    type,
  } as Extract<SidecarCommand, { type: TType }>;
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

function readProtocolVersion(value: unknown): typeof SIDECAR_PROTOCOL_VERSION {
  const protocolVersion = readString(value, 'event.protocolVersion');

  if (protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`Unsupported sidecar protocol version: ${protocolVersion}`);
  }

  return protocolVersion;
}

function readReadyStatus(value: unknown): 'ready' {
  const status = readString(value, 'event.status');

  if (status !== 'ready') {
    throw new Error(`Unsupported sidecar status: ${status}`);
  }

  return status;
}

function readListeningMode(value: unknown, fieldName: string): ListeningMode {
  const mode = readString(value, fieldName);

  if (mode === 'always_on' || mode === 'press_and_hold' || mode === 'one_sentence') {
    return mode;
  }

  throw new Error(`Unsupported listening mode: ${mode}`);
}

function readSessionState(value: unknown, fieldName: string): SessionState {
  const state = readString(value, fieldName);

  if (
    state === 'error' ||
    state === 'idle' ||
    state === 'listening' ||
    state === 'paused' ||
    state === 'speech_detected' ||
    state === 'transcribing'
  ) {
    return state;
  }

  throw new Error(`Unsupported session state: ${state}`);
}

function readSessionStopReason(value: unknown, fieldName: string): SessionStopReason {
  const reason = readString(value, fieldName);

  if (
    reason === 'sentence_complete' ||
    reason === 'session_replaced' ||
    reason === 'timeout' ||
    reason === 'user_cancel' ||
    reason === 'user_stop'
  ) {
    return reason;
  }

  throw new Error(`Unsupported session stop reason: ${reason}`);
}

function readEngineId(value: unknown, fieldName: string): EngineId {
  const engineId = readString(value, fieldName);

  if (!isEngineId(engineId)) {
    throw new Error(`Unsupported engine id: ${engineId}`);
  }

  return engineId;
}

function readSelectedModel(value: unknown, fieldName: string): SelectedModel {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  const kind = readString(value.kind, `${fieldName}.kind`);

  if (kind === 'catalog_model') {
    return normalizeSelectedModel({
      engineId: readEngineId(value.engineId, `${fieldName}.engineId`),
      kind,
      modelId: readString(value.modelId, `${fieldName}.modelId`),
    });
  }

  if (kind === 'external_file') {
    return normalizeSelectedModel({
      engineId: readEngineId(value.engineId, `${fieldName}.engineId`),
      filePath: readString(value.filePath, `${fieldName}.filePath`),
      kind,
    });
  }

  throw new Error(`Unsupported selected model kind: ${kind}`);
}

function readModelProbeStatus(value: unknown, fieldName: string): ModelProbeResultRecord['status'] {
  const status = readString(value, fieldName);

  if (status === 'invalid' || status === 'missing' || status === 'ready') {
    return status;
  }

  throw new Error(`Unsupported model probe status: ${status}`);
}

function readRuntimeCapabilities(value: unknown): RuntimeCapability[] {
  if (value === undefined) {
    return [];
  }

  return readArray(value, 'event.runtimeCapabilities').map((capability, index) => {
    const record = readRecord(capability, `event.runtimeCapabilities[${index}]`);

    return {
      available: readBoolean(record.available, `event.runtimeCapabilities[${index}].available`),
      backend: readString(record.backend, `event.runtimeCapabilities[${index}].backend`),
      engine: readString(record.engine, `event.runtimeCapabilities[${index}].engine`),
      reason: readNullableString(record.reason, `event.runtimeCapabilities[${index}].reason`),
    };
  });
}

function readModelInstallState(value: unknown, fieldName: string): ModelInstallState {
  const state = readString(value, fieldName);

  if (
    state === 'cancelled' ||
    state === 'completed' ||
    state === 'downloading' ||
    state === 'failed' ||
    state === 'probing' ||
    state === 'queued' ||
    state === 'verifying'
  ) {
    return state;
  }

  throw new Error(`Unsupported model install state: ${state}`);
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
    };
  });
}

function readModelEngines(value: unknown): ModelEngineRecord[] {
  return readArray(value, 'event.engines').map((engine, index) => {
    const record = readRecord(engine, `event.engines[${index}]`);

    return {
      displayName: readString(record.displayName, `event.engines[${index}].displayName`),
      engineId: readEngineId(record.engineId, `event.engines[${index}].engineId`),
      summary: readString(record.summary, `event.engines[${index}].summary`),
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
      capabilityFlags: readStringArray(
        record.capabilityFlags,
        `event.models[${index}].capabilityFlags`,
      ),
      collectionId: readString(record.collectionId, `event.models[${index}].collectionId`),
      displayName: readString(record.displayName, `event.models[${index}].displayName`),
      engineId: readEngineId(record.engineId, `event.models[${index}].engineId`),
      languageTags: readStringArray(record.languageTags, `event.models[${index}].languageTags`),
      licenseLabel: readString(record.licenseLabel, `event.models[${index}].licenseLabel`),
      licenseUrl: readString(record.licenseUrl, `event.models[${index}].licenseUrl`),
      modelCardUrl: readNullableString(record.modelCardUrl, `event.models[${index}].modelCardUrl`),
      modelId: readString(record.modelId, `event.models[${index}].modelId`),
      notes: readStringArray(record.notes, `event.models[${index}].notes`),
      recommended: readBoolean(record.recommended, `event.models[${index}].recommended`),
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
    const role = readString(record.role, `${fieldName}[${index}].role`);

    if (
      role !== 'punctuation_model' &&
      role !== 'supporting_file' &&
      role !== 'transcription_model'
    ) {
      throw new Error(`Unsupported model artifact role: ${role}`);
    }

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
      engineId: readEngineId(record.engineId, `event.models[${index}].engineId`),
      installPath: readString(record.installPath, `event.models[${index}].installPath`),
      installedAtUnixMs: readNonNegativeNumber(
        record.installedAtUnixMs,
        `event.models[${index}].installedAtUnixMs`,
      ),
      modelId: readString(record.modelId, `event.models[${index}].modelId`),
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

function createWarningEvent(
  value: Record<string, unknown>,
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION,
): WarningEvent {
  return {
    code: readString(value.code, 'event.code'),
    ...readOptionalEventFields(value),
    message: readString(value.message, 'event.message'),
    protocolVersion,
    type: 'warning',
  };
}

function createErrorEvent(
  value: Record<string, unknown>,
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION,
): ErrorEvent {
  return {
    code: readString(value.code, 'event.code'),
    ...readOptionalEventFields(value),
    message: readString(value.message, 'event.message'),
    protocolVersion,
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
