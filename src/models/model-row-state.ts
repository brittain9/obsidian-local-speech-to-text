import { basename } from 'node:path';

import type { ActiveInstallInfo, ModelManagerState } from './model-install-manager';
import {
  type CatalogModelRecord,
  getTotalModelSize,
  type InstalledModelRecord,
  type ModelCatalogRecord,
  type ModelFamilyId,
  matchesModelTriple,
  type RuntimeId,
  type SelectedModel,
} from './model-management-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type ModelRowAction = 'install' | 'use' | 'selected' | 'cancel' | 'remove' | 'details';

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
    installedModels.find((m) =>
      matchesModelTriple(m, model.runtimeId, model.familyId, model.modelId),
    ) !== undefined;

  const isSelected =
    selectedModel?.kind === 'catalog_model' &&
    matchesModelTriple(selectedModel, model.runtimeId, model.familyId, model.modelId);

  const thisInstall =
    activeInstall !== null &&
    matchesModelTriple(activeInstall.installUpdate, model.runtimeId, model.familyId, model.modelId)
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
      engineLabel: resolveFamilyDisplayName(
        catalog,
        selectedModel.runtimeId,
        selectedModel.familyId,
      ),
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
    catalog.models.find((m) =>
      matchesModelTriple(m, selectedModel.runtimeId, selectedModel.familyId, selectedModel.modelId),
    ) ?? null;

  const installedModel =
    installedModels.find((m) =>
      matchesModelTriple(m, selectedModel.runtimeId, selectedModel.familyId, selectedModel.modelId),
    ) ?? null;

  const displayName = catalogEntry?.displayName ?? selectedModel.modelId;
  const engineLabel = resolveFamilyDisplayName(
    catalog,
    selectedModel.runtimeId,
    selectedModel.familyId,
  );

  const sizeBytes =
    installedModel?.totalSizeBytes ??
    (catalogEntry !== null ? getTotalModelSize(catalogEntry) : null);

  return {
    displayName,
    engineLabel,
    detail:
      installedModel !== null
        ? 'Model is installed and ready.'
        : 'The selected managed model is not installed.',
    installedLabel: installedModel !== null ? 'Installed' : 'Not installed',
    sourceLabel: 'Managed download',
    sizeBytes,
    installLocation: installedModel?.installPath ?? null,
    resolvedPath: installedModel?.runtimePath ?? null,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveFamilyDisplayName(
  catalog: ModelCatalogRecord,
  runtimeId: RuntimeId,
  familyId: ModelFamilyId,
): string {
  const record = catalog.families.find((f) => f.runtimeId === runtimeId && f.familyId === familyId);
  return record?.displayName ?? familyId;
}

function compareCatalogModels(left: CatalogModelRecord, right: CatalogModelRecord): number {
  return getTotalModelSize(left) - getTotalModelSize(right);
}
