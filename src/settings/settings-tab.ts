import type { App, Plugin } from 'obsidian';
import { Platform, PluginSettingTab, Setting } from 'obsidian';
import { ManageModelsModal } from '../models/manage-models-modal';
import type { ModelInstallManager } from '../models/model-install-manager';
import { ExternalModelFileModal, ModelDetailsModal } from '../models/model-management-modals';
import type { SpeakingStyle, SystemInfoEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import { buildAccelerationSummary, buildEffectiveBackendLines } from './acceleration-info';
import { renderModelSection } from './model-settings-section';
import {
  INSERTION_MODES,
  type InsertionMode,
  isInsertionMode,
  isSpeakingStyle,
  type PluginSettings,
} from './plugin-settings';

interface SettingsTabDependencies {
  getSettings: () => PluginSettings;
  modelInstallManager: ModelInstallManager;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection: Pick<SidecarConnection, 'getSystemInfo'>;
}

const INSERTION_MODE_OPTIONS: Array<{ label: string; value: InsertionMode }> = [
  { label: 'Insert at cursor', value: 'insert_at_cursor' },
  { label: 'Append on a new line', value: 'append_on_new_line' },
  { label: 'Append as a new paragraph', value: 'append_as_new_paragraph' },
];

const SPEAKING_STYLE_OPTIONS: Array<{ label: string; value: SpeakingStyle }> = [
  { label: 'Responsive — ends utterances quickly after you stop talking', value: 'responsive' },
  { label: 'Balanced — standard detection (default)', value: 'balanced' },
  { label: 'Patient — waits longer through pauses', value: 'patient' },
];

export class LocalSttSettingTab extends PluginSettingTab {
  private disposeModelSection: (() => void) | null = null;

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
    containerEl.createEl('h2', { text: 'Local STT' });
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
        'When enabled, incoming audio is discarded while the previous utterance is being transcribed. Disable this only if you want bounded queueing and overload warnings instead.',
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
      .setName('Transcript placement')
      .setDesc(
        'Choose whether each transcript lands at the cursor or is appended to the end of the note with optional line separation.',
      )
      .addDropdown((dropdown) => {
        for (const option of INSERTION_MODE_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown.setValue(settings.insertionMode);
        dropdown.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            insertionMode: isInsertionMode(value) ? value : INSERTION_MODES[0],
          });
        });
      });

    // --- Engine options ---
    new Setting(containerEl).setName('Engine options').setHeading();
    const engineSection = containerEl.createDiv();
    void this.renderEngineOptions(engineSection);

    // --- Advanced: Sidecar (collapsible) ---
    const advancedDetails = containerEl.createEl('details', { cls: 'local-stt-advanced' });
    advancedDetails.createEl('summary', { text: 'Advanced: Sidecar' });

    new Setting(advancedDetails)
      .setName('Sidecar path override')
      .setDesc('Optional absolute path to a debug or manually installed sidecar executable file.')
      .addText((text) => {
        text.setPlaceholder('Auto-detect from native/target/debug');
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
      const catalogModel = state.catalog.models.find(
        (m) => m.runtimeId === runtimeId && m.familyId === familyId && m.modelId === modelId,
      );
      if (catalogModel === undefined) return;
      const installedModel = state.installedModels.find(
        (m) => m.runtimeId === runtimeId && m.familyId === familyId && m.modelId === modelId,
      );
      new ModelDetailsModal(this.app, catalogModel, installedModel?.installPath ?? null).open();
    };
  }

  private async renderEngineOptions(
    containerEl: HTMLDivElement,
    cachedSystemInfo?: SystemInfoEvent | null,
  ): Promise<void> {
    const systemInfo =
      cachedSystemInfo !== undefined ? cachedSystemInfo : await this.fetchSystemInfo();

    const settings = this.dependencies.getSettings();
    const detailLines = buildEffectiveBackendLines(systemInfo, settings.accelerationPreference);

    containerEl.empty();

    new Setting(containerEl)
      .setName('GPU acceleration')
      .setDesc(
        'Use GPU backends when available for compiled runtimes. Disabled forces every runtime onto CPU.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', 'Use when available');
        dropdown.addOption('cpu_only', 'Disabled');
        dropdown.setValue(settings.accelerationPreference);
        dropdown.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            accelerationPreference: value === 'cpu_only' ? 'cpu_only' : 'auto',
          });
          void this.renderEngineOptions(containerEl, systemInfo);
        });
      });

    const descriptionEl = containerEl.createDiv({ cls: 'setting-item-description' });
    descriptionEl.createDiv({ text: buildAccelerationSummary(systemInfo) });

    for (const line of detailLines) {
      descriptionEl.createDiv({ text: line });
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
