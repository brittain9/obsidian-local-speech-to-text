import { randomUUID } from 'node:crypto';

import type { AudioCaptureStream } from '../audio/audio-capture-stream';
import type { NotePlacementOptions } from '../editor/note-surface';
import type { Session } from '../session/session';
import type { StageId } from '../session/session-journal';
import type { PluginSettings } from '../settings/plugin-settings';
import { formatErrorMessage } from '../shared/format-utils';
import type { PluginLogger } from '../shared/plugin-logger';
import type {
  ContextRequestEvent,
  ContextWindow,
  LlmTransformConfig,
  QueueBackpressureTier,
  SessionState,
  SidecarEvent,
  TranscriptReadyEvent,
} from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import { SidecarNotInstalledError } from '../sidecar/sidecar-paths';
import type { TranscriptRenderOptions } from '../transcript/renderer';

export type DictationControllerState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'speech_detected'
  | 'speech_ending'
  | 'transcribing'
  | 'error';

type ControllerSession = Pick<
  Session,
  'acceptTranscript' | 'dispose' | 'readNoteContext' | 'setAnchorMode'
>;

interface ActiveSessionSnapshot {
  accelerationPreference: PluginSettings['accelerationPreference'];
  dictationAnchor: PluginSettings['dictationAnchor'];
  listeningMode: PluginSettings['listeningMode'];
  llmTransform: LlmTransformConfig | null;
  modelSelection: NonNullable<PluginSettings['selectedModel']>;
  modelStorePathOverride: string;
  sessionStartUnixMs: number;
  showTimestamps: PluginSettings['showTimestamps'];
  speakingStyle: PluginSettings['speakingStyle'];
  transcriptFormatting: PluginSettings['transcriptFormatting'];
  useNoteAsContext: PluginSettings['useNoteAsContext'];
}

interface DictationSessionControllerDependencies {
  captureStream: Pick<AudioCaptureStream, 'isCapturing' | 'start' | 'stop'>;
  createSession: (options: {
    callbacks: {
      onLockedNoteClosed: () => void;
      onLockedNoteDeleted: () => void;
    };
    placement: NotePlacementOptions;
    rendererOptions: TranscriptRenderOptions;
    sessionId: string;
  }) => ControllerSession;
  getSettings: () => PluginSettings;
  logger?: PluginLogger;
  notice: (message: string) => void;
  onSidecarMissing?: () => void;
  setRibbonQueueTier: (tier: QueueBackpressureTier) => void;
  setRibbonState: (state: DictationControllerState) => void;
  sidecarConnection: Pick<
    SidecarConnection,
    | 'cancelSession'
    | 'ensureStarted'
    | 'sendAudioFrame'
    | 'sendContextResponse'
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
  private queueTier: QueueBackpressureTier = 'normal';
  private readonly releaseSidecarSubscription: () => void;
  private session: ControllerSession | null = null;
  private sessionId: string | null = null;
  private sessionSnapshot: ActiveSessionSnapshot | null = null;
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
    const activeSessionId = this.sessionId;
    if (activeSessionId !== null) {
      try {
        await this.dependencies.sidecarConnection.stopSession(activeSessionId, 500);
      } catch (error) {
        this.dependencies.logger?.warn(
          'session',
          'timed out stopping dictation during unload',
          error,
        );
      }
    }
    this.releaseSidecarSubscription();
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
    const snapshot: ActiveSessionSnapshot = {
      accelerationPreference: settings.accelerationPreference,
      dictationAnchor: settings.dictationAnchor,
      listeningMode: settings.listeningMode,
      llmTransform: resolveLlmTransformSnapshot(settings),
      modelSelection: selectedModel,
      modelStorePathOverride: settings.modelStorePathOverride,
      sessionStartUnixMs: Date.now(),
      showTimestamps: settings.showTimestamps,
      speakingStyle: settings.speakingStyle,
      transcriptFormatting: settings.transcriptFormatting,
      useNoteAsContext: settings.useNoteAsContext,
    };
    const sessionId = createSessionId();
    let session: ControllerSession;

