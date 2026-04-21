import type { AudioCaptureStream } from '../audio/audio-capture-stream';
import type { EditorService } from '../editor/editor-service';
import type { PluginSettings } from '../settings/plugin-settings';
import { formatErrorMessage } from '../shared/format-utils';
import type { PluginLogger } from '../shared/plugin-logger';
import type { SessionState, SidecarEvent, TranscriptReadyEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import { SidecarNotInstalledError } from '../sidecar/sidecar-paths';

export type DictationControllerState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'speech_detected'
  | 'speech_ending'
  | 'transcribing'
  | 'paused'
  | 'error';

interface DictationSessionControllerDependencies {
  captureStream: Pick<AudioCaptureStream, 'isCapturing' | 'start' | 'stop'>;
  editorService: Pick<
    EditorService,
    'assertActiveEditorAvailable' | 'beginAnchor' | 'endAnchor' | 'insertPhrase' | 'setAnchorMode'
  >;
  getSettings: () => PluginSettings;
  logger?: PluginLogger;
  notice: (message: string) => void;
  onSidecarMissing?: () => void;
  setRibbonState: (state: DictationControllerState) => void;
  sidecarConnection: Pick<
    SidecarConnection,
    | 'cancelSession'
    | 'ensureStarted'
    | 'sendAudioFrame'
    | 'startSession'
    | 'stopSession'
    | 'subscribe'
  >;
}

const ANCHOR_VISIBLE_DELAY_MS = 2500;

export class DictationSessionController {
  private abortingSessionId: string | null = null;
  private anchorTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingStartSessionId: string | null = null;
  private readonly releaseSidecarSubscription: () => void;
  private sessionId: string | null = null;
  private state: DictationControllerState = 'idle';

  constructor(private readonly dependencies: DictationSessionControllerDependencies) {
    this.releaseSidecarSubscription = this.dependencies.sidecarConnection.subscribe((event) => {
      void this.handleSidecarEvent(event);
    });
    this.applyUiState('idle');
  }

  getState(): DictationControllerState {
    return this.state;
  }

  isBusy(): boolean {
    return this.sessionId !== null || this.state === 'starting' || this.abortingSessionId !== null;
  }

  async cancelDictation(): Promise<void> {
    if (this.sessionId === null) {
      this.dependencies.notice('Dictation is not currently active.');
      return;
    }

    try {
      await this.dependencies.sidecarConnection.cancelSession(this.sessionId);
    } catch (error) {
      await this.cleanupLocalSession();
      this.handleError('Failed to cancel the dictation session', error);
    }
  }

  async dispose(): Promise<void> {
    this.releaseSidecarSubscription();
    this.dependencies.editorService.endAnchor();
    await this.cleanupLocalSession();
    this.applyUiState('idle');
  }

  handleRibbonClick(): void {
    void this.toggleDictation();
  }

  async startDictation(): Promise<void> {
    if (this.sessionId !== null) {
      this.dependencies.notice('Dictation is already active.');
      return;
    }

    try {
      await this.dependencies.sidecarConnection.ensureStarted();
    } catch (error) {
      if (error instanceof SidecarNotInstalledError) {
        this.dependencies.logger?.debug('sidecar', 'sidecar not installed — prompting install');
        this.dependencies.onSidecarMissing?.();
        return;
      }
      this.handleError('Failed to start the dictation session', error);
      return;
    }

    const settings = this.dependencies.getSettings();
    const selectedModel = this.requireSelectedModel(settings);
    const sessionId = createSessionId();

    this.dependencies.editorService.assertActiveEditorAvailable();
    this.sessionId = sessionId;
    this.applyUiState('starting');
    this.dependencies.logger?.debug('session', `starting dictation session ${sessionId}`);

    try {
      await this.dependencies.captureStream.start((frameBytes) => {
        if (this.sessionId !== sessionId) {
          return;
        }

        try {
          this.dependencies.sidecarConnection.sendAudioFrame(frameBytes);
        } catch (error) {
          this.dependencies.logger?.warn('session', 'failed to forward an audio frame', error);
        }
      });
      this.pendingStartSessionId = sessionId;
      try {
        await this.dependencies.sidecarConnection.startSession({
          accelerationPreference: settings.accelerationPreference,
          language: 'en',
          mode: settings.listeningMode,
          modelSelection: selectedModel,
          pauseWhileProcessing: settings.pauseWhileProcessing,
          sessionId,
          speakingStyle: settings.speakingStyle,
          ...(settings.modelStorePathOverride.length > 0
            ? { modelStorePathOverride: settings.modelStorePathOverride }
            : {}),
        });
      } finally {
        if (this.pendingStartSessionId === sessionId) {
          this.pendingStartSessionId = null;
        }
      }
    } catch (error) {
      await this.cleanupLocalSession();
      if (error instanceof SidecarNotInstalledError) {
        this.dependencies.logger?.debug('sidecar', 'sidecar not installed — prompting install');
        this.applyUiState('idle');
        this.dependencies.onSidecarMissing?.();
        return;
      }
      this.handleError('Failed to start the dictation session', error);
    }
  }

  async stopDictation(): Promise<void> {
    if (this.sessionId === null) {
      this.dependencies.notice('Dictation is not currently active.');
      return;
    }

    // Stop capture immediately so the mic turns off, but keep sessionId alive
    // so transcript_ready events are still accepted while the sidecar drains.
    if (this.dependencies.captureStream.isCapturing()) {
      await this.dependencies.captureStream.stop();
    }

    try {
      await this.dependencies.sidecarConnection.stopSession(this.sessionId);
    } catch (error) {
      await this.cleanupLocalSession();
      this.handleError('Failed to stop the dictation session', error);
    }
  }

  private async toggleDictation(): Promise<void> {
    if (this.state === 'error' && this.sessionId === null) {
      this.applyUiState('idle');
      return;
    }

    if (this.sessionId !== null) {
      await this.stopDictation();
      return;
    }

    await this.startDictation();
  }

  private applyUiState(state: DictationControllerState): void {
    this.state = state;
    this.dependencies.setRibbonState(state);
  }

  private async cleanupLocalSession(): Promise<void> {
    this.abortingSessionId = null;
    this.pendingStartSessionId = null;
    this.sessionId = null;
    this.clearAnchorTimer();

    if (this.dependencies.captureStream.isCapturing()) {
      await this.dependencies.captureStream.stop();
    }
  }

  private applySessionStateToAnchor(state: SessionState): void {
    if (!isAnchorVisibleSessionState(state)) {
      this.clearAnchorTimer();
      this.dependencies.editorService.setAnchorMode('hidden');
      return;
    }

    if (this.anchorTimerId !== null) {
      return;
    }

    const timerId = setTimeout(() => {
      if (this.anchorTimerId !== timerId) {
        return;
      }

      this.dependencies.editorService.setAnchorMode('visible');
    }, ANCHOR_VISIBLE_DELAY_MS);

    this.anchorTimerId = timerId;
  }

  private clearAnchorTimer(): void {
    if (this.anchorTimerId !== null) {
      clearTimeout(this.anchorTimerId);
      this.anchorTimerId = null;
    }
  }

  private async handleErrorEvent(event: Extract<SidecarEvent, { type: 'error' }>): Promise<void> {
    if (
      this.pendingStartSessionId !== null &&
      (event.sessionId === undefined || event.sessionId === this.pendingStartSessionId)
    ) {
      return;
    }

    if (
      event.sessionId !== undefined &&
      event.sessionId !== this.sessionId &&
      event.sessionId !== this.abortingSessionId
    ) {
      return;
    }

    const detail = event.details ? `${event.message} (${event.details})` : event.message;
    this.applyUiState('error');
    this.dependencies.notice(`Local STT: ${detail}`);

    if (event.sessionId !== undefined && event.sessionId === this.sessionId) {
      void this.abortSessionAfterError(event.sessionId);
    }
  }

  private async handleSessionStopped(
    event: Extract<SidecarEvent, { type: 'session_stopped' }>,
  ): Promise<void> {
    if (event.sessionId !== this.sessionId && event.sessionId !== this.abortingSessionId) {
      return;
    }

    this.dependencies.logger?.debug(
      'session',
      `session ${event.sessionId} stopped (reason: ${event.reason})`,
    );
    this.dependencies.editorService.endAnchor();
    await this.cleanupLocalSession();
    this.applyUiState('idle');

    if (event.reason === 'timeout') {
      this.dependencies.notice('Local STT: one-sentence mode timed out before speech started.');
    }
  }

  private async handleSidecarEvent(event: SidecarEvent): Promise<void> {
    switch (event.type) {
      case 'health_ok':
      case 'system_info':
        return;

      case 'session_started':
        if (event.sessionId === this.sessionId) {
          try {
            this.dependencies.editorService.beginAnchor(
              this.dependencies.getSettings().dictationAnchor,
            );
          } catch (error) {
            this.dependencies.logger?.warn('session', 'failed to begin dictation anchor', error);
          }
        }
        return;

      case 'session_state_changed':
        if (event.sessionId === this.sessionId) {
          this.applyUiState(event.state);
          this.applySessionStateToAnchor(event.state);
        }
        return;

      case 'transcript_ready':
        await this.handleTranscriptReady(event);
        return;

      case 'warning':
        if (event.sessionId === undefined || event.sessionId === this.sessionId) {
          const detail = event.details ? `${event.message} (${event.details})` : event.message;
          this.dependencies.notice(`Local STT: ${detail}`);
        }
        return;

      case 'session_stopped':
        await this.handleSessionStopped(event);
        return;

      case 'error':
        await this.handleErrorEvent(event);
        return;
    }
  }

  private async handleTranscriptReady(event: TranscriptReadyEvent): Promise<void> {
    if (event.sessionId !== this.sessionId) {
      return;
    }

    this.dependencies.logger?.debug(
      'session',
      `transcript received (${event.text.length} chars, ${event.processingDurationMs}ms processing)`,
    );

    // Capability-gate warnings are intentionally dev-console only (see D-008) —
    // users don't need to know the worker soft-dropped an unsupported field.
    // Do not surface these via Notice.
    for (const warning of event.warnings) {
      this.dependencies.logger?.debug(
        'session',
        `capability gate dropped "${warning.field}": ${warning.reason}`,
      );
    }

    const text = normalizeTranscriptText(event);

    if (text === null) {
      this.dependencies.logger?.debug('session', 'discarding empty transcript');
      return;
    }

    try {
      this.dependencies.editorService.insertPhrase(
        text,
        this.dependencies.getSettings().phraseSeparator,
      );
    } catch (error) {
      this.handleError('Failed to insert the local transcript', error);
      void this.abortSessionAfterError(event.sessionId);
    }
  }

  private handleError(message: string, error: unknown): void {
    this.dependencies.logger?.error('session', message, error);
    this.applyUiState('error');
    this.dependencies.notice(`${message}: ${formatErrorMessage(error)}`);
  }

  private async abortSessionAfterError(sessionId: string): Promise<void> {
    if (this.abortingSessionId === sessionId) {
      return;
    }

    this.abortingSessionId = sessionId;

    try {
      await this.dependencies.sidecarConnection.cancelSession(sessionId);
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        'failed to cancel an errored session cleanly',
        error,
      );

      if (this.sessionId === sessionId) {
        await this.cleanupLocalSession();
      }
    } finally {
      if (this.abortingSessionId === sessionId) {
        this.abortingSessionId = null;
      }
    }
  }

  private requireSelectedModel(
    settings: PluginSettings,
  ): NonNullable<PluginSettings['selectedModel']> {
    if (settings.selectedModel !== null) {
      return settings.selectedModel;
    }

    throw new Error('Select a Local STT model before starting dictation.');
  }
}

function createSessionId(): string {
  return `session-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

function isAnchorVisibleSessionState(state: SessionState): boolean {
  return (
    state === 'speech_detected' ||
    state === 'speech_ending' ||
    state === 'transcribing' ||
    state === 'paused'
  );
}

function normalizeTranscriptText(event: TranscriptReadyEvent): string | null {
  const text = event.text.trim();

  if (text.length > 0) {
    return text;
  }

  const fallbackText = event.segments
    .map((segment) => segment.text.trim())
    .join(' ')
    .trim();

  return fallbackText.length > 0 ? fallbackText : null;
}
