import type { App, Hotkey } from 'obsidian';

import type { AudioCaptureStream } from '../audio/audio-capture-stream';
import type { EditorService } from '../editor/editor-service';
import type { PluginSettings } from '../settings/plugin-settings';
import type { PluginLogger } from '../shared/plugin-logger';
import type { SidecarEvent, TranscriptReadyEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import type { PluginRuntimeState } from '../ui/status-bar';
import {
  matchesAnyHotkey,
  resolveCommandHotkeys,
  shouldIgnoreHeldKeyEvent,
} from './shortcut-matcher';

export type DictationControllerState = PluginRuntimeState;

interface DictationSessionControllerDependencies {
  app: App;
  captureStream: Pick<AudioCaptureStream, 'isCapturing' | 'start' | 'stop'>;
  editorService: Pick<EditorService, 'assertActiveEditorAvailable' | 'insertTranscript'>;
  getSettings: () => PluginSettings;
  logger?: PluginLogger;
  notice: (message: string) => void;
  pressAndHoldGateCommandId: string;
  pressAndHoldGateDefaultHotkeys?: Hotkey[];
  setRibbonState: (state: DictationControllerState) => void;
  setStatusState: (state: PluginRuntimeState, detail?: string) => void;
  sidecarConnection: Pick<
    SidecarConnection,
    'cancelSession' | 'sendAudioFrame' | 'setGate' | 'startSession' | 'stopSession' | 'subscribe'
  >;
}

export class DictationSessionController {
  private abortingSessionId: string | null = null;
  private gateOpen = false;
  private readonly releaseSidecarSubscription: () => void;
  private ribbonHoldActive = false;
  private suppressNextRibbonClick = false;
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
    await this.cleanupLocalSession();
    this.applyUiState('idle');
  }

  handleDocumentKeyDown(event: KeyboardEvent): void {
    if (!this.isPressAndHoldMode()) {
      return;
    }

    if (shouldIgnoreHeldKeyEvent(event.target)) {
      return;
    }

    const hotkeys = resolveCommandHotkeys(
      this.dependencies.app,
      this.dependencies.pressAndHoldGateCommandId,
      this.dependencies.pressAndHoldGateDefaultHotkeys ?? [],
    );

    if (hotkeys.length === 0 || !matchesAnyHotkey(event, hotkeys)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.repeat || this.gateOpen) {
      return;
    }

    void this.openPressAndHoldGate();
  }

  handleDocumentKeyUp(event: KeyboardEvent): void {
    if (!this.isPressAndHoldMode()) {
      return;
    }

    const hotkeys = resolveCommandHotkeys(
      this.dependencies.app,
      this.dependencies.pressAndHoldGateCommandId,
      this.dependencies.pressAndHoldGateDefaultHotkeys ?? [],
    );

    if (hotkeys.length === 0 || !matchesAnyHotkey(event, hotkeys)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void this.closePressAndHoldGate();
  }

  handleRibbonClick(): void {
    if (this.isPressAndHoldMode() && this.suppressNextRibbonClick) {
      this.suppressNextRibbonClick = false;
      return;
    }

    void this.toggleDictation();
  }

  handleRibbonPointerDown(): void {
    if (!this.isPressAndHoldMode()) {
      return;
    }

    this.ribbonHoldActive = true;
    this.suppressNextRibbonClick = true;
    void this.openPressAndHoldGate();
  }

  handleRibbonPointerUp(): void {
    if (!this.ribbonHoldActive) {
      return;
    }

    this.ribbonHoldActive = false;

    if (!this.isPressAndHoldMode()) {
      return;
    }

    void this.closePressAndHoldGate();
  }

  async startDictation(options: { openGateAfterStart?: boolean } = {}): Promise<void> {
    if (this.sessionId !== null) {
      this.dependencies.notice('Dictation is already active.');
      return;
    }

    const settings = this.dependencies.getSettings();
    const selectedModel = this.requireSelectedModel(settings);
    const sessionId = createSessionId();

    this.dependencies.editorService.assertActiveEditorAvailable();
    this.sessionId = sessionId;
    this.gateOpen = false;
    this.applyUiState('starting', 'opening session');
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
      await this.dependencies.sidecarConnection.startSession({
        accelerationPreference: settings.accelerationPreference,
        language: 'en',
        mode: settings.listeningMode,
        modelSelection: selectedModel,
        pauseWhileProcessing: settings.pauseWhileProcessing,
        sessionId,
        ...(settings.modelStorePathOverride.length > 0
          ? { modelStorePathOverride: settings.modelStorePathOverride }
          : {}),
      });

      if (options.openGateAfterStart && settings.listeningMode === 'press_and_hold') {
        await this.dependencies.sidecarConnection.setGate(true);
        this.gateOpen = true;
      }
    } catch (error) {
      await this.cleanupLocalSession();
      this.handleError('Failed to start the dictation session', error);
    }
  }

  async stopDictation(): Promise<void> {
    if (this.sessionId === null) {
      this.dependencies.notice('Dictation is not currently active.');
      return;
    }

    try {
      await this.dependencies.sidecarConnection.stopSession(this.sessionId);
    } catch (error) {
      await this.cleanupLocalSession();
      this.handleError('Failed to stop the dictation session', error);
    }
  }

  async toggleDictation(): Promise<void> {
    if (this.sessionId !== null) {
      await this.stopDictation();
      return;
    }

    await this.startDictation();
  }

  private applyUiState(state: DictationControllerState, detail?: string): void {
    this.state = state;
    this.dependencies.setRibbonState(state);
    this.dependencies.setStatusState(state, detail);
  }

  private async cleanupLocalSession(): Promise<void> {
    this.abortingSessionId = null;
    this.gateOpen = false;
    this.ribbonHoldActive = false;
    this.sessionId = null;
    this.suppressNextRibbonClick = false;

    if (this.dependencies.captureStream.isCapturing()) {
      await this.dependencies.captureStream.stop();
    }
  }

  private async closePressAndHoldGate(): Promise<void> {
    if (!this.isPressAndHoldMode() || !this.gateOpen || this.sessionId === null) {
      return;
    }

    this.gateOpen = false;
    this.dependencies.logger?.debug('session', 'gate closed');

    try {
      await this.dependencies.sidecarConnection.setGate(false);
    } catch (error) {
      this.handleError('Failed to close the press-and-hold gate', error);
    }
  }

  private async handleErrorEvent(event: Extract<SidecarEvent, { type: 'error' }>): Promise<void> {
    if (
      event.sessionId !== undefined &&
      event.sessionId !== this.sessionId &&
      event.sessionId !== this.abortingSessionId
    ) {
      return;
    }

    const detail = event.details ? `${event.message} (${event.details})` : event.message;
    this.applyUiState('error', detail);
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
    await this.cleanupLocalSession();
    this.applyUiState('idle');

    if (event.reason === 'timeout') {
      this.dependencies.notice('Local STT: one-sentence mode timed out before speech started.');
    }
  }

  private async handleSidecarEvent(event: SidecarEvent): Promise<void> {
    switch (event.type) {
      case 'health_ok':
      case 'session_started':
      case 'system_info':
        return;

      case 'session_state_changed':
        if (event.sessionId === this.sessionId) {
          this.applyUiState(event.state);
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

    try {
      this.dependencies.editorService.insertTranscript(
        normalizeTranscriptText(event),
        this.dependencies.getSettings().insertionMode,
      );
    } catch (error) {
      this.handleError('Failed to insert the local transcript', error);
      void this.abortSessionAfterError(event.sessionId);
    }
  }

  private handleError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);

    this.dependencies.logger?.error('session', message, error);
    this.applyUiState('error', detail);
    this.dependencies.notice(`${message}: ${detail}`);
  }

  private isPressAndHoldMode(): boolean {
    return this.dependencies.getSettings().listeningMode === 'press_and_hold';
  }

  private async openPressAndHoldGate(): Promise<void> {
    if (!this.isPressAndHoldMode()) {
      return;
    }

    if (this.sessionId === null) {
      await this.startDictation({ openGateAfterStart: true });
      return;
    }

    if (this.gateOpen) {
      return;
    }

    this.gateOpen = true;
    this.dependencies.logger?.debug('session', 'gate opened');

    try {
      await this.dependencies.sidecarConnection.setGate(true);
    } catch (error) {
      this.handleError('Failed to open the press-and-hold gate', error);
    }
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

      if (this.sessionId === null && this.abortingSessionId === null && this.state === 'error') {
        this.applyUiState('idle');
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

function normalizeTranscriptText(event: TranscriptReadyEvent): string {
  const text = event.text.trim();

  if (text.length > 0) {
    return text;
  }

  const fallbackText = event.segments
    .map((segment) => segment.text.trim())
    .join(' ')
    .trim();

  if (fallbackText.length === 0) {
    throw new Error('Transcription completed but returned no text.');
  }

  return fallbackText;
}
