import type { App, Plugin } from 'obsidian';
import { Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import { resolveEngineCapabilities } from '../models/capability-view';
import { ManageModelsModal } from '../models/manage-models-modal';
import type { ModelInstallManager } from '../models/model-install-manager';
import { ExternalModelFileModal, ModelDetailsModal } from '../models/model-management-modals';
import { matchesModelTriple } from '../models/model-management-types';
import { getInstallCopy, type InstallIntent } from '../setup/sidecar-install-copy';
import { SidecarInstallModal } from '../setup/sidecar-install-modal';
import { formatErrorMessage } from '../shared/format-utils';
import type { PluginLogger } from '../shared/plugin-logger';
import { detectNvidiaDriver, type NvidiaDriverStatus } from '../sidecar/gpu-precheck';
import type { SpeakingStyle, SystemInfoEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import {
  type InstallManifest,
  readInstallManifest,
  type SidecarInstallVariant,
  uninstallSidecarVariant,
  variantDirectoryPath,
} from '../sidecar/sidecar-installer';
import { describeAcceleration } from './acceleration-info';
import { renderModelSection } from './model-settings-section';
import {
  type DictationAnchor,
  isDictationAnchor,
  isPhraseSeparator,
  isSpeakingStyle,
  type PhraseSeparator,
  type PluginSettings,
} from './plugin-settings';

interface SettingsTabDependencies {
  getSettings: () => PluginSettings;
  isDictationBusy: () => boolean;
  logger?: PluginLogger | undefined;
  modelInstallManager: ModelInstallManager;
  pluginVersion: string;
  resolvePluginDirectory: () => Promise<string>;
  restartSidecar: () => Promise<void>;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection: Pick<SidecarConnection, 'getSystemInfo' | 'shutdown'>;
}

const DICTATION_ANCHOR_OPTIONS: Array<{ label: string; value: DictationAnchor }> = [
  { label: 'At cursor', value: 'at_cursor' },
  { label: 'End of note', value: 'end_of_note' },
];

const PHRASE_SEPARATOR_OPTIONS: Array<{ label: string; value: PhraseSeparator }> = [
  { label: 'Space', value: 'space' },
  { label: 'New line', value: 'new_line' },
  { label: 'New paragraph (use this if you pause between thoughts)', value: 'new_paragraph' },
];

const SPEAKING_STYLE_OPTIONS: Array<{ label: string; value: SpeakingStyle }> = [
  { label: 'Responsive — ends utterances quickly after you stop talking', value: 'responsive' },
  { label: 'Balanced — standard detection (default)', value: 'balanced' },
  { label: 'Patient — waits longer through pauses', value: 'patient' },
];

export class LocalSttSettingTab extends PluginSettingTab {
  private disposeEngineSection: (() => void) | null = null;
  private disposeModelSection: (() => void) | null = null;
  private nvidiaDriverStatus: Promise<NvidiaDriverStatus> | null = null;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly dependencies: SettingsTabDependencies,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.tearDown();

    const { containerEl } = this;
    const settings = this.dependencies.getSettings();

    containerEl.empty();
    containerEl.createEl('h2', { text: 'Local Transcript' });
    containerEl.createEl('p', {
      text: 'Configure transcript placement, managed local models, listening mode, and the native sidecar.',
    });

    // --- Model ---
    new Setting(containerEl).setName('Model').setHeading();
    const modelSection = containerEl.createDiv();
    const manager = this.dependencies.modelInstallManager;
    this.disposeModelSection = renderModelSection(modelSection, manager, {
      onManageModels: () => {
        new ManageModelsModal(this.app, {
          manager,
          onChanged: () => {
            this.display();
          },
        }).open();
      },
      onExternalFile: () => {
        const selectedModel = this.dependencies.getSettings().selectedModel;
        new ExternalModelFileModal(
          this.app,
          selectedModel?.kind === 'external_file' ? selectedModel.filePath : '',
          {
            manager,
            onChanged: async () => {
              this.display();
            },
          },
        ).open();
      },
      onModelInfo: this.buildModelInfoCallback(manager, settings),
    });

    // --- Transcription ---
    new Setting(containerEl).setName('Transcription').setHeading();

    new Setting(containerEl)
      .setName('Listening mode')
      .setDesc(
        'Choose whether dictation keeps listening continuously or captures one utterance and stops.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('always_on', 'Always on');
        dropdown.addOption('one_sentence', 'One sentence');
        dropdown.setValue(settings.listeningMode);
        dropdown.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            listeningMode:
              value === 'always_on' || value === 'one_sentence' ? value : 'one_sentence',
          });
        });
      });

    new Setting(containerEl)
      .setName('Pause while processing')
      .setDesc(
        'When enabled, capture pauses while a previous utterance is being transcribed. Disable to keep capturing — utterances queue in order and the session stops if the queue saturates.',
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.pauseWhileProcessing);
        toggle.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            pauseWhileProcessing: value,
          });
        });
      });

    new Setting(containerEl)
      .setName('Speaking style')
      .setDesc('Tune how quickly utterances end after you stop speaking.')
      .addDropdown((dropdown) => {
        for (const option of SPEAKING_STYLE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(settings.speakingStyle);
        dropdown.onChange(async (value) => {
          if (!isSpeakingStyle(value)) {
            return;
          }
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            speakingStyle: value,
          });
        });
      });

    new Setting(containerEl)
      .setName('Dictation anchor')
      .setDesc(
        'Where each dictation session anchors. The first phrase lands here and stays pinned for the rest of the session, even if you click elsewhere in the note.',
      )
      .addDropdown((dropdown) => {
        for (const option of DICTATION_ANCHOR_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(settings.dictationAnchor);
        dropdown.onChange(async (value) => {
          if (!isDictationAnchor(value)) {
            return;
          }
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            dictationAnchor: value,
          });
        });
      });

    new Setting(containerEl)
      .setName('Phrase separator')
      .setDesc(
        'How consecutive phrases are joined within one session. Does not affect the first phrase.',
      )
      .addDropdown((dropdown) => {
        for (const option of PHRASE_SEPARATOR_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(settings.phraseSeparator);
        dropdown.onChange(async (value) => {
          if (!isPhraseSeparator(value)) {
            return;
          }
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            phraseSeparator: value,
          });
        });
      });

    // --- Engine options ---
    new Setting(containerEl).setName('Engine options').setHeading();
    const engineSection = containerEl.createDiv();
    void this.bindEngineOptions(engineSection, manager);
    const gpuSection = containerEl.createDiv();
    void this.renderGpuSidecarControls(gpuSection);

    // --- Advanced: Sidecar (collapsible) ---
    const advancedDetails = containerEl.createEl('details', { cls: 'local-stt-advanced' });
    advancedDetails.createEl('summary', { text: 'Advanced: Sidecar' });

    new Setting(advancedDetails)
      .setName('Sidecar path override')
      .setDesc('Optional absolute path to an installed or dev sidecar executable file.')
      .addText((text) => {
        text.setPlaceholder('Auto-detect from bin/cpu, bin/cuda, or native/target debug builds');
        text.setValue(settings.sidecarPathOverride);
        text.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            sidecarPathOverride: value.trim(),
          });
        });
      });

    if (Platform.isLinux) {
      new Setting(advancedDetails)
        .setName('CUDA library path')
        .setDesc(
          'Optional colon-separated library search path for the sidecar process only. Use this for Flatpak or custom CUDA installs without changing Obsidian\u2019s global environment.',
        )
        .addText((text) => {
          text.setPlaceholder(
            '/run/host/usr/local/cuda-12.9/targets/x86_64-linux/lib:/run/host/usr/lib64',
          );
          text.setValue(settings.cudaLibraryPath);
          text.onChange(async (value) => {
            await this.persistSettings({
              ...this.dependencies.getSettings(),
              cudaLibraryPath: value.trim(),
            });
          });
        });
    }

    new Setting(advancedDetails)
      .setName('Startup timeout (ms)')
      .setDesc('Maximum time allowed for the startup health handshake.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.setValue(String(settings.sidecarStartupTimeoutMs));
        text.onChange(async (value) => {
          const parsedValue = Number.parseInt(value, 10);

          if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
            return;
          }

          await this.persistSettings({
            ...this.dependencies.getSettings(),
            sidecarStartupTimeoutMs: parsedValue,
          });
        });
      });

    new Setting(advancedDetails)
      .setName('Request timeout (ms)')
      .setDesc(
        'Maximum time allowed for start, stop, cancel, health, and model-management requests before failing them.',
      )
      .addText((text) => {
        text.inputEl.type = 'number';
        text.setValue(String(settings.sidecarRequestTimeoutMs));
        text.onChange(async (value) => {
          const parsedValue = Number.parseInt(value, 10);

          if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
            return;
          }

          await this.persistSettings({
            ...this.dependencies.getSettings(),
            sidecarRequestTimeoutMs: parsedValue,
          });
        });
      });

    new Setting(advancedDetails)
      .setName('Model store folder override')
      .setDesc(
        'Optional absolute folder path for managed downloads. Leave blank to use the shared default model store.',
      )
      .addText((text) => {
        text.setPlaceholder('Use the shared default model store');
        text.setValue(settings.modelStorePathOverride);
        text.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            modelStorePathOverride: value.trim(),
          });
        });
      });

    new Setting(advancedDetails)
      .setName('Developer mode')
      .setDesc(
        'Log verbose diagnostic output to the developer console (Ctrl+Shift+I). Useful for debugging or reporting issues.',
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.developerMode);
        toggle.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            developerMode: value,
          });
        });
      });
  }

  override hide(): void {
    this.tearDown();
  }

  private tearDown(): void {
    this.disposeModelSection?.();
    this.disposeModelSection = null;
    this.disposeEngineSection?.();
    this.disposeEngineSection = null;
    this.nvidiaDriverStatus = null;
  }

  private buildModelInfoCallback(
    manager: ModelInstallManager,
    settings: PluginSettings,
  ): (() => void) | null {
    const sel = settings.selectedModel;

    if (sel === null || sel.kind !== 'catalog_model') {
      return null;
    }

    const { runtimeId, familyId, modelId } = sel;

    return () => {
      const state = manager.getState();
      const catalogModel = state.catalog.models.find((m) =>
        matchesModelTriple(m, runtimeId, familyId, modelId),
      );
      if (catalogModel === undefined) return;
      const installedModel = state.installedModels.find((m) =>
        matchesModelTriple(m, runtimeId, familyId, modelId),
      );
      const capabilities = resolveEngineCapabilities(
        state.compiledRuntimes,
        state.compiledAdapters,
        catalogModel.runtimeId,
        catalogModel.familyId,
      );
      new ModelDetailsModal(
        this.app,
        catalogModel,
        installedModel?.installPath ?? null,
        capabilities,
      ).open();
    };
  }

  private async bindEngineOptions(
    containerEl: HTMLDivElement,
    manager: ModelInstallManager,
  ): Promise<void> {
    const systemInfo = await this.fetchSystemInfo();
    this.renderEngineOptions(containerEl, systemInfo);
    this.disposeEngineSection = manager.subscribe(() => {
      this.renderEngineOptions(containerEl, systemInfo);
    });
  }

  private renderEngineOptions(
    containerEl: HTMLDivElement,
    systemInfo: SystemInfoEvent | null,
  ): void {
    const settings = this.dependencies.getSettings();
    const { label } = describeAcceleration(systemInfo, settings.accelerationPreference);

    containerEl.empty();

    const descFragment = document.createDocumentFragment();
    descFragment.createSpan({
      text: 'Use the GPU when available. Turn off to run every engine on CPU.',
    });
    descFragment.createEl('br');
    descFragment.createSpan({ text: `Currently: ${label}` });

    new Setting(containerEl)
      .setName('Hardware acceleration')
      .setDesc(descFragment)
      .addToggle((toggle) => {
        toggle.setValue(settings.accelerationPreference === 'auto');
        toggle.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            accelerationPreference: value ? 'auto' : 'cpu_only',
          });
          this.renderEngineOptions(containerEl, systemInfo);
        });
      });

    const caps = this.dependencies.modelInstallManager.getState().selectedModelCapabilities;
    if (caps.status === 'ready' && caps.capabilities.family.supportsInitialPrompt) {
      new Setting(containerEl)
        .setName('Use note as context')
        .setDesc(
          'Send a glossary of distinctive terms from the note as the engine’s prompt. Helps spell proper nouns and technical terms. Only used by engines that support initial prompts.',
        )
        .addToggle((toggle) => {
          toggle.setValue(settings.useNoteAsContext);
          toggle.onChange(async (value) => {
            await this.persistSettings({
              ...this.dependencies.getSettings(),
              useNoteAsContext: value,
            });
          });
        });
    }
  }

  private async renderGpuSidecarControls(containerEl: HTMLDivElement): Promise<void> {
    const pluginDirectory = await this.resolvePluginDirectorySafe();

    if (pluginDirectory === null) return;

    const [cpuManifest, cudaManifest] = await Promise.all([
      readInstallManifest(variantDirectoryPath(pluginDirectory, 'cpu')),
      readInstallManifest(variantDirectoryPath(pluginDirectory, 'cuda')),
    ]);

    this.renderInstalledStatus(containerEl, cpuManifest, cudaManifest);
    this.renderCpuInstallRow(containerEl, pluginDirectory, cpuManifest);

    if (Platform.isMacOS) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'On macOS, Metal acceleration is compiled into the sidecar binary — no separate install step. The toggle above auto-enables it when the sidecar is running.',
      });
      return;
    }

    if (cudaManifest === null) {
      await this.renderInstallCudaRow(containerEl, pluginDirectory);
    } else {
      this.renderUninstallCudaRow(containerEl, pluginDirectory);
    }
  }

  private renderCpuInstallRow(
    containerEl: HTMLDivElement,
    pluginDirectory: string,
    cpuManifest: InstallManifest | null,
  ): void {
    const isInstalled = cpuManifest !== null;
    const setting = new Setting(containerEl)
      .setName(isInstalled ? 'Reinstall CPU sidecar' : 'Install CPU sidecar')
      .setDesc(
        isInstalled
          ? 'Re-downloads the CPU sidecar archive from GitHub releases. Useful if the install looks corrupted.'
          : 'Downloads the CPU speech-to-text sidecar from GitHub releases. Required to run transcription.',
      );

    setting.addButton((button) => {
      button.setButtonText(isInstalled ? 'Reinstall' : 'Download CPU sidecar');
      if (!isInstalled) button.setCta();
      button.onClick(() => {
        this.openInstallModal(pluginDirectory, 'cpu', isInstalled ? 'reinstall' : 'install');
      });
    });
  }

  private renderInstalledStatus(
    containerEl: HTMLDivElement,
    cpuManifest: InstallManifest | null,
    cudaManifest: InstallManifest | null,
  ): void {
    const status = containerEl.createEl('p', { cls: 'setting-item-description' });
    status.setText(
      `Installed sidecars — CPU: ${formatInstalledStatus(cpuManifest)} · CUDA: ${formatInstalledStatus(cudaManifest)}`,
    );
  }

  private async renderInstallCudaRow(
    containerEl: HTMLDivElement,
    pluginDirectory: string,
  ): Promise<void> {
    // Memoize the nvidia-smi probe for the tab's lifetime. display() can fire
    // multiple times per tab open (e.g. after the accel toggle flips), and
    // spawning a child process on each render is wasteful. Cleared in
    // tearDown() so the driver state is re-probed next time the tab opens.
    if (this.nvidiaDriverStatus === null) {
      this.nvidiaDriverStatus = detectNvidiaDriver();
    }
    const driverStatus = await this.nvidiaDriverStatus;
    const driverReason = describeDriverStatus(driverStatus);

    const setting = new Setting(containerEl)
      .setName('Install CUDA acceleration')
      .setDesc(driverReason);

    setting.addButton((button) => {
      button.setButtonText('Install CUDA sidecar');
      if (driverStatus === 'absent') {
        button.setDisabled(true);
      } else if (driverStatus === 'present') {
        button.setCta();
      }
      button.onClick(() => {
        this.openCudaInstallModal(pluginDirectory);
      });
    });

    if (driverStatus === 'absent') {
      setting.addButton((button) => {
        button.setButtonText('Install anyway');
        button.setTooltip('Proceed with CUDA install even though no NVIDIA driver was detected.');
        button.onClick(() => {
          this.openCudaInstallModal(pluginDirectory);
        });
      });
    }
  }

  private renderUninstallCudaRow(containerEl: HTMLDivElement, pluginDirectory: string): void {
    new Setting(containerEl)
      .setName('Uninstall GPU acceleration')
      .setDesc('Removes the CUDA sidecar from this plugin directory and restarts on CPU.')
      .addButton((button) => {
        button.setButtonText('Uninstall CUDA sidecar');
        button.setWarning();
        button.onClick(() => {
          void this.handleUninstallCuda(pluginDirectory);
        });
      });
  }

  private openCudaInstallModal(pluginDirectory: string): void {
    this.openInstallModal(pluginDirectory, 'cuda', 'install', async () => {
      await this.persistSettings({
        ...this.dependencies.getSettings(),
        accelerationPreference: 'auto',
      });
    });
  }

  private openInstallModal(
    pluginDirectory: string,
    variant: SidecarInstallVariant,
    intent: InstallIntent,
    onInstalled?: () => Promise<void>,
  ): void {
    if (this.dependencies.isDictationBusy()) {
      new Notice('Stop dictation before installing a sidecar — the install restarts the engine.');
      return;
    }

    new SidecarInstallModal(this.app, {
      beforeReplace: async () => {
        await this.shutdownSidecarBeforeFileMutation(`${variant} install`);
      },
      copy: getInstallCopy(variant, intent),
      logger: this.dependencies.logger,
      onInstalled: async () => {
        await onInstalled?.();
        await this.dependencies.restartSidecar();
        await this.dependencies.modelInstallManager.init();
        this.display();
      },
      pluginDirectory,
      variant,
      version: this.dependencies.pluginVersion,
    }).open();
  }

  private async handleUninstallCuda(pluginDirectory: string): Promise<void> {
    if (this.dependencies.isDictationBusy()) {
      new Notice('Stop dictation before uninstalling the CUDA sidecar.');
      return;
    }

    await this.shutdownSidecarBeforeFileMutation('CUDA uninstall');

    try {
      await uninstallSidecarVariant(pluginDirectory, 'cuda');
      await this.dependencies.restartSidecar();
      new Notice('CUDA sidecar uninstalled. Running on CPU.');
      this.display();
    } catch (error) {
      this.dependencies.logger?.error('installer', 'failed to uninstall CUDA sidecar', error);
      new Notice(`Failed to uninstall CUDA sidecar: ${formatErrorMessage(error)}`);
    }
  }

  private async shutdownSidecarBeforeFileMutation(reason: string): Promise<void> {
    // Windows holds DLL handles on the live sidecar process, so install and
    // uninstall paths must stop it before removing or replacing bin/*.
    try {
      await this.dependencies.sidecarConnection.shutdown();
    } catch (error) {
      this.dependencies.logger?.warn(
        'installer',
        `sidecar shutdown failed before ${reason}; proceeding`,
        error,
      );
    }
  }

  private async resolvePluginDirectorySafe(): Promise<string | null> {
    try {
      return await this.dependencies.resolvePluginDirectory();
    } catch (error) {
      this.dependencies.logger?.error('installer', 'failed to resolve plugin directory', error);
      return null;
    }
  }

  private async fetchSystemInfo(): Promise<SystemInfoEvent | null> {
    try {
      return await this.dependencies.sidecarConnection.getSystemInfo();
    } catch {
      return null;
    }
  }

  private async persistSettings(nextSettings: PluginSettings): Promise<void> {
    await this.dependencies.saveSettings(nextSettings);
  }
}

function formatInstalledStatus(manifest: InstallManifest | null): string {
  if (manifest === null) return 'not installed';
  return manifest.version;
}

function describeDriverStatus(status: NvidiaDriverStatus): string {
  switch (status) {
    case 'present':
      return 'NVIDIA driver detected. Downloads the CUDA sidecar archive from GitHub releases.';
    case 'absent':
      return 'No NVIDIA driver detected (nvidia-smi not on PATH). Use "Install anyway" if you are certain your system supports CUDA.';
    case 'unknown':
      return 'Unable to probe for an NVIDIA driver. Proceed only if you know your GPU supports CUDA.';
  }
}
