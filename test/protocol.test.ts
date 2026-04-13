import { describe, expect, it } from 'vitest';

import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';
import {
  AUDIO_FRAME_KIND,
  createGetSystemInfoCommand,
  createHealthCommand,
  createStartSessionCommand,
  encodeAudioFrame,
  encodeJsonFrame,
  FRAME_HEADER_LENGTH,
  FramedMessageParser,
  JSON_FRAME_KIND,
  parseEventFrame,
  SIDECAR_PROTOCOL_VERSION,
} from '../src/sidecar/protocol';

describe('sidecar protocol', () => {
  it('serializes JSON commands with the framed header', () => {
    const frame = encodeJsonFrame(createHealthCommand());

    expect(frame[0]).toBe(JSON_FRAME_KIND);
    expect(readPayload(frame)).toEqual({
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      type: 'health',
    });
  });

  it('serializes audio frames with the expected byte size', () => {
    const payload = new Uint8Array(PCM_BYTES_PER_FRAME).fill(7);
    const frame = encodeAudioFrame(payload);

    expect(frame[0]).toBe(AUDIO_FRAME_KIND);
    expect(frame.byteLength).toBe(5 + PCM_BYTES_PER_FRAME);
  });

  it('serializes start_session command with accelerationPreference', () => {
    const command = createStartSessionCommand({
      accelerationPreference: 'auto',
      language: 'en',
      mode: 'always_on',
      modelSelection: { kind: 'external_file', engineId: 'whisper_cpp', filePath: '/tmp/m.bin' },
      pauseWhileProcessing: true,
      sessionId: 'session-gpu',
    });
    const frame = encodeJsonFrame(command);
    const payload = readPayload(frame) as Record<string, unknown>;

    expect(payload.accelerationPreference).toBe('auto');
    expect(payload).not.toHaveProperty('useGpu');
    expect(payload.sessionId).toBe('session-gpu');
  });

  it('serializes get_system_info command', () => {
    const frame = encodeJsonFrame(createGetSystemInfoCommand());

    expect(readPayload(frame)).toEqual({
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      type: 'get_system_info',
    });
  });

  it('parses system_info event', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const frame = encodeJsonFrame({
      compiledBackends: ['cpu', 'cuda'],
      compiledEngines: ['whisper_cpp', 'cohere_onnx'],
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      runtimeCapabilities: [
        {
          available: true,
          backend: 'cuda',
          engine: 'whisper_cpp',
          reason: null,
        },
      ],
      systemInfo: 'AVX = 1 | CUDA = 1',
      type: 'system_info',
    });
    const parsed = parser.pushChunk(frame);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      envelope: {
        compiledBackends: ['cpu', 'cuda'],
        compiledEngines: ['whisper_cpp', 'cohere_onnx'],
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        runtimeCapabilities: [
          {
            available: true,
            backend: 'cuda',
            engine: 'whisper_cpp',
            reason: null,
          },
        ],
        systemInfo: 'AVX = 1 | CUDA = 1',
        type: 'system_info',
      },
      kind: JSON_FRAME_KIND,
    });
  });

  it('defaults missing runtimeCapabilities to an empty list for backward compatibility', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const frame = encodeRawJsonFrame({
      compiledBackends: ['cpu', 'cuda'],
      compiledEngines: ['whisper_cpp'],
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      systemInfo: 'AVX = 1 | CUDA = 1',
      type: 'system_info',
    });
    const parsed = parser.pushChunk(frame);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      envelope: {
        compiledBackends: ['cpu', 'cuda'],
        compiledEngines: ['whisper_cpp'],
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        runtimeCapabilities: [],
        systemInfo: 'AVX = 1 | CUDA = 1',
        type: 'system_info',
      },
      kind: JSON_FRAME_KIND,
    });
  });

  it('rejects non-object JSON in parseEventFrame', () => {
    expect(() => parseEventFrame('"hello"')).toThrow('Sidecar event must be a JSON object.');
    expect(() => parseEventFrame('42')).toThrow('Sidecar event must be a JSON object.');
  });

  it('rejects missing type field in parseEventFrame', () => {
    expect(() =>
      parseEventFrame(JSON.stringify({ protocolVersion: SIDECAR_PROTOCOL_VERSION })),
    ).toThrow('event.type must be a string.');
  });

  it('rejects unknown event type in parseEventFrame', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          type: 'nonexistent_event',
        }),
      ),
    ).toThrow('Unsupported sidecar event type: nonexistent_event');
  });

  it('rejects wrong protocol version in parseEventFrame', () => {
    expect(() =>
      parseEventFrame(JSON.stringify({ protocolVersion: 'v999', type: 'health_ok' })),
    ).toThrow('Unsupported sidecar protocol version: v999');
  });

  it('rejects unknown frame kind byte in FramedMessageParser.pushChunk', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const payload = new Uint8Array(4);
    const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.byteLength);
    const view = new DataView(frame.buffer);

    frame[0] = 0xff;
    view.setUint32(1, payload.byteLength, true);
    frame.set(payload, FRAME_HEADER_LENGTH);

    expect(() => parser.pushChunk(frame)).toThrow('Unsupported sidecar frame kind: 255');
  });

  it('rejects wrong-size payload in encodeAudioFrame', () => {
    expect(() => encodeAudioFrame(new Uint8Array(1))).toThrow(
      `Audio frames must be ${PCM_BYTES_PER_FRAME} bytes, received 1.`,
    );
  });

  it('rejects transcript_ready with missing sessionId', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          processingDurationMs: 100,
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          segments: [],
          text: 'hello',
          type: 'transcript_ready',
          utteranceDurationMs: 500,
        }),
      ),
    ).toThrow('event.sessionId must be a string.');
  });

  it('parses mixed JSON and binary frames across chunk boundaries', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const transcriptFrame = encodeJsonFrame({
      processingDurationMs: 125,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      segments: [],
      sessionId: 'session-1',
      text: 'hello world',
      type: 'transcript_ready',
      utteranceDurationMs: 900,
    });
    const audioFrame = encodeAudioFrame(new Uint8Array(PCM_BYTES_PER_FRAME).fill(3));
    const combined = new Uint8Array(transcriptFrame.byteLength + audioFrame.byteLength);

    combined.set(transcriptFrame, 0);
    combined.set(audioFrame, transcriptFrame.byteLength);

    const frames = [
      ...parser.pushChunk(combined.slice(0, 17)),
      ...parser.pushChunk(combined.slice(17)),
    ];

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      envelope: {
        processingDurationMs: 125,
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        segments: [],
        sessionId: 'session-1',
        text: 'hello world',
        type: 'transcript_ready',
        utteranceDurationMs: 900,
      },
      kind: JSON_FRAME_KIND,
    });
    expect(frames[1]?.kind).toBe(AUDIO_FRAME_KIND);
  });
});

function readPayload(frame: Uint8Array): unknown {
  const payloadLength = new DataView(frame.buffer).getUint32(1, true);
  const payloadBytes = frame.slice(5, 5 + payloadLength);

  return JSON.parse(new TextDecoder().decode(payloadBytes));
}

function encodeRawJsonFrame(payload: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(5 + payloadBytes.byteLength);
  const view = new DataView(frame.buffer);

  frame[0] = JSON_FRAME_KIND;
  view.setUint32(1, payloadBytes.byteLength, true);
  frame.set(payloadBytes, 5);

  return frame;
}
