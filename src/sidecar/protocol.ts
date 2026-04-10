export const SIDECAR_PROTOCOL_VERSION = 'v1' as const;

export type SidecarRequestType = 'health' | 'transcribe_mock' | 'shutdown';

export type EmptyPayload = Record<string, never>;

export interface TranscribeMockRequestPayload {
  seedText?: string;
}

export interface HealthResponsePayload {
  status: 'ready';
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  sidecarVersion: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeMockResponsePayload {
  text: string;
  segments: TranscriptSegment[];
}

export interface ShutdownResponsePayload {
  acknowledged: boolean;
}

export interface SidecarProtocolError {
  code: string;
  message: string;
  details?: string;
}

export interface RequestPayloadByType {
  health: EmptyPayload;
  transcribe_mock: TranscribeMockRequestPayload;
  shutdown: EmptyPayload;
}

export interface ResponsePayloadByType {
  health: HealthResponsePayload;
  transcribe_mock: TranscribeMockResponsePayload;
  shutdown: ShutdownResponsePayload;
}

export interface SidecarRequest<TType extends SidecarRequestType = SidecarRequestType> {
  id: string;
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  type: TType;
  payload: RequestPayloadByType[TType];
}

export interface SidecarSuccessResponse<TType extends SidecarRequestType = SidecarRequestType> {
  id: string;
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  type: TType;
  ok: true;
  payload: ResponsePayloadByType[TType];
}

export interface SidecarFailureResponse {
  id: string;
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  type: SidecarRequestType;
  ok: false;
  error: SidecarProtocolError;
}

export type SidecarResponse = SidecarSuccessResponse | SidecarFailureResponse;

export function createRequest<TType extends SidecarRequestType>(
  id: string,
  type: TType,
  payload: RequestPayloadByType[TType],
): SidecarRequest<TType> {
  return {
    id,
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    type,
    payload,
  };
}

export function serializeRequest(request: SidecarRequest): string {
  return JSON.stringify(request);
}

export function parseResponseLine(line: string): SidecarResponse {
  const parsedValue: unknown = JSON.parse(line);

  if (!isRecord(parsedValue)) {
    throw new Error('Sidecar response must be a JSON object.');
  }

  const id = readString(parsedValue.id, 'response.id');
  const protocolVersion = readProtocolVersion(parsedValue.protocolVersion);
  const type = readRequestType(parsedValue.type);
  const ok = readBoolean(parsedValue.ok, 'response.ok');

  if (ok) {
    return {
      id,
      protocolVersion,
      type,
      ok: true,
      payload: readSuccessPayload(type, parsedValue.payload),
    };
  }

  return {
    id,
    protocolVersion,
    type,
    ok: false,
    error: readProtocolError(parsedValue.error),
  };
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

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean.`);
  }

  return value;
}

function readNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${fieldName} must be a number.`);
  }

  return value;
}

function readProtocolVersion(value: unknown): typeof SIDECAR_PROTOCOL_VERSION {
  const protocolVersion = readString(value, 'response.protocolVersion');

  if (protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    throw new Error(`Unsupported sidecar protocol version: ${protocolVersion}`);
  }

  return protocolVersion;
}

function readRequestType(value: unknown): SidecarRequestType {
  const type = readString(value, 'response.type');

  if (type === 'health' || type === 'transcribe_mock' || type === 'shutdown') {
    return type;
  }

  throw new Error(`Unsupported sidecar response type: ${type}`);
}

function readSuccessPayload<TType extends SidecarRequestType>(
  type: TType,
  value: unknown,
): ResponsePayloadByType[TType] {
  if (!isRecord(value)) {
    throw new Error('response.payload must be an object.');
  }

  switch (type) {
    case 'health':
      return {
        status: readReadyStatus(value.status),
        protocolVersion: readProtocolVersion(value.protocolVersion),
        sidecarVersion: readString(value.sidecarVersion, 'response.payload.sidecarVersion'),
      } as ResponsePayloadByType[TType];

    case 'transcribe_mock':
      return {
        text: readString(value.text, 'response.payload.text'),
        segments: readTranscriptSegments(value.segments),
      } as ResponsePayloadByType[TType];

    case 'shutdown':
      return {
        acknowledged: readBoolean(value.acknowledged, 'response.payload.acknowledged'),
      } as ResponsePayloadByType[TType];
  }
}

function readReadyStatus(value: unknown): 'ready' {
  const status = readString(value, 'response.payload.status');

  if (status !== 'ready') {
    throw new Error(`Unsupported sidecar status: ${status}`);
  }

  return status;
}

function readTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('response.payload.segments must be an array.');
  }

  return value.map((segment, index) => {
    if (!isRecord(segment)) {
      throw new Error(`response.payload.segments[${index}] must be an object.`);
    }

    return {
      startMs: readNumber(segment.startMs, `response.payload.segments[${index}].startMs`),
      endMs: readNumber(segment.endMs, `response.payload.segments[${index}].endMs`),
      text: readString(segment.text, `response.payload.segments[${index}].text`),
    };
  });
}

function readProtocolError(value: unknown): SidecarProtocolError {
  if (!isRecord(value)) {
    throw new Error('response.error must be an object.');
  }

  const protocolError: SidecarProtocolError = {
    code: readString(value.code, 'response.error.code'),
    message: readString(value.message, 'response.error.message'),
  };

  if (typeof value.details === 'string') {
    protocolError.details = value.details;
  }

  return protocolError;
}
