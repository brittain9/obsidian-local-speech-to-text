import { describe, expect, it } from 'vitest';

import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';
import {
  AUDIO_FRAME_KIND,
  type ContextWindow,
  createContextResponseCommand,
  createGetSystemInfoCommand,
  createHealthCommand,
  createStartSessionCommand,
  encodeAudioFrame,
  encodeJsonFrame,
  FRAME_HEADER_LENGTH,
  FramedMessageParser,
  JSON_FRAME_KIND,
  parseEventFrame,
} from '../src/sidecar/protocol';

describe('sidecar protocol', () => {
  it('serializes JSON commands with the framed header', () => {
    const frame = encodeJsonFrame(createHealthCommand());

    expect(frame[0]).toBe(JSON_FRAME_KIND);
    expect(readPayload(frame)).toEqual({
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
      modelSelection: {
        familyId: 'whisper',
        filePath: '/tmp/m.bin',
        kind: 'external_file',
        runtimeId: 'whisper_cpp',
      },
      sessionStartUnixMs: 1_700_000_000_000,
      sessionId: 'session-gpu',
      speakingStyle: 'balanced',
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
      type: 'get_system_info',
    });
  });

  it('parses system_info event', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const runtimeCapabilities = {
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu' as const, 'cuda' as const],
      supportedModelFormats: ['ggml' as const],
    };
    const familyCapabilities = {
      maxAudioDurationSecs: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'all' as const },
      supportsInitialPrompt: true,
      supportsLanguageSelection: true,
      supportsSegmentTimestamps: true,
      supportsWordTimestamps: false,
    };
    const compiledRuntime = {
      displayName: 'whisper.cpp',
      runtimeCapabilities,
      runtimeId: 'whisper_cpp' as const,
    };
    const compiledAdapter = {
      displayName: 'Whisper',
      familyCapabilities,
      familyId: 'whisper' as const,
      runtimeId: 'whisper_cpp' as const,
    };
    const frame = encodeJsonFrame({
      compiledAdapters: [compiledAdapter],
      compiledRuntimes: [compiledRuntime],
      sidecarVersion: '0.0.0-test',
      systemInfo: 'AVX = 1 | CUDA = 1',
      type: 'system_info',
    });
    const parsed = parser.pushChunk(frame);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      envelope: {
        compiledAdapters: [compiledAdapter],
        compiledRuntimes: [compiledRuntime],
        sidecarVersion: '0.0.0-test',
        systemInfo: 'AVX = 1 | CUDA = 1',
        type: 'system_info',
      },
      kind: JSON_FRAME_KIND,
    });
  });

  it('parses model_probe_result event carrying merged capabilities', () => {
    const mergedCapabilities = {
      family: {
        maxAudioDurationSecs: null,
        producesPunctuation: true,
        supportedLanguages: { kind: 'english_only' as const },
        supportsInitialPrompt: true,
        supportsLanguageSelection: false,
        supportsSegmentTimestamps: true,
        supportsWordTimestamps: false,
      },
      familyId: 'whisper' as const,
      runtime: {
        acceleratorDetails: {
          cpu: { available: true, unavailableReason: null },
        },
        availableAccelerators: ['cpu' as const],
        supportedModelFormats: ['ggml' as const],
      },
      runtimeId: 'whisper_cpp' as const,
    };
    const payload = {
      available: true,
      details: null,
      displayName: 'Whisper Small',
      familyId: 'whisper' as const,
      installed: true,
      mergedCapabilities,
      message: 'Model selection is ready.',
      modelId: 'small',
      resolvedPath: '/models/whisper-small.bin',
      runtimeId: 'whisper_cpp' as const,
      selection: {
        familyId: 'whisper' as const,
        kind: 'catalog_model' as const,
        modelId: 'small',
        runtimeId: 'whisper_cpp' as const,
      },
      sizeBytes: 100,
      status: 'ready' as const,
      type: 'model_probe_result' as const,
    };
    const event = parseEventFrame(JSON.stringify(payload));

    expect(event).toEqual(payload);
  });

  it('parses model_probe_result event when merged capabilities are absent', () => {
    const payload = {
      available: false,
      details: 'not installed',
      displayName: null,
      familyId: 'whisper' as const,
      installed: false,
      message: 'The selected managed model is not installed or is incomplete.',
      modelId: 'small',
      resolvedPath: null,
      runtimeId: 'whisper_cpp' as const,
      selection: {
        familyId: 'whisper' as const,
        kind: 'catalog_model' as const,
        modelId: 'small',
        runtimeId: 'whisper_cpp' as const,
      },
      sizeBytes: null,
      status: 'missing' as const,
      type: 'model_probe_result' as const,
    };
    const event = parseEventFrame(JSON.stringify(payload));

    expect(event).toEqual({ ...payload, mergedCapabilities: null });
  });

  it('rejects non-object JSON in parseEventFrame', () => {
    expect(() => parseEventFrame('"hello"')).toThrow('Sidecar event must be a JSON object.');
    expect(() => parseEventFrame('42')).toThrow('Sidecar event must be a JSON object.');
  });

  it('rejects missing type field in parseEventFrame', () => {
    expect(() => parseEventFrame(JSON.stringify({}))).toThrow('event.type must be a string.');
  });

  it('rejects unknown event type in parseEventFrame', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          type: 'nonexistent_event',
        }),
      ),
    ).toThrow('Unsupported sidecar event type: nonexistent_event');
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
          isFinal: true,
          pauseMsBeforeUtterance: null,
          processingDurationMs: 100,
          revision: 0,
          segments: [],
          stageResults: [],
          text: 'hello',
          type: 'transcript_ready',
          utteranceDurationMs: 500,
          utteranceEndMsInSession: 900,
          utteranceIndex: 0,
          utteranceStartMsInSession: 0,
          utteranceId: 'utt-1',
          warnings: [],
        }),
      ),
    ).toThrow('event.sessionId must be a string.');
  });

  it('rejects transcript_ready with missing utteranceId', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          isFinal: true,
          pauseMsBeforeUtterance: null,
          processingDurationMs: 100,
          revision: 0,
          segments: [],
          sessionId: 'session-1',
          stageResults: [],
          text: 'hello',
          type: 'transcript_ready',
          utteranceDurationMs: 500,
          utteranceEndMsInSession: 500,
          utteranceIndex: 0,
          utteranceStartMsInSession: 0,
          warnings: [],
        }),
      ),
    ).toThrow('event.utteranceId must be a string.');
  });

  it('parses transcript_ready with pauseMsBeforeUtterance set to a number', () => {
    const event = parseEventFrame(
      JSON.stringify({
        isFinal: true,
        pauseMsBeforeUtterance: 320,
        processingDurationMs: 100,
        revision: 0,
        segments: [],
        sessionId: 'session-1',
        stageResults: [],
        text: 'hello',
        type: 'transcript_ready',
        utteranceDurationMs: 500,
        utteranceEndMsInSession: 500,
        utteranceIndex: 0,
        utteranceStartMsInSession: 0,
        utteranceId: 'utt-1',
        warnings: [],
      }),
    );

    expect(event.type).toBe('transcript_ready');
    if (event.type === 'transcript_ready') {
      expect(event.pauseMsBeforeUtterance).toBe(320);
    }
  });

  it('parses transcript_ready with pauseMsBeforeUtterance explicitly null', () => {
    const event = parseEventFrame(
      JSON.stringify({
        isFinal: true,
        pauseMsBeforeUtterance: null,
        processingDurationMs: 100,
        revision: 0,
        segments: [],
        sessionId: 'session-1',
        stageResults: [],
        text: 'hello',
        type: 'transcript_ready',
        utteranceDurationMs: 500,
        utteranceEndMsInSession: 500,
        utteranceIndex: 0,
        utteranceStartMsInSession: 0,
        utteranceId: 'utt-1',
        warnings: [],
      }),
    );

    expect(event.type).toBe('transcript_ready');
    if (event.type === 'transcript_ready') {
      expect(event.pauseMsBeforeUtterance).toBeNull();
    }
  });

  it('parses transcription_queue_changed event for each known tier', () => {
    for (const tier of ['normal', 'catching_up', 'falling_behind', 'saturated'] as const) {
      const event = parseEventFrame(
        JSON.stringify({
          queuedUtterances: 7,
          sessionId: 'session-1',
          tier,
          type: 'transcription_queue_changed',
        }),
      );

      expect(event).toEqual({
        queuedUtterances: 7,
        sessionId: 'session-1',
        tier,
        type: 'transcription_queue_changed',
      });
    }
  });

  it('rejects transcription_queue_changed with an unknown tier', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          queuedUtterances: 7,
          sessionId: 'session-1',
          tier: 'overheating',
          type: 'transcription_queue_changed',
        }),
      ),
    ).toThrow(/event\.tier must be one of/);
  });

  it('parses session_stopped with the queue_overload reason', () => {
    const event = parseEventFrame(
      JSON.stringify({
        reason: 'queue_overload',
        sessionId: 'session-1',
        type: 'session_stopped',
      }),
    );

    expect(event).toEqual({
      reason: 'queue_overload',
      sessionId: 'session-1',
      type: 'session_stopped',
    });
  });

  it('parses transcript_ready with stage history', () => {
    const event = parseEventFrame(
      JSON.stringify({
        isFinal: true,
        pauseMsBeforeUtterance: 250,
        processingDurationMs: 125,
        revision: 0,
        segments: [],
        sessionId: 'session-1',
        stageResults: [
          {
            durationMs: 100,
            isFinal: true,
            payload: {
              voiceActivity: {
                audioEndMs: 1100,
                audioStartMs: 100,
                maxProbability: 0.98,
                meanProbability: 0.72,
                speechEndMs: 980,
                speechStartMs: 180,
                unvoicedMs: 200,
                voicedMs: 800,
              },
            },
            revisionIn: 0,
            revisionOut: 0,
            stageId: 'engine',
            status: { kind: 'ok' },
          },
          {
            durationMs: 0,
            isFinal: true,
            revisionIn: 0,
            stageId: 'punctuation',
            status: { kind: 'skipped', reason: 'no_action' },
          },
        ],
        text: 'hello world',
        type: 'transcript_ready',
        utteranceDurationMs: 900,
        utteranceEndMsInSession: 900,
        utteranceIndex: 0,
        utteranceStartMsInSession: 0,
        utteranceId: 'utt-1',
        warnings: [],
      }),
    );

    expect(event).toEqual({
      isFinal: true,
      pauseMsBeforeUtterance: 250,
      processingDurationMs: 125,
      revision: 0,
      segments: [],
      sessionId: 'session-1',
      stageResults: [
        {
          durationMs: 100,
          isFinal: true,
          payload: {
            voiceActivity: {
              audioEndMs: 1100,
              audioStartMs: 100,
              maxProbability: 0.98,
              meanProbability: 0.72,
              speechEndMs: 980,
              speechStartMs: 180,
              unvoicedMs: 200,
              voicedMs: 800,
            },
          },
          revisionIn: 0,
          revisionOut: 0,
          stageId: 'engine',
          status: { kind: 'ok' },
        },
        {
          durationMs: 0,
          isFinal: true,
          revisionIn: 0,
          stageId: 'punctuation',
          status: { kind: 'skipped', reason: 'no_action' },
        },
      ],
      text: 'hello world',
      type: 'transcript_ready',
      utteranceDurationMs: 900,
      utteranceEndMsInSession: 900,
      utteranceIndex: 0,
      utteranceStartMsInSession: 0,
      utteranceId: 'utt-1',
      warnings: [],
    });
  });

  it('parses context_request event', () => {
    const event = parseEventFrame(
      JSON.stringify({
        budgetChars: 1024,
        correlationId: 'corr-1',
        sessionId: 'session-1',
        type: 'context_request',
        utteranceId: 'utt-1',
      }),
    );

    expect(event).toEqual({
      budgetChars: 1024,
      correlationId: 'corr-1',
      sessionId: 'session-1',
      type: 'context_request',
      utteranceId: 'utt-1',
    });
  });

  it('serializes context_response with a context window', () => {
    const context: ContextWindow = {
      budgetChars: 512,
      sources: [
        {
          endRevision: 0,
          kind: 'session_utterance',
          text: 'hello',
          truncated: false,
          utteranceId: 'utt-prior',
        },
      ],
      text: 'hello',
      truncated: false,
    };

    const command = createContextResponseCommand('corr-1', context);
    const frame = encodeJsonFrame(command);
    const payload = readPayload(frame) as Record<string, unknown>;

    expect(payload).toEqual({
      context,
      correlationId: 'corr-1',
      type: 'context_response',
    });
  });

  it('serializes context_response with a null context', () => {
    const frame = encodeJsonFrame(createContextResponseCommand('corr-1', null));

    expect(readPayload(frame)).toEqual({
      context: null,
      correlationId: 'corr-1',
      type: 'context_response',
    });
  });

  it('parses mixed JSON and binary frames across chunk boundaries', () => {
    const parser = new FramedMessageParser(parseEventFrame);
    const transcriptFrame = encodeJsonFrame({
      isFinal: true,
      pauseMsBeforeUtterance: null,
      processingDurationMs: 125,
      revision: 0,
      segments: [],
      sessionId: 'session-1',
      stageResults: [],
      text: 'hello world',
      type: 'transcript_ready',
      utteranceDurationMs: 900,
      utteranceEndMsInSession: 900,
      utteranceIndex: 0,
      utteranceStartMsInSession: 0,
      utteranceId: 'utt-1',
      warnings: [],
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
        isFinal: true,
        pauseMsBeforeUtterance: null,
        processingDurationMs: 125,
        revision: 0,
        segments: [],
        sessionId: 'session-1',
        stageResults: [],
        text: 'hello world',
        type: 'transcript_ready',
        utteranceDurationMs: 900,
        utteranceEndMsInSession: 900,
        utteranceIndex: 0,
        utteranceStartMsInSession: 0,
        utteranceId: 'utt-1',
        warnings: [],
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
