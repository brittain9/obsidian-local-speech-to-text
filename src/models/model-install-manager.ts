import type { PluginSettings } from '../settings/plugin-settings';
import type { PluginLogger } from '../shared/plugin-logger';
import type {
  CompiledAdapterInfo,
  CompiledRuntimeInfo,
  ModelInstallUpdateEvent,
  ModelProbeResultEvent,
  SidecarEvent,
  SystemInfoEvent,
} from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import {
  type CatalogModelSelection,
  type InstalledModelRecord,
  type ModelCatalogRecord,
  type ModelInstallUpdateRecord,
  type ModelStoreRecord,
  matchesModelTriple,
  type SelectedModel,
  type SelectedModelCapabilities,
  selectedModelEquals,
} from './model-management-types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InstallPhase = 'canceling' | 'cancelStuck' | 'installing';

export interface ActiveInstallInfo {
  installUpdate: ModelInstallUpdateRecord;
  lastError: string | null;
  phase: InstallPhase;
}

type LoadStatus = 'error' | 'loading' | 'ready';

export interface ModelManagerState {
  activeInstall: ActiveInstallInfo | null;
  catalog: ModelCatalogRecord;
  compiledAdapters: CompiledAdapterInfo[];
  compiledRuntimes: CompiledRuntimeInfo[];
  installedModels: InstalledModelRecord[];
  loadError: string | null;
  loadStatus: LoadStatus;
  modelStore: ModelStoreRecord;
  selectedModel: SelectedModel | null;
  selectedModelCapabilities: SelectedModelCapabilities;
}

