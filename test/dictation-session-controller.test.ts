import { describe, expect, it, vi } from 'vitest';
import { DictationSessionController } from '../src/dictation/dictation-session-controller';
import type { NotePlacementOptions } from '../src/editor/note-surface';
import type { TranscriptRevision } from '../src/session/session-journal';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type { ContextWindow, SidecarEvent, StartSessionCommand } from '../src/sidecar/protocol';
import { SidecarNotInstalledError } from '../src/sidecar/sidecar-paths';

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

class FakeSession {
  public readonly acceptTranscript = vi.fn((_revision: TranscriptRevision) => ({
    kind: 'accepted' as const,
  }));
  public readonly readNoteContext = vi.fn(
    (_maxChars: number): { text: string; truncated: boolean } | null => null,
  );
  public readonly dispose = vi.fn(async (_options?: { deleteRecovery: boolean }) => {});
  public readonly modeCalls: string[] = [];

  setAnchorMode(mode: 'hidden' | 'visible'): void {
    this.modeCalls.push(mode);
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
  public ensureStarted = vi.fn(async () => {});
  public listeners = new Set<(event: SidecarEvent) => void>();
  public lastSessionId: string | null = null;
  public sendAudioFrame = vi.fn(() => {});
  public sendContextResponse = vi.fn(
    (_correlationId: string, _context: ContextWindow | null) => {},
  );
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

  it('recovers from session creation failures before starting capture', async () => {
    const captureStream = new FakeCaptureStream();
    const notice = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      captureStream,
      createSession: () => {
        throw new Error('No active Markdown editor is available.');
      },
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      sidecarConnection,
    });

    await controller.startDictation();

    expect(captureStream.start).not.toHaveBeenCalled();
    expect(sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
    expect(notice.mock.calls[0]?.[0]).toContain('No active Markdown editor is available.');
  });

