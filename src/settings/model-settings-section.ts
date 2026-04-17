import { Setting } from 'obsidian';

import { isCancellingPhase, type ModelInstallManager } from '../models/model-install-manager';
import {
  createInstallProgressElement,
  updateInstallProgressElement,
} from '../models/model-install-progress';
import { deriveCurrentModelDisplay } from '../models/model-row-state';

// ---------------------------------------------------------------------------
// Badge helper (maps installedLabel -> CSS modifier + display text)
// ---------------------------------------------------------------------------

function getBadgeInfo(installedLabel: string): { modifier: string; text: string } {
  switch (installedLabel) {
    case 'Installed':
      return { modifier: 'ready', text: 'Ready' };
    case 'Not installed':
      return { modifier: 'missing', text: 'Not installed' };
    case 'External file':
      return { modifier: 'external', text: 'Unverified' };
    default:
      return { modifier: 'none', text: 'No model' };
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ModelSectionCallbacks {
  onManageModels: () => void;
  onExternalFile: () => void;
  onModelInfo: (() => void) | null;
}

/**
 * Renders the model section of the settings tab using the new
 * ModelInstallManager as the state source.
 *
 * Returns a dispose function that unsubscribes from manager state changes.
 * Call it when the settings tab is hidden or re-rendered.
 */
export function renderModelSection(
  container: HTMLDivElement,
  manager: ModelInstallManager,
  callbacks: ModelSectionCallbacks,
): () => void {
  let installProgressEl: HTMLDivElement | null = null;

  function render(): void {
    container.empty();
    installProgressEl = null;

    const state = manager.getState();
    const currentModel = deriveCurrentModelDisplay(state);

    // --- Current model row ---
    const descFragment = document.createDocumentFragment();
    if (currentModel.engineLabel.length > 0) {
      descFragment.createSpan({ text: `${currentModel.engineLabel} \u00b7 ` });
    }
    const badge = getBadgeInfo(currentModel.installedLabel);
    descFragment.createSpan({
      cls: `local-stt-badge local-stt-badge--${badge.modifier}`,
      text: badge.text,
    });

    const cardSetting = new Setting(container)
      .setName(currentModel.displayName)
      .setDesc(descFragment);

    cardSetting.addButton((button) => {
      button
        .setCta()
        .setButtonText('Manage models')
        .onClick(() => {
          callbacks.onManageModels();
        });
    });

    cardSetting.addExtraButton((button) => {
      button
        .setIcon('file-input')
        .setTooltip('Use external file')
        .onClick(() => {
          callbacks.onExternalFile();
        });
    });

    if (callbacks.onModelInfo !== null) {
      const onModelInfo = callbacks.onModelInfo;
      cardSetting.addExtraButton((button) => {
        button
          .setIcon('info')
          .setTooltip('Model details')
          .onClick(() => {
            onModelInfo();
          });
      });
    }

    // --- Install progress panel ---
    const { activeInstall } = state;
    if (activeInstall !== null) {
      const progressState = {
        ...activeInstall.installUpdate,
        isCancelling: isCancellingPhase(activeInstall.phase),
      };
      const progressEl = createInstallProgressElement(progressState);
      installProgressEl = progressEl;

      const activeInstallDisplayName =
        state.catalog.models.find(
          (m) =>
            m.runtimeId === activeInstall.installUpdate.runtimeId &&
            m.familyId === activeInstall.installUpdate.familyId &&
            m.modelId === activeInstall.installUpdate.modelId,
        )?.displayName ?? activeInstall.installUpdate.modelId;

      const fragment = document.createDocumentFragment();
      fragment.append(progressEl);
      new Setting(container).setName(`Installing: ${activeInstallDisplayName}`).setDesc(fragment);
    }
  }

  function handleStateChange(): void {
    const state = manager.getState();
    const { activeInstall } = state;

    // If progress element is present and install is still active, do a fast
    // in-place update instead of a full re-render.
    if (activeInstall !== null && installProgressEl !== null) {
      updateInstallProgressElement(installProgressEl, {
        ...activeInstall.installUpdate,
        isCancelling: isCancellingPhase(activeInstall.phase),
      });
      return;
    }

    render();
  }

  render();
  return manager.subscribe(handleStateChange);
}
