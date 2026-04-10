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
      text: 'Configure the local Whisper model, temp audio directory, and native sidecar.',
    });

    new Setting(containerEl)
      .setName('Whisper model file path')
      .setDesc(
        'Absolute path to a local whisper.cpp-compatible Whisper model file, such as ggml-large-v3-turbo.bin.',
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

    new Setting(containerEl)
      .setName('Temp audio directory override')
      .setDesc(
        'Optional absolute directory for temporary WAV files. Defaults to the system temp directory.',
      )
      .addText((text) => {
        text.setPlaceholder('System temp directory / obsidian-local-stt');
        text.setValue(settings.tempAudioDirectoryOverride);
        text.onChange(async (value) => {
          await this.dependencies.saveSettings({
            ...this.dependencies.getSettings(),
            tempAudioDirectoryOverride: value.trim(),
          });
        });
      });

    containerEl.createEl('h3', { text: 'Sidecar' });
    containerEl.createEl('p', {
      text: 'Use these settings only if you need to point Obsidian at a non-default debug or manually installed sidecar.',
    });

    new Setting(containerEl)
      .setName('Sidecar path override')
      .setDesc('Optional absolute path to a debug or manually installed sidecar binary.')
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
      .setDesc('Maximum time allowed for a sidecar request before failing it.')
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
  }
}