  it('recovers from sidecar start failures without staying busy', async () => {
    const captureStream = new FakeCaptureStream();
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSession.mockImplementationOnce(async () => {
      throw new Error('Sidecar refused session.');
    });
    const controller = createController({
      captureStream,
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(captureStream.stop).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledWith({ deleteRecovery: true });
    expect(controller.getState()).toBe('error');
    expect(controller.isBusy()).toBe(false);
  });

  it('prompts install when the sidecar is not installed and suppresses the error notice', async () => {
    const captureStream = new FakeCaptureStream();
    const notice = vi.fn();
    const onSidecarMissing = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.ensureStarted.mockImplementationOnce(async () => {
      throw new SidecarNotInstalledError('Sidecar executable was not found in ...');
    });
    const controller = createController({
      captureStream,
      getSettings: () => createSettings({ selectedModel: null }),
      notice,
      onSidecarMissing,
      sidecarConnection,
    });

    await controller.startDictation();

    expect(onSidecarMissing).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
    expect(captureStream.start).not.toHaveBeenCalled();
    expect(sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(controller.isBusy()).toBe(false);
  });

  it('does not call onSidecarMissing for generic sidecar errors', async () => {
    const notice = vi.fn();
    const onSidecarMissing = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSession.mockImplementationOnce(async () => {
      throw new Error('Sidecar refused session.');
    });
    const controller = createController({
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      onSidecarMissing,
      sidecarConnection,
    });

    await controller.startDictation();

    expect(onSidecarMissing).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toContain('Failed to start the dictation session');
  });

  it('surfaces a generic error when the sidecar pre-check fails non-sentinel', async () => {
    const notice = vi.fn();
    const onSidecarMissing = vi.fn();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.ensureStarted.mockImplementationOnce(async () => {
      throw new Error('Sidecar path override does not exist');
    });
    const controller = createController({
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      onSidecarMissing,
      sidecarConnection,
    });

    await controller.startDictation();

    expect(onSidecarMissing).not.toHaveBeenCalled();
    expect(sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]?.[0]).toContain('Failed to start the dictation session');
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

  it('keeps transcript_ready from cancelling a pending state timer', async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const sidecarConnection = new FakeSidecarConnection();
      const controller = createController({
        createSession: () => session,
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
      vi.advanceTimersByTime(1000);
      sidecarConnection.emit(
        transcriptReadyEvent({
          processingDurationMs: 200,
          sessionId,
          text: 'hello',
          utteranceDurationMs: 500,
          utteranceId: 'utt-anchor',
        }),
      );
      vi.advanceTimersByTime(499);

      vi.advanceTimersByTime(1);
      expect(controller.getState()).toBe('transcribing');
      expect(session.modeCalls.at(-1)).toBe('visible');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the visible-anchor timer when the session settles before the threshold', async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      const sidecarConnection = new FakeSidecarConnection();
      const controller = createController({
        createSession: () => session,
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
      vi.advanceTimersByTime(1000);
      sidecarConnection.emit({ sessionId, state: 'listening', type: 'session_state_changed' });
      vi.advanceTimersByTime(5000);

      expect(controller.getState()).toBe('listening');
      expect(session.modeCalls).toEqual(['hidden', 'hidden']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates the session with the configured note placement', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    const createdSessions: Array<{ placement: NotePlacementOptions; session: FakeSession }> = [];
    const controller = createController({
      createSession: ({ placement }) => {
        const session = new FakeSession();
        createdSessions.push({ placement, session });
        return session;
      },
      getSettings: () =>
        createSettings({
          dictationAnchor: 'end_of_note',
          phraseSeparator: 'new_paragraph',
          selectedModel: createExternalModelSelection(),
        }),
      sidecarConnection,
    });

    await controller.startDictation();

    expect(createdSessions.map((entry) => entry.placement)).toEqual([
      { anchor: 'end_of_note', separator: 'new_paragraph' },
    ]);
  });

  it('delegates normalized transcripts to the active session', async () => {
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    sidecarConnection.emit(
      transcriptReadyEvent({
        sessionId: sidecarConnection.lastSessionId ?? 'session-1',
        text: 'hello obsidian',
        utteranceId: 'utt-from-sidecar',
      }),
    );

    expect(session.acceptTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        isFinal: true,
        revision: 0,
        sessionId: sidecarConnection.lastSessionId,
        text: 'hello obsidian',
        utteranceId: 'utt-from-sidecar',
      }),
    );
  });

  it('replies to context_request with note text wrapped as a context window', async () => {
    const session = new FakeSession();
    session.readNoteContext.mockReturnValueOnce({ text: 'prior text', truncated: false });
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-1',
      sessionId,
      type: 'context_request',
      utteranceId: 'utt-next',
    });

    expect(session.readNoteContext).toHaveBeenCalledWith(384);
    const expected: ContextWindow = {
      budgetChars: 384,
      sources: [{ kind: 'note_glossary', text: 'prior text', truncated: false }],
      text: 'prior text',
      truncated: false,
    };
    expect(sidecarConnection.sendContextResponse).toHaveBeenCalledWith('corr-1', expected);
  });

  it('replies with null when the session returns no note context', async () => {
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-empty',
      sessionId,
      type: 'context_request',
      utteranceId: 'utt-first',
    });

    expect(sidecarConnection.sendContextResponse).toHaveBeenCalledWith('corr-empty', null);
  });

  it('replies with null when useNoteAsContext is disabled, without consulting the session', async () => {
    const session = new FakeSession();
    session.readNoteContext.mockReturnValueOnce({ text: 'should be ignored', truncated: false });
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
      getSettings: () =>
        createSettings({
          selectedModel: createExternalModelSelection(),
          useNoteAsContext: false,
        }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-off',
      sessionId,
      type: 'context_request',
      utteranceId: 'utt-off',
    });

    expect(session.readNoteContext).not.toHaveBeenCalled();
    expect(sidecarConnection.sendContextResponse).toHaveBeenCalledWith('corr-off', null);
  });

  it('uses the start snapshot for context policy across context_request events', async () => {
    const session = new FakeSession();
    session.readNoteContext.mockReturnValue({ text: 'note text', truncated: false });
    const sidecarConnection = new FakeSidecarConnection();
    let useNoteAsContext = true;
    const controller = createController({
      createSession: () => session,
      getSettings: () =>
        createSettings({
          selectedModel: createExternalModelSelection(),
          useNoteAsContext,
        }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-on',
      sessionId,
      type: 'context_request',
      utteranceId: 'utt-on',
    });

    useNoteAsContext = false;

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-off',
      sessionId,
      type: 'context_request',
      utteranceId: 'utt-off',
    });

    expect(sidecarConnection.sendContextResponse).toHaveBeenNthCalledWith(1, 'corr-on', {
      budgetChars: 384,
      sources: [{ kind: 'note_glossary', text: 'note text', truncated: false }],
      text: 'note text',
      truncated: false,
    });
    expect(sidecarConnection.sendContextResponse).toHaveBeenNthCalledWith(2, 'corr-off', {
      budgetChars: 384,
      sources: [{ kind: 'note_glossary', text: 'note text', truncated: false }],
      text: 'note text',
      truncated: false,
    });
  });

  it('ignores context_request for an unrelated session', async () => {
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();

    sidecarConnection.emit({
      budgetChars: 384,
      correlationId: 'corr-stale',
      sessionId: 'session-from-elsewhere',
      type: 'context_request',
      utteranceId: 'utt-foreign',
    });

    expect(session.readNoteContext).not.toHaveBeenCalled();
    expect(sidecarConnection.sendContextResponse).not.toHaveBeenCalled();
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

    sidecarConnection.emit(
      transcriptReadyEvent({
        sessionId: sidecarConnection.lastSessionId ?? 'session-1',
        text: '   ',
        utteranceId: 'utt-empty',
      }),
    );

    await vi.waitFor(() => {
      expect(notice).not.toHaveBeenCalled();
      expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
      expect(controller.getState()).not.toBe('error');
    });
  });

