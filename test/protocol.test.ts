import { describe, expect, it } from 'vitest';

import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';
import {
  AUDIO_FRAME_KIND,
  createGetSystemInfoCommand,
  createHealthCommand,
  createStartSessionCommand,
  encodeAudioFrame,
  encodeJsonFrame,
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

  it('serializes start_session command with useGpu field', () => {
    const command = createStartSessionCommand({
      language: 'en',
      mode: 'always_on',
      modelSelection: { kind: 'external_file', engineId: 'whisper_cpp', filePath: '/tmp/m.bin' },
      pauseWhileProcessing: true,
      sessionId: 'session-gpu',
      useGpu: false,
    });
    const frame = encodeJsonFrame(command);
    const payload = readPayload(frame) as Record<string, unknown>;

    expect(payload.useGpu).toBe(false);
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
        systemInfo: 'AVX = 1 | CUDA = 1',
        type: 'system_info',
      },
      kind: JSON_FRAME_KIND,
    });
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
