import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import { formatBytes, formatErrorMessage } from '../shared/format-utils';
import { resolveEngineCapabilities } from './capability-view';
import { isCancellingPhase, type ModelInstallManager } from './model-install-manager';
import {
  createInstallProgressElement,
  type InstallProgressState,
  updateInstallProgressElement,
} from './model-install-progress';
import { ModelDetailsModal } from './model-management-modals';
import {
  type CatalogModelRecord,
  getTotalModelSize,
  type ModelFamilyId,
  matchesModelTriple,
  type RuntimeId,
} from './model-management-types';
import { deriveModelRowStates, type ModelRowState } from './model-row-state';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

interface ManageModelsModalDependencies {
  manager: ModelInstallManager;
  onChanged: () => void;
}

interface AdapterTabKey {
  runtimeId: RuntimeId;
  familyId: ModelFamilyId;
}

function adapterTabId(key: AdapterTabKey): string {
  return `${key.runtimeId}:${key.familyId}`;
}

// ---------------------------------------------------------------------------
// ManageModelsModal
// ---------------------------------------------------------------------------

export class ManageModelsModal extends Modal {
  private actionInProgress = false;
  private activeTab: AdapterTabKey | null = null;
  private listContainer: HTMLDivElement | null = null;
  private readonly progressElements = new Map<string, HTMLDivElement>();
  private releaseSubscription: (() => void) | null = null;
  private tabButtons = new Map<string, HTMLButtonElement>();
  private tabBarEl: HTMLDivElement | null = null;

  constructor(
    app: App,
    private readonly deps: ManageModelsModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('local-stt-manage-models');
    this.titleEl.setText('Manage models');
    this.contentEl.empty();

    // Tab bar (no search)
    const toolbar = this.contentEl.createDiv({ cls: 'local-stt-toolbar' });
    this.tabBarEl = toolbar.createDiv({ cls: 'local-stt-tab-bar' });

    this.listContainer = this.contentEl.createDiv({ cls: 'local-stt-model-list' });

    this.renderTabs();
    this.renderModelList();

    this.releaseSubscription = this.deps.manager.subscribe(() => {
      this.handleStateChange();
    });
  }