  it('keeps the session alive while stop drains in-flight transcripts', async () => {
    const captureStream = new FakeCaptureStream();
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.stopSession.mockImplementationOnce(async (sessionId: string) => ({
      reason: 'user_stop',
      sessionId,
      type: 'session_stopped',
    }));
    const controller = createController({
      captureStream,
      createSession: () => session,
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      sidecarConnection,
    });

    await controller.startDictation();
    const sessionId = sidecarConnection.lastSessionId ?? 'session-1';
    await controller.stopDictation();

    sidecarConnection.emit(
      transcriptReadyEvent({
        sessionId,
        text: 'drained transcript',
        utteranceId: 'utt-drained',
      }),
    );

    expect(captureStream.stop).toHaveBeenCalledTimes(1);
    expect(session.acceptTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'drained transcript' }),
    );
    expect(session.dispose).not.toHaveBeenCalled();

    sidecarConnection.emit({
      reason: 'user_stop',
      sessionId,
      type: 'session_stopped',
    });

    await vi.waitFor(() => {
      expect(session.dispose).toHaveBeenCalledWith({ deleteRecovery: true });
    });
  });

  it('disposes the session when the sidecar stops regardless of reason', async () => {
    const session = new FakeSession();
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: () => session,
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

    await vi.waitFor(() => {
      expect(session.dispose).toHaveBeenCalledWith({ deleteRecovery: true });
    });
  });

  it('requests graceful stop when the active session reports locked-note close', async () => {
    const captureStream = new FakeCaptureStream();
    const notice = vi.fn();
    let onLockedNoteClosed: () => void = () => {
      throw new Error('Expected session callbacks to be captured.');
    };
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      captureStream,
      createSession: (options) => {
        onLockedNoteClosed = options.callbacks.onLockedNoteClosed;
        return new FakeSession();
      },
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      sidecarConnection,
    });

    await controller.startDictation();
    onLockedNoteClosed();

    await vi.waitFor(() => {
      expect(sidecarConnection.stopSession).toHaveBeenCalledTimes(1);
    });
    expect(notice).toHaveBeenCalledWith('Dictation stopped — locked note was closed');
    expect(captureStream.stop).toHaveBeenCalledTimes(1);
  });

  it('requests cancel when the active session reports locked-note delete', async () => {
    const notice = vi.fn();
    let onLockedNoteDeleted: () => void = () => {
      throw new Error('Expected session callbacks to be captured.');
    };
    const sidecarConnection = new FakeSidecarConnection();
    const controller = createController({
      createSession: (options) => {
        onLockedNoteDeleted = options.callbacks.onLockedNoteDeleted;
        return new FakeSession();
      },
      getSettings: () => createSettings({ selectedModel: createExternalModelSelection() }),
      notice,
      sidecarConnection,
    });

    await controller.startDictation();
    onLockedNoteDeleted();

    await vi.waitFor(() => {
      expect(sidecarConnection.cancelSession).toHaveBeenCalledTimes(1);
    });
    expect(notice).toHaveBeenCalledWith('Dictation cancelled — locked note was deleted');
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
  createSession?: (options: {
    callbacks: {
      onLockedNoteClosed: () => void;
      onLockedNoteDeleted: () => void;
    };
    placement: NotePlacementOptions;
    sessionId: string;
  }) => FakeSession;
  getSettings?: () => PluginSettings;
  notice?: ReturnType<typeof vi.fn>;
  onSidecarMissing?: () => void;
  sidecarConnection?: FakeSidecarConnection;
}): DictationSessionController {
  return new DictationSessionController({
    captureStream: overrides.captureStream ?? new FakeCaptureStream(),
    createSession: overrides.createSession ?? (() => new FakeSession()),
    getSettings: overrides.getSettings ?? (() => createSettings({})),
    notice: overrides.notice ?? (() => {}),
    ...(overrides.onSidecarMissing ? { onSidecarMissing: overrides.onSidecarMissing } : {}),
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

function okEngineStage(durationMs: number): TranscriptRevision['stageResults'][number] {
  return {
    durationMs,
    isFinal: true,
    revisionIn: 0,
    revisionOut: 0,
    stageId: 'engine',
    status: { kind: 'ok' },
  };
}

function transcriptReadyEvent(args: {
  processingDurationMs?: number;
  sessionId: string;
  text: string;
  utteranceDurationMs?: number;
  utteranceId: string;
}): Extract<SidecarEvent, { type: 'transcript_ready' }> {
  const processingDurationMs = args.processingDurationMs ?? 75;
  return {
    isFinal: true,
    processingDurationMs,
    revision: 0,
    segments: [],
    sessionId: args.sessionId,
    stageResults: [okEngineStage(processingDurationMs)],
    text: args.text,
    type: 'transcript_ready',
    utteranceDurationMs: args.utteranceDurationMs ?? 700,
    utteranceEndMsInSession: 700,
    utteranceIndex: 0,
    utteranceStartMsInSession: 0,
    utteranceId: args.utteranceId,
    warnings: [],
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
