import type { MicrophoneRecorder } from '../audio/microphone-recorder';
import { createTempWavFilePath, deleteFileIfExists } from '../audio/temp-audio-file';
import type { EditorService } from '../editor/editor-service';
import { assertAbsoluteExistingFilePath } from '../filesystem/path-validation';
import type { PluginSettings } from '../settings/plugin-settings';
import type { TranscribeFileResponsePayload } from '../sidecar/protocol';
import type { SidecarClient } from '../sidecar/sidecar-client';
import type { PluginRuntimeState } from '../ui/status-bar';

export type DictationControllerState = 'idle' | 'recording' | 'transcribing' | 'error';

type DictationLogger = (message: string, error?: unknown) => void;

interface DictationControllerDependencies {
  editorService: Pick<EditorService, 'assertActiveEditorAvailable' | 'insertTextAtCursor'>;
  getSettings: () => PluginSettings;
  logger?: DictationLogger;
  notice: (message: string) => void;
  recorder: Pick<MicrophoneRecorder, 'cancel' | 'dispose' | 'start' | 'stop'>;
  setRibbonState: (state: DictationControllerState) => void;
  setStatusState: (state: PluginRuntimeState, detail?: string) => void;
  sidecarClient: Pick<SidecarClient, 'transcribeFile'>;
}

export class DictationController {
  private state: DictationControllerState = 'idle';

  constructor(private readonly dependencies: DictationControllerDependencies) {
    this.applyUiState('idle');
  }

  getState(): DictationControllerState {
    return this.state;
  }

  isBusy(): boolean {
    return this.state === 'recording' || this.state === 'transcribing';
  }

  async startDictation(): Promise<void> {
    if (this.state === 'recording') {
      this.dependencies.notice('Dictation is already recording.');
      return;
    }

    if (this.state === 'transcribing') {
      this.dependencies.notice('Transcription is already in progress.');
      return;
    }

    try {
      await this.requireConfiguredModelPath();
      this.dependencies.editorService.assertActiveEditorAvailable();
      await this.dependencies.recorder.start();
      this.applyUiState('recording');
    } catch (error) {
      await this.dependencies.recorder.cancel();
      this.handleError('Failed to start dictation', error);
    }
  }

  async stopAndTranscribe(): Promise<void> {
    if (this.state !== 'recording') {
      this.dependencies.notice('Dictation is not currently recording.');
      return;
    }

    let recordedAudioPath: string | null = null;

    this.applyUiState('transcribing');

    try {
      const modelFilePath = await this.requireConfiguredModelPath();
      const tempAudioPath = await createTempWavFilePath(
        this.dependencies.getSettings().tempAudioDirectoryOverride,
      );
      recordedAudioPath = tempAudioPath;
      const recordedAudio = await this.dependencies.recorder.stop(tempAudioPath);
      recordedAudioPath = recordedAudio.audioFilePath;

      const transcript = await this.dependencies.sidecarClient.transcribeFile({
        audioFilePath: recordedAudio.audioFilePath,
        language: 'en',
        modelFilePath,
      });
      const normalizedText = normalizeTranscriptText(transcript);

      this.dependencies.editorService.insertTextAtCursor(normalizedText);
      this.applyUiState('idle');
      this.dependencies.notice('Inserted local transcript into the active note.');
    } catch (error) {
      await this.dependencies.recorder.cancel();
      this.handleError('Failed to transcribe dictation', error);
    } finally {
      if (recordedAudioPath !== null) {
        await deleteFileIfExists(recordedAudioPath).catch((error: unknown) => {
          this.dependencies.logger?.('failed to clean up temp audio file', error);
        });
      }
    }
  }

  async cancelDictation(): Promise<void> {
    if (this.state === 'transcribing') {
      this.dependencies.notice('Cancellation is not available while transcription is in progress.');
      return;
    }

    if (this.state !== 'recording') {
      this.dependencies.notice('Dictation is not currently recording.');
      return;
    }

    try {
      await this.dependencies.recorder.cancel();
      this.applyUiState('idle');
      this.dependencies.notice('Canceled local dictation.');
    } catch (error) {
      this.handleError('Failed to cancel dictation', error);
    }
  }

  async toggleDictation(): Promise<void> {
    if (this.state === 'recording') {
      await this.stopAndTranscribe();
      return;
    }

    await this.startDictation();
  }

  async dispose(): Promise<void> {
    await this.dependencies.recorder.dispose();
    this.applyUiState('idle');
  }

  private applyUiState(state: DictationControllerState, detail?: string): void {
    this.state = state;
    this.dependencies.setRibbonState(state);
    this.dependencies.setStatusState(state, detail);
  }

  private handleError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);

    this.dependencies.logger?.(message, error);
    this.applyUiState('error', detail);
    this.dependencies.notice(`${message}: ${detail}`);
  }

  private async requireConfiguredModelPath(): Promise<string> {
    const modelFilePath = this.dependencies.getSettings().modelFilePath.trim();

    if (modelFilePath.length === 0) {
      throw new Error('Configure a Whisper model file path in Local STT settings.');
    }

    return assertAbsoluteExistingFilePath(modelFilePath, 'Whisper model file path');
  }
}

function normalizeTranscriptText(response: TranscribeFileResponsePayload): string {
  const text = response.text.trim();

  if (text.length > 0) {
    return text;
  }

  const fallbackText = response.segments
    .map((segment) => segment.text.trim())
    .join(' ')
    .trim();

  if (fallbackText.length === 0) {
    throw new Error('Transcription completed but returned no text.');
  }

  return fallbackText;
}
