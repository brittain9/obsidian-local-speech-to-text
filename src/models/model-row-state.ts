import { basename } from 'node:path';

import type { ActiveInstallInfo, ModelManagerState } from './model-install-manager';
import {
  type CatalogModelRecord,
  getEngineDisplayName,
  getTotalModelSize,
  type InstalledModelRecord,
  type SelectedModel,
} from './model-management-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ModelRowAction = 'install' | 'use' | 'selected' | 'cancel' | 'remove' | 'details';

export interface ModelRowState {
  model: CatalogModelRecord;
  installed: boolean;
  isSelected: boolean;
  isInstalling: boolean;
  isCanceling: boolean;
  allowedActions: ModelRowAction[];
}

export interface CurrentModelDisplay {
  displayName: string;
  engineLabel: string;
  detail: string;
  installedLabel: string;
  sourceLabel: string;
  sizeBytes: number | null;
  installLocation: string | null;
  resolvedPath: string | null;
}

// ---------------------------------------------------------------------------
// deriveModelRowStates
// ---------------------------------------------------------------------------

export function deriveModelRowStates(state: ModelManagerState): ModelRowState[] {
  const { catalog, installedModels, selectedModel, activeInstall } = state;

  return [...catalog.models].sort(compareCatalogModels).map((model) => {
    return deriveRowState(model, installedModels, selectedModel, activeInstall);
  });
}

function deriveRowState(
  model: CatalogModelRecord,
  installedModels: InstalledModelRecord[],
  selectedModel: SelectedModel | null,
  activeInstall: ActiveInstallInfo | null,
): ModelRowState {
  const installed =
    installedModels.find((m) => m.engineId === model.engineId && m.modelId === model.modelId) !==
    undefined;

  const isSelected =
    selectedModel?.kind === 'catalog_model' &&
    selectedModel.engineId === model.engineId &&
    selectedModel.modelId === model.modelId;

  const thisInstall =
    activeInstall !== null &&
    activeInstall.installUpdate.engineId === model.engineId &&
    activeInstall.installUpdate.modelId === model.modelId
      ? activeInstall
      : null;

  const isInstalling = thisInstall?.phase === 'installing';
  const isCanceling = thisInstall?.phase === 'canceling' || thisInstall?.phase === 'cancelStuck';

  const hasOtherActiveInstall = activeInstall !== null && thisInstall === null;

  const allowedActions = deriveAllowedActions({
    installed,
    isSelected,
    isInstalling,
    isCanceling,
    hasOtherActiveInstall,
  });

  return {
    model,
    installed,
    isSelected,
    isInstalling,
    isCanceling,
    allowedActions,
  };
}

function deriveAllowedActions(flags: {
  installed: boolean;
  isSelected: boolean;
  isInstalling: boolean;
  isCanceling: boolean;
  hasOtherActiveInstall: boolean;
}): ModelRowAction[] {
  const { installed, isSelected, isInstalling, isCanceling, hasOtherActiveInstall } = flags;

  // Currently canceling or cancelStuck — only details allowed.
  if (isCanceling) {
    return ['details'];
  }

  // Currently installing — cancel and details.
  if (isInstalling) {
    return ['cancel', 'details'];
  }

  // Not installing this model, and it is not installed.
  if (!installed) {
    // Another model is installing — block install.
    if (hasOtherActiveInstall) {
      return ['details'];
    }

    // No active install — offer install.
    return ['install', 'details'];
  }

  // Installed and selected.
  if (isSelected) {
    return ['selected', 'details'];
  }

  // Installed and not selected.
  return ['use', 'remove', 'details'];
}

// ---------------------------------------------------------------------------
// deriveCurrentModelDisplay
// ---------------------------------------------------------------------------

const EMPTY_CURRENT_MODEL_DISPLAY: CurrentModelDisplay = {
  displayName: 'No model selected',
  engineLabel: '',
  detail: 'Choose an installed model or validate an external file.',
  installedLabel: 'Not selected',
  sourceLabel: '',
  sizeBytes: null,
  installLocation: null,
  resolvedPath: null,
};

export function deriveCurrentModelDisplay(state: ModelManagerState): CurrentModelDisplay {
  const { selectedModel, catalog, installedModels } = state;

  if (selectedModel === null) {
    return EMPTY_CURRENT_MODEL_DISPLAY;
  }

  if (selectedModel.kind === 'external_file') {
    return {
      displayName: basename(selectedModel.filePath),
      engineLabel: getEngineDisplayName(selectedModel.engineId),
      detail: 'The selected external file has not been validated yet.',
      installedLabel: 'External file',
      sourceLabel: 'External file',
      sizeBytes: null,
      installLocation: null,
      resolvedPath: selectedModel.filePath,
    };
  }

  // catalog_model
  const catalogEntry =
    catalog.models.find(
      (m) => m.engineId === selectedModel.engineId && m.modelId === selectedModel.modelId,
    ) ?? null;

  const installedModel =
    installedModels.find(
      (m) => m.engineId === selectedModel.engineId && m.modelId === selectedModel.modelId,
    ) ?? null;

  const displayName = catalogEntry?.displayName ?? selectedModel.modelId;
  const engineLabel = getEngineDisplayName(selectedModel.engineId);

  const sizeBytes =
    installedModel?.totalSizeBytes ??
    (catalogEntry !== null ? getTotalModelSize(catalogEntry) : null);

  const installedLabel = resolveInstalledLabel(installedModel);

  return {
    displayName,
    engineLabel,
    detail: deriveSelectedModelDetail(installedModel),
    installedLabel,
    sourceLabel: 'Managed download',
    sizeBytes,
    installLocation: installedModel?.installPath ?? null,
    resolvedPath: installedModel?.runtimePath ?? null,
  };
}

function resolveInstalledLabel(installedModel: InstalledModelRecord | null): string {
  if (installedModel !== null) {
    return 'Installed';
  }

  return 'Not installed';
}

function deriveSelectedModelDetail(installedModel: InstalledModelRecord | null): string {
  if (installedModel !== null) {
    return 'Model is installed and ready.';
  }

  return 'The selected managed model is not installed.';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function compareCatalogModels(left: CatalogModelRecord, right: CatalogModelRecord): number {
  return getTotalModelSize(left) - getTotalModelSize(right);
}
