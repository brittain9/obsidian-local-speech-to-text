import { basename } from 'node:path';

import type { PluginSettings } from '../settings/plugin-settings';
import type { PluginLogger } from '../shared/plugin-logger';
import type {
  InstalledModelsEvent,
  ModelCatalogEvent,
  ModelInstallUpdateEvent,
  ModelProbeResultEvent,
  ModelStoreEvent,
} from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import {
  type CatalogModelRecord,
  type CatalogModelSelection,
  type EngineId,
  getEngineDisplayName,
  getTotalModelSize,
  type InstalledModelRecord,
  isEngineId,
  type ModelCatalogRecord,
  type ModelInstallUpdateRecord,
  type ModelProbeResultRecord,
  type ModelStoreRecord,
  type SelectedModel,
} from './model-management-types';

type InstallUpdateListener = (event: ModelInstallUpdateEvent) => void;

interface ModelManagementServiceDependencies {
  getSettings: () => PluginSettings;
  logger?: PluginLogger;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection: Pick<
    SidecarConnection,
    | 'cancelModelInstall'
    | 'getModelStore'
    | 'getSystemInfo'
    | 'installModel'
    | 'listInstalledModels'
    | 'listModelCatalog'
    | 'probeModelSelection'
    | 'removeModel'
    | 'subscribe'
  >;
}

export interface CurrentModelCardState {
  detail: string;
  displayName: string;
  engineLabel: string;
  installLocation: string | null;
  installedLabel: string;
  resolvedPath: string | null;
  sizeBytes: number | null;
  sourceLabel: string;
}

export interface CatalogExplorerRowState {
  installUpdate: ModelInstallUpdateRecord | null;
  installedModel: InstalledModelRecord | null;
  isSelected: boolean;
  model: CatalogModelRecord;
}

export interface ModelManagementSnapshot {
  activeInstall: ModelInstallUpdateRecord | null;
  catalog: ModelCatalogRecord;
  currentModel: CurrentModelCardState;
  currentSelection: SelectedModel | null;
  installedModels: InstalledModelRecord[];
  modelStore: ModelStoreRecord;
  rows: CatalogExplorerRowState[];
  supportedEngineIds: EngineId[];
}

export class ModelManagementService {
  private activeInstall: ModelInstallUpdateRecord | null = null;
  private readonly installUpdateListeners = new Set<InstallUpdateListener>();
  private lastLoggedInstallStateKey: string | null = null;
  private readonly releaseSidecarSubscription: () => void;

  constructor(private readonly dependencies: ModelManagementServiceDependencies) {
    this.releaseSidecarSubscription = this.dependencies.sidecarConnection.subscribe((event) => {
      if (event.type !== 'model_install_update') {
        return;
      }

      this.activeInstall = isTerminalInstallState(event.state) ? null : event;
      const installStateKey = `${event.installId}:${event.state}`;

      if (installStateKey !== this.lastLoggedInstallStateKey) {
        const logMessage = createInstallLifecycleLogMessage(event);

        if (logMessage !== null) {
          this.dependencies.logger?.debug('model', logMessage);
        }
      }

      this.lastLoggedInstallStateKey = isTerminalInstallState(event.state) ? null : installStateKey;

      for (const listener of this.installUpdateListeners) {
        listener(event);
      }
    });
  }

  dispose(): void {
    this.releaseSidecarSubscription();
    this.installUpdateListeners.clear();
  }

  subscribeToInstallUpdates(listener: InstallUpdateListener): () => void {
    this.installUpdateListeners.add(listener);

    return () => {
      this.installUpdateListeners.delete(listener);
    };
  }

  async getSnapshot(): Promise<ModelManagementSnapshot> {
    this.dependencies.logger?.debug('model', 'loading model management snapshot');
    const settings = this.dependencies.getSettings();
    const modelStorePathOverride =
      settings.modelStorePathOverride.length > 0 ? settings.modelStorePathOverride : undefined;
    const [catalogEvent, installedEvent, modelStoreEvent, probeResult, supportedEngineIds] =
      await Promise.all([
        this.dependencies.sidecarConnection.listModelCatalog(),
        this.dependencies.sidecarConnection.listInstalledModels(modelStorePathOverride),
        this.dependencies.sidecarConnection.getModelStore(modelStorePathOverride),
        this.probeCurrentSelection(settings.selectedModel, modelStorePathOverride),
        this.fetchSupportedEngineIds(),
      ]);

    return buildModelManagementSnapshot({
      activeInstall: this.activeInstall,
      catalog: catalogEvent,
      currentSelection: settings.selectedModel,
      installedModels: installedEvent.models,
      modelStore: modelStoreEvent,
      probeResult,
      supportedEngineIds,
    });
  }

  async installCatalogModel(selection: CatalogModelSelection): Promise<ModelInstallUpdateEvent> {
    this.dependencies.logger?.debug(
      'model',
      `initiating install for ${selection.engineId}:${selection.modelId}`,
    );
    const update = await this.dependencies.sidecarConnection.installModel({
      engineId: selection.engineId,
      installId: createInstallId(),
      modelId: selection.modelId,
      ...createModelStoreOverridePayload(this.dependencies.getSettings().modelStorePathOverride),
    });

    if (update.state !== 'failed') {
      this.activeInstall = update;
    }

    return update;
  }

