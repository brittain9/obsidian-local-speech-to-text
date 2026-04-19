import { describe, expect, it, vi } from 'vitest';
import { DictationSessionController } from '../src/dictation/dictation-session-controller';
import type { DictationAnchorMode } from '../src/editor/dictation-anchor-extension';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type DictationAnchor,
  type PhraseSeparator,
  type PluginSettings,
} from '../src/settings/plugin-settings';
import type { SessionState, SidecarEvent, StartSessionCommand } from '../src/sidecar/protocol';

class FakeEditorService {
  public readonly beginCalls: Array<DictationAnchor> = [];
  public readonly modeCalls: Array<DictationAnchorMode> = [];
  public readonly phraseCalls: Array<{ text: string; separator: PhraseSeparator }> = [];
  public endCalls = 0;
  public assertActiveEditorAvailable = vi.fn(() => {});

  beginAnchor(anchor: DictationAnchor): void {
    this.beginCalls.push(anchor);
  }

  setAnchorMode(mode: DictationAnchorMode): void {
    this.modeCalls.push(mode);
  }

  insertPhrase(text: string, separator: PhraseSeparator): void {
    this.phraseCalls.push({ text, separator });
  }

  endAnchor(): void {
    this.endCalls += 1;
  }
}

class FakeCaptureStream {
  public capturing = false;
  public frameListener: ((frameBytes: Uint8Array) => void) | null = null;
  public start = vi.fn(async (listener: (frameBytes: Uint8Array) => void) => {
    this.capturing = true;
    this.frameListener = listener;
  });
  public stop = vi.fn(async () => {
    this.capturing = false;
    this.frameListener = null;
  });

  isCapturing(): boolean {
    return this.capturing;
  }
}

class FakeSidecarConnection {
  public cancelSession = vi.fn(async (sessionId: string) => {
    this.emit({
      reason: 'user_cancel',
      sessionId,
      type: 'session_stopped',
    });
    return {
      reason: 'user_cancel',
      sessionId,
      type: 'session_stopped',
    } as const;
  });
  public listeners = new Set<(event: SidecarEvent) => void>();
  public lastSessionId: string | null = null;
  public sendAudioFrame = vi.fn(() => {});
  public startSession = vi.fn(async (payload: Omit<StartSessionCommand, 'type'>) => {
    this.lastSessionId = payload.sessionId;
    this.emit({
      mode: payload.mode,
      sessionId: payload.sessionId,
      type: 'session_started',
    });
    this.emit({
      sessionId: payload.sessionId,
      state: 'listening',
      type: 'session_state_changed',
    });

    return {
      mode: payload.mode,
      sessionId: payload.sessionId,
      type: 'session_started',
    } as const;
  });
  public stopSession = vi.fn(async (sessionId: string) => {
    this.emit({
      reason: 'user_stop',
      sessionId,
      type: 'session_stopped',
    });
    return {
      reason: 'user_stop',
      sessionId,
      type: 'session_stopped',
    } as const;
  });
  public subscribe = vi.fn((listener: (event: SidecarEvent) => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  });

