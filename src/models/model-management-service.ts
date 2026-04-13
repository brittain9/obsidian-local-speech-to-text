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
  selectedModelEquals,
} from './model-management-types';

type InstallStateListener = () => void;

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
  installState: ActiveInstallState | null;
  installedModel: InstalledModelRecord | null;
  isSelected: boolean;
  model: CatalogModelRecord;
}

export interface ActiveInstallState {
  installUpdate: ModelInstallUpdateRecord;
  isCancelling: boolean;
}

export interface ModelManagementSnapshot {
  activeInstall: ActiveInstallState | null;
  catalog: ModelCatalogRecord;
  currentModel: CurrentModelCardState;
  currentSelection: SelectedModel | null;
  installedModels: InstalledModelRecord[];
  modelStore: ModelStoreRecord;
  rows: CatalogExplorerRowState[];
  supportedEngineIds: EngineId[];
}

export class ModelManagementService {
  private activeInstall: ActiveInstallState | null = null;
  private cachedSnapshot: ModelManagementSnapshot | null = null;
  private cancelForceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly installStateListeners = new Set<InstallStateListener>();
  private lastLoggedInstallStateKey: string | null = null;
  private readonly releaseSidecarSubscription: () => void;

  constructor(private readonly dependencies: ModelManagementServiceDependencies) {
    this.releaseSidecarSubscription = this.dependencies.sidecarConnection.subscribe((event) => {
      if (event.type !== 'model_install_update') {
        return;
      }

      this.activeInstall = resolveNextActiveInstallState(this.activeInstall, event);
      const installStateKey = `${event.installId}:${event.state}`;

      if (installStateKey !== this.lastLoggedInstallStateKey) {
        const logMessage = createInstallLifecycleLogMessage(event);

        if (logMessage !== null) {
          this.dependencies.logger?.debug('model', logMessage);
        }
      }

      this.lastLoggedInstallStateKey = isTerminalInstallState(event.state) ? null : installStateKey;
      this.notifyInstallStateChanged();
    });
  }

  dispose(): void {
    if (this.cancelForceTimer !== null) {
      globalThis.clearTimeout(this.cancelForceTimer);
    }

    this.releaseSidecarSubscription();
    this.installStateListeners.clear();
  }

  subscribeToInstallUpdates(listener: InstallStateListener): () => void {
    this.installStateListeners.add(listener);

    return () => {
      this.installStateListeners.delete(listener);
    };
  }

  getActiveInstallState(): ActiveInstallState | null {
    return this.activeInstall;
  }

