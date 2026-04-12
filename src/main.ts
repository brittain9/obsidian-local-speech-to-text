import { dirname, join } from 'node:path';

import { FileSystemAdapter, Notice, Platform, Plugin } from 'obsidian';

import { AudioCaptureStream } from './audio/audio-capture-stream';
import { PCM_RECORDER_WORKLET_OUTPUT_PATH } from './audio/pcm-recorder-worklet-shared';
import { PRESS_AND_HOLD_GATE_COMMAND_ID, registerCommands } from './commands/register-commands';
import { DictationSessionController } from './dictation/dictation-session-controller';
import { EditorService } from './editor/editor-service';
import { assertAbsoluteExistingFilePath, getExistingPathKind } from './filesystem/path-validation';
import { ModelManagementService } from './models/model-management-service';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type PluginSettings,
  resolvePluginSettings,
} from './settings/plugin-settings';
import { LocalSttSettingTab } from './settings/settings-tab';
import { createPluginLogger, type PluginLogger } from './shared/plugin-logger';
import { assertSidecarExecutableIsFresh } from './sidecar/sidecar-build-state';
import { SidecarConnection } from './sidecar/sidecar-connection';
import type { SidecarLaunchSpec } from './sidecar/sidecar-process';
import { DictationRibbonController } from './ui/dictation-ribbon';
import { StatusBarController } from './ui/status-bar';

const SIDECAR_BINARY_BASENAME = 'obsidian-local-stt-sidecar';

export default class LocalSttPlugin extends Plugin {
  private audioCaptureStream: AudioCaptureStream | null = null;
  private dictationController: DictationSessionController | null = null;
  private editorService: EditorService | null = null;
  private logger: PluginLogger = createPluginLogger(() => this.settings.developerMode);
  private modelManagementService: ModelManagementService | null = null;
  private ribbonController: DictationRibbonController | null = null;
  private settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private sidecarConnection: SidecarConnection | null = null;
  private statusBar: StatusBarController | null = null;

  override async onload(): Promise<void> {
    this.settings = resolvePluginSettings(await this.loadData());

    this.editorService = new EditorService(this.app);
    this.statusBar = new StatusBarController(this.addStatusBarItem());
    this.sidecarConnection = new SidecarConnection({
      getRequestTimeoutMs: () => this.settings.sidecarRequestTimeoutMs,
      logger: this.logger,
      resolveLaunchSpec: async () => this.resolveSidecarLaunchSpec(),
    });
    this.audioCaptureStream = new AudioCaptureStream({
      logger: this.logger,
      resolveWorkletModulePath: async () => this.resolveRecorderWorkletModulePath(),
    });
    this.modelManagementService = new ModelManagementService({
      getSettings: () => this.settings,
      logger: this.logger,
      saveSettings: async (nextSettings) => {
        await this.updateSettings(nextSettings);
      },
      sidecarConnection: this.sidecarConnection,
    });

    const ribbonElement = this.addRibbonIcon('mic', 'Local STT: Start Dictation Session', () => {
      this.requireDictationController().handleRibbonClick();
    });
    this.ribbonController = new DictationRibbonController(ribbonElement);
    this.dictationController = new DictationSessionController({
      app: this.app,
      captureStream: this.audioCaptureStream,
      editorService: this.editorService,
      getSettings: () => this.settings,
      logger: this.logger,
      notice: (message) => {
        new Notice(message);
      },
      pressAndHoldGateCommandId: `${this.manifest.id}:${PRESS_AND_HOLD_GATE_COMMAND_ID}`,
      setRibbonState: (state) => {
        this.ribbonController?.setState(state);
      },
      setStatusState: (state, detail) => {
        this.statusBar?.setState(state, detail);
      },
      sidecarConnection: this.sidecarConnection,
    });

    this.registerDomEvent(this.ribbonController.getElement(), 'pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      this.requireDictationController().handleRibbonPointerDown();
    });
    this.registerDomEvent(window, 'pointerup', () => {
      this.requireDictationController().handleRibbonPointerUp();
    });
    this.registerDomEvent(document, 'keydown', (event) => {
      this.requireDictationController().handleDocumentKeyDown(event);
    });
    this.registerDomEvent(document, 'keyup', (event) => {
      this.requireDictationController().handleDocumentKeyUp(event);
    });

    this.addSettingTab(
      new LocalSttSettingTab(this.app, this, {
        getSettings: () => this.settings,
        modelManagementService: this.requireModelManagementService(),
        saveSettings: async (nextSettings) => {
          await this.updateSettings(nextSettings);
        },
        sidecarConnection: this.requireSidecarConnection(),
      }),
    );

