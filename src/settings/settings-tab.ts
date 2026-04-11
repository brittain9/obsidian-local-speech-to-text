import type { App, Plugin } from 'obsidian';
import { PluginSettingTab, Setting } from 'obsidian';

import type { PluginSettings } from './plugin-settings';

interface SettingsTabDependencies {
  getSettings: () => PluginSettings;
  saveSettings: (settings: PluginSettings) => Promise<void>;
}

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
      text: 'Configure the local Whisper model, listening mode, and native sidecar.',
    });

    new Setting(containerEl)
      .setName('Whisper model file path')
      .setDesc(
        'Absolute path to a local whisper.cpp-compatible model file, such as ggml-small.en-q5_1.bin or ggml-large-v3-turbo-q8_0.bin.',
      )
      .addText((text) => {
        text.setPlaceholder('/absolute/path/to/ggml-large-v3-turbo.bin');
        text.setValue(settings.modelFilePath);
        text.onChange(async (value) => {
          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            modelFilePath: value.trim(),
          });
        });
      });

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
          await this.dependencies.saveSettings({
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
          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            pauseWhileProcessing: value,
          });
        });
      });

    new Setting(containerEl)
      .setName('Insertion mode')
      .setDesc('Current implementation supports insertion at the cursor only.')
      .addDropdown((dropdown) => {
        dropdown.addOption('insert_at_cursor', 'Insert at cursor');
        dropdown.setValue(settings.insertionMode);
        dropdown.onChange(async (value) => {
          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            insertionMode: value === 'insert_at_cursor' ? value : 'insert_at_cursor',
          });
        });
      });

    containerEl.createEl('h3', { text: 'Sidecar' });
    containerEl.createEl('p', {
      text: 'Use these settings only if you need to point Obsidian at a non-default debug or manually installed sidecar.',
    });

    new Setting(containerEl)
      .setName('Sidecar path override')
      .setDesc('Optional absolute path to a debug or manually installed sidecar executable file.')
      .addText((text) => {
        text.setPlaceholder('Auto-detect from native/sidecar/target/debug');
        text.setValue(settings.sidecarPathOverride);
        text.onChange(async (value) => {
          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            sidecarPathOverride: value.trim(),
          });
        });
      });

    new Setting(containerEl)
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

          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            sidecarStartupTimeoutMs: parsedValue,
          });
        });
      });

    new Setting(containerEl)
      .setName('Request timeout (ms)')
      .setDesc(
        'Maximum time allowed for start, stop, cancel, and health requests before failing them. Increase this only if the sidecar regularly stalls during startup or shutdown.',
      )
      .addText((text) => {
        text.inputEl.type = 'number';
        text.setValue(String(settings.sidecarRequestTimeoutMs));
        text.onChange(async (value) => {
          const parsedValue = Number.parseInt(value, 10);

          if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
            return;
          }

          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            sidecarRequestTimeoutMs: parsedValue,
          });
        });
      });

    containerEl.createEl('p', {
      text: 'Assign a hotkey to “Local STT: Press-And-Hold Gate” in Obsidian Hotkeys if you want keyboard press-and-hold input.',
    });
  }
}
