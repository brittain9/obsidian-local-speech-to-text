import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DictationController } from '../src/dictation/dictation-controller';
import type { PluginSettings } from '../src/settings/plugin-settings';
import type { TranscribeFileRequestPayload } from '../src/sidecar/protocol';
import type { PluginRuntimeState } from '../src/ui/status-bar';

class FakeEditorService {
  public insertedText = '';
  public assertActiveEditorAvailable = vi.fn(() => {});

  insertTextAtCursor(text: string): void {
    this.insertedText += text;
  }
}

class FakeRecorder {
  public cancel = vi.fn(async () => {});
  public start = vi.fn(async () => {});
  public stop = vi.fn(async (outputFilePath: string) => ({
    audioFilePath: outputFilePath,
    durationMs: 1_500,
    sampleRate: 16_000,
  }));
  public dispose = vi.fn(async () => {});
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('DictationController', () => {
  it('fails fast when the model path is missing', async () => {
    const notices: string[] = [];
    const states: PluginRuntimeState[] = [];
    const editorService = new FakeEditorService();
    const recorder = new FakeRecorder();
    const controller = new DictationController({
      editorService,
      getSettings: () => createSettings({ modelFilePath: '' }),
      notice: (message) => {
        notices.push(message);
      },
      recorder,
      setRibbonState: () => {},
      setStatusState: (state) => {
        states.push(state);
      },
      sidecarClient: {
        transcribeFile: vi.fn(),
      },
    });

    await controller.startDictation();

    expect(recorder.start).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('error');
    expect(notices.at(-1)).toContain('Configure a Whisper model file path');
  });

  it('records, transcribes, and inserts text into the active note', async () => {
    const modelFilePath = await createModelFile();
    const notices: string[] = [];
    const sidecarRequests: TranscribeFileRequestPayload[] = [];
    const statusStates: PluginRuntimeState[] = [];
    const editorService = new FakeEditorService();
    const recorder = new FakeRecorder();
    const controller = new DictationController({
      editorService,
      getSettings: () =>
        createSettings({
          modelFilePath,
          tempAudioDirectoryOverride: join(tmpdir(), 'obsidian-local-stt-tests'),
        }),
      notice: (message) => {
        notices.push(message);
      },
      recorder,
      setRibbonState: () => {},
      setStatusState: (state) => {
        statusStates.push(state);
      },
      sidecarClient: {
        transcribeFile: vi.fn(async (payload: TranscribeFileRequestPayload) => {
          sidecarRequests.push(payload);
          return {
            segments: [
              {
                endMs: 900,
                startMs: 0,
                text: 'hello obsidian',
              },
            ],
            text: 'hello obsidian',
          };
        }),
      },
    });

    await controller.startDictation();
    await controller.stopAndTranscribe();

    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(sidecarRequests).toHaveLength(1);
    expect(sidecarRequests[0]?.language).toBe('en');
    expect(sidecarRequests[0]?.modelFilePath).toBe(modelFilePath);
    expect(editorService.insertedText).toBe('hello obsidian');
    expect(statusStates).toContain('recording');
    expect(statusStates.at(-1)).toBe('idle');
    expect(notices.at(-1)).toBe('Inserted local transcript into the active note.');
  });

  it('rejects cancellation while transcription is in progress', async () => {
    const modelFilePath = await createModelFile();
    const notices: string[] = [];
    let releaseTranscription = () => {};
    const transcriptionStarted = new Promise<void>((resolve) => {
      releaseTranscription = resolve;
    });
    const controller = new DictationController({
      editorService: new FakeEditorService(),
      getSettings: () =>
        createSettings({
          modelFilePath,
        }),
      notice: (message) => {
        notices.push(message);
      },
      recorder: new FakeRecorder(),
      setRibbonState: () => {},
      setStatusState: () => {},
      sidecarClient: {
        transcribeFile: vi.fn(async () => {
          await transcriptionStarted;
          return {
            segments: [],
            text: 'done',
          };
        }),
      },
    });

    await controller.startDictation();
    const stopPromise = controller.stopAndTranscribe();
    await vi.waitFor(() => {
      expect(controller.getState()).toBe('transcribing');
    });

    await controller.cancelDictation();
    releaseTranscription();
    await stopPromise;

    expect(notices).toContain('Cancellation is not available while transcription is in progress.');
  });

  it('surfaces a bad temp audio override instead of failing silently', async () => {
    const modelFilePath = await createModelFile();
    const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-dictation-'));
    const invalidTempPath = join(tempDirectory, 'sidecar-binary');
    tempDirectories.push(tempDirectory);
    await writeFile(invalidTempPath, 'not a directory');

    const notices: string[] = [];
    const recorder = new FakeRecorder();
    const controller = new DictationController({
      editorService: new FakeEditorService(),
      getSettings: () =>
        createSettings({
          modelFilePath,
          tempAudioDirectoryOverride: invalidTempPath,
        }),
      notice: (message) => {
        notices.push(message);
      },
      recorder,
      setRibbonState: () => {},
      setStatusState: () => {},
      sidecarClient: {
        transcribeFile: vi.fn(),
      },
    });

    await controller.startDictation();
    await controller.stopAndTranscribe();

    expect(recorder.stop).not.toHaveBeenCalled();
    expect(notices.at(-1)).toContain(
      'Temp audio directory override must be a directory, not a file',
    );
  });
});

function createSettings(overrides: Partial<PluginSettings>): PluginSettings {
  return {
    insertionMode: 'insert_at_cursor',
    modelFilePath: '/tmp/models/ggml-large-v3-turbo.bin',
    sidecarPathOverride: '',
    sidecarRequestTimeoutMs: 300_000,
    sidecarStartupTimeoutMs: 4_000,
    tempAudioDirectoryOverride: '',
    ...overrides,
  };
}

async function createModelFile(): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-model-'));
  const modelFilePath = join(tempDirectory, 'ggml-small.en-q5_1.bin');
  tempDirectories.push(tempDirectory);
  await writeFile(modelFilePath, 'model placeholder');
  return modelFilePath;
}