  override onClose(): void {
    this.releaseSubscription?.();
    this.releaseSubscription = null;
    this.actionInProgress = false;
    this.listContainer = null;
    this.tabBarEl = null;
    this.tabButtons.clear();
    this.progressElements.clear();
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // Tab bar
  // -------------------------------------------------------------------------

  private renderTabs(): void {
    if (this.tabBarEl === null) {
      return;
    }

    this.tabBarEl.empty();
    this.tabButtons.clear();

    const state = this.deps.manager.getState();

    // Only show adapter tabs for (runtime, family) pairs present in both the
    // compiled sidecar AND the catalog — compiled alone doesn't guarantee any
    // downloadable models, and catalog alone doesn't guarantee the sidecar can
    // run them.
    const adapters = state.compiledAdapters
      .filter((adapter) =>
        state.catalog.families.some(
          (family) =>
            family.runtimeId === adapter.runtimeId && family.familyId === adapter.familyId,
        ),
      )
      .map((adapter) => ({
        displayName: adapter.displayName,
        runtimeId: adapter.runtimeId,
        familyId: adapter.familyId,
      }));

    if (
      this.activeTab === null ||
      !adapters.some(
        (a) => a.runtimeId === this.activeTab?.runtimeId && a.familyId === this.activeTab?.familyId,
      )
    ) {
      const first = adapters[0];
      this.activeTab =
        first !== undefined ? { runtimeId: first.runtimeId, familyId: first.familyId } : null;
    }

    for (const adapter of adapters) {
      const tabKey: AdapterTabKey = {
        runtimeId: adapter.runtimeId,
        familyId: adapter.familyId,
      };
      const btn = this.tabBarEl.createEl('button', {
        cls: 'local-stt-tab',
        text: adapter.displayName,
      });

      if (
        this.activeTab !== null &&
        tabKey.runtimeId === this.activeTab.runtimeId &&
        tabKey.familyId === this.activeTab.familyId
      ) {
        btn.addClass('local-stt-tab--active');
      }

      btn.addEventListener('click', () => {
        this.activeTab = tabKey;
        this.updateTabActiveStates();
        this.renderModelList();
      });

      this.tabButtons.set(adapterTabId(tabKey), btn);
    }
  }

  private updateTabActiveStates(): void {
    const activeId = this.activeTab === null ? null : adapterTabId(this.activeTab);
    for (const [tabId, btn] of this.tabButtons) {
      btn.toggleClass('local-stt-tab--active', tabId === activeId);
    }
  }

  // -------------------------------------------------------------------------
  // Model list
  // -------------------------------------------------------------------------

  private renderModelList(): void {
    if (this.listContainer === null || this.activeTab === null) {
      return;
    }

    this.listContainer.empty();
    this.progressElements.clear();

    const state = this.deps.manager.getState();

    if (state.loadStatus === 'loading') {
      this.listContainer.createEl('p', { text: 'Loading model catalog\u2026' });
      return;
    }

    if (state.loadStatus === 'error') {
      this.listContainer.createEl('p', {
        text: state.loadError ?? 'Failed to load the model catalog.',
      });
      return;
    }

    const rows = deriveModelRowStates(state);
    const activeTab = this.activeTab;
    const tabRows = rows.filter(
      (row) =>
        row.model.runtimeId === activeTab.runtimeId && row.model.familyId === activeTab.familyId,
    );

    if (tabRows.length === 0) {
      this.listContainer.createEl('p', {
        cls: 'local-stt-empty-state',
        text: 'No models available for this engine.',
      });
      return;
    }

    for (const row of tabRows) {
      this.renderRow(row, this.listContainer.createDiv());
    }
  }

  private renderRow(row: ModelRowState, container: HTMLDivElement): void {
    container.empty();

    const setting = new Setting(container);
    setting.settingEl.addClass('local-stt-model-row');
    setting.setName(row.model.displayName);

    // Description: install progress when installing/canceling, tags + size otherwise.
    if (row.isInstalling || row.isCanceling) {
      const progressState = this.buildProgressState(row);
      if (progressState !== null) {
        const progressEl = createInstallProgressElement(progressState);
        this.progressElements.set(getRowKey(row), progressEl);
        const fragment = document.createDocumentFragment();
        fragment.append(progressEl);
        setting.setDesc(fragment);
      }
    } else {
      setting.setDesc(this.buildTagsFragment(row.model));
    }

    // Action buttons based on allowedActions.
    for (const action of row.allowedActions) {
      switch (action) {
        case 'install':
          setting.addButton((button) => {
            button
              .setCta()
              .setButtonText('Install')
              .setDisabled(this.actionInProgress)
              .onClick(() => {
                void this.runAction(async () => {
                  await this.deps.manager.install({
                    familyId: row.model.familyId,
                    kind: 'catalog_model',
                    modelId: row.model.modelId,
                    runtimeId: row.model.runtimeId,
                  });
                }, 'Model install started.');
              });
          });
          break;

        case 'use':
          setting.addButton((button) => {
            button
              .setCta()
              .setButtonText('Use')
              .setDisabled(this.actionInProgress)
              .onClick(() => {
                void this.runAction(async () => {
                  await this.deps.manager.select({
                    familyId: row.model.familyId,
                    kind: 'catalog_model',
                    modelId: row.model.modelId,
                    runtimeId: row.model.runtimeId,
                  });
                  this.close();
                }, 'Model selected.');
              });
          });
          break;

        case 'selected':
          setting.addButton((button) => {
            button.setButtonText('Selected').setDisabled(true);
          });
          break;

        case 'cancel':
          setting.addButton((button) => {
            if (row.isCanceling) {
              button.setButtonText('Cancelling\u2026').setDisabled(true);
            } else {
              button
                .setCta()
                .setButtonText('Cancel')
                .setDisabled(this.actionInProgress)
                .onClick(() => {
                  void this.runAction(async () => {
                    await this.deps.manager.cancel();
                  }, 'Install cancelled.');
                });
            }
          });
          break;

        case 'remove':
          setting.addButton((button) => {
            button
              .setWarning()
              .setButtonText('Remove')
              .setDisabled(this.actionInProgress)
              .onClick(() => {
                void this.runAction(async () => {
                  await this.deps.manager.remove({
                    familyId: row.model.familyId,
                    kind: 'catalog_model',
                    modelId: row.model.modelId,
                    runtimeId: row.model.runtimeId,
                  });
                }, 'Model removed.');
              });
          });
          break;

        case 'details':
          setting.addExtraButton((button) => {
            button
              .setIcon('info')
              .setTooltip('Details')
              .onClick(() => {
                const state = this.deps.manager.getState();
                const installedModel = state.installedModels.find((m) =>
                  matchesModelTriple(m, row.model.runtimeId, row.model.familyId, row.model.modelId),
                );
                const capabilities = resolveEngineCapabilities(
                  state.compiledRuntimes,
                  state.compiledAdapters,
                  row.model.runtimeId,
                  row.model.familyId,
                );
                new ModelDetailsModal(
                  this.app,
                  row.model,
                  installedModel?.installPath ?? null,
                  capabilities,
                ).open();
              });
          });
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // State change handler
  // -------------------------------------------------------------------------

  private handleStateChange(): void {
    const state = this.deps.manager.getState();
    const { activeInstall } = state;

    // Fast path: if an install is active for a visible row, try in-place
    // progress update instead of full re-render.
    if (activeInstall !== null) {
      const key = installTripleKey(activeInstall.installUpdate);
      const existingProgressEl = this.progressElements.get(key);

      if (existingProgressEl !== null && existingProgressEl !== undefined) {
        updateInstallProgressElement(existingProgressEl, {
          ...activeInstall.installUpdate,
          isCancelling: isCancellingPhase(activeInstall.phase),
        });
        return;
      }

      // The active install belongs to a different adapter than the visible tab.
      // Progress ticks for that install don't affect visible rows — skip the
      // full re-render to avoid clobbering the DOM under the user's cursor.
      if (
        this.activeTab === null ||
        activeInstall.installUpdate.runtimeId !== this.activeTab.runtimeId ||
        activeInstall.installUpdate.familyId !== this.activeTab.familyId
      ) {
        return;
      }
    }

    this.renderModelList();
  }

  // -------------------------------------------------------------------------
  // Action runner
  // -------------------------------------------------------------------------

  private async runAction(action: () => Promise<void>, successMessage: string): Promise<void> {
    if (this.actionInProgress) {
      return;
    }

    this.actionInProgress = true;
    this.renderModelList();

    try {
      await action();
      new Notice(`Local Transcript: ${successMessage}`);
      this.deps.onChanged();
    } catch (error) {
      new Notice(`Local Transcript: ${formatErrorMessage(error)}`);
    } finally {
      this.actionInProgress = false;
      this.renderModelList();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildProgressState(row: ModelRowState): InstallProgressState | null {
    const state = this.deps.manager.getState();
    const { activeInstall } = state;

    if (activeInstall === null) {
      return null;
    }

    if (
      activeInstall.installUpdate.runtimeId !== row.model.runtimeId ||
      activeInstall.installUpdate.familyId !== row.model.familyId ||
      activeInstall.installUpdate.modelId !== row.model.modelId
    ) {
      return null;
    }

    return {
      ...activeInstall.installUpdate,
      isCancelling: isCancellingPhase(activeInstall.phase),
    };
  }

  private buildTagsFragment(model: CatalogModelRecord): DocumentFragment {
    const frag = document.createDocumentFragment();
    const tagsContainer = frag.createEl('span', { cls: 'local-stt-tags' });

    for (const tag of model.uxTags) {
      tagsContainer.createEl('span', {
        cls: 'local-stt-tag',
        text: tag,
      });
    }

    const totalSize = getTotalModelSize(model);
    if (totalSize > 0) {
      tagsContainer.createEl('span', {
        cls: 'local-stt-tag local-stt-tag--size',
        text: formatBytes(totalSize),
      });
    }

    return frag;
  }
}

function getRowKey(row: ModelRowState): string {
  return `${row.model.runtimeId}:${row.model.familyId}:${row.model.modelId}`;
}

function installTripleKey(update: {
  runtimeId: RuntimeId;
  familyId: ModelFamilyId;
  modelId: string;
}): string {
  return `${update.runtimeId}:${update.familyId}:${update.modelId}`;
}
