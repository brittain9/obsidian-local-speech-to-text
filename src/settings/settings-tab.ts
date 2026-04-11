import type { App, Plugin } from 'obsidian';
import { PluginSettingTab, Setting } from 'obsidian';

import {
  CurrentModelInfoModal,
  ExternalModelFileModal,
  ModelExplorerModal,
} from '../models/model-management-modals';
import type {
  CurrentModelCardState,
  ModelManagementService,
  ModelManagementSnapshot,
} from '../models/model-management-service';
import { formatErrorMessage, formatInstallProgress } from '../shared/format-utils';
import type { InsertionMode, PluginSettings } from './plugin-settings';

interface SettingsTabDependencies {
  getSettings: () => PluginSettings;
  modelManagementService: ModelManagementService;
  saveSettings: (settings: PluginSettings) => Promise<void>;
}

const INSERTION_MODE_OPTIONS: Array<{ label: string; value: InsertionMode }> = [
  { label: 'Insert at cursor', value: 'insert_at_cursor' },
  { label: 'Append on a new line', value: 'append_on_new_line' },
  { label: 'Append as a new paragraph', value: 'append_as_new_paragraph' },
];

export class LocalSttSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly dependencies: SettingsTabDependencies,
  ) {
    super(app, plugin);
  }

  override display(): void {
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
    void this.renderModelSection(modelSection);

    // --- Transcription ---
    new Setting(containerEl).setName('Transcription').setHeading();

    new Setting(containerEl)
      .setName('Listening mode')
      .setDesc(
        'Choose whether dictation keeps listening continuously, waits for a held gate, or captures one utterance and stops.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('always_on', 'Always on');
        dropdown.addOption('press_and_hold', 'Press and hold');
        dropdown.addOption('one_sentence', 'One sentence');
        dropdown.setValue(settings.listeningMode);
        dropdown.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            listeningMode:
              value === 'always_on' || value === 'press_and_hold' || value === 'one_sentence'
                ? value
                : 'one_sentence',
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
            insertionMode: value as InsertionMode,
          });
        });
      });

    // --- Advanced: Sidecar (collapsible) ---
    const advancedDetails = containerEl.createEl('details', { cls: 'local-stt-advanced' });
    advancedDetails.createEl('summary', { text: 'Advanced: Sidecar' });

    new Setting(advancedDetails)
      .setName('Sidecar path override')
      .setDesc('Optional absolute path to a debug or manually installed sidecar executable file.')
      .addText((text) => {
        text.setPlaceholder('Auto-detect from native/sidecar/target/debug');
        text.setValue(settings.sidecarPathOverride);
        text.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            sidecarPathOverride: value.trim(),
          });
        });
      });

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

    containerEl.createEl('p', {
      text: 'Assign a hotkey to "Local STT: Press-And-Hold Gate" in Obsidian Hotkeys for keyboard press-and-hold input. This hotkey target does not appear in the command palette.',
    });
  }

  private async persistSettings(nextSettings: PluginSettings): Promise<void> {
    await this.dependencies.saveSettings(nextSettings);
  }

  private async renderModelSection(containerEl: HTMLDivElement): Promise<void> {
    containerEl.empty();

    const placeholderSetting = new Setting(containerEl).setName('Loading current model\u2026');
    this.addModelActions(placeholderSetting, null);

    try {
      const snapshot = await this.dependencies.modelManagementService.getSnapshot();
      this.renderCurrentModelCard(containerEl, snapshot);
    } catch (error) {
      containerEl.empty();
      containerEl.createEl('p', {
        text: formatErrorMessage(error, 'Failed to load the current model state.'),
      });
    }
  }

  private renderCurrentModelCard(
    containerEl: HTMLDivElement,
    snapshot: ModelManagementSnapshot,
  ): void {
    containerEl.empty();

    const { currentModel, currentSelection, modelStore } = snapshot;

    const descFragment = document.createDocumentFragment();
    if (currentModel.engineLabel.length > 0) {
      descFragment.createSpan({ text: currentModel.engineLabel + ' \u00b7 ' });
    }
    const badge = getBadgeInfo(currentModel.installedLabel);
    descFragment.createSpan({
      cls: `local-stt-badge local-stt-badge--${badge.modifier}`,
      text: badge.text,
    });

    const cardSetting = new Setting(containerEl)
      .setName(currentModel.displayName)
      .setDesc(descFragment);

    this.addModelActions(
      cardSetting,
      currentSelection !== null
        ? { currentModel, storePath: modelStore.path }
        : null,
    );

    if (snapshot.activeInstall !== null) {
      const { activeInstall } = snapshot;
      new Setting(containerEl)
        .setName(`Installing: ${activeInstall.modelId}`)
        .setDesc(formatInstallProgress(activeInstall));
    }
  }

  private addModelActions(
    setting: Setting,
    infoContext: { currentModel: CurrentModelCardState; storePath: string } | null,
  ): void {
    setting.addButton((button) => {
      button
        .setCta()
        .setButtonText('Browse models')
        .onClick(() => {
          new ModelExplorerModal(this.app, {
            onChanged: async () => {
              this.display();
            },
            service: this.dependencies.modelManagementService,
          }).open();
        });
    });

    setting.addExtraButton((button) => {
      button
        .setIcon('file-input')
        .setTooltip('Use external file')
        .onClick(() => {
          const selectedModel = this.dependencies.getSettings().selectedModel;
          new ExternalModelFileModal(
            this.app,
            selectedModel?.kind === 'external_file' ? selectedModel.filePath : '',
            {
              onChanged: async () => {
                this.display();
              },
              service: this.dependencies.modelManagementService,
            },
          ).open();
        });
    });

    if (infoContext !== null) {
      setting.addExtraButton((button) => {
        button
          .setIcon('info')
          .setTooltip('Model details')
          .onClick(() => {
            new CurrentModelInfoModal(
              this.app,
              infoContext.currentModel,
              infoContext.storePath,
            ).open();
          });
      });
    }
  }
}

function getBadgeInfo(installedLabel: string): { modifier: string; text: string } {
  switch (installedLabel) {
    case 'Installed':
    case 'Validated external file':
      return { modifier: 'ready', text: 'Ready' };
    case 'Not installed':
      return { modifier: 'missing', text: 'Not installed' };
    case 'Unavailable':
      return { modifier: 'missing', text: 'Unavailable' };
    case 'External file':
      return { modifier: 'external', text: 'Unverified' };
    default:
      return { modifier: 'none', text: 'No model' };
  }
}
