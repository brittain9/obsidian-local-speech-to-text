import { describe, expect, it, vi } from 'vitest';
import {
  type ActiveInstallState,
  applyActiveInstallStateToSnapshot,
  buildCatalogExplorerRows,
  buildCurrentModelCardState,
  createInstallLifecycleLogMessage,
  ModelManagementService,
} from '../src/models/model-management-service';
import {
  type CatalogModelRecord,
  type EngineId,
  type InstalledModelRecord,
  type ModelCatalogRecord,
  type ModelInstallUpdateRecord,
  type ModelProbeResultRecord,
  type SelectedModel,
  selectedModelEquals,
} from '../src/models/model-management-types';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type { SidecarEvent } from '../src/sidecar/protocol';

describe('model management snapshot builders', () => {
  it('orders catalog rows from smallest to largest and annotates selected installed models', () => {
    const catalog = sampleCatalog();
    const installedModels: InstalledModelRecord[] = [
      {
        catalogVersion: 1,
        engineId: 'whisper_cpp',
        installPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0',
        installedAtUnixMs: 1_700_000_000_000,
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimePath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
        totalSizeBytes: 900,
      },
      {
        catalogVersion: 1,
        engineId: 'whisper_cpp',
        installPath: '/models/whisper_cpp/whisper_small_en_q5_1',
        installedAtUnixMs: 1_700_000_000_000,
        modelId: 'whisper_small_en_q5_1',
        runtimePath: '/models/whisper_cpp/whisper_small_en_q5_1/model.bin',
        totalSizeBytes: 100,
      },
    ];
    const currentSelection: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const activeInstall = sampleActiveInstallState();

    const rows = buildCatalogExplorerRows(
      catalog,
      installedModels,
      currentSelection,
      activeInstall,
    );
    const [firstRow, secondRow] = rows;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.model.modelId)).toEqual([
      'whisper_small_en_q5_1',
      'whisper_large_v3_turbo_q8_0',
    ]);
    expect(firstRow?.isSelected).toBe(true);
    expect(firstRow?.installedModel?.modelId).toBe('whisper_small_en_q5_1');
    expect(firstRow?.installState).toBeNull();
    expect(secondRow?.installState?.installUpdate.installId).toBe('install-1');
    expect(secondRow?.installState?.isCancelling).toBe(false);
  });

  it('builds a managed-model card from catalog metadata when the install is missing', () => {
    const currentSelection: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const probeResult: ModelProbeResultRecord = {
      available: false,
      details: 'missing install metadata',
      displayName: 'Whisper Small English Q5_1',
      engineId: 'whisper_cpp',
      installed: false,
      message: 'The selected managed model is not installed or is incomplete.',
      modelId: 'whisper_small_en_q5_1',
      resolvedPath: null,
      selection: currentSelection,
      sizeBytes: null,
      status: 'missing',
    };

    const card = buildCurrentModelCardState(currentSelection, sampleCatalog(), [], probeResult);

    expect(card.displayName).toBe('Whisper Small English Q5_1');
    expect(card.engineLabel).toBe('Whisper');
    expect(card.installedLabel).toBe('Not installed');
    expect(card.sizeBytes).toBe(100);
    expect(card.sourceLabel).toBe('Managed download');
    expect(card.detail).toBe('The selected managed model is not installed or is incomplete.');
  });

  it('builds an external-file card from a successful probe result', () => {
    const currentSelection: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/models/custom-model.bin',
      kind: 'external_file',
    };
    const probeResult: ModelProbeResultRecord = {
      available: true,
      details: null,
      displayName: 'custom-model.bin',
      engineId: 'whisper_cpp',
      installed: false,
      message: 'Model selection is ready.',
      modelId: null,
      resolvedPath: '/tmp/models/custom-model.bin',
      selection: currentSelection,
      sizeBytes: 321,
      status: 'ready',
    };

    const card = buildCurrentModelCardState(currentSelection, sampleCatalog(), [], probeResult);

    expect(card.displayName).toBe('custom-model.bin');
    expect(card.installedLabel).toBe('Validated external file');
    expect(card.resolvedPath).toBe('/tmp/models/custom-model.bin');
    expect(card.sizeBytes).toBe(321);
    expect(card.sourceLabel).toBe('External file');
  });

  it('applies non-terminal install state updates without rebuilding the full snapshot', () => {
    const currentSelection: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const catalog = sampleCatalog();
    const activeInstall = sampleActiveInstallState();
    const snapshot = {
      activeInstall,
      catalog,
      currentModel: buildCurrentModelCardState(currentSelection, catalog, [], null),
      currentSelection,
      installedModels: [] as InstalledModelRecord[],
      modelStore: {
        overridePath: null,
        path: '/models',
        usingDefaultPath: true,
      },
      rows: buildCatalogExplorerRows(catalog, [], currentSelection, activeInstall),
      supportedEngineIds: ['whisper_cpp'] as EngineId[],
    };

    const nextSnapshot = applyActiveInstallStateToSnapshot(snapshot, {
      installUpdate: {
        ...activeInstall.installUpdate,
        downloadedBytes: 400,
      },
      isCancelling: true,
    });

    expect(nextSnapshot.activeInstall?.installUpdate.downloadedBytes).toBe(400);
    expect(nextSnapshot.activeInstall?.isCancelling).toBe(true);
    expect(
      nextSnapshot.rows.find((row) => row.model.modelId === 'whisper_large_v3_turbo_q8_0'),
    ).toMatchObject({
      installState: {
        installUpdate: expect.objectContaining({ downloadedBytes: 400 }),
        isCancelling: true,
      },
    });
    expect(
      nextSnapshot.rows.find((row) => row.model.modelId === 'whisper_small_en_q5_1'),
    ).toMatchObject({
      installState: null,
    });
  });

  it('logs only install lifecycle boundaries instead of download percentages', () => {
    const baseUpdate = sampleInstallUpdate();

    expect(createInstallLifecycleLogMessage(baseUpdate)).toBe(
      'install whisper_large_v3_turbo_q8_0 (install-1): download started',
    );
    expect(
      createInstallLifecycleLogMessage({
        ...baseUpdate,
        state: 'completed',
      }),
    ).toBe('install whisper_large_v3_turbo_q8_0 (install-1): completed');
    expect(
      createInstallLifecycleLogMessage({
        ...baseUpdate,
        state: 'failed',
      }),
    ).toBeNull();
    expect(
      createInstallLifecycleLogMessage({
        ...baseUpdate,
        state: 'verifying',
      }),
    ).toBeNull();
  });

  it('discards a stale probe result whose selection does not match the current selection', () => {
    const currentSelection: SelectedModel = {
      engineId: 'cohere_onnx',
      kind: 'catalog_model',
      modelId: 'cohere_fp16',
    };
    const staleProbe: ModelProbeResultRecord = {
      available: true,
      details: null,
      displayName: 'Whisper Small English Q5_1',
      engineId: 'whisper_cpp',
      installed: true,
      message: 'Model selection is ready.',
      modelId: 'whisper_small_en_q5_1',
      resolvedPath: '/models/whisper_cpp/whisper_small_en_q5_1/model.bin',
      selection: {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_small_en_q5_1',
      },
      sizeBytes: 100,
      status: 'ready',
    };

    const card = buildCurrentModelCardState(currentSelection, sampleCatalog(), [], staleProbe);

    expect(card.displayName).not.toBe('Whisper Small English Q5_1');
    expect(card.resolvedPath).toBeNull();
    expect(card.sizeBytes).toBeNull();
  });
});