  async cancelActiveInstall(): Promise<ModelInstallUpdateEvent | null> {
    const activeInstall = this.activeInstall;

    if (activeInstall === null) {
      return null;
    }

    return this.dependencies.sidecarConnection.cancelModelInstall(activeInstall.installId);
  }

  async removeCatalogModel(selection: CatalogModelSelection): Promise<void> {
    this.dependencies.logger?.debug('model', `removing ${selection.engineId}:${selection.modelId}`);
    const event = await this.dependencies.sidecarConnection.removeModel({
      engineId: selection.engineId,
      modelId: selection.modelId,
      ...createModelStoreOverridePayload(this.dependencies.getSettings().modelStorePathOverride),
    });
    const currentSelection = this.dependencies.getSettings().selectedModel;

    if (
      event.removed &&
      currentSelection?.kind === 'catalog_model' &&
      currentSelection.engineId === selection.engineId &&
      currentSelection.modelId === selection.modelId
    ) {
      await this.updateSettings({ selectedModel: null });
    }
  }

  async selectCatalogModel(selection: CatalogModelSelection): Promise<ModelProbeResultEvent> {
    const probeResult = await this.dependencies.sidecarConnection.probeModelSelection({
      modelSelection: selection,
      ...createModelStoreOverridePayload(this.dependencies.getSettings().modelStorePathOverride),
    });

    if (!probeResult.available) {
      throw new Error(createProbeFailureMessage(probeResult));
    }

    this.dependencies.logger?.debug('model', `selected ${selection.engineId}:${selection.modelId}`);
    await this.updateSettings({ selectedModel: selection });
    return probeResult;
  }

  async validateAndSelectExternalFile(filePath: string): Promise<ModelProbeResultEvent> {
    const selection: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: filePath.trim(),
      kind: 'external_file',
    };
    const probeResult = await this.dependencies.sidecarConnection.probeModelSelection({
      modelSelection: selection,
      ...createModelStoreOverridePayload(this.dependencies.getSettings().modelStorePathOverride),
    });

    if (!probeResult.available) {
      throw new Error(createProbeFailureMessage(probeResult));
    }

    await this.updateSettings({ selectedModel: selection });
    return probeResult;
  }

  async clearSelectedModel(): Promise<void> {
    this.dependencies.logger?.debug('model', 'cleared selected model');
    await this.updateSettings({ selectedModel: null });
  }

  private async probeCurrentSelection(
    selectedModel: SelectedModel | null,
    modelStorePathOverride: string | undefined,
  ): Promise<ModelProbeResultRecord | null> {
    if (selectedModel === null) {
      return null;
    }

    return this.dependencies.sidecarConnection.probeModelSelection({
      modelSelection: selectedModel,
      ...createModelStoreOverridePayload(modelStorePathOverride),
    });
  }

  private async fetchSupportedEngineIds(): Promise<EngineId[]> {
    try {
      const info = await this.dependencies.sidecarConnection.getSystemInfo();
      return info.compiledEngines.filter(isEngineId);
    } catch {
      return ['whisper_cpp'];
    }
  }

  private async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    await this.dependencies.saveSettings({
      ...this.dependencies.getSettings(),
      ...patch,
    });
  }
}

export function buildModelManagementSnapshot(input: {
  activeInstall: ModelInstallUpdateRecord | null;
  catalog: ModelCatalogEvent;
  currentSelection: SelectedModel | null;
  installedModels: InstalledModelsEvent['models'];
  modelStore: ModelStoreEvent;
  probeResult: ModelProbeResultRecord | null;
  supportedEngineIds: EngineId[];
}): ModelManagementSnapshot {
  return {
    activeInstall: input.activeInstall,
    catalog: input.catalog,
    currentModel: buildCurrentModelCardState(
      input.currentSelection,
      input.catalog,
      input.installedModels,
      input.probeResult,
    ),
    currentSelection: input.currentSelection,
    installedModels: input.installedModels,
    modelStore: input.modelStore,
    rows: buildCatalogExplorerRows(
      input.catalog,
      input.installedModels,
      input.currentSelection,
      input.activeInstall,
    ),
    supportedEngineIds: input.supportedEngineIds,
  };
}

export function isTerminalInstallState(state: ModelInstallUpdateRecord['state']): boolean {
  return state === 'cancelled' || state === 'completed' || state === 'failed';
}

export function createInstallLifecycleLogMessage(
  installUpdate: ModelInstallUpdateRecord,
): string | null {
  const installLabel = `${installUpdate.modelId} (${installUpdate.installId})`;

  switch (installUpdate.state) {
    case 'downloading':
      return `install ${installLabel}: download started`;
    case 'completed':
      return `install ${installLabel}: completed`;
    case 'cancelled':
      return `install ${installLabel}: cancelled`;
    case 'failed':
    case 'probing':
    case 'queued':
    case 'verifying':
      return null;
  }
}