  getCachedSnapshot(): ModelManagementSnapshot | null {
    return this.cachedSnapshot;
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

    const snapshot = buildModelManagementSnapshot({
      activeInstall: this.activeInstall,
      catalog: catalogEvent,
      currentSelection: settings.selectedModel,
      installedModels: installedEvent.models,
      modelStore: modelStoreEvent,
      probeResult,
      supportedEngineIds,
    });
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  async installCatalogModel(selection: CatalogModelSelection): Promise<ModelInstallUpdateEvent> {
    if (this.activeInstall !== null) {
      throw new Error('Another model is already being installed.');
    }

    this.dependencies.logger?.debug(
      'model',
      `initiating install for ${selection.engineId}:${selection.modelId}`,
    );
    return this.dependencies.sidecarConnection.installModel({
      engineId: selection.engineId,
      installId: createInstallId(),
      modelId: selection.modelId,
      ...createModelStoreOverridePayload(this.dependencies.getSettings().modelStorePathOverride),
    });
  }

  async cancelActiveInstall(): Promise<void> {
    const activeInstall = this.activeInstall;

    if (activeInstall === null || activeInstall.isCancelling) {
      return;
    }

    if (this.cancelForceTimer !== null) {
      globalThis.clearTimeout(this.cancelForceTimer);
      this.cancelForceTimer = null;
    }

    this.activeInstall = {
      ...activeInstall,
      isCancelling: true,
    };
    this.notifyInstallStateChanged();

    try {
      await this.dependencies.sidecarConnection.cancelModelInstall(
        activeInstall.installUpdate.installId,
      );
    } catch (error) {
      if (
        this.activeInstall !== null &&
        this.activeInstall.installUpdate.installId === activeInstall.installUpdate.installId
      ) {
        this.activeInstall = {
          ...this.activeInstall,
          isCancelling: false,
        };
        this.notifyInstallStateChanged();
      }

      throw error;
    }

    const cancelledInstallId = activeInstall.installUpdate.installId;
    this.cancelForceTimer = globalThis.setTimeout(() => {
      if (
        this.activeInstall !== null &&
        this.activeInstall.installUpdate.installId === cancelledInstallId &&
        this.activeInstall.isCancelling
      ) {
        this.dependencies.logger?.warn(
          'model',
          `force-clearing stale cancel state for ${cancelledInstallId}`,
        );
        this.activeInstall = null;
        this.notifyInstallStateChanged();
      }
    }, 30_000);
  }

  async removeCatalogModel(selection: CatalogModelSelection): Promise<void> {
    if (
      this.activeInstall !== null &&
      this.activeInstall.installUpdate.engineId === selection.engineId &&
      this.activeInstall.installUpdate.modelId === selection.modelId
    ) {
      throw new Error('This model is currently being installed and cannot be removed.');
    }

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

  private notifyInstallStateChanged(): void {
    for (const listener of this.installStateListeners) {
      listener();
    }
  }
}

export function buildModelManagementSnapshot(input: {
  activeInstall: ActiveInstallState | null;
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

export function applyActiveInstallStateToSnapshot(
  snapshot: ModelManagementSnapshot,
  activeInstall: ActiveInstallState,
): ModelManagementSnapshot {
  const previousInstall = snapshot.activeInstall?.installUpdate ?? null;
  const nextInstall = activeInstall.installUpdate;

  return {
    ...snapshot,
    activeInstall,
    rows: snapshot.rows.map((row) => {
      const matchesNextInstall =
        row.model.engineId === nextInstall.engineId && row.model.modelId === nextInstall.modelId;
      const matchesPreviousInstall =
        previousInstall !== null &&
        row.model.engineId === previousInstall.engineId &&
        row.model.modelId === previousInstall.modelId;

      if (!matchesNextInstall && !matchesPreviousInstall) {
        return row;
      }

      return {
        ...row,
        installState: matchesNextInstall ? activeInstall : null,
      };
    }),
  };
}

export function buildCatalogExplorerRows(
  catalog: ModelCatalogRecord,
  installedModels: InstalledModelRecord[],
  currentSelection: SelectedModel | null,
  activeInstall: ActiveInstallState | null,
): CatalogExplorerRowState[] {
  return [...catalog.models].sort(compareCatalogModels).map((model) => ({
    installState:
      activeInstall !== null &&
      activeInstall.installUpdate.engineId === model.engineId &&
      activeInstall.installUpdate.modelId === model.modelId
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

  const matchedProbe =
    probeResult !== null && selectedModelEquals(probeResult.selection, currentSelection)
      ? probeResult
      : null;

  const displayName =
    matchedProbe?.displayName ?? resolveSelectionDisplayName(currentSelection, catalog);
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
    matchedProbe?.sizeBytes ??
    installedModel?.totalSizeBytes ??
    (catalogEntry !== null ? getTotalModelSize(catalogEntry) : null);

  return {
    detail: matchedProbe?.message ?? defaultSelectionDetail(currentSelection),
    displayName,
    engineLabel: getEngineDisplayName(currentSelection.engineId),
    installLocation: installedModel?.installPath ?? null,
    installedLabel: resolveInstalledLabel(currentSelection, matchedProbe, installedModel),
    resolvedPath: matchedProbe?.resolvedPath ?? installedModel?.runtimePath ?? null,
    sizeBytes,
    sourceLabel: currentSelection.kind === 'catalog_model' ? 'Managed download' : 'External file',
  };
}

function compareCatalogModels(left: CatalogModelRecord, right: CatalogModelRecord): number {
  return getTotalModelSize(left) - getTotalModelSize(right);
}

function resolveNextActiveInstallState(
  currentState: ActiveInstallState | null,
  installUpdate: ModelInstallUpdateEvent,
): ActiveInstallState | null {
  if (isTerminalInstallState(installUpdate.state)) {
    return null;
  }

  return {
    installUpdate,
    isCancelling:
      currentState?.installUpdate.installId === installUpdate.installId &&
      currentState.isCancelling,
  };
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
