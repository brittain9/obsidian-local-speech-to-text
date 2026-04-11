import { describe, expect, it } from 'vitest';

import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';
import {
  AUDIO_FRAME_KIND,
  createHealthCommand,
  encodeAudioFrame,
  encodeJsonFrame,
  FramedMessageParser,
  JSON_FRAME_KIND,
  parseEventFrame,
  SIDECAR_PROTOCOL_VERSION,
} from '../src/sidecar/protocol';

describe('sidecar protocol v2', () => {
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

  it('rejects events with an unexpected protocol version', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          protocolVersion: 'v1',
          sidecarVersion: '0.1.0',
          status: 'ready',
          type: 'health_ok',
        }),
      ),
    ).toThrow('Unsupported sidecar protocol version');
  });
});

function readPayload(frame: Uint8Array): unknown {
  const payloadLength = new DataView(frame.buffer).getUint32(1, true);
  const payloadBytes = frame.slice(5, 5 + payloadLength);

  return JSON.parse(new TextDecoder().decode(payloadBytes));
}
