import { dirname, join } from 'node:path';

import { FileSystemAdapter, Notice, Platform, Plugin } from 'obsidian';

import { AudioCaptureStream } from './audio/audio-capture-stream';
import { PCM_RECORDER_WORKLET_OUTPUT_PATH } from './audio/pcm-recorder-worklet-shared';
import { registerCommands } from './commands/register-commands';
import { DictationSessionController } from './dictation/dictation-session-controller';
import { dictationAnchorExtension } from './editor/dictation-anchor-extension';
import { EditorService } from './editor/editor-service';
import { assertAbsoluteExistingFilePath, getExistingPathKind } from './filesystem/path-validation';
import { ModelInstallManager } from './models/model-install-manager';
import { logAccelerationFallbacks } from './settings/acceleration-info';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type PluginSettings,
  resolvePluginSettings,
} from './settings/plugin-settings';
import { LocalSttSettingTab } from './settings/settings-tab';
import { formatErrorMessage } from './shared/format-utils';
import { createPluginLogger, type PluginLogger } from './shared/plugin-logger';
import { assertSidecarExecutableIsFresh } from './sidecar/sidecar-build-state';
import { SidecarConnection } from './sidecar/sidecar-connection';
import type { SidecarLaunchSpec } from './sidecar/sidecar-process';
import { DictationRibbonController } from './ui/dictation-ribbon';

const SIDECAR_BINARY_BASENAME = 'obsidian-local-stt-sidecar';

export default class LocalSttPlugin extends Plugin {
  private audioCaptureStream: AudioCaptureStream | null = null;
  private dictationController: DictationSessionController | null = null;
  private editorService: EditorService | null = null;
  private logger: PluginLogger = createPluginLogger(() => this.settings.developerMode);
  private modelInstallManager: ModelInstallManager | null = null;
  private ribbonController: DictationRibbonController | null = null;
  private settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private sidecarConnection: SidecarConnection | null = null;

  override async onload(): Promise<void> {
    this.settings = resolvePluginSettings(await this.loadData());

    this.registerEditorExtension(dictationAnchorExtension());
    this.editorService = new EditorService(this.app, this);
    this.sidecarConnection = new SidecarConnection({
      getRequestTimeoutMs: () => this.settings.sidecarRequestTimeoutMs,
      logger: this.logger,
      resolveLaunchSpec: async () => this.resolveSidecarLaunchSpec(),
    });
    this.audioCaptureStream = new AudioCaptureStream({
      logger: this.logger,
      resolveWorkletModulePath: async () => this.resolveRecorderWorkletModulePath(),
    });
    this.modelInstallManager = new ModelInstallManager({
      getSettings: () => this.settings,
      logger: this.logger,
      saveSettings: async (nextSettings) => {
        await this.updateSettings(nextSettings);
      },
      sidecarConnection: this.sidecarConnection,
    });

    const ribbonElement = this.addRibbonIcon('mic', 'Local STT: Click to start', () => {
      this.requireDictationController().handleRibbonClick();
    });
    this.ribbonController = new DictationRibbonController(ribbonElement);
    this.dictationController = new DictationSessionController({
      captureStream: this.audioCaptureStream,
      editorService: this.editorService,
      getSettings: () => this.settings,
      logger: this.logger,
      notice: (message) => {
        new Notice(message);
      },
      setRibbonState: (state) => {
        this.ribbonController?.setState(state);
      },
      sidecarConnection: this.sidecarConnection,
    });

    this.addSettingTab(
      new LocalSttSettingTab(this.app, this, {
        getSettings: () => this.settings,
        modelInstallManager: this.requireModelInstallManager(),
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

    try {
      await this.checkSidecarHealth({ showNotice: false });
      const systemInfo = await this.requireSidecarConnection().getSystemInfo();
      logAccelerationFallbacks(systemInfo, this.settings.accelerationPreference, this.logger);
    } catch (error) {
      this.logger.error('sidecar', 'initial startup check failed', error);
    }

    this.modelInstallManager?.init().catch((error: unknown) => {
      this.logger.error('model', 'model install manager init failed', error);
    });
  }

  override async onunload(): Promise<void> {
    try {
      this.modelInstallManager?.dispose();
    } catch (error) {
      this.logger.error('model', 'failed to dispose model install manager cleanly', error);
    }

    try {
      await this.dictationController?.dispose();
    } catch (error) {
      this.logger.error('session', 'failed to dispose dictation controller cleanly', error);
    }

    try {
      await this.sidecarConnection?.shutdown();
    } catch (error) {
      this.logger.error('sidecar', 'failed to shut down sidecar cleanly', error);
    } finally {
      this.sidecarConnection?.dispose();
    }

    this.ribbonController?.dispose();
  }

  private async checkSidecarHealth(options: { showNotice?: boolean } = {}): Promise<void> {
    const sidecarConnection = this.requireSidecarConnection();

    try {
      const health = await sidecarConnection.healthCheck(this.settings.sidecarStartupTimeoutMs);

      if (options.showNotice ?? true) {
        new Notice(`Local STT sidecar is ready (${health.sidecarVersion}).`);
      }
    } catch (error) {
      this.handleError('Sidecar health check failed', error, options.showNotice ?? true);
      throw error;
    }
  }

  private handleError(message: string, error: unknown, showNotice: boolean): void {
    if (showNotice) {
      new Notice(`${message}: ${formatErrorMessage(error)}`);
    }
  }

  private async restartSidecar(): Promise<void> {
    if (this.requireDictationController().isBusy()) {
      new Notice('Restart the sidecar only when dictation is idle.');
      return;
    }

    const sidecarConnection = this.requireSidecarConnection();

    try {
      const health = await sidecarConnection.restart(this.settings.sidecarStartupTimeoutMs);

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

  private requireModelInstallManager(): ModelInstallManager {
    if (this.modelInstallManager === null) {
      throw new Error('Model install manager has not been initialized.');
    }

    return this.modelInstallManager;
  }

  private async resolveSidecarLaunchSpec(): Promise<SidecarLaunchSpec> {
    const executablePath = await this.resolveSidecarExecutablePath();
    const env =
      Platform.isLinux && this.settings.cudaLibraryPath.length > 0
        ? {
            LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
              ? `${this.settings.cudaLibraryPath}:${process.env.LD_LIBRARY_PATH}`
              : this.settings.cudaLibraryPath,
          }
        : undefined;

    return {
      args: ['--app-version', this.manifest.version],
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
    const sidecarProjectDirectory = join(pluginDirectory, 'native');
    const executablePath = join(
      sidecarProjectDirectory,
      'target',
      'debug',
      getSidecarExecutableName(),
    );
    const pathKind = await getExistingPathKind(executablePath);

    if (pathKind === 'missing') {
      throw new Error(
        `Sidecar executable was not found at ${executablePath}. Build native first or configure Sidecar path override.`,
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
}

function getSidecarExecutableName(): string {
  return Platform.isWin ? `${SIDECAR_BINARY_BASENAME}.exe` : SIDECAR_BINARY_BASENAME;
}
