import type { App, Hotkey } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import { DictationSessionController } from '../src/dictation/dictation-session-controller';
import type { InsertionMode, PluginSettings } from '../src/settings/plugin-settings';
import type { SidecarEvent, StartSessionCommand } from '../src/sidecar/protocol';

class FakeEditorService {
  public insertedTranscripts: Array<{ mode: InsertionMode; text: string }> = [];
  public assertActiveEditorAvailable = vi.fn(() => {});

  insertTranscript(text: string, mode: InsertionMode): void {
    this.insertedTranscripts.push({ mode, text });
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
      protocolVersion: 'v3',
      reason: 'user_cancel',
      sessionId,
      type: 'session_stopped',
    });
    return {
      protocolVersion: 'v3',
      reason: 'user_cancel',
      sessionId,
      type: 'session_stopped',
    } as const;
  });
  public listeners = new Set<(event: SidecarEvent) => void>();
  public lastSessionId: string | null = null;
  public sendAudioFrame = vi.fn(() => {});
  public setGate = vi.fn(async () => {});
  public startSession = vi.fn(
    async (payload: Omit<StartSessionCommand, 'protocolVersion' | 'type'>) => {
      this.lastSessionId = payload.sessionId;
      this.emit({
        mode: payload.mode,
        protocolVersion: 'v3',
        sessionId: payload.sessionId,
        type: 'session_started',
      });
      this.emit({
        protocolVersion: 'v3',
        sessionId: payload.sessionId,
        state: payload.mode === 'press_and_hold' ? 'idle' : 'listening',
        type: 'session_state_changed',
      });

      return {
        mode: payload.mode,
        protocolVersion: 'v3',
        sessionId: payload.sessionId,
        type: 'session_started',
      } as const;
    },
  );
  public stopSession = vi.fn(async (sessionId: string) => {
    this.emit({
      protocolVersion: 'v3',
      reason: 'user_stop',
      sessionId,
      type: 'session_stopped',
    });
    return {
      protocolVersion: 'v3',
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

  it('inserts transcript text from async sidecar events using the current placement mode', async () => {
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
      insertionMode: 'append_as_new_paragraph',
    };

    sidecarConnection.emit({
      processingDurationMs: 75,
      protocolVersion: 'v3',
      segments: [],
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      text: 'hello obsidian',
      type: 'transcript_ready',
      utteranceDurationMs: 700,
    });

    expect(editorService.insertedTranscripts).toEqual([
      {
        mode: 'append_as_new_paragraph',
        text: 'hello obsidian',
      },
    ]);
  });

  it('notifies when a transcript completes with no usable text', async () => {
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
      protocolVersion: 'v3',
      segments: [],
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      text: '   ',
      type: 'transcript_ready',
      utteranceDurationMs: 700,
    });

    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        'Failed to insert the local transcript: Transcription completed but returned no text.',
      );
      expect(sidecarConnection.cancelSession).toHaveBeenCalledTimes(1);
    });
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

  it('returns to idle after cancel cleanup fails for an errored session', async () => {
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
      protocolVersion: 'v3',
      sessionId: sidecarConnection.lastSessionId ?? 'session-1',
      type: 'error',
    });

    await vi.waitFor(() => {
      expect(captureStream.stop).toHaveBeenCalledTimes(1);
      expect(controller.getState()).toBe('idle');
      expect(controller.isBusy()).toBe(false);
    });
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
              protocolVersion: 'v3',
              reason: 'user_cancel',
              sessionId,
              type: 'session_stopped',
            });
            resolve({
              protocolVersion: 'v3',
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
      protocolVersion: 'v3',
      sessionId,
      type: 'error',
    });
    sidecarConnection.emit({
      code: 'session_failed',
      message: 'The engine crashed again.',
      protocolVersion: 'v3',
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

  it('opens and closes the press-and-hold gate on the configured hotkey', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      app: createAppWithHotkeys([{ key: 'K', modifiers: ['Shift'] }]),
      getSettings: () =>
        createSettings({
          listeningMode: 'press_and_hold',
          selectedModel: createExternalModelSelection(),
        }),
      sidecarConnection,
    });

    controller.handleDocumentKeyDown(createKeyboardEvent('K', { shiftKey: true }));
    await vi.waitFor(() => {
      expect(sidecarConnection.startSession).toHaveBeenCalledTimes(1);
      expect(sidecarConnection.setGate).toHaveBeenCalledWith(true);
    });

    controller.handleDocumentKeyUp(createKeyboardEvent('K', { shiftKey: true }));
    await vi.waitFor(() => {
      expect(sidecarConnection.setGate).toHaveBeenCalledWith(false);
    });
  });

  it('clears ribbon click suppression during local cleanup', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSession.mockImplementation(async () => {
      throw new Error('session start failed');
    });
    const controller = createController({
      getSettings: () =>
        createSettings({
          listeningMode: 'press_and_hold',
          selectedModel: createExternalModelSelection(),
        }),
      sidecarConnection,
    });

    controller.handleRibbonPointerDown();
    await vi.waitFor(() => {
      expect(sidecarConnection.startSession).toHaveBeenCalledTimes(1);
    });

    controller.handleRibbonClick();
    await vi.waitFor(() => {
      expect(sidecarConnection.startSession).toHaveBeenCalledTimes(2);
    });
  });
});

function createAppWithHotkeys(hotkeys: Hotkey[]): App {
  return {
    hotkeyManager: {
      getHotkeys: () => hotkeys,
    },
  } as unknown as App;
}

function createController(overrides: {
  app?: App;
  captureStream?: FakeCaptureStream;
  editorService?: FakeEditorService;
  getSettings?: () => PluginSettings;
  notice?: ReturnType<typeof vi.fn>;
  sidecarConnection?: FakeSidecarConnection;
}): DictationSessionController {
  return new DictationSessionController({
    app: overrides.app ?? createAppWithHotkeys([]),
    captureStream: overrides.captureStream ?? new FakeCaptureStream(),
    editorService: overrides.editorService ?? new FakeEditorService(),
    getSettings: overrides.getSettings ?? (() => createSettings({})),
    notice: overrides.notice ?? (() => {}),
    pressAndHoldGateCommandId: 'obsidian-local-stt:press-and-hold-gate',
    setRibbonState: () => {},
    setStatusState: () => {},
    sidecarConnection: overrides.sidecarConnection ?? new FakeSidecarConnection(),
  });
}

function createKeyboardEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
): KeyboardEvent {
  return {
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    key,
    metaKey: modifiers.metaKey ?? false,
    preventDefault: vi.fn(),
    repeat: false,
    shiftKey: modifiers.shiftKey ?? false,
    stopPropagation: vi.fn(),
    target: null,
  } as unknown as KeyboardEvent;
}

function createSettings(overrides: Partial<PluginSettings>): PluginSettings {
  return {
    accelerationPreference: 'auto',
    cudaLibraryPath: '',
    developerMode: false,
    insertionMode: 'insert_at_cursor',
    listeningMode: 'one_sentence',
    modelStorePathOverride: '',
    pauseWhileProcessing: true,
    selectedModel: null,
    sidecarPathOverride: '',
    sidecarRequestTimeoutMs: 300_000,
    sidecarStartupTimeoutMs: 4_000,
    ...overrides,
  };
}

function createExternalModelSelection() {
  return {
    engineId: 'whisper_cpp' as const,
    filePath: '/tmp/ggml-small.en-q5_1.bin',
    kind: 'external_file' as const,
  };
}
