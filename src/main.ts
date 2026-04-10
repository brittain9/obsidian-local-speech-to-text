import { dirname, join } from 'node:path';

import { FileSystemAdapter, Notice, Platform, Plugin } from 'obsidian';

import { MicrophoneRecorder } from './audio/microphone-recorder';
import { PCM_RECORDER_WORKLET_OUTPUT_PATH } from './audio/pcm-recorder-worklet-shared';
import { registerCommands } from './commands/register-commands';
import { DictationController } from './dictation/dictation-controller';
import { EditorService } from './editor/editor-service';
import { assertAbsoluteExistingFilePath, getExistingPathKind } from './filesystem/path-validation';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type PluginSettings,
  resolvePluginSettings,
} from './settings/plugin-settings';
import { normalizePersistedPluginSettings } from './settings/settings-normalization';
import { LocalSttSettingTab } from './settings/settings-tab';
import { SidecarClient } from './sidecar/sidecar-client';
import type { SidecarLogEntry } from './sidecar/sidecar-logging';
import type { SidecarLaunchSpec } from './sidecar/sidecar-process';
import { DictationRibbonController } from './ui/dictation-ribbon';
import { StatusBarController } from './ui/status-bar';

const SIDECAR_BINARY_BASENAME = 'obsidian-local-stt-sidecar';

export default class LocalSttPlugin extends Plugin {
  private dictationController: DictationController | null = null;
  private editorService: EditorService | null = null;
  private microphoneRecorder: MicrophoneRecorder | null = null;
  private ribbonController: DictationRibbonController | null = null;
  private settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private sidecarClient: SidecarClient | null = null;
  private statusBar: StatusBarController | null = null;

  override async onload(): Promise<void> {
    const loadedSettings = resolvePluginSettings(await this.loadData());
    const normalizedSettings = await normalizePersistedPluginSettings(loadedSettings);
    this.settings = normalizedSettings.settings;

    if (normalizedSettings.didChange) {
      await this.saveData(this.settings);

      for (const message of normalizedSettings.messages) {
        console.warn('[Local STT]', message);
        new Notice(`Local STT: ${message}`);
      }
    }

    this.editorService = new EditorService(this.app);
    this.statusBar = new StatusBarController(this.addStatusBarItem());
    this.sidecarClient = new SidecarClient({
      getRequestTimeoutMs: () => this.settings.sidecarRequestTimeoutMs,
      logger: (entry) => {
        writePluginLog('[Local STT]', entry);
      },
      resolveLaunchSpec: async () => this.resolveSidecarLaunchSpec(),
    });
    this.microphoneRecorder = new MicrophoneRecorder({
      logger: (message, error) => {
        writePluginLog('[Local STT] microphone recorder', {
          error,
          level: error === undefined ? 'warn' : 'error',
          message,
        });
      },
      resolveWorkletModulePath: async () => this.resolveRecorderWorkletModulePath(),
    });
    this.ribbonController = new DictationRibbonController(
      this.addRibbonIcon('mic', 'Local STT: Start Dictation', async () => {
        await this.requireDictationController().toggleDictation();
      }),
    );
    this.dictationController = new DictationController({
      editorService: this.editorService,
      getSettings: () => this.settings,
      logger: (message, error) => {
        writePluginLog('[Local STT]', {
          error,
          level: error === undefined ? 'warn' : 'error',
          message,
        });
      },
      notice: (message) => {
        new Notice(message);
      },
      recorder: this.microphoneRecorder,
      setRibbonState: (state) => {
        this.ribbonController?.setState(state);
      },
      setStatusState: (state, detail) => {
        this.statusBar?.setState(state, detail);
      },
      sidecarClient: this.sidecarClient,
    });

    this.addSettingTab(
      new LocalSttSettingTab(this.app, this, {
        getSettings: () => this.settings,
        saveSettings: async (nextSettings) => {
          await this.updateSettings(nextSettings);
        },
      }),
    );

    registerCommands({
      cancelDictation: async () => this.requireDictationController().cancelDictation(),
      checkSidecarHealth: async () => this.checkSidecarHealth(),
      plugin: this,
      restartSidecar: async () => this.restartSidecar(),
      startDictation: async () => this.requireDictationController().startDictation(),
      stopAndTranscribe: async () => this.requireDictationController().stopAndTranscribe(),
    });

    await this.checkSidecarHealth({ showNotice: false }).catch((error: unknown) => {
      console.error('[Local STT] initial sidecar health check failed', error);
    });
  }

  override async onunload(): Promise<void> {
    try {
      await this.dictationController?.dispose();
    } catch (error) {
      console.error('[Local STT] failed to dispose dictation controller cleanly', error);
    }

    try {
      await this.sidecarClient?.shutdown(this.settings.sidecarStartupTimeoutMs);
    } catch (error) {
      console.error('[Local STT] failed to shut down sidecar cleanly', error);
    }

    this.ribbonController?.dispose();
    this.statusBar?.dispose();
  }

