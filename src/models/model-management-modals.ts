import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import { formatBytes, formatErrorMessage } from '../shared/format-utils';
import { createInstallProgressFragment } from './model-install-progress';
import type {
  ActiveInstallState,
  CatalogExplorerRowState,
  CurrentModelCardState,
  ModelManagementService,
  ModelManagementSnapshot,
} from './model-management-service';
import { applyActiveInstallStateToSnapshot } from './model-management-service';
import {
  type CatalogModelRecord,
  type EngineId,
  getTotalModelSize,
} from './model-management-types';

interface ModelModalDependencies {
  onChanged: () => Promise<void>;
  service: ModelManagementService;
}

export class ModelExplorerModal extends Modal {
  private actionInProgress = false;
  private activeEngineId: EngineId | null = null;
  private listContainer: HTMLDivElement | null = null;
  private loadSequence = 0;
  private releaseInstallUpdateSubscription: (() => void) | null = null;
  private readonly rowContainers = new Map<string, HTMLDivElement>();
  private searchQuery = '';
  private snapshot: ModelManagementSnapshot | null = null;
  private tabBarEl: HTMLDivElement | null = null;
  private tabButtons: Map<EngineId, HTMLButtonElement> = new Map();

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

    // Tab bar + search row
    const toolbar = this.contentEl.createDiv({ cls: 'local-stt-toolbar' });
    this.tabBarEl = toolbar.createDiv({ cls: 'local-stt-tab-bar' });
    const searchWrapper = toolbar.createDiv({ cls: 'local-stt-search-wrapper' });
    const searchInput = searchWrapper.createEl('input', {
      cls: 'local-stt-search-input',
      attr: { type: 'text', placeholder: 'Search\u2026', spellcheck: 'false' },
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase();
      this.renderFromCache();
    });

