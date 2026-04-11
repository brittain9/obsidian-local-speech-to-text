import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import { formatBytes, formatErrorMessage, formatInstallProgress } from '../shared/format-utils';
import type {
  CatalogExplorerRowState,
  CurrentModelCardState,
  ModelManagementService,
  ModelManagementSnapshot,
} from './model-management-service';
import {
  type CatalogModelRecord,
  getEngineDisplayName,
  getPrimaryArtifact,
} from './model-management-types';

interface ModelModalDependencies {
  onChanged: () => Promise<void>;
  service: ModelManagementService;
}

export class ModelExplorerModal extends Modal {
  private listContainer: HTMLDivElement | null = null;
  private releaseInstallUpdateSubscription: (() => void) | null = null;
  private searchQuery = '';
  private snapshot: ModelManagementSnapshot | null = null;

  constructor(
    app: App,
    private readonly dependencies: ModelModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('local-stt-explorer');
    this.titleEl.setText('Browse models');
    this.contentEl.empty();

    new Setting(this.contentEl)
      .setName('Search')
      .setDesc('Filter the catalog by name, summary, notes, or tags.')
      .addText((text) => {
        text.setPlaceholder('Search models');
        text.onChange((value) => {
          this.searchQuery = value.trim().toLowerCase();
          this.renderFromCache();
        });
      });

    this.listContainer = this.contentEl.createDiv({ cls: 'local-stt-model-list' });
    this.releaseInstallUpdateSubscription = this.dependencies.service.subscribeToInstallUpdates(
      () => {
        void this.loadAndRender();
      },
    );
    void this.loadAndRender();
  }

  override onClose(): void {
    this.releaseInstallUpdateSubscription?.();
    this.releaseInstallUpdateSubscription = null;
    this.listContainer = null;
    this.snapshot = null;
    this.contentEl.empty();
  }

  private async loadAndRender(): Promise<void> {
    if (this.listContainer === null) {
      return;
    }

    this.listContainer.empty();
    this.listContainer.createEl('p', { text: 'Loading model catalog\u2026' });

    try {
      this.snapshot = await this.dependencies.service.getSnapshot();

      if (this.listContainer === null) {
        return;
      }

      this.renderFromCache();
    } catch (error) {
      if (this.listContainer !== null) {
        this.listContainer.empty();
        this.listContainer.createEl('p', {
          text: formatErrorMessage(error, 'Failed to load the model catalog.'),
        });
      }
    }
  }

  private renderFromCache(): void {
    if (this.listContainer === null || this.snapshot === null) {
      return;
    }

    this.listContainer.empty();

    const matchingRows = this.snapshot.rows.filter((row) => matchesQuery(row, this.searchQuery));

    if (matchingRows.length === 0) {
      this.listContainer.createEl('p', { text: 'No catalog models matched the current search.' });
      return;
    }

    for (const row of matchingRows) {
      this.renderRow(row);
    }
  }

  private renderRow(row: CatalogExplorerRowState): void {
    const rowEl = this.listContainer?.createDiv({ cls: 'local-stt-model-row' });

    if (rowEl === undefined || rowEl === null) {
      return;
    }

    // Header: name (left) + size (right)
    const header = rowEl.createDiv({ cls: 'local-stt-row-header' });
    header.createEl('strong', { text: row.model.displayName });
    const primaryArtifact = getPrimaryArtifact(row.model);
    if (primaryArtifact !== null) {
      header.createSpan({
        cls: 'local-stt-row-size',
        text: formatBytes(primaryArtifact.sizeBytes),
      });
    }

    // Summary
    rowEl.createEl('p', { cls: 'local-stt-row-summary', text: row.model.summary });

    // Tags
    if (row.model.uxTags.length > 0) {
      const tagsEl = rowEl.createDiv({ cls: 'local-stt-tags' });
      for (const tag of row.model.uxTags) {
        tagsEl.createSpan({
          cls: tag === 'recommended' ? 'local-stt-tag local-stt-tag--recommended' : 'local-stt-tag',
          text: tag,
        });
      }
    }

    // Actions — single Setting row
    const actionSetting = new Setting(rowEl);

    if (row.installUpdate !== null) {
      actionSetting.setDesc(formatInstallProgress(row.installUpdate));
      actionSetting.addButton((button) => {
        button
          .setCta()
          .setButtonText('Cancel')
          .onClick(async () => {
            await this.dependencies.service.cancelActiveInstall();
          });
      });
    } else if (row.installedModel !== null) {
      actionSetting.addButton((button) => {
        button
          .setButtonText(row.isSelected ? 'Selected' : 'Use')
          .setDisabled(row.isSelected);
        if (!row.isSelected) {
          button.setCta();
        }
        button.onClick(async () => {
          await this.runAction(async () => {
            await this.dependencies.service.selectCatalogModel({
              engineId: row.model.engineId,
              kind: 'catalog_model',
              modelId: row.model.modelId,
            });
            this.close();
          }, 'Selected managed model.');
        });
      });
      actionSetting.addButton((button) => {
        button
          .setWarning()
          .setButtonText('Remove')
          .onClick(async () => {
            await this.runAction(async () => {
              await this.dependencies.service.removeCatalogModel({
                engineId: row.model.engineId,
                kind: 'catalog_model',
                modelId: row.model.modelId,
              });
            }, 'Removed managed model.');
          });
      });
    } else {
      actionSetting.addButton((button) => {
        button
          .setCta()
          .setButtonText('Install')
          .onClick(async () => {
            await this.runAction(async () => {
              await this.dependencies.service.installCatalogModel({
                engineId: row.model.engineId,
                kind: 'catalog_model',
                modelId: row.model.modelId,
              });
            }, 'Started managed model install.');
          });
      });
    }

    actionSetting.addExtraButton((button) => {
      button
        .setIcon('info')
        .setTooltip('Details')
        .onClick(() => {
          new ModelDetailsModal(
            this.app,
            row.model,
            row.installedModel?.installPath ?? null,
          ).open();
        });
    });
  }

