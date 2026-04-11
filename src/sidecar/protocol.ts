import { PCM_BYTES_PER_FRAME } from '../shared/pcm-format';

export const SIDECAR_PROTOCOL_VERSION = 'v2' as const;

export const JSON_FRAME_KIND = 0x01;
export const AUDIO_FRAME_KIND = 0x02;
export const FRAME_HEADER_LENGTH = 5;

export type ListeningMode = 'always_on' | 'press_and_hold' | 'one_sentence';
export type SessionState =
  | 'idle'
  | 'listening'
  | 'speech_detected'
  | 'transcribing'
  | 'paused'
  | 'error';

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
  language: 'en';
  mode: ListeningMode;
  modelFilePath: string;
  pauseWhileProcessing: boolean;
  sessionId: string;
}

export interface SetGateCommand extends EnvelopeBase<'set_gate'> {
  open: boolean;
}

export interface StopSessionCommand extends EnvelopeBase<'stop_session'> {}

export interface CancelSessionCommand extends EnvelopeBase<'cancel_session'> {}

export interface ShutdownCommand extends EnvelopeBase<'shutdown'> {}

export type SidecarCommand =
  | HealthCommand
  | StartSessionCommand
  | SetGateCommand
  | StopSessionCommand
  | CancelSessionCommand
  | ShutdownCommand;

export interface HealthOkEvent extends EnvelopeBase<'health_ok'> {
  sidecarVersion: string;
  status: 'ready';
}

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
  | SessionStartedEvent
  | SessionStateChangedEvent
  | SessionStoppedEvent
  | TranscriptReadyEvent
  | WarningEvent;

export function createHealthCommand(): HealthCommand {
  return createEnvelope('health');
}

export function createStartSessionCommand(
  payload: Omit<StartSessionCommand, 'protocolVersion' | 'type'>,
): StartSessionCommand {
  return {
    ...createEnvelope('start_session'),
    ...payload,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function readNonNegativeNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
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
    state === 'idle' ||
    state === 'listening' ||
    state === 'speech_detected' ||
    state === 'transcribing' ||
    state === 'paused' ||
    state === 'error'
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createWarningEvent(
  value: Record<string, unknown>,
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION,
): WarningEvent {
  const event: WarningEvent = {
    code: readString(value.code, 'event.code'),
    message: readString(value.message, 'event.message'),
    protocolVersion,
    type: 'warning',
  };
  const details = readOptionalString(value.details, 'event.details');
  const sessionId = readOptionalString(value.sessionId, 'event.sessionId');

  if (details !== undefined) {
    event.details = details;
  }

  if (sessionId !== undefined) {
    event.sessionId = sessionId;
  }

  return event;
}

function createErrorEvent(
  value: Record<string, unknown>,
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION,
): ErrorEvent {
  const event: ErrorEvent = {
    code: readString(value.code, 'event.code'),
    message: readString(value.message, 'event.message'),
    protocolVersion,
    type: 'error',
  };
  const details = readOptionalString(value.details, 'event.details');
  const sessionId = readOptionalString(value.sessionId, 'event.sessionId');

  if (details !== undefined) {
    event.details = details;
  }

  if (sessionId !== undefined) {
    event.sessionId = sessionId;
  }

  return event;
}