    this.listContainer = this.contentEl.createDiv({ cls: 'local-stt-model-list' });
    searchInput.focus();
    this.releaseInstallUpdateSubscription = this.dependencies.service.subscribeToInstallUpdates(
      () => {
        const activeInstall = this.dependencies.service.getActiveInstallState();

        if (this.snapshot !== null && activeInstall !== null) {
          this.snapshot = applyActiveInstallStateToSnapshot(this.snapshot, activeInstall);
          this.updateVisibleInstallRow(activeInstall);
          return;
        }

        void this.loadAndRender();
      },
    );
    void this.loadAndRender();
  }

  override onClose(): void {
    this.releaseInstallUpdateSubscription?.();
    this.releaseInstallUpdateSubscription = null;
    this.actionInProgress = false;
    this.listContainer = null;
    this.snapshot = null;
    this.tabBarEl = null;
    this.tabButtons.clear();
    this.rowContainers.clear();
    this.contentEl.empty();
  }

  private async loadAndRender(): Promise<void> {
    if (this.listContainer === null) {
      return;
    }

    const loadSequence = ++this.loadSequence;

    if (this.snapshot === null) {
      const cached = this.dependencies.service.getCachedSnapshot();

      if (cached !== null) {
        this.applySnapshot(cached, loadSequence);
        void this.fetchAndApplySnapshot(loadSequence);
        return;
      }

      this.listContainer.empty();
      this.listContainer.createEl('p', { text: 'Loading model catalog\u2026' });
    }

    await this.fetchAndApplySnapshot(loadSequence);
  }

  private applySnapshot(snapshot: ModelManagementSnapshot, loadSequence: number): void {
    if (this.listContainer === null || loadSequence !== this.loadSequence) {
      return;
    }

    const activeInstall = this.dependencies.service.getActiveInstallState();

    if (activeInstall !== null) {
      this.snapshot = applyActiveInstallStateToSnapshot(snapshot, activeInstall);
    } else {
      this.snapshot = {
        ...snapshot,
        activeInstall: null,
        rows: snapshot.rows.map((row) =>
          row.installState !== null ? { ...row, installState: null } : row,
        ),
      };
    }

    const supportedEngines = this.snapshot.catalog.engines.filter((e) =>
      this.snapshot?.supportedEngineIds.includes(e.engineId),
    );

    if (
      this.activeEngineId === null ||
      !supportedEngines.some((e) => e.engineId === this.activeEngineId)
    ) {
      this.activeEngineId = supportedEngines[0]?.engineId ?? null;
    }

    this.renderTabs();
    this.renderFromCache();
  }

  private async fetchAndApplySnapshot(loadSequence: number): Promise<void> {
    try {
      const snapshot = await this.dependencies.service.getSnapshot();
      this.applySnapshot(snapshot, loadSequence);
    } catch (error) {
      if (this.listContainer !== null && loadSequence === this.loadSequence) {
        this.listContainer.empty();
        this.listContainer.createEl('p', {
          text: formatErrorMessage(error, 'Failed to load the model catalog.'),
        });
      }
    }
  }

  private renderTabs(): void {
    if (this.snapshot === null || this.tabBarEl === null) {
      return;
    }

    this.tabBarEl.empty();
    this.tabButtons.clear();

    const supportedEngines = this.snapshot.catalog.engines.filter((e) =>
      this.snapshot?.supportedEngineIds.includes(e.engineId),
    );

    for (const engine of supportedEngines) {
      const btn = this.tabBarEl.createEl('button', {
        cls: 'local-stt-tab',
        text: engine.displayName,
      });

      if (engine.engineId === this.activeEngineId) {
        btn.addClass('local-stt-tab--active');
      }

      btn.addEventListener('click', () => {
        this.activeEngineId = engine.engineId;
        this.updateTabActiveStates();
        this.renderFromCache();
      });

      this.tabButtons.set(engine.engineId, btn);
    }
  }

  private updateTabActiveStates(): void {
    for (const [engineId, btn] of this.tabButtons) {
      btn.toggleClass('local-stt-tab--active', engineId === this.activeEngineId);
    }
  }

  private renderFromCache(): void {
    if (this.listContainer === null || this.snapshot === null || this.activeEngineId === null) {
      return;
    }

    this.listContainer.empty();
    this.rowContainers.clear();

    const engineRows = this.snapshot.rows.filter(
      (row) => row.model.engineId === this.activeEngineId,
    );
    const matchingRows = engineRows.filter((row) => matchesQuery(row, this.searchQuery));

    if (matchingRows.length === 0) {
      const message =
        this.searchQuery.length > 0
          ? 'No models matched the current search.'
          : 'No models available for this engine.';
      this.listContainer.createEl('p', {
        cls: 'local-stt-empty-state',
        text: message,
      });
      return;
    }

    for (const row of matchingRows) {
      const rowContainer = this.listContainer.createDiv();
      this.rowContainers.set(getRowKey(row.model.engineId, row.model.modelId), rowContainer);
      this.renderRow(row, rowContainer);
    }
  }

  private updateVisibleInstallRow(activeInstall: ActiveInstallState): void {
    if (this.snapshot === null || this.activeEngineId === null) {
      return;
    }

    if (activeInstall.installUpdate.engineId !== this.activeEngineId) {
      return;
    }

    const row = this.snapshot.rows.find(
      (candidate) =>
        candidate.model.engineId === activeInstall.installUpdate.engineId &&
        candidate.model.modelId === activeInstall.installUpdate.modelId,
    );

    if (row === undefined || !matchesQuery(row, this.searchQuery)) {
      return;
    }

    const rowContainer = this.rowContainers.get(
      getRowKey(activeInstall.installUpdate.engineId, activeInstall.installUpdate.modelId),
    );

    if (rowContainer === undefined) {
      return;
    }

    // Preserve interactivity in the rest of the modal while one row streams progress updates.
    this.renderRow(row, rowContainer);
  }

  private renderRow(row: CatalogExplorerRowState, rowContainer: HTMLDivElement): void {
    rowContainer.empty();

    const setting = new Setting(rowContainer);
    setting.settingEl.addClass('local-stt-model-row');

    // Name
    setting.setName(row.model.displayName);

    // Description: tags + size pill, or install progress
    if (row.installState !== null) {
      const installState = row.installState;
      setting.setDesc(
        createInstallProgressFragment({
          ...installState.installUpdate,
          isCancelling: installState.isCancelling,
        }),
      );
    } else {
      const frag = document.createDocumentFragment();
      const tagsContainer = frag.createEl('span', { cls: 'local-stt-tags' });

      for (const tag of row.model.uxTags) {
        tagsContainer.createEl('span', {
          cls: tag === 'recommended' ? 'local-stt-tag local-stt-tag--recommended' : 'local-stt-tag',
          text: tag,
        });
      }

      const totalSize = getTotalModelSize(row.model);
      if (totalSize > 0) {
        tagsContainer.createEl('span', {
          cls: 'local-stt-tag local-stt-tag--size',
          text: formatBytes(totalSize),
        });
      }

      setting.setDesc(frag);
    }

    // Action buttons
    const anotherModelInstalling =
      this.snapshot?.activeInstall !== null && row.installState === null;

    if (row.installState !== null) {
      const installState = row.installState;
      setting.addButton((button) => {
        if (!installState.isCancelling) {
          button.setCta();
        }
        button
          .setButtonText(installState.isCancelling ? 'Cancelling…' : 'Cancel')
          .setDisabled(installState.isCancelling || this.actionInProgress)
          .onClick(async () => {
            try {
              await this.dependencies.service.cancelActiveInstall();
              await this.dependencies.onChanged();
            } catch (error) {
              new Notice(
                `Local STT: ${formatErrorMessage(error, 'Failed to cancel the model install.')}`,
              );
            }
          });
      });
    } else if (row.installedModel !== null) {
      setting.addButton((button) => {
        const disabled = row.isSelected || this.actionInProgress;
        button.setButtonText(row.isSelected ? 'Selected' : 'Use').setDisabled(disabled);
        if (!row.isSelected) {
          button.setCta();
        }
        button.onClick(async () => {
          const completed = await this.runAction(async () => {
            await this.dependencies.service.selectCatalogModel({
              engineId: row.model.engineId,
              kind: 'catalog_model',
              modelId: row.model.modelId,
            });
          }, 'Selected managed model.');

          if (completed) {
            this.close();
          }
        });
      });
      setting.addButton((button) => {
        button
          .setWarning()
          .setButtonText('Remove')
          .setDisabled(this.actionInProgress)
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
      setting.addButton((button) => {
        button
          .setCta()
          .setButtonText('Install')
          .setDisabled(anotherModelInstalling || this.actionInProgress)
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

    // Info button
    setting.addExtraButton((button) => {
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

  private async runAction(action: () => Promise<void>, successMessage: string): Promise<boolean> {
    if (this.actionInProgress) {
      return false;
    }

    this.actionInProgress = true;
    this.renderFromCache();

    try {
      await action();
      new Notice(`Local STT: ${successMessage}`);
      await this.dependencies.onChanged();
      await this.loadAndRender();
      return true;
    } catch (error) {
      new Notice(`Local STT: ${formatErrorMessage(error, 'The model action failed.')}`);
      return false;
    } finally {
      this.actionInProgress = false;
      this.renderFromCache();
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

    this.inputEl?.focus();

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

export class ModelDetailsModal extends Modal {
  constructor(
    app: App,
    private readonly model: CatalogModelRecord,
    private readonly installPath: string | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.model.displayName);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.model.summary });

    const dl = this.contentEl.createEl('dl', { cls: 'local-stt-details-grid' });

    const totalSize = getTotalModelSize(this.model);
    if (totalSize > 0) {
      dl.createEl('dt', { text: 'Total size' });
      dl.createEl('dd', { text: formatBytes(totalSize) });
    }

    dl.createEl('dt', { text: 'Source' });
    appendDetailsLink(dl.createEl('dd'), this.model.sourceUrl, this.model.sourceUrl, true);

    dl.createEl('dt', { text: 'License' });
    appendDetailsLink(dl.createEl('dd'), this.model.licenseLabel, this.model.licenseUrl);

    if (this.installPath !== null) {
      dl.createEl('dt', { text: 'Install path' });
      dl.createEl('dd', { text: this.installPath, cls: 'local-stt-mono' });
    }

    // Artifact table — all files, not just primary
    if (this.model.artifacts.length > 0) {
      this.contentEl.createEl('h4', {
        text: `Files (${this.model.artifacts.length})`,
        cls: 'local-stt-details-section-heading',
      });

      const table = this.contentEl.createEl('table', { cls: 'local-stt-artifact-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'File' });
      headerRow.createEl('th', { text: 'Size' });

      const tbody = table.createEl('tbody');
      for (const artifact of this.model.artifacts) {
        const tr = tbody.createEl('tr');
        tr.createEl('td', { text: artifact.filename, cls: 'local-stt-mono' });
        tr.createEl('td', { text: formatBytes(artifact.sizeBytes) });
      }
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
    ...row.model.uxTags,
    ...row.model.languageTags,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}

function getRowKey(engineId: EngineId, modelId: string): string {
  return `${engineId}:${modelId}`;
}

function appendDetailsLink(
  container: HTMLElement,
  label: string,
  href: string,
  monospace = false,
): void {
  const link = container.createEl('a', {
    href,
    text: label,
  });

  link.setAttr('target', '_blank');
  link.setAttr('rel', 'noopener noreferrer');
  if (monospace) {
    link.addClass('local-stt-mono');
  }
}