export function applyInstallUpdateToSnapshot(
  snapshot: ModelManagementSnapshot,
  installUpdate: ModelInstallUpdateRecord,
): ModelManagementSnapshot {
  const nextActiveInstall = isTerminalInstallState(installUpdate.state) ? null : installUpdate;

  return {
    ...snapshot,
    activeInstall: nextActiveInstall,
    rows: snapshot.rows.map((row) => {
      if (
        row.model.engineId !== installUpdate.engineId ||
        row.model.modelId !== installUpdate.modelId
      ) {
        return row;
      }

      return {
        ...row,
        installUpdate: nextActiveInstall,
      };
    }),
  };
}

export function buildCatalogExplorerRows(
  catalog: ModelCatalogRecord,
  installedModels: InstalledModelRecord[],
  currentSelection: SelectedModel | null,
  activeInstall: ModelInstallUpdateRecord | null,
): CatalogExplorerRowState[] {
  return [...catalog.models].sort(compareCatalogModels).map((model) => ({
    installUpdate:
      activeInstall !== null &&
      activeInstall.engineId === model.engineId &&
      activeInstall.modelId === model.modelId
        ? activeInstall
        : null,
    installedModel:
      installedModels.find(
        (installedModel) =>
          installedModel.engineId === model.engineId && installedModel.modelId === model.modelId,
      ) ?? null,
    isSelected:
      currentSelection?.kind === 'catalog_model' &&
      currentSelection.engineId === model.engineId &&
      currentSelection.modelId === model.modelId,
    model,
  }));
}

export function buildCurrentModelCardState(
  currentSelection: SelectedModel | null,
  catalog: ModelCatalogRecord,
  installedModels: InstalledModelRecord[],
  probeResult: ModelProbeResultRecord | null,
): CurrentModelCardState {
  if (currentSelection === null) {
    return {
      detail: 'Choose an installed model or validate an external file.',
      displayName: 'No model selected',
      engineLabel: '',
      installLocation: null,
      installedLabel: 'Not selected',
      resolvedPath: null,
      sizeBytes: null,
      sourceLabel: '',
    };
  }

  const displayName =
    probeResult?.displayName ?? resolveSelectionDisplayName(currentSelection, catalog);
  const installedModel =
    currentSelection.kind === 'catalog_model'
      ? (installedModels.find(
          (model) =>
            model.engineId === currentSelection.engineId &&
            model.modelId === currentSelection.modelId,
        ) ?? null)
      : null;
  const catalogEntry =
    currentSelection.kind === 'catalog_model'
      ? (catalog.models.find(
          (model) =>
            model.engineId === currentSelection.engineId &&
            model.modelId === currentSelection.modelId,
        ) ?? null)
      : null;
  const sizeBytes =
    probeResult?.sizeBytes ??
    installedModel?.totalSizeBytes ??
    (catalogEntry !== null ? getTotalModelSize(catalogEntry) : null);

  return {
    detail: probeResult?.message ?? defaultSelectionDetail(currentSelection),
    displayName,
    engineLabel: getEngineDisplayName(currentSelection.engineId),
    installLocation: installedModel?.installPath ?? null,
    installedLabel: resolveInstalledLabel(currentSelection, probeResult, installedModel),
    resolvedPath: probeResult?.resolvedPath ?? installedModel?.runtimePath ?? null,
    sizeBytes,
    sourceLabel: currentSelection.kind === 'catalog_model' ? 'Managed download' : 'External file',
  };
}

function compareCatalogModels(left: CatalogModelRecord, right: CatalogModelRecord): number {
  return getTotalModelSize(right) - getTotalModelSize(left);
}

function createModelStoreOverridePayload(modelStorePathOverride: string | undefined): {
  modelStorePathOverride?: string;
} {
  return modelStorePathOverride !== undefined && modelStorePathOverride.length > 0
    ? { modelStorePathOverride }
    : {};
}

function createInstallId(): string {
  return `install-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

function createProbeFailureMessage(probeResult: ModelProbeResultEvent): string {
  return probeResult.details
    ? `${probeResult.message} (${probeResult.details})`
    : probeResult.message;
}

function defaultSelectionDetail(selection: SelectedModel): string {
  return selection.kind === 'catalog_model'
    ? 'The selected managed model has not been validated yet.'
    : 'The selected external file has not been validated yet.';
}

function resolveInstalledLabel(
  selection: SelectedModel,
  probeResult: ModelProbeResultRecord | null,
  installedModel: InstalledModelRecord | null,
): string {
  if (selection.kind === 'external_file') {
    return probeResult?.available ? 'Validated external file' : 'External file';
  }

  if (probeResult?.available || installedModel !== null) {
    return 'Installed';
  }

  if (probeResult?.status === 'missing') {
    return 'Not installed';
  }

  return 'Unavailable';
}

function resolveSelectionDisplayName(
  selection: SelectedModel,
  catalog: ModelCatalogRecord,
): string {
  if (selection.kind === 'external_file') {
    return basename(selection.filePath);
  }

  return (
    catalog.models.find(
      (model) => model.engineId === selection.engineId && model.modelId === selection.modelId,
    )?.displayName ?? selection.modelId
  );
}