interface ModelInstallManagerDependencies {
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function isTerminalInstallState(state: ModelInstallUpdateRecord['state']): boolean {
  return state === 'cancelled' || state === 'completed' || state === 'failed';
}

export function isCancellingPhase(phase: InstallPhase): boolean {
  return phase === 'canceling' || phase === 'cancelStuck';
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

export function createInstallId(): string {
  return `install-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CANCEL_STUCK_TIMEOUT_MS = 30_000;

const EMPTY_CATALOG: ModelCatalogRecord = {
  catalogVersion: 0,
  collections: [],
  families: [],
  models: [],
};

const EMPTY_MODEL_STORE: ModelStoreRecord = {
  overridePath: null,
  path: '',
  usingDefaultPath: true,
};

function createModelStoreOverridePayload(modelStorePathOverride: string | undefined): {
  modelStorePathOverride?: string;
} {
  return modelStorePathOverride !== undefined && modelStorePathOverride.length > 0
    ? { modelStorePathOverride }
    : {};
}

function createProbeFailureMessage(probeResult: ModelProbeResultEvent): string {
  return probeResult.details
    ? `${probeResult.message} (${probeResult.details})`
    : probeResult.message;
}

// ---------------------------------------------------------------------------
// ModelInstallManager
// ---------------------------------------------------------------------------

export class ModelInstallManager {
  private activeInstall: ActiveInstallInfo | null = null;
  private cancelStuckTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private catalog: ModelCatalogRecord = EMPTY_CATALOG;
  private compiledAdapters: CompiledAdapterInfo[] = [];
  private compiledRuntimes: CompiledRuntimeInfo[] = [];
  private installedModels: InstalledModelRecord[] = [];
  private lastLoggedInstallStateKey: string | null = null;
  private readonly listeners = new Set<() => void>();
  private loadError: string | null = null;
  private loadStatus: LoadStatus = 'loading';
  private modelStore: ModelStoreRecord = EMPTY_MODEL_STORE;
  private releaseSidecarSubscription: (() => void) | null = null;
  private selectedModelCapabilities: SelectedModelCapabilities = { status: 'none' };

  constructor(private readonly deps: ModelInstallManagerDependencies) {}

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    this.loadStatus = 'loading';
    this.loadError = null;

    // Wire up the sidecar event listener before fetching so we don't miss
    // install events that arrive during the init fetch.
    if (this.releaseSidecarSubscription === null) {
      this.releaseSidecarSubscription = this.deps.sidecarConnection.subscribe((event) => {
        this.handleSidecarEvent(event);
      });
    }

    try {
      const settings = this.deps.getSettings();
      const overridePayload = createModelStoreOverridePayload(settings.modelStorePathOverride);

      const [catalogEvent, installedEvent, modelStoreEvent, systemInfo] = await Promise.all([
        this.deps.sidecarConnection.listModelCatalog(),
        this.deps.sidecarConnection.listInstalledModels(overridePayload.modelStorePathOverride),
        this.deps.sidecarConnection.getModelStore(overridePayload.modelStorePathOverride),
        this.fetchSystemInfo(),
      ]);

      this.catalog = catalogEvent;
      this.installedModels = installedEvent.models;
      this.modelStore = modelStoreEvent;
      this.compiledRuntimes = systemInfo?.compiledRuntimes ?? [];
      this.compiledAdapters = systemInfo?.compiledAdapters ?? [];
      this.loadStatus = 'ready';
      this.loadError = null;
    } catch (error) {
      this.loadStatus = 'error';
      this.loadError = error instanceof Error ? error.message : String(error);
    }

    const persistedSelection = this.deps.getSettings().selectedModel;
    if (persistedSelection !== null) {
      this.selectedModelCapabilities = { selection: persistedSelection, status: 'pending' };
      void this.refreshSelectedCapabilities(persistedSelection);
    }

    this.notify();
  }

  dispose(): void {
    if (this.cancelStuckTimer !== null) {
      globalThis.clearTimeout(this.cancelStuckTimer);
      this.cancelStuckTimer = null;
    }

    if (this.releaseSidecarSubscription !== null) {
      this.releaseSidecarSubscription();
      this.releaseSidecarSubscription = null;
    }

    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -----------------------------------------------------------------------
  // State snapshot
  // -----------------------------------------------------------------------

  getState(): Readonly<ModelManagerState> {
    return {
      activeInstall: this.activeInstall,
      catalog: this.catalog,
      compiledAdapters: this.compiledAdapters,
      compiledRuntimes: this.compiledRuntimes,
      installedModels: this.installedModels,
      loadError: this.loadError,
      loadStatus: this.loadStatus,
      modelStore: this.modelStore,
      selectedModel: this.deps.getSettings().selectedModel,
      selectedModelCapabilities: this.selectedModelCapabilities,
    };
  }

  // -----------------------------------------------------------------------
  // Install operations
  // -----------------------------------------------------------------------

  async install(selection: CatalogModelSelection): Promise<ModelInstallUpdateEvent> {
    if (this.activeInstall !== null) {
      throw new Error('Another model is already being installed.');
    }

    this.deps.logger?.debug(
      'model',
      `initiating install for ${selection.runtimeId}:${selection.familyId}:${selection.modelId}`,
    );
    return this.deps.sidecarConnection.installModel({
      familyId: selection.familyId,
      installId: createInstallId(),
      modelId: selection.modelId,
      runtimeId: selection.runtimeId,
      ...createModelStoreOverridePayload(this.deps.getSettings().modelStorePathOverride),
    });
  }

  async cancel(): Promise<void> {
    const current = this.activeInstall;

    if (current === null || current.phase !== 'installing') {
      return;
    }

    // Clear any lingering timer from a prior cancel attempt.
    if (this.cancelStuckTimer !== null) {
      globalThis.clearTimeout(this.cancelStuckTimer);
      this.cancelStuckTimer = null;
    }

    this.activeInstall = { ...current, phase: 'canceling' };
    this.notify();

    try {
      await this.deps.sidecarConnection.cancelModelInstall(current.installUpdate.installId);
    } catch (error) {
      // If the cancel command itself failed and we are still tracking the same
      // install, revert to 'installing' so the user can retry.
      if (
        this.activeInstall !== null &&
        this.activeInstall.installUpdate.installId === current.installUpdate.installId
      ) {
        this.activeInstall = {
          ...this.activeInstall,
          lastError: error instanceof Error ? error.message : String(error),
          phase: 'installing',
        };
        this.notify();
      }

      throw error;
    }

    // Start the cancel-stuck timeout.
    const cancelledInstallId = current.installUpdate.installId;
    this.cancelStuckTimer = globalThis.setTimeout(() => {
      if (
        this.activeInstall !== null &&
        this.activeInstall.installUpdate.installId === cancelledInstallId &&
        this.activeInstall.phase === 'canceling'
      ) {
        this.deps.logger?.warn(
          'model',
          `cancel appears stuck for ${cancelledInstallId}, transitioning to cancelStuck`,
        );
        this.activeInstall = { ...this.activeInstall, phase: 'cancelStuck' };
        this.notify();
      }
    }, CANCEL_STUCK_TIMEOUT_MS);
  }

  async dismissCancelStuck(): Promise<void> {
    if (this.activeInstall === null || this.activeInstall.phase !== 'cancelStuck') {
      return;
    }

    // Refresh installed models from sidecar to check if the model actually
    // completed while we were stuck.
    const overridePayload = createModelStoreOverridePayload(
      this.deps.getSettings().modelStorePathOverride,
    );
    const installedEvent = await this.deps.sidecarConnection.listInstalledModels(
      overridePayload.modelStorePathOverride,
    );
    this.installedModels = installedEvent.models;

    // Clear the stuck timer if it is somehow still pending.
    if (this.cancelStuckTimer !== null) {
      globalThis.clearTimeout(this.cancelStuckTimer);
      this.cancelStuckTimer = null;
    }

    this.activeInstall = null;
    this.notify();
  }

  // -----------------------------------------------------------------------
  // Selection operations (independent of install state)
  // -----------------------------------------------------------------------

  async select(selection: SelectedModel): Promise<ModelProbeResultEvent> {
    const probeResult = await this.deps.sidecarConnection.probeModelSelection({
      modelSelection: selection,
      ...createModelStoreOverridePayload(this.deps.getSettings().modelStorePathOverride),
    });

    if (!probeResult.available) {
      throw new Error(createProbeFailureMessage(probeResult));
    }

    this.deps.logger?.debug(
      'model',
      `selected ${
        selection.kind === 'catalog_model'
          ? `${selection.runtimeId}:${selection.familyId}:${selection.modelId}`
          : selection.filePath
      }`,
    );
    await this.updateSettings({ selectedModel: selection });
    this.applyProbeResultToCapabilities(selection, probeResult);
    return probeResult;
  }

  async remove(selection: CatalogModelSelection): Promise<void> {
    const currentSelection = this.deps.getSettings().selectedModel;

    if (
      currentSelection !== null &&
      currentSelection.kind === 'catalog_model' &&
      matchesModelTriple(
        currentSelection,
        selection.runtimeId,
        selection.familyId,
        selection.modelId,
      )
    ) {
      throw new Error('Cannot remove the currently selected model. Clear the selection first.');
    }

    if (
      this.activeInstall !== null &&
      matchesModelTriple(
        this.activeInstall.installUpdate,
        selection.runtimeId,
        selection.familyId,
        selection.modelId,
      )
    ) {
      throw new Error('This model is currently being installed and cannot be removed.');
    }

    this.deps.logger?.debug(
      'model',
      `removing ${selection.runtimeId}:${selection.familyId}:${selection.modelId}`,
    );
    const event = await this.deps.sidecarConnection.removeModel({
      familyId: selection.familyId,
      modelId: selection.modelId,
      runtimeId: selection.runtimeId,
      ...createModelStoreOverridePayload(this.deps.getSettings().modelStorePathOverride),
    });

    if (event.removed) {
      this.installedModels = this.installedModels.filter(
        (m) => !matchesModelTriple(m, selection.runtimeId, selection.familyId, selection.modelId),
      );
      this.notify();
    }
  }

  async clearSelection(): Promise<void> {
    this.deps.logger?.debug('model', 'cleared selected model');
    await this.updateSettings({ selectedModel: null });
    this.selectedModelCapabilities = { status: 'none' };
    this.notify();
  }

  async validateAndSelectExternalFile(filePath: string): Promise<ModelProbeResultEvent> {
    const selection: SelectedModel = {
      familyId: 'whisper',
      filePath: filePath.trim(),
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    };
    return this.select(selection);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async refreshSelectedCapabilities(selection: SelectedModel): Promise<void> {
    try {
      const probeResult = await this.deps.sidecarConnection.probeModelSelection({
        modelSelection: selection,
        ...createModelStoreOverridePayload(this.deps.getSettings().modelStorePathOverride),
      });
      this.applyProbeResultToCapabilities(selection, probeResult);
    } catch (error) {
      this.deps.logger?.warn(
        'model',
        `failed to probe selected model capabilities: ${error instanceof Error ? error.message : String(error)}`,
      );
      const current = this.deps.getSettings().selectedModel;
      if (current !== null && selectedModelEquals(current, selection)) {
        this.selectedModelCapabilities = {
          reason: 'probe_failed',
          selection,
          status: 'unavailable',
        };
        this.notify();
      }
    }
  }

  private applyProbeResultToCapabilities(
    selection: SelectedModel,
    probeResult: ModelProbeResultEvent,
  ): void {
    const current = this.deps.getSettings().selectedModel;
    if (current === null || !selectedModelEquals(current, selection)) {
      return;
    }

    if (probeResult.status === 'ready' && probeResult.mergedCapabilities !== null) {
      this.selectedModelCapabilities = {
        capabilities: probeResult.mergedCapabilities,
        selection,
        status: 'ready',
      };
    } else if (probeResult.status === 'missing' || probeResult.status === 'invalid') {
      this.selectedModelCapabilities = {
        details: createProbeFailureMessage(probeResult),
        reason: probeResult.status,
        selection,
        status: 'unavailable',
      };
    } else {
      this.selectedModelCapabilities = {
        reason: 'probe_failed',
        selection,
        status: 'unavailable',
      };
    }

    this.notify();
  }

  private handleSidecarEvent(event: SidecarEvent): void {
    if (event.type !== 'model_install_update') {
      return;
    }

    this.activeInstall = this.resolveNextInstallState(this.activeInstall, event);
    const installStateKey = `${event.installId}:${event.state}`;

    if (installStateKey !== this.lastLoggedInstallStateKey) {
      const logMessage = createInstallLifecycleLogMessage(event);

      if (logMessage !== null) {
        this.deps.logger?.debug('model', logMessage);
      }
    }

    this.lastLoggedInstallStateKey = isTerminalInstallState(event.state) ? null : installStateKey;

    // Clear cancel-stuck timer on any terminal event.
    if (isTerminalInstallState(event.state) && this.cancelStuckTimer !== null) {
      globalThis.clearTimeout(this.cancelStuckTimer);
      this.cancelStuckTimer = null;
    }

    // On completed installs, refresh the installed models list so the UI
    // reflects the new model without requiring a restart.
    if (event.state === 'completed') {
      void this.refreshAfterInstall();
      return;
    }

    this.notify();
  }

  private async refreshAfterInstall(): Promise<void> {
    try {
      const overridePayload = createModelStoreOverridePayload(
        this.deps.getSettings().modelStorePathOverride,
      );
      const installedEvent = await this.deps.sidecarConnection.listInstalledModels(
        overridePayload.modelStorePathOverride,
      );
      this.installedModels = installedEvent.models;
    } catch (error) {
      this.deps.logger?.warn(
        'model',
        `failed to refresh installed models after install: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.notify();
  }

  private resolveNextInstallState(
    current: ActiveInstallInfo | null,
    installUpdate: ModelInstallUpdateEvent,
  ): ActiveInstallInfo | null {
    if (isTerminalInstallState(installUpdate.state)) {
      return null;
    }

    // Preserve the current phase if the incoming event belongs to the same
    // install (keeps 'canceling' / 'cancelStuck' across progress ticks).
    const preservedPhase =
      current !== null && current.installUpdate.installId === installUpdate.installId
        ? current.phase
        : 'installing';

    return {
      installUpdate,
      lastError: null,
      phase: preservedPhase,
    };
  }

  private async fetchSystemInfo(): Promise<SystemInfoEvent | null> {
    try {
      return await this.deps.sidecarConnection.getSystemInfo();
    } catch {
      return null;
    }
  }

  private async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    await this.deps.saveSettings({
      ...this.deps.getSettings(),
      ...patch,
    });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
