import { ItemView, Notice, Setting, type WorkspaceLeaf } from 'obsidian';

import type { OllamaClient, OllamaModelOption } from '../llm/ollama-client';
import { DEFAULT_LLM_TRANSFORM_PROMPT, type PluginSettings } from '../settings/plugin-settings';
import type { PluginLogger } from '../shared/plugin-logger';
import type { SessionState, SidecarEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';

export const LOCAL_TRANSCRIPT_VIEW_TYPE = 'local-transcript-sidebar';
const LOCAL_TRANSCRIPT_VIEW_TITLE = 'Local Transcript';
const LOCAL_TRANSCRIPT_VIEW_ICON = 'audio-lines';
const OLLAMA_ENABLE_FAILURE_NOTICE = 'Start Ollama, then enable LLM transform again.';
const MODEL_REQUIRED_NOTICE = 'Select an Ollama model, then enable LLM transform again.';
const MODEL_MISSING_NOTICE =
  'Refresh models, select an installed model, then enable LLM transform again.';

interface LocalTranscriptViewDependencies {
  getSettings: () => PluginSettings;
  logger?: PluginLogger | undefined;
  notice?: (message: string) => void;
  ollamaClient: OllamaClient;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection: Pick<SidecarConnection, 'subscribe'>;
}

export class LocalTranscriptView extends ItemView {
  private models: OllamaModelOption[] = [];
  private ollamaStatus = 'Ollama status unknown.';
  private promptInputEl: HTMLTextAreaElement | null = null;
  private queueDepth = 0;
  private releaseSidecarSubscription: (() => void) | null = null;
  private sessionState: SessionState = 'idle';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly dependencies: LocalTranscriptViewDependencies,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return LOCAL_TRANSCRIPT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return LOCAL_TRANSCRIPT_VIEW_TITLE;
  }

  override getIcon(): string {
    return LOCAL_TRANSCRIPT_VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    this.releaseSidecarSubscription = this.dependencies.sidecarConnection.subscribe((event) => {
      this.handleSidecarEvent(event);
    });
    this.render();
  }

  override async onClose(): Promise<void> {
    this.releaseSidecarSubscription?.();
    this.releaseSidecarSubscription = null;
  }

  private render(): void {
    const { contentEl } = this;
    const settings = this.dependencies.getSettings();
    const timestampsEnabled = settings.showTimestamps;

    this.promptInputEl = null;
    contentEl.empty();
    contentEl.addClass('local-transcript-sidebar');

    new Setting(contentEl).setName('LLM transform').addToggle((toggle) => {
      toggle.setValue(settings.llmTransformEnabled);
      toggle.onChange(async (enabled) => {
        await this.handleEnableChanged(enabled);
      });
    });

    if (timestampsEnabled) {
      contentEl.createEl('p', {
        cls: 'local-transcript-muted',
        text: 'Disabled while timestamps are enabled.',
      });
    }

    contentEl.createEl('p', {
      cls: 'local-transcript-status',
      text: this.ollamaStatus,
    });

    new Setting(contentEl).setName('Ollama models').addButton((button) => {
      button.setButtonText('Refresh models');
      button.onClick(async () => {
        await this.refreshModels({ disableOnFailure: settings.llmTransformEnabled });
      });
    });

    new Setting(contentEl).setName('Model').addDropdown((dropdown) => {
      dropdown.addOption('', 'Select a model');
      for (const model of this.models) {
        dropdown.addOption(model.id, model.displayName);
      }
      dropdown.setValue(settings.llmTransformModel);
      dropdown.onChange(async (value) => {
        await this.persistSettings({
          ...this.dependencies.getSettings(),
          llmTransformModel: value.trim(),
        });
      });
    });

    new Setting(contentEl).setName('Prompt').addTextArea((text) => {
      text.inputEl.rows = 6;
      this.promptInputEl = text.inputEl;
      text.setValue(settings.llmTransformPrompt);
      text.inputEl.addEventListener('blur', () => {
        this.render();
      });
      text.onChange(async (value) => {
        await this.persistSettings(
          {
            ...this.dependencies.getSettings(),
            llmTransformPrompt: value,
          },
          { rerender: false },
        );
      });
    });

    new Setting(contentEl)
      .setName('LLM developer mode')
      .setDesc(
        'Write Original and Transformed sections into the note for each processed utterance.',
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.llmTransformDeveloperMode);
        toggle.onChange(async (value) => {
          await this.persistSettings({
            ...this.dependencies.getSettings(),
            llmTransformDeveloperMode: value,
          });
        });
      });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText('Reset prompt to default');
      button.onClick(async () => {
        await this.persistSettings({
          ...this.dependencies.getSettings(),
          llmTransformPrompt: DEFAULT_LLM_TRANSFORM_PROMPT,
        });
      });
    });

    const inFlightCount = this.queueDepth + (this.sessionState === 'transcribing' ? 1 : 0);
    if (settings.llmTransformEnabled && inFlightCount > 0) {
      contentEl.createEl('p', {
        cls: 'local-transcript-processing',
        text: `Processing ${inFlightCount} utterance(s)...`,
      });
    }
  }

  private async handleEnableChanged(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.persistSettings({
        ...this.dependencies.getSettings(),
        llmTransformEnabled: false,
      });
      return;
    }

    try {
      await this.refreshModels({ disableOnFailure: false, rerender: false });
      const settings = this.dependencies.getSettings();
      const selectedModel = settings.llmTransformModel.trim();

      if (selectedModel.length === 0) {
        await this.persistSettings({ ...settings, llmTransformEnabled: false });
        this.notice(MODEL_REQUIRED_NOTICE);
        return;
      }

      if (!this.models.some((model) => model.id === selectedModel)) {
        await this.persistSettings({ ...settings, llmTransformEnabled: false });
        this.notice(MODEL_MISSING_NOTICE);
        return;
      }

      await this.persistSettings({ ...settings, llmTransformEnabled: true });
      void this.dependencies.ollamaClient.prewarmModel(selectedModel).catch((error: unknown) => {
        this.dependencies.logger?.warn('llm', 'Ollama pre-warm failed', error);
        new Notice('Local Transcript: Ollama pre-warm failed.');
      });
    } catch (error) {
      this.dependencies.logger?.warn('llm', 'Ollama preflight failed', error);
      await this.persistSettings({
        ...this.dependencies.getSettings(),
        llmTransformEnabled: false,
      });
      this.notice(OLLAMA_ENABLE_FAILURE_NOTICE);
    }
  }

  private async refreshModels(options: {
    disableOnFailure: boolean;
    rerender?: boolean;
  }): Promise<void> {
    try {
      await this.dependencies.ollamaClient.probeOllama();
      this.models = await this.dependencies.ollamaClient.listOllamaModels();
      this.ollamaStatus =
        this.models.length === 0
          ? 'Ollama is running. No chat models found.'
          : 'Ollama is running.';
      if (options.rerender ?? true) {
        this.render();
      }
    } catch (error) {
      this.models = [];
      this.ollamaStatus = 'Ollama is unavailable.';
      if (options.disableOnFailure) {
        await this.persistSettings({
          ...this.dependencies.getSettings(),
          llmTransformEnabled: false,
        });
        this.notice(OLLAMA_ENABLE_FAILURE_NOTICE);
      } else if (options.rerender ?? true) {
        this.render();
      }
      throw error;
    }
  }

  private handleSidecarEvent(event: SidecarEvent): void {
    if (event.type === 'transcription_queue_changed') {
      this.queueDepth = event.queuedUtterances;
      this.renderIfPromptIsNotFocused();
      return;
    }

    if (event.type === 'session_state_changed') {
      this.sessionState = event.state;
      this.renderIfPromptIsNotFocused();
    }
  }

  private async persistSettings(
    nextSettings: PluginSettings,
    options: { rerender?: boolean } = {},
  ): Promise<void> {
    await this.dependencies.saveSettings(nextSettings);
    if (options.rerender ?? true) {
      this.render();
    }
  }

  private renderIfPromptIsNotFocused(): void {
    if (this.promptInputEl !== null && document.activeElement === this.promptInputEl) {
      return;
    }
    this.render();
  }

  private notice(message: string): void {
    if (this.dependencies.notice !== undefined) {
      this.dependencies.notice(message);
      return;
    }
    new Notice(message);
  }
}