  emit(event: SidecarEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe('DictationSessionController', () => {
  it('starts a session and begins capture', async () => {
    const captureStream = new FakeCaptureStream();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(captureStream.start).toHaveBeenCalledTimes(1);
    expect(sidecarConnection.startSession).toHaveBeenCalledTimes(1);
    expect(sidecarConnection.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accelerationPreference: 'auto',
      }),
    );
    expect(sidecarConnection.startSession.mock.calls[0]?.[0]).not.toHaveProperty('useGpu');
    expect(controller.getState()).toBe('listening');
  });

  it('forces CPU when accelerationPreference is cpu_only', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      getSettings: () =>
        createSettings({
          accelerationPreference: 'cpu_only',
          selectedModel: createExternalModelSelection(),
        }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(sidecarConnection.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accelerationPreference: 'cpu_only',
      }),
    );
    expect(sidecarConnection.startSession.mock.calls[0]?.[0]).not.toHaveProperty('useGpu');
  });

  it('recovers from capture startup failures without staying busy', async () => {
    const captureStream = new FakeCaptureStream();
    const sidecarConnection = new FakeSidecarConnection();
    captureStream.start.mockImplementationOnce(async () => {
      throw new Error('Microphone denied.');
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
  });

  it('recovers from sidecar start failures without staying busy', async () => {
    const captureStream = new FakeCaptureStream();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSession.mockImplementationOnce(async () => {
      throw new Error('Sidecar refused session.');
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(captureStream.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
  });

  it('handles startup error events through the rejected startSession call only once', async () => {
    const captureStream = new FakeCaptureStream();
    const notice = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSession.mockImplementationOnce(async (payload) => {
      sidecarConnection.emit({
        code: 'vad_init_failed',
        details: 'Failed to initialize the bundled Silero VAD.',
        message: 'Failed to initialize the bundled Silero VAD.',
        type: 'error',
      });
      throw new Error(`Failed to initialize start session ${payload.sessionId}.`);
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      sidecarConnection,
    });

    await controller.startDictation();

    expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
    expect(captureStream.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toContain('Failed to start the dictation session');
  });

  it('begins the editor anchor on session_started and passes the configured preference', async () => {
    const editorService = new FakeEditorService();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      editorService,
      getSettings: () =>
        createSettings({
          dictationAnchor: 'end_of_note',
          selectedModel: createExternalModelSelection(),
        }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(editorService.beginCalls).toEqual(['end_of_note']);
  });

  it('keeps the speaking indicator hidden during short utterances', async () => {
    const editorService = new FakeEditorService();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      editorService,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    const states: SessionState[] = [
      'speech_detected',
      'speech_paused',
      'transcribing',
      'listening',
      'paused',
      'idle',
      'error',
    ];
    for (const state of states) {
      sidecarConnection.emit({ sessionId, state, type: 'session_state_changed' });
    }

    // First 'hidden' is from the initial 'listening' emit in startSession.
    // Then speech_detected → hidden (timer starts), speech_paused → no-op (still in speech),
    // transcribing → processing (timer cleared), then hidden for each non-speech state.
    expect(editorService.modeCalls).toEqual([
      'hidden',
      'hidden',
      'processing',
      'hidden',
      'hidden',
      'hidden',
      'hidden',
    ]);
    expect(editorService.modeCalls).not.toContain('speaking');
  });

  it('surfaces the speaking indicator after the threshold of sustained speech', async () => {
    vi.useFakeTimers();
    try {
      const editorService = new FakeEditorService();
      const sidecarConnection = new FakeSidecarConnection();
      const controller = createController({
        editorService,
        getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
        sidecarConnection,
      });

      await controller.startDictation();
      const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

      sidecarConnection.emit({
        sessionId,
        state: 'speech_detected',
        type: 'session_state_changed',
      });
      expect(editorService.modeCalls.at(-1)).toBe('hidden');

      vi.advanceTimersByTime(2499);
      expect(editorService.modeCalls).not.toContain('speaking');

      vi.advanceTimersByTime(1);
      expect(editorService.modeCalls.at(-1)).toBe('speaking');

      void controller;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the speaking timer when the session leaves speech before the threshold', async () => {
    vi.useFakeTimers();
    try {
      const editorService = new FakeEditorService();
      const sidecarConnection = new FakeSidecarConnection();
      const controller = createController({
        editorService,
        getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
        sidecarConnection,
      });

      await controller.startDictation();
      const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

      sidecarConnection.emit({
        sessionId,
        state: 'speech_detected',
        type: 'session_state_changed',
      });
      vi.advanceTimersByTime(1000);
      sidecarConnection.emit({ sessionId, state: 'transcribing', type: 'session_state_changed' });
      vi.advanceTimersByTime(5000);

      expect(editorService.modeCalls).not.toContain('speaking');

      void controller;
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts transcript phrases using the current phrase separator', async () => {
    const editorService = new FakeEditorService();
    const sidecarConnection = new FakeSidecarConnection();
    let settings = createSettings({ selectedModel: createExternalModelSelection() });
    const controller = createController({
      editorService,
      getSettings: () => settings,
      sidecarConnection,
    });

    await controller.startDictation();
    settings = {
      ...settings,
      phraseSeparator: 'new_paragraph',
    };

    sidecarConnection.emit({
      processingDurationMs: 75,
      segments: [],
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      text: 'hello obsidian',
      type: 'transcript_ready',
      utteranceDurationMs: 700,
      warnings: [],
    });

    expect(editorService.phraseCalls).toEqual([
      { text: 'hello obsidian', separator: 'new_paragraph' },
    ]);
  });

  it('silently discards an empty transcript and continues the session', async () => {
    const notice = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      sidecarConnection,
    });

    await controller.startDictation();

    sidecarConnection.emit({
      processingDurationMs: 75,
      segments: [],
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      text: '   ',
      type: 'transcript_ready',
      utteranceDurationMs: 700,
      warnings: [],
    });

    await vi.waitFor(() => {
      expect(notice).not.toHaveBeenCalled();
      expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
      expect(controller.getState()).not.toBe('error');
    });
  });

  it('ends the editor anchor when the session stops regardless of reason', async () => {
    const editorService = new FakeEditorService();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      editorService,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    sidecarConnection.emit({
      reason: 'timeout',
      sessionId,
      type: 'session_stopped',
    });

    expect(editorService.endCalls).toBe(1);
  });

  it('stops local capture even when stopSession fails', async () => {
    const captureStream = new FakeCaptureStream();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.stopSession.mockImplementationOnce(async () => {
      throw new Error('stop failed');
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    await controller.stopDictation();

    expect(captureStream.stop).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
  });

  it('persists error state after cancel cleanup fails until ribbon click acknowledges', async () => {
    const captureStream = new FakeCaptureStream();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementationOnce(async () => {
      throw new Error('cancel failed');
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    sidecarConnection.emit({
      code: 'session_failed',
      message: 'The engine crashed.',
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      type: 'error',
    });

    await vi.waitFor(() => {
      expect(captureStream.stop).toHaveBeenCalledTimes(1);
      expect(controller.getState()).toBe('error');
      expect(controller.isBusy()).toBe(false);
    });

    controller.handleRibbonClick();
    expect(controller.getState()).toBe('idle');
  });

  it('cancels an errored session only once when duplicate errors arrive', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    let resolveCancel: () => void = () => {
      throw new Error('Expected cancel resolver to be captured.');
    };
    sidecarConnection.cancelSession.mockImplementationOnce(
      async (sessionId: string) =>
        await new Promise((resolve) => {
          resolveCancel = () => {
            sidecarConnection.emit({
              reason: 'user_cancel',
              sessionId,
              type: 'session_stopped',
            });
            resolve({
              reason: 'user_cancel',
              sessionId,
              type: 'session_stopped',
            });
          };
        }),
    );
    const controller = createController({
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';
    sidecarConnection.emit({
      code: 'session_failed',
      message: 'The engine crashed.',

      sessionId,
      type: 'error',
    });
    sidecarConnection.emit({
      code: 'session_failed',
      message: 'The engine crashed again.',
      sessionId,
      type: 'error',
    });

    await vi.waitFor(() => {
      expect(sidecarConnection.cancelSession).toHaveBeenCalledTimes(1);
    });

    resolveCancel();

    await vi.waitFor(() => {
      expect(controller.getState()).toBe('idle');
    });
  });
});

function createController(overrides: {
  captureStream?: FakeCaptureStream;
  editorService?: FakeEditorService;
  getSettings?: () => PluginSettings;
  notice?: ReturnType<typeof vi.fn>;
  sidecarConnection?: FakeSidecarConnection;
}): DictationSessionController {
  return new DictationSessionController({
    captureStream: overrides.captureStream ?? new FakeCaptureStream(),
    editorService: overrides.editorService ?? new FakeEditorService(),
    getSettings: overrides.getSettings ?? (() => createSettings({})),
    notice: overrides.notice ?? (() => {}),
    setRibbonState: () => {},
    sidecarConnection: overrides.sidecarConnection ?? new FakeSidecarConnection(),
  });
}

function createSettings(overrides: Partial<PluginSettings>): PluginSettings {
  return {
    ...DEFAULT_PLUGIN_SETTINGS,
    ...overrides,
  };
}

function createExternalModelSelection() {
  return {
    familyId: 'whisper' as const,
    filePath: '/tmp/ggml-small.en-q5_1.bin',
    kind: 'external_file' as const,
    runtimeId: 'whisper_cpp' as const,
  };
}
