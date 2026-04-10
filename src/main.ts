import { FileSystemAdapter, Notice, Platform, Plugin } from 'obsidian';

import { registerCommands } from './commands/register-commands';
import { EditorService } from './editor/editor-service';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type PluginSettings,
  resolvePluginSettings,
} from './settings/plugin-settings';
import { LocalSttSettingTab } from './settings/settings-tab';
import { SidecarClient } from './sidecar/sidecar-client';
import type { SidecarLaunchSpec } from './sidecar/sidecar-process';
import { StatusBarController } from './ui/status-bar';

const BOOTSTRAP_INSERTION_TEXT = 'Local STT bootstrap path is wired correctly.\n';
const SIDECAR_BINARY_BASENAME = 'obsidian-local-stt-sidecar';

export default class LocalSttPlugin extends Plugin {
  private editorService: EditorService | null = null;
  private settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private sidecarClient: SidecarClient | null = null;
  private statusBar: StatusBarController | null = null;

  override async onload(): Promise<void> {
    this.settings = resolvePluginSettings(await this.loadData());
    this.editorService = new EditorService(this.app);
    this.statusBar = new StatusBarController(this.addStatusBarItem());
    this.sidecarClient = new SidecarClient({
      getRequestTimeoutMs: () => this.settings.sidecarRequestTimeoutMs,
      logger: (message, error) => {
        console.error('[Local STT]', message, error);
      },
      resolveLaunchSpec: async () => this.resolveSidecarLaunchSpec(),
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
      checkSidecarHealth: async () => this.checkSidecarHealth(),
      insertBootstrapText: () => this.insertBootstrapText(),
      insertMockTranscript: async () => this.insertMockTranscript(),
      plugin: this,
      restartSidecar: async () => this.restartSidecar(),
    });

    await this.checkSidecarHealth({ showNotice: false }).catch((error: unknown) => {
      console.error('[Local STT] initial sidecar health check failed', error);
    });
  }

  override async onunload(): Promise<void> {
    try {
      await this.sidecarClient?.shutdown();
    } catch (error) {
      console.error('[Local STT] failed to shut down sidecar cleanly', error);
    }

    this.statusBar?.dispose();
  }

  private async checkSidecarHealth(options: { showNotice?: boolean } = {}): Promise<void> {
    const sidecarClient = this.requireSidecarClient();

    this.statusBar?.setState('starting', 'health check');

    try {
      const health = await withTimeout(
        sidecarClient.healthCheck(),
        this.settings.sidecarStartupTimeoutMs,
        'Sidecar startup health check timed out.',
      );

      this.statusBar?.setState('ready', `v${health.sidecarVersion}`);

      if (options.showNotice ?? true) {
        new Notice(`Local STT sidecar is ready (${health.sidecarVersion}).`);
      }
    } catch (error) {
      this.handleError('Sidecar health check failed', error, options.showNotice ?? true);
      throw error;
    }
  }

  private insertBootstrapText(): void {
    try {
      this.requireEditorService().insertTextAtCursor(BOOTSTRAP_INSERTION_TEXT);
      this.statusBar?.setState('idle');
      new Notice('Inserted bootstrap text into the active note.');
    } catch (error) {
      this.handleError('Failed to insert bootstrap text', error, true);
    }
  }

  private async insertMockTranscript(): Promise<void> {
    const sidecarClient = this.requireSidecarClient();

    this.statusBar?.setState('starting', 'transcribing');

    try {
      const transcript = await sidecarClient.transcribeMock();
      this.requireEditorService().insertTextAtCursor(transcript.text);
      this.statusBar?.setState('ready', 'mock transcript');
      new Notice('Inserted mock transcript from the local sidecar.');
    } catch (error) {
      this.handleError('Mock transcription failed', error, true);
    }
  }

  private async restartSidecar(): Promise<void> {
    const sidecarClient = this.requireSidecarClient();

    this.statusBar?.setState('starting', 'restarting');

    try {
      const health = await withTimeout(
        sidecarClient.restart(),
        this.settings.sidecarStartupTimeoutMs,
        'Sidecar restart timed out.',
      );

      this.statusBar?.setState('ready', `v${health.sidecarVersion}`);
      new Notice(`Restarted Local STT sidecar (${health.sidecarVersion}).`);
    } catch (error) {
      this.handleError('Sidecar restart failed', error, true);
    }
  }

  private async updateSettings(nextSettings: PluginSettings): Promise<void> {
    this.settings = nextSettings;
    await this.saveData(this.settings);
  }

  private requireEditorService(): EditorService {
    if (this.editorService === null) {
      throw new Error('Editor service has not been initialized.');
    }

    return this.editorService;
  }

  private requireSidecarClient(): SidecarClient {
    if (this.sidecarClient === null) {
      throw new Error('Sidecar client has not been initialized.');
    }

    return this.sidecarClient;
  }

  private async resolveSidecarLaunchSpec(): Promise<SidecarLaunchSpec> {
    const executablePath = await this.resolveSidecarExecutablePath();
    const { dirname } = await import('node:path');

    return {
      command: executablePath,
      cwd: dirname(executablePath),
    };
  }

  private async resolveSidecarExecutablePath(): Promise<string> {
    const overridePath = this.settings.sidecarPathOverride.trim();

    if (overridePath.length > 0) {
      return overridePath;
    }

    const pluginDirectory = await this.resolvePluginDirectoryPath();
    const { join } = await import('node:path');

    return join(
      pluginDirectory,
      'native',
      'sidecar',
      'target',
      'debug',
      getSidecarExecutableName(),
    );
  }

  private async resolvePluginDirectoryPath(): Promise<string> {
    if (!Platform.isDesktopApp) {
      throw new Error('Local STT requires Obsidian desktop.');
    }

    const vaultAdapter = this.app.vault.adapter;

    if (!(vaultAdapter instanceof FileSystemAdapter)) {
      throw new Error('The current vault adapter does not expose a filesystem path.');
    }

    const { join } = await import('node:path');

    return join(vaultAdapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
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

function getSidecarExecutableName(): string {
  return Platform.isWin ? `${SIDECAR_BINARY_BASENAME}.exe` : SIDECAR_BINARY_BASENAME;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = globalThis.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      globalThis.clearTimeout(timeoutHandle);
    }
  }
}