  private async checkSidecarHealth(options: { showNotice?: boolean } = {}): Promise<void> {
    const sidecarClient = this.requireSidecarClient();

    this.statusBar?.setState('starting', 'health check');

    try {
      const health = await sidecarClient.healthCheck(this.settings.sidecarStartupTimeoutMs);

      this.statusBar?.setState('idle', `sidecar v${health.sidecarVersion}`);

      if (options.showNotice ?? true) {
        new Notice(`Local STT sidecar is ready (${health.sidecarVersion}).`);
      }
    } catch (error) {
      this.handleError('Sidecar health check failed', error, options.showNotice ?? true);
      throw error;
    }
  }

  private async restartSidecar(): Promise<void> {
    if (this.requireDictationController().isBusy()) {
      new Notice('Restart the sidecar only when dictation is idle.');
      return;
    }

    const sidecarClient = this.requireSidecarClient();

    this.statusBar?.setState('starting', 'restarting');

    try {
      const health = await sidecarClient.restart(this.settings.sidecarStartupTimeoutMs);

      this.statusBar?.setState('idle', `sidecar v${health.sidecarVersion}`);
      new Notice(`Restarted Local STT sidecar (${health.sidecarVersion}).`);
    } catch (error) {
      this.handleError('Sidecar restart failed', error, true);
    }
  }

  private async updateSettings(nextSettings: PluginSettings): Promise<void> {
    this.settings = resolvePluginSettings(nextSettings);
    await this.saveData(this.settings);
  }

  private requireEditorService(): EditorService {
    if (this.editorService === null) {
      throw new Error('Editor service has not been initialized.');
    }

    return this.editorService;
  }

  private requireDictationController(): DictationController {
    if (this.dictationController === null) {
      throw new Error('Dictation controller has not been initialized.');
    }

    return this.dictationController;
  }

  private requireSidecarClient(): SidecarClient {
    if (this.sidecarClient === null) {
      throw new Error('Sidecar client has not been initialized.');
    }

    return this.sidecarClient;
  }

  private async resolveSidecarLaunchSpec(): Promise<SidecarLaunchSpec> {
    const executablePath = await this.resolveSidecarExecutablePath();

    return {
      command: executablePath,
      cwd: dirname(executablePath),
    };
  }

  private async resolveSidecarExecutablePath(): Promise<string> {
    const overridePath = this.settings.sidecarPathOverride.trim();

    if (overridePath.length > 0) {
      return assertAbsoluteExistingFilePath(overridePath, 'Sidecar path override');
    }

    const pluginDirectory = await this.resolvePluginDirectoryPath();
    const executablePath = join(
      pluginDirectory,
      'native',
      'sidecar',
      'target',
      'debug',
      getSidecarExecutableName(),
    );
    const pathKind = await getExistingPathKind(executablePath);

    if (pathKind === 'missing') {
      throw new Error(
        `Sidecar executable was not found at ${executablePath}. Build native/sidecar first or configure Sidecar path override.`,
      );
    }

    if (pathKind !== 'file') {
      throw new Error(`Sidecar executable path must point to a file: ${executablePath}`);
    }

    return executablePath;
  }

  private async resolvePluginDirectoryPath(): Promise<string> {
    if (!Platform.isDesktopApp) {
      throw new Error('Local STT requires Obsidian desktop.');
    }

    const vaultAdapter = this.app.vault.adapter;

    if (!(vaultAdapter instanceof FileSystemAdapter)) {
      throw new Error('The current vault adapter does not expose a filesystem path.');
    }

    return join(vaultAdapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  private async resolveRecorderWorkletModulePath(): Promise<string> {
    return join(await this.resolvePluginDirectoryPath(), PCM_RECORDER_WORKLET_OUTPUT_PATH);
  }

  private handleError(message: string, error: unknown, showNotice: boolean): void {
    const detail = error instanceof Error ? error.message : String(error);

    console.error(`[Local STT] ${message}`, error);
    this.statusBar?.setState('error', detail);

    if (showNotice) {
      new Notice(`${message}: ${detail}`);
    }
  }
}

type PluginLogLevel = SidecarLogEntry['level'] | 'error' | 'info';

interface PluginLogEntry {
  level: PluginLogLevel;
  message: string;
  error?: unknown;
}

function writePluginLog(prefix: string, entry: PluginLogEntry): void {
  const logMethod = resolveConsoleMethod(entry.level);

  if (entry.error === undefined) {
    logMethod(prefix, entry.message);
    return;
  }

  logMethod(prefix, entry.message, entry.error);
}

function resolveConsoleMethod(level: PluginLogLevel): typeof console.debug {
  switch (level) {
    case 'debug':
      return console.debug;
    case 'info':
      return console.info;
    case 'warn':
      return console.warn;
    case 'error':
      return console.error;
  }
}

function getSidecarExecutableName(): string {
  return Platform.isWin ? `${SIDECAR_BINARY_BASENAME}.exe` : SIDECAR_BINARY_BASENAME;
}