    registerCommands({
      cancelDictation: async () => this.requireDictationController().cancelDictation(),
      checkSidecarHealth: async () => this.checkSidecarHealth(),
      plugin: this,
      restartSidecar: async () => this.restartSidecar(),
      startDictation: async () => this.requireDictationController().startDictation(),
      stopDictation: async () => this.requireDictationController().stopDictation(),
    });

    await this.checkSidecarHealth({ showNotice: false }).catch((error: unknown) => {
      this.logger.error('sidecar', 'initial health check failed', error);
    });
  }

  override async onunload(): Promise<void> {
    try {
      this.modelManagementService?.dispose();
    } catch (error) {
      this.logger.error('model', 'failed to dispose model management service cleanly', error);
    }

    try {
      await this.dictationController?.dispose();
    } catch (error) {
      this.logger.error('session', 'failed to dispose dictation controller cleanly', error);
    }

    try {
      await this.sidecarConnection?.shutdown(this.settings.sidecarStartupTimeoutMs);
    } catch (error) {
      this.logger.error('sidecar', 'failed to shut down sidecar cleanly', error);
    }

    this.ribbonController?.dispose();
    this.statusBar?.dispose();
  }

  private async checkSidecarHealth(options: { showNotice?: boolean } = {}): Promise<void> {
    const sidecarConnection = this.requireSidecarConnection();

    this.statusBar?.setState('starting', 'health check');

    try {
      const health = await sidecarConnection.healthCheck(this.settings.sidecarStartupTimeoutMs);

      this.statusBar?.setState('idle', `sidecar v${health.sidecarVersion}`);

      if (options.showNotice ?? true) {
        new Notice(`Local STT sidecar is ready (${health.sidecarVersion}).`);
      }
    } catch (error) {
      this.handleError('Sidecar health check failed', error, options.showNotice ?? true);
      throw error;
    }
  }

  private handleError(message: string, error: unknown, showNotice: boolean): void {
    const detail = error instanceof Error ? error.message : String(error);

    this.statusBar?.setState('error', detail);

    if (showNotice) {
      new Notice(`${message}: ${detail}`);
    }
  }

  private async restartSidecar(): Promise<void> {
    if (this.requireDictationController().isBusy()) {
      new Notice('Restart the sidecar only when dictation is idle.');
      return;
    }

    const sidecarConnection = this.requireSidecarConnection();

    this.statusBar?.setState('starting', 'restarting');

    try {
      const health = await sidecarConnection.restart(this.settings.sidecarStartupTimeoutMs);

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

  private requireDictationController(): DictationSessionController {
    if (this.dictationController === null) {
      throw new Error('Dictation controller has not been initialized.');
    }

    return this.dictationController;
  }

  private requireSidecarConnection(): SidecarConnection {
    if (this.sidecarConnection === null) {
      throw new Error('Sidecar connection has not been initialized.');
    }

    return this.sidecarConnection;
  }

  private requireModelManagementService(): ModelManagementService {
    if (this.modelManagementService === null) {
      throw new Error('Model management service has not been initialized.');
    }

    return this.modelManagementService;
  }

  private async resolveSidecarLaunchSpec(): Promise<SidecarLaunchSpec> {
    const executablePath = await this.resolveSidecarExecutablePath();
    const catalogPath = await this.resolveModelCatalogPath();
    const env =
      Platform.isLinux && this.settings.cudaLibraryPath.length > 0
        ? {
            LD_LIBRARY_PATH: this.settings.cudaLibraryPath,
          }
        : undefined;

    return {
      args: ['--catalog-path', catalogPath, '--app-version', this.manifest.version],
      command: executablePath,
      cwd: dirname(executablePath),
      ...(env ? { env } : {}),
    };
  }

  private async resolveSidecarExecutablePath(): Promise<string> {
    const overridePath = this.settings.sidecarPathOverride.trim();

    if (overridePath.length > 0) {
      return assertAbsoluteExistingFilePath(overridePath, 'Sidecar path override');
    }

    const pluginDirectory = await this.resolvePluginDirectoryPath();
    const sidecarProjectDirectory = join(pluginDirectory, 'native', 'sidecar');
    const executablePath = join(
      sidecarProjectDirectory,
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

    await assertSidecarExecutableIsFresh(executablePath, sidecarProjectDirectory);

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

  private async resolveModelCatalogPath(): Promise<string> {
    return assertAbsoluteExistingFilePath(
      join(await this.resolvePluginDirectoryPath(), 'config', 'model-catalog.json'),
      'Bundled model catalog path',
    );
  }
}

function getSidecarExecutableName(): string {
  return Platform.isWin ? `${SIDECAR_BINARY_BASENAME}.exe` : SIDECAR_BINARY_BASENAME;
}