describe('selectedModelEquals', () => {
  it('matches identical catalog model selections', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects catalog selections with different model IDs', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const right: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });

  it('rejects selections with different kinds', () => {
    const catalog: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const external: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };

    expect(selectedModelEquals(catalog, external)).toBe(false);
  });

  it('matches identical external file selections', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects external file selections with different engine IDs', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };
    const right: SelectedModel = {
      engineId: 'cohere_onnx',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });
});

describe('ModelManagementService', () => {
  it('keeps cancel-pending state until a terminal install update arrives', async () => {
    const harness = createServiceHarness();
    const installUpdate = sampleInstallUpdate();
    const notifications = vi.fn();
    const service = harness.service;
    const release = service.subscribeToInstallUpdates(notifications);

    harness.emit({
      ...installUpdate,
      protocolVersion: 'v3',
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()).toMatchObject({
      installUpdate,
      isCancelling: false,
    });

    await service.cancelActiveInstall();
    expect(harness.sidecarConnection.cancelModelInstall).toHaveBeenCalledWith('install-1');
    expect(service.getActiveInstallState()).toMatchObject({
      installUpdate,
      isCancelling: true,
    });

    harness.emit({
      ...installUpdate,
      downloadedBytes: 400,
      protocolVersion: 'v3',
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()).toMatchObject({
      installUpdate: expect.objectContaining({ downloadedBytes: 400 }),
      isCancelling: true,
    });

    harness.emit({
      ...installUpdate,
      message: 'Model install cancelled.',
      protocolVersion: 'v3',
      state: 'cancelled',
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()).toBeNull();
    expect(notifications).toHaveBeenCalledTimes(4);

    release();
    service.dispose();
  });

  it('reverts local cancel-pending state when the cancel command fails', async () => {
    const harness = createServiceHarness();
    const installUpdate = sampleInstallUpdate();

    harness.emit({
      ...installUpdate,
      protocolVersion: 'v3',
      type: 'model_install_update',
    });
    harness.sidecarConnection.cancelModelInstall.mockRejectedValueOnce(new Error('write failed'));

    await expect(harness.service.cancelActiveInstall()).rejects.toThrow('write failed');
    expect(harness.service.getActiveInstallState()).toMatchObject({
      installUpdate,
      isCancelling: false,
    });

    harness.service.dispose();
  });

  it('model selection is independent of active install', async () => {
    const harness = createServiceHarness();
    const service = harness.service;

    harness.emit({
      details: null,
      downloadedBytes: 20,
      engineId: 'whisper_cpp',
      installId: 'install-sel-1',
      message: 'Downloading',
      modelId: 'whisper_small_en_q5_1',
      protocolVersion: 'v3',
      state: 'downloading',
      totalBytes: 100,
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()?.installUpdate.modelId).toBe('whisper_small_en_q5_1');

    harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce({
      available: true,
      details: null,
      displayName: 'Whisper Small English Q5_1',
      engineId: 'whisper_cpp',
      installed: true,
      message: 'Model selection is ready.',
      modelId: 'whisper_small_en_q5_1',
      resolvedPath: '/models/whisper_cpp/whisper_small_en_q5_1/model.bin',
      selection: {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_small_en_q5_1',
      },
      sizeBytes: 100,
      status: 'ready',
    });
    await service.selectCatalogModel({
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    });

    expect(service.getActiveInstallState()?.installUpdate.installId).toBe('install-sel-1');
    expect(harness.getSettings().selectedModel).toEqual({
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    });

    harness.emit({
      details: null,
      downloadedBytes: 100,
      engineId: 'whisper_cpp',
      installId: 'install-sel-1',
      message: 'Complete.',
      modelId: 'whisper_small_en_q5_1',
      protocolVersion: 'v3',
      state: 'completed',
      totalBytes: 100,
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()).toBeNull();
    expect(harness.getSettings().selectedModel).toEqual({
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    });

    service.dispose();
  });

  it('cancelling an install does not affect model selection', async () => {
    const harness = createServiceHarness();
    const service = harness.service;
    const originalSelection = harness.getSettings().selectedModel;

    harness.emit({
      details: null,
      downloadedBytes: 30,
      engineId: 'whisper_cpp',
      installId: 'install-cancel-sel',
      message: 'Downloading',
      modelId: 'whisper_small_en_q5_1',
      protocolVersion: 'v3',
      state: 'downloading',
      totalBytes: 100,
      type: 'model_install_update',
    });

    await service.cancelActiveInstall();
    expect(harness.getSettings().selectedModel).toEqual(originalSelection);

    harness.emit({
      details: null,
      downloadedBytes: 30,
      engineId: 'whisper_cpp',
      installId: 'install-cancel-sel',
      message: 'Cancelled.',
      modelId: 'whisper_small_en_q5_1',
      protocolVersion: 'v3',
      state: 'cancelled',
      totalBytes: 100,
      type: 'model_install_update',
    });
    expect(service.getActiveInstallState()).toBeNull();
    expect(harness.getSettings().selectedModel).toEqual(originalSelection);

    service.dispose();
  });

  it('getSnapshot caches the last result for getCachedSnapshot', async () => {
    const harness = createServiceHarness();
    configureSidecarForSnapshot(harness.sidecarConnection);

    expect(harness.service.getCachedSnapshot()).toBeNull();

    const snapshot = await harness.service.getSnapshot();
    const cached = harness.service.getCachedSnapshot();

    expect(cached).toBe(snapshot);

    harness.service.dispose();
  });

  it('rejects install when another model is already being installed', async () => {
    const harness = createServiceHarness();

    harness.emit({
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-guard-1',
      message: 'Downloading',
      modelId: 'whisper_large_v3_turbo_q8_0',
      protocolVersion: 'v3',
      state: 'downloading',
      totalBytes: 900,
      type: 'model_install_update',
    });
    expect(harness.service.getActiveInstallState()).not.toBeNull();

    await expect(
      harness.service.installCatalogModel({
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_small_en_q5_1',
      }),
    ).rejects.toThrow('Another model is already being installed.');
    expect(harness.sidecarConnection.installModel).not.toHaveBeenCalled();

    harness.service.dispose();
  });

  it('blocks removing the model that is actively being installed', async () => {
    const harness = createServiceHarness();

    harness.emit({
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-remove-guard',
      message: 'Downloading',
      modelId: 'whisper_large_v3_turbo_q8_0',
      protocolVersion: 'v3',
      state: 'downloading',
      totalBytes: 900,
      type: 'model_install_update',
    });

    await expect(
      harness.service.removeCatalogModel({
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
      }),
    ).rejects.toThrow('This model is currently being installed and cannot be removed.');
    expect(harness.sidecarConnection.removeModel).not.toHaveBeenCalled();

    harness.sidecarConnection.removeModel.mockResolvedValueOnce({ removed: true });
    await harness.service.removeCatalogModel({
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    });
    expect(harness.sidecarConnection.removeModel).toHaveBeenCalledOnce();

    harness.service.dispose();
  });

  it('force-clears stale cancel state after 30s timeout', async () => {
    vi.useFakeTimers();

    try {
      const harness = createServiceHarness();

      harness.emit({
        details: null,
        downloadedBytes: 50,
        engineId: 'whisper_cpp',
        installId: 'install-force-clear',
        message: 'Downloading',
        modelId: 'whisper_large_v3_turbo_q8_0',
        protocolVersion: 'v3',
        state: 'downloading',
        totalBytes: 900,
        type: 'model_install_update',
      });

      await harness.service.cancelActiveInstall();
      expect(harness.service.getActiveInstallState()?.isCancelling).toBe(true);

      vi.advanceTimersByTime(30_000);
      expect(harness.service.getActiveInstallState()).toBeNull();

      harness.service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel force-clear timer is harmless if terminal event arrives first', async () => {
    vi.useFakeTimers();

    try {
      const harness = createServiceHarness();

      harness.emit({
        details: null,
        downloadedBytes: 50,
        engineId: 'whisper_cpp',
        installId: 'install-force-noop',
        message: 'Downloading',
        modelId: 'whisper_large_v3_turbo_q8_0',
        protocolVersion: 'v3',
        state: 'downloading',
        totalBytes: 900,
        type: 'model_install_update',
      });

      await harness.service.cancelActiveInstall();
      expect(harness.service.getActiveInstallState()?.isCancelling).toBe(true);

      harness.emit({
        details: null,
        downloadedBytes: 50,
        engineId: 'whisper_cpp',
        installId: 'install-force-noop',
        message: 'Cancelled.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        protocolVersion: 'v3',
        state: 'cancelled',
        totalBytes: 900,
        type: 'model_install_update',
      });
      expect(harness.service.getActiveInstallState()).toBeNull();

      vi.advanceTimersByTime(30_000);
      expect(harness.service.getActiveInstallState()).toBeNull();

      harness.service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cached snapshot reflects point-in-time state, not live install state', async () => {
    const harness = createServiceHarness();
    configureSidecarForSnapshot(harness.sidecarConnection);

    const snapshot = await harness.service.getSnapshot();
    expect(snapshot.activeInstall).toBeNull();

    harness.emit({
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-cache-1',
      message: 'Downloading',
      modelId: 'whisper_small_en_q5_1',
      protocolVersion: 'v3',
      state: 'downloading',
      totalBytes: 100,
      type: 'model_install_update',
    });
    expect(harness.service.getActiveInstallState()).not.toBeNull();

    const cached = harness.service.getCachedSnapshot();
    expect(cached?.activeInstall).toBeNull();

    harness.service.dispose();
  });
});

function createServiceHarness(): {
  emit: (event: SidecarEvent) => void;
  getSettings: () => PluginSettings;
  service: ModelManagementService;
  sidecarConnection: ReturnType<typeof createSidecarConnectionStub>;
} {
  const listeners = new Set<(event: SidecarEvent) => void>();
  const sidecarConnection = createSidecarConnectionStub(listeners);
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    selectedModel: {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
    },
  };
  const service = new ModelManagementService({
    getSettings: () => settings,
    saveSettings: async (nextSettings) => {
      settings = nextSettings;
    },
    sidecarConnection,
  });

  return {
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    getSettings: () => settings,
    service,
    sidecarConnection,
  };
}

function createSidecarConnectionStub(listeners: Set<(event: SidecarEvent) => void>) {
  return {
    cancelModelInstall: vi.fn(async () => {}),
    getModelStore: vi.fn(),
    getSystemInfo: vi.fn(),
    installModel: vi.fn(),
    listInstalledModels: vi.fn(),
    listModelCatalog: vi.fn(),
    probeModelSelection: vi.fn(),
    removeModel: vi.fn(),
    subscribe: (listener: (event: SidecarEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function sampleCatalog(): ModelCatalogRecord {
  return {
    catalogVersion: 1,
    collections: [
      {
        collectionId: 'english_cpu_first',
        displayName: 'English CPU First',
        summary: 'summary',
      },
    ],
    engines: [
      {
        displayName: 'Whisper',
        engineId: 'whisper_cpp',
        summary: 'summary',
      },
    ],
    models: [
      sampleModel({
        displayName: 'Whisper Large V3 Turbo Q8_0',
        modelId: 'whisper_large_v3_turbo_q8_0',
        recommended: false,
        sizeBytes: 900,
        summary: 'Heavier CPU model.',
      }),
      sampleModel({
        displayName: 'Whisper Small English Q5_1',
        modelId: 'whisper_small_en_q5_1',
        recommended: true,
        sizeBytes: 100,
        summary: 'Recommended starter model.',
      }),
    ],
  };
}

function sampleInstallUpdate(): ModelInstallUpdateRecord {
  return {
    details: null,
    downloadedBytes: 50,
    engineId: 'whisper_cpp',
    installId: 'install-1',
    message: 'Downloading',
    modelId: 'whisper_large_v3_turbo_q8_0',
    state: 'downloading',
    totalBytes: 900,
  };
}

function sampleActiveInstallState(): ActiveInstallState {
  return {
    installUpdate: sampleInstallUpdate(),
    isCancelling: false,
  };
}

function sampleModel(input: {
  displayName: string;
  modelId: string;
  recommended: boolean;
  sizeBytes: number;
  summary: string;
}): CatalogModelRecord {
  return {
    artifacts: [
      {
        artifactId: 'transcription',
        downloadUrl: `https://example.com/${input.modelId}.bin`,
        filename: `${input.modelId}.bin`,
        required: true,
        role: 'transcription_model',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        sizeBytes: input.sizeBytes,
      },
    ],
    capabilityFlags: ['dictation'],
    collectionId: 'english_cpu_first',
    displayName: input.displayName,
    engineId: 'whisper_cpp',
    languageTags: ['en'],
    licenseLabel: 'MIT',
    licenseUrl: 'https://example.com/license',
    modelCardUrl: null,
    modelId: input.modelId,
    notes: [],
    recommended: input.recommended,
    sourceUrl: 'https://example.com/source',
    summary: input.summary,
    uxTags: [],
  };
}

function configureSidecarForSnapshot(
  sidecarConnection: ReturnType<typeof createSidecarConnectionStub>,
): void {
  sidecarConnection.listModelCatalog.mockResolvedValue(sampleCatalog());
  sidecarConnection.listInstalledModels.mockResolvedValue({
    models: [
      {
        catalogVersion: 1,
        engineId: 'whisper_cpp',
        installPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0',
        installedAtUnixMs: 1_700_000_000_000,
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimePath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
        totalSizeBytes: 900,
      },
    ],
  });
  sidecarConnection.getModelStore.mockResolvedValue({
    overridePath: null,
    path: '/models',
    usingDefaultPath: true,
  });
  sidecarConnection.probeModelSelection.mockResolvedValue({
    available: true,
    details: null,
    displayName: 'Whisper Large V3 Turbo Q8_0',
    engineId: 'whisper_cpp',
    installed: true,
    message: 'Model selection is ready.',
    modelId: 'whisper_large_v3_turbo_q8_0',
    resolvedPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
    selection: {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
    },
    sizeBytes: 900,
    status: 'ready',
  });
  sidecarConnection.getSystemInfo.mockResolvedValue({
    compiledEngines: ['whisper_cpp'],
  });
}
