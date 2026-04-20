import type { App, Plugin } from 'obsidian';
import { Platform, PluginSettingTab, Setting } from 'obsidian';
import { resolveEngineCapabilities } from '../models/capability-view';
import { ManageModelsModal } from '../models/manage-models-modal';
import type { ModelInstallManager } from '../models/model-install-manager';
import { ExternalModelFileModal, ModelDetailsModal } from '../models/model-management-modals';
import { matchesModelTriple } from '../models/model-management-types';
import type { SpeakingStyle, SystemInfoEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
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
  modelInstallManager: ModelInstallManager;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection: Pick<SidecarConnection, 'getSystemInfo'>;
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

  private async renderEngineOptions(
    containerEl: HTMLDivElement,
    cachedSystemInfo?: SystemInfoEvent | null,
  ): Promise<void> {
    const systemInfo =
      cachedSystemInfo !== undefined ? cachedSystemInfo : await this.fetchSystemInfo();

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
          void this.renderEngineOptions(containerEl, systemInfo);
        });
      });
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