    try {
      session = this.dependencies.createSession({
        callbacks: {
          onLockedNoteClosed: () => {
            this.handleLockedNoteClosed(sessionId);
          },
          onLockedNoteDeleted: () => {
            this.handleLockedNoteDeleted(sessionId);
          },
        },
        placement: {
          anchor: snapshot.dictationAnchor,
        },
        rendererOptions: {
          showTimestamps: snapshot.showTimestamps,
          transcriptFormatting: snapshot.transcriptFormatting,
        },
        sessionId,
      });
    } catch (error) {
      this.handleError('Failed to start the dictation session', error);
      return;
    }

    this.sessionId = sessionId;
    this.session = session;
    this.sessionSnapshot = snapshot;
    this.applyUiState('starting');
    this.dependencies.logger?.debug('session', `starting dictation session ${sessionId}`);

    let frameForwardAborted = false;

    try {
      await this.dependencies.captureStream.start((frameBytes) => {
        if (frameForwardAborted || this.sessionId !== sessionId) {
          return;
        }

        try {
          this.dependencies.sidecarConnection.sendAudioFrame(frameBytes);
        } catch (error) {
          frameForwardAborted = true;
          this.dependencies.logger?.warn(
            'session',
            'stopping audio capture: sidecar rejected an audio frame',
            error,
          );
          void this.dependencies.captureStream.stop();
        }
      });
      this.pendingStartSessionId = sessionId;
      try {
        await this.dependencies.sidecarConnection.startSession({
          accelerationPreference: snapshot.accelerationPreference,
          language: 'en',
          ...(snapshot.llmTransform !== null ? { llmTransform: snapshot.llmTransform } : {}),
          mode: snapshot.listeningMode,
          modelSelection: snapshot.modelSelection,
          sessionStartUnixMs: snapshot.sessionStartUnixMs,
          sessionId,
          speakingStyle: snapshot.speakingStyle,
          ...(snapshot.modelStorePathOverride.length > 0
            ? { modelStorePathOverride: snapshot.modelStorePathOverride }
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
    this.sessionSnapshot = null;
    const session = this.session;
    this.session = null;
    this.clearAnchorTimer();
    this.resetQueueTier();

    if (this.dependencies.captureStream.isCapturing()) {
      await this.dependencies.captureStream.stop();
    }

    await session?.dispose({ deleteRecovery: true });
  }

  private applySessionStateToAnchor(state: SessionState): void {
    if (!isAnchorVisibleSessionState(state)) {
      this.clearAnchorTimer();
      this.session?.setAnchorMode('hidden');
      return;
    }

    if (this.anchorTimerId !== null) {
      return;
    }

    const timerId = setTimeout(() => {
      if (this.anchorTimerId !== timerId) {
        return;
      }

      this.session?.setAnchorMode('visible');
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
    this.dependencies.notice(`Local Transcript: ${detail}`);

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
    await this.cleanupLocalSession();
    this.applyUiState('idle');

    if (event.reason === 'timeout') {
      this.dependencies.notice(
        'Local Transcript: one-sentence mode timed out before speech started.',
      );
    }
  }

  private async handleSidecarEvent(event: SidecarEvent): Promise<void> {
    switch (event.type) {
      case 'health_ok':
      case 'system_info':
        return;

      case 'session_started':
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

      case 'transcription_queue_changed':
        this.handleQueueTierChange(event);
        return;

      case 'context_request':
        this.handleContextRequest(event);
        return;

      case 'warning':
        if (event.sessionId === undefined || event.sessionId === this.sessionId) {
          const detail = event.details ? `${event.message} (${event.details})` : event.message;
          this.dependencies.notice(`Local Transcript: ${detail}`);
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

  private handleQueueTierChange(
    event: Extract<SidecarEvent, { type: 'transcription_queue_changed' }>,
  ): void {
    if (event.sessionId !== this.sessionId) {
      return;
    }

    const previousTier = this.queueTier;
    this.queueTier = event.tier;
    this.dependencies.setRibbonQueueTier(event.tier);

    // Only notify on upward entry into falling_behind. Recovering from
    // `saturated` also passes through this tier, but the session is already
    // shutting down and the "pause to let it catch up" guidance would be
    // misleading on top of the saturation error.
    const recoveringFromSaturation = previousTier === 'saturated';
    if (
      event.tier === 'falling_behind' &&
      previousTier !== 'falling_behind' &&
      !recoveringFromSaturation
    ) {
      this.dependencies.notice(
        'Local Transcript: transcription is falling behind — pause to let it catch up.',
      );
    }
  }

  private resetQueueTier(): void {
    this.queueTier = 'normal';
    this.dependencies.setRibbonQueueTier('normal');
  }

  private handleContextRequest(event: ContextRequestEvent): void {
    if (event.sessionId !== this.sessionId) {
      return;
    }

    const snapshot = this.sessionSnapshot;
    const note = snapshot?.useNoteAsContext
      ? (this.session?.readNoteContext(event.budgetChars) ?? null)
      : null;
    const context: ContextWindow | null =
      note === null
        ? null
        : {
            budgetChars: event.budgetChars,
            sources: [{ kind: 'note_glossary', text: note.text, truncated: note.truncated }],
            text: note.text,
            truncated: note.truncated,
          };

    if (note !== null) {
      this.dependencies.logger?.debug(
        'session',
        `context_request: ${note.text} (${note.text.length}/${event.budgetChars} chars, truncated=${note.truncated})`,
      );
    }

    try {
      this.dependencies.sidecarConnection.sendContextResponse(event.correlationId, context);
    } catch (error) {
      this.dependencies.logger?.warn('session', 'failed to send context response', error);
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
    this.logDroppedHallucinations(event);

    const text = event.text.trim();

    const session = this.session;
    if (session === null) {
      return;
    }

    const result = session.acceptTranscript({
      isFinal: event.isFinal,
      pauseMsBeforeUtterance: event.pauseMsBeforeUtterance,
      revision: event.revision,
      segments: event.segments,
      sessionId: event.sessionId,
      stageResults: event.stageResults,
      text,
      utteranceEndMsInSession: event.utteranceEndMsInSession,
      utteranceId: event.utteranceId,
      utteranceIndex: event.utteranceIndex,
      utteranceStartMsInSession: event.utteranceStartMsInSession,
    });
    if (result.kind === 'rejected') {
      this.handleError('Failed to record the local transcript', new Error(result.reason));
      void this.abortSessionAfterError(event.sessionId);
    }
  }

  private logDroppedHallucinations(event: TranscriptReadyEvent): void {
    const targetStageId: StageId = 'hallucination_filter';
    for (const stage of event.stageResults) {
      if (stage.stageId !== targetStageId || stage.status.kind !== 'ok') {
        continue;
      }
      const droppedSegments = stage.payload?.droppedSegments;
      if (!Array.isArray(droppedSegments)) {
        continue;
      }
      for (const segment of droppedSegments) {
        this.dependencies.logger?.debug('session', 'hallucination segment dropped', segment);
      }
    }
  }

  private handleLockedNoteClosed(sessionId: string): void {
    if (this.sessionId !== sessionId) {
      return;
    }

    this.dependencies.notice('Dictation stopped — locked note was closed');
    void this.stopDictation();
  }

  private handleLockedNoteDeleted(sessionId: string): void {
    if (this.sessionId !== sessionId) {
      return;
    }

    this.dependencies.notice('Dictation cancelled — locked note was deleted');
    void this.cancelDictation();
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

    throw new Error('Select a Local Transcript model before starting dictation.');
  }
}

function createSessionId(): string {
  return `session-${randomUUID()}`;
}

function resolveLlmTransformSnapshot(settings: PluginSettings): LlmTransformConfig | null {
  const model = settings.llmTransformModel.trim();

  if (!settings.llmTransformEnabled || settings.showTimestamps || model.length === 0) {
    return null;
  }

  return {
    developerMode: settings.llmTransformDeveloperMode,
    model,
    prompt: settings.llmTransformPrompt,
  };
}

function isAnchorVisibleSessionState(state: SessionState): boolean {
  return state === 'speech_detected' || state === 'speech_ending' || state === 'transcribing';
}