  private async runAction(action: () => Promise<void>, successMessage: string): Promise<void> {
    try {
      await action();
      new Notice(`Local STT: ${successMessage}`);
      await this.dependencies.onChanged();
      await this.loadAndRender();
    } catch (error) {
      new Notice(`Local STT: ${formatErrorMessage(error, 'The model action failed.')}`);
    }
  }
}

export class ExternalModelFileModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    private readonly currentPath: string,
    private readonly dependencies: ModelModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('Use external file');
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: 'Validate an absolute model file path. External files bypass managed downloads and managed updates.',
    });

    new Setting(this.contentEl)
      .setName('Model file path')
      .setDesc('Enter an absolute whisper.cpp-compatible model file path.')
      .addText((text) => {
        text.setPlaceholder('/absolute/path/to/ggml-small.en-q5_1.bin');
        text.setValue(this.currentPath);
        this.inputEl = text.inputEl;
      });

    new Setting(this.contentEl).addButton((button) => {
      button
        .setCta()
        .setButtonText('Validate and use')
        .onClick(async () => {
          const nextPath = this.inputEl?.value.trim() ?? '';

          try {
            await this.dependencies.service.validateAndSelectExternalFile(nextPath);
            await this.dependencies.onChanged();
            new Notice('Local STT: External model file validated and selected.');
            this.close();
          } catch (error) {
            new Notice(
              `Local STT: ${formatErrorMessage(error, 'Failed to validate the external model file.')}`,
            );
          }
        });
    });
  }
}

class ModelDetailsModal extends Modal {
  constructor(
    app: App,
    private readonly model: CatalogModelRecord,
    private readonly installPath: string | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    const primaryArtifact = getPrimaryArtifact(this.model);

    this.titleEl.setText(this.model.displayName);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.model.summary });

    const dl = this.contentEl.createEl('dl', { cls: 'local-stt-details-grid' });

    dl.createEl('dt', { text: 'Engine' });
    dl.createEl('dd', { text: getEngineDisplayName(this.model.engineId) });

    dl.createEl('dt', { text: 'Source' });
    dl.createEl('dd', { text: this.model.sourceUrl, cls: 'local-stt-mono' });

    dl.createEl('dt', { text: 'License' });
    dl.createEl('dd', { text: `${this.model.licenseLabel} (${this.model.licenseUrl})` });

    if (primaryArtifact !== null) {
      dl.createEl('dt', { text: 'Artifact' });
      dl.createEl('dd', {
        text: `${primaryArtifact.filename} (${formatBytes(primaryArtifact.sizeBytes)})`,
      });

      dl.createEl('dt', { text: 'SHA-256' });
      dl.createEl('dd', { text: primaryArtifact.sha256, cls: 'local-stt-mono' });

      dl.createEl('dt', { text: 'Download URL' });
      dl.createEl('dd', { text: primaryArtifact.downloadUrl, cls: 'local-stt-mono' });
    }

    if (this.installPath !== null) {
      dl.createEl('dt', { text: 'Install path' });
      dl.createEl('dd', { text: this.installPath, cls: 'local-stt-mono' });
    }

    if (this.model.notes.length > 0) {
      dl.createEl('dt', { text: 'Notes' });
      dl.createEl('dd', { text: this.model.notes.join(' ') });
    }
  }
}

export class CurrentModelInfoModal extends Modal {
  constructor(
    app: App,
    private readonly cardState: CurrentModelCardState,
    private readonly storePath: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.cardState.displayName);
    this.contentEl.empty();

    const dl = this.contentEl.createEl('dl', { cls: 'local-stt-details-grid' });

    if (this.cardState.sourceLabel.length > 0) {
      dl.createEl('dt', { text: 'Source' });
      dl.createEl('dd', { text: this.cardState.sourceLabel });
    }

    dl.createEl('dt', { text: 'Status' });
    dl.createEl('dd', { text: this.cardState.installedLabel });

    if (this.cardState.detail.length > 0) {
      dl.createEl('dt', { text: 'Detail' });
      dl.createEl('dd', { text: this.cardState.detail });
    }

    if (this.cardState.sizeBytes !== null) {
      dl.createEl('dt', { text: 'Size' });
      dl.createEl('dd', { text: formatBytes(this.cardState.sizeBytes) });
    }

    if (this.cardState.installLocation !== null) {
      dl.createEl('dt', { text: 'Install path' });
      dl.createEl('dd', { text: this.cardState.installLocation, cls: 'local-stt-mono' });
    }

    if (this.cardState.resolvedPath !== null) {
      dl.createEl('dt', { text: 'Resolved path' });
      dl.createEl('dd', { text: this.cardState.resolvedPath, cls: 'local-stt-mono' });
    }

    dl.createEl('dt', { text: 'Model store' });
    dl.createEl('dd', { text: this.storePath, cls: 'local-stt-mono' });
  }
}

function matchesQuery(row: CatalogExplorerRowState, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  const haystack = [
    row.model.displayName,
    row.model.summary,
    ...row.model.notes,
    ...row.model.uxTags,
    ...row.model.languageTags,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}
