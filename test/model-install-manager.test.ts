import { describe, expect, it, vi } from 'vitest';
import {
  createInstallId,
  createInstallLifecycleLogMessage,
  isTerminalInstallState,
  ModelInstallManager,
} from '../src/models/model-install-manager';
import type {
  CatalogModelRecord,
  CatalogModelSelection,
  InstalledModelRecord,
  ModelCatalogRecord,
  ModelInstallUpdateRecord,
  ModelStoreRecord,
} from '../src/models/model-management-types';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type { SidecarEvent } from '../src/sidecar/protocol';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function createManagerHarness(settingsOverride?: Partial<PluginSettings>) {
  const listeners = new Set<(event: SidecarEvent) => void>();
  const sidecarConnection = createSidecarConnectionStub(listeners);
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    ...settingsOverride,
  };

  const manager = new ModelInstallManager({
    getSettings: () => settings,
    saveSettings: async (nextSettings) => {
      settings = nextSettings;
    },
    sidecarConnection,
  });

  return {
    emit: (event: SidecarEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    getSettings: () => settings,
    manager,
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

function configureSidecarForInit(
  sidecarConnection: ReturnType<typeof createSidecarConnectionStub>,
) {
  sidecarConnection.listModelCatalog.mockResolvedValue(sampleCatalog());
  sidecarConnection.listInstalledModels.mockResolvedValue({
    models: [sampleInstalledModel()],
  });
  sidecarConnection.getModelStore.mockResolvedValue(sampleModelStore());
  sidecarConnection.getSystemInfo.mockResolvedValue({
    compiledEngines: ['whisper_cpp'],
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
      sampleCatalogModel({
        displayName: 'Whisper Large V3 Turbo Q8_0',
        modelId: 'whisper_large_v3_turbo_q8_0',
        sizeBytes: 900,
      }),
      sampleCatalogModel({
        displayName: 'Whisper Small English Q5_1',
        modelId: 'whisper_small_en_q5_1',
        sizeBytes: 100,
      }),
    ],
  };
}

function sampleCatalogModel(input: {
  displayName: string;
  modelId: string;
  sizeBytes: number;
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
    recommended: false,
    sourceUrl: 'https://example.com/source',
    summary: 'Test model',
    uxTags: [],
  };
}

function sampleInstalledModel(): InstalledModelRecord {
  return {
    catalogVersion: 1,
    engineId: 'whisper_cpp',
    installPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0',
    installedAtUnixMs: 1_700_000_000_000,
    modelId: 'whisper_large_v3_turbo_q8_0',
    runtimePath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
    totalSizeBytes: 900,
  };
}

function sampleModelStore(): ModelStoreRecord {
  return {
    overridePath: null,
    path: '/models',
    usingDefaultPath: true,
  };
}

function sampleInstallUpdate(
  overrides?: Partial<ModelInstallUpdateRecord>,
): ModelInstallUpdateRecord {
  return {
    details: null,
    downloadedBytes: 50,
    engineId: 'whisper_cpp',
    installId: 'install-1',
    message: 'Downloading',
    modelId: 'whisper_large_v3_turbo_q8_0',
    state: 'downloading',
    totalBytes: 900,
    ...overrides,
  };
}

function sampleSelection(modelId = 'whisper_large_v3_turbo_q8_0'): CatalogModelSelection {
  return {
    engineId: 'whisper_cpp',
    kind: 'catalog_model',
    modelId,
  };
}

function emitInstallUpdate(
  harness: ReturnType<typeof createManagerHarness>,
  overrides?: Partial<ModelInstallUpdateRecord>,
) {
  harness.emit({
    ...sampleInstallUpdate(overrides),
    protocolVersion: 'v3',
    type: 'model_install_update',
  });
}

// ---------------------------------------------------------------------------
// Shared helper tests
// ---------------------------------------------------------------------------

describe('isTerminalInstallState', () => {
  it('identifies terminal states', () => {
    expect(isTerminalInstallState('completed')).toBe(true);
    expect(isTerminalInstallState('cancelled')).toBe(true);
    expect(isTerminalInstallState('failed')).toBe(true);
  });

  it('rejects non-terminal states', () => {
    expect(isTerminalInstallState('downloading')).toBe(false);
    expect(isTerminalInstallState('queued')).toBe(false);
    expect(isTerminalInstallState('verifying')).toBe(false);
    expect(isTerminalInstallState('probing')).toBe(false);
  });
});

describe('createInstallLifecycleLogMessage', () => {
  it('returns messages for lifecycle boundaries', () => {
    const base = sampleInstallUpdate();

    expect(createInstallLifecycleLogMessage(base)).toBe(
      'install whisper_large_v3_turbo_q8_0 (install-1): download started',
    );
    expect(createInstallLifecycleLogMessage({ ...base, state: 'completed' })).toBe(
      'install whisper_large_v3_turbo_q8_0 (install-1): completed',
    );
    expect(createInstallLifecycleLogMessage({ ...base, state: 'cancelled' })).toBe(
      'install whisper_large_v3_turbo_q8_0 (install-1): cancelled',
    );
  });

  it('returns null for non-boundary states', () => {
    const base = sampleInstallUpdate();

    expect(createInstallLifecycleLogMessage({ ...base, state: 'failed' })).toBeNull();
    expect(createInstallLifecycleLogMessage({ ...base, state: 'verifying' })).toBeNull();
    expect(createInstallLifecycleLogMessage({ ...base, state: 'probing' })).toBeNull();
    expect(createInstallLifecycleLogMessage({ ...base, state: 'queued' })).toBeNull();
  });
});

describe('createInstallId', () => {
  it('produces unique IDs', () => {
    const a = createInstallId();
    const b = createInstallId();

    expect(a).toMatch(/^install-\d+-\d+$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// ModelInstallManager
// ---------------------------------------------------------------------------

describe('ModelInstallManager', () => {
  // -- init ---------------------------------------------------------------

  describe('init()', () => {
    it('loads state from sidecar and sets loadStatus to ready', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);

      const stateBefore = harness.manager.getState();
      expect(stateBefore.loadStatus).toBe('loading');

      await harness.manager.init();

      const state = harness.manager.getState();
      expect(state.loadStatus).toBe('ready');
      expect(state.loadError).toBeNull();
      expect(state.catalog.models).toHaveLength(2);
      expect(state.installedModels).toHaveLength(1);
      expect(state.modelStore.path).toBe('/models');
      expect(state.supportedEngineIds).toEqual(['whisper_cpp']);

      harness.manager.dispose();
    });

    it('sets loadStatus to error on failure', async () => {
      const harness = createManagerHarness();
      harness.sidecarConnection.listModelCatalog.mockRejectedValue(new Error('connection lost'));
      harness.sidecarConnection.listInstalledModels.mockRejectedValue(new Error('connection lost'));
      harness.sidecarConnection.getModelStore.mockRejectedValue(new Error('connection lost'));
      harness.sidecarConnection.getSystemInfo.mockRejectedValue(new Error('connection lost'));

      await harness.manager.init();

      const state = harness.manager.getState();
      expect(state.loadStatus).toBe('error');
      expect(state.loadError).toBe('connection lost');

      harness.manager.dispose();
    });

    it('notifies subscribers after init completes', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      const listener = vi.fn();
      harness.manager.subscribe(listener);

      await harness.manager.init();

      expect(listener).toHaveBeenCalledOnce();

      harness.manager.dispose();
    });
  });

  // -- install ------------------------------------------------------------

  describe('install()', () => {
    it('transitions from idle to installing on sidecar progress event', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      expect(harness.manager.getState().activeInstall).toBeNull();

      emitInstallUpdate(harness);

      const state = harness.manager.getState();
      expect(state.activeInstall).not.toBeNull();
      expect(state.activeInstall?.phase).toBe('installing');
      expect(state.activeInstall?.installUpdate.modelId).toBe('whisper_large_v3_turbo_q8_0');

      harness.manager.dispose();
    });

    it('rejects when another install is active', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);

      await expect(
        harness.manager.install(sampleSelection('whisper_small_en_q5_1')),
      ).rejects.toThrow('Another model is already being installed.');
      expect(harness.sidecarConnection.installModel).not.toHaveBeenCalled();

      harness.manager.dispose();
    });

    it('sends install command to sidecar when idle', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.installModel.mockResolvedValueOnce(
        sampleInstallUpdate({ state: 'queued' }),
      );
      await harness.manager.install(sampleSelection());

      expect(harness.sidecarConnection.installModel).toHaveBeenCalledOnce();
      expect(harness.sidecarConnection.installModel).toHaveBeenCalledWith(
        expect.objectContaining({
          engineId: 'whisper_cpp',
          modelId: 'whisper_large_v3_turbo_q8_0',
        }),
      );

      harness.manager.dispose();
    });
  });

  // -- sidecar progress events --------------------------------------------

  describe('sidecar progress events', () => {
    it('updates activeInstall during installing phase', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness, { downloadedBytes: 100 });

      expect(harness.manager.getState().activeInstall?.installUpdate.downloadedBytes).toBe(100);

      emitInstallUpdate(harness, { downloadedBytes: 400 });

      expect(harness.manager.getState().activeInstall?.installUpdate.downloadedBytes).toBe(400);
      expect(harness.manager.getState().activeInstall?.phase).toBe('installing');

      harness.manager.dispose();
    });

    it('transitions back to idle on terminal sidecar event', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      expect(harness.manager.getState().activeInstall).not.toBeNull();

      emitInstallUpdate(harness, { state: 'completed' });
      expect(harness.manager.getState().activeInstall).toBeNull();

      harness.manager.dispose();
    });

    it('transitions to idle on failed terminal event', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      emitInstallUpdate(harness, { state: 'failed' });

      expect(harness.manager.getState().activeInstall).toBeNull();

      harness.manager.dispose();
    });

    it('notifies subscribers on each progress update', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      const listener = vi.fn();
      harness.manager.subscribe(listener);

      emitInstallUpdate(harness, { downloadedBytes: 100 });
      emitInstallUpdate(harness, { downloadedBytes: 400 });
      emitInstallUpdate(harness, { state: 'completed' });

      expect(listener).toHaveBeenCalledTimes(3);

      harness.manager.dispose();
    });
  });

  // -- cancel -------------------------------------------------------------

  describe('cancel()', () => {
    it('transitions from installing to canceling', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      expect(harness.manager.getState().activeInstall?.phase).toBe('installing');

      await harness.manager.cancel();

      expect(harness.sidecarConnection.cancelModelInstall).toHaveBeenCalledWith('install-1');
      expect(harness.manager.getState().activeInstall?.phase).toBe('canceling');

      harness.manager.dispose();
    });

    it('reverts to installing when cancel command fails', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      harness.sidecarConnection.cancelModelInstall.mockRejectedValueOnce(new Error('write failed'));

      await expect(harness.manager.cancel()).rejects.toThrow('write failed');
      expect(harness.manager.getState().activeInstall?.phase).toBe('installing');

      harness.manager.dispose();
    });

    it('preserves canceling phase on progress events', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      await harness.manager.cancel();
      expect(harness.manager.getState().activeInstall?.phase).toBe('canceling');

      emitInstallUpdate(harness, { downloadedBytes: 400 });
      expect(harness.manager.getState().activeInstall?.phase).toBe('canceling');
      expect(harness.manager.getState().activeInstall?.installUpdate.downloadedBytes).toBe(400);

      harness.manager.dispose();
    });

    it('transitions to idle on terminal event during canceling', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      await harness.manager.cancel();

      emitInstallUpdate(harness, { state: 'cancelled' });
      expect(harness.manager.getState().activeInstall).toBeNull();

      harness.manager.dispose();
    });

    it('is a no-op when no install is active', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      await harness.manager.cancel();
      expect(harness.sidecarConnection.cancelModelInstall).not.toHaveBeenCalled();

      harness.manager.dispose();
    });
  });

  // -- cancelStuck timeout ------------------------------------------------

  describe('cancelStuck timeout', () => {
    it('transitions from canceling to cancelStuck after 30s', async () => {
      vi.useFakeTimers();

      try {
        const harness = createManagerHarness();
        configureSidecarForInit(harness.sidecarConnection);
        await harness.manager.init();

        emitInstallUpdate(harness);
        await harness.manager.cancel();
        expect(harness.manager.getState().activeInstall?.phase).toBe('canceling');

        vi.advanceTimersByTime(30_000);
        expect(harness.manager.getState().activeInstall?.phase).toBe('cancelStuck');

        harness.manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire if terminal event arrives before timeout', async () => {
      vi.useFakeTimers();

      try {
        const harness = createManagerHarness();
        configureSidecarForInit(harness.sidecarConnection);
        await harness.manager.init();

        emitInstallUpdate(harness);
        await harness.manager.cancel();

        emitInstallUpdate(harness, { state: 'cancelled' });
        expect(harness.manager.getState().activeInstall).toBeNull();

        vi.advanceTimersByTime(30_000);
        expect(harness.manager.getState().activeInstall).toBeNull();

        harness.manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('late terminal event during cancelStuck transitions to idle', async () => {
      vi.useFakeTimers();

      try {
        const harness = createManagerHarness();
        configureSidecarForInit(harness.sidecarConnection);
        await harness.manager.init();

        emitInstallUpdate(harness);
        await harness.manager.cancel();
        vi.advanceTimersByTime(30_000);
        expect(harness.manager.getState().activeInstall?.phase).toBe('cancelStuck');

        emitInstallUpdate(harness, { state: 'cancelled' });
        expect(harness.manager.getState().activeInstall).toBeNull();

        harness.manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -- dismissCancelStuck -------------------------------------------------

  describe('dismissCancelStuck()', () => {
    it('transitions to idle and refreshes installed models', async () => {
      vi.useFakeTimers();

      try {
        const harness = createManagerHarness();
        configureSidecarForInit(harness.sidecarConnection);
        await harness.manager.init();

        emitInstallUpdate(harness);
        await harness.manager.cancel();
        vi.advanceTimersByTime(30_000);
        expect(harness.manager.getState().activeInstall?.phase).toBe('cancelStuck');

        // Model actually completed during stuck state.
        harness.sidecarConnection.listInstalledModels.mockResolvedValueOnce({
          models: [
            sampleInstalledModel(),
            {
              ...sampleInstalledModel(),
              modelId: 'whisper_small_en_q5_1',
              installPath: '/models/whisper_cpp/whisper_small_en_q5_1',
              totalSizeBytes: 100,
            },
          ],
        });

        await harness.manager.dismissCancelStuck();

        const state = harness.manager.getState();
        expect(state.activeInstall).toBeNull();
        expect(state.installedModels).toHaveLength(2);

        harness.manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a no-op when phase is not cancelStuck', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);
      // Phase is 'installing', not 'cancelStuck'.
      await harness.manager.dismissCancelStuck();

      expect(harness.manager.getState().activeInstall).not.toBeNull();
      // listInstalledModels should only have been called during init().
      expect(harness.sidecarConnection.listInstalledModels).toHaveBeenCalledOnce();

      harness.manager.dispose();
    });
  });

  // -- remove -------------------------------------------------------------

  describe('remove()', () => {
    it('rejects if model is the selected model', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection(),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      await expect(harness.manager.remove(sampleSelection())).rejects.toThrow(
        'Cannot remove the currently selected model.',
      );
      expect(harness.sidecarConnection.removeModel).not.toHaveBeenCalled();

      harness.manager.dispose();
    });

    it('rejects if model is actively installing', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness);

      await expect(harness.manager.remove(sampleSelection())).rejects.toThrow(
        'This model is currently being installed and cannot be removed.',
      );
      expect(harness.sidecarConnection.removeModel).not.toHaveBeenCalled();

      harness.manager.dispose();
    });

    it('succeeds for a non-selected, non-installing model', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection('whisper_small_en_q5_1'),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.removeModel.mockResolvedValueOnce({ removed: true });
      await harness.manager.remove(sampleSelection());

      expect(harness.sidecarConnection.removeModel).toHaveBeenCalledOnce();
      // Installed models list should be updated locally.
      expect(
        harness.manager
          .getState()
          .installedModels.find((m) => m.modelId === 'whisper_large_v3_turbo_q8_0'),
      ).toBeUndefined();

      harness.manager.dispose();
    });

    it('does not remove from local list if sidecar reports removed: false', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.removeModel.mockResolvedValueOnce({ removed: false });
      await harness.manager.remove(sampleSelection());

      expect(
        harness.manager
          .getState()
          .installedModels.find((m) => m.modelId === 'whisper_large_v3_turbo_q8_0'),
      ).toBeDefined();

      harness.manager.dispose();
    });
  });

  // -- select -------------------------------------------------------------

  describe('select()', () => {
    it('validates via probe before accepting', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce({
        available: true,
        details: null,
        displayName: 'Whisper Large V3 Turbo Q8_0',
        engineId: 'whisper_cpp',
        installed: true,
        message: 'Model selection is ready.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        resolvedPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
        selection: sampleSelection(),
        sizeBytes: 900,
        status: 'ready',
      });

      await harness.manager.select(sampleSelection());

      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());

      harness.manager.dispose();
    });

    it('rejects when probe reports model unavailable', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce({
        available: false,
        details: 'missing install metadata',
        displayName: 'Whisper Large V3 Turbo Q8_0',
        engineId: 'whisper_cpp',
        installed: false,
        message: 'Model is not installed.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        resolvedPath: null,
        selection: sampleSelection(),
        sizeBytes: null,
        status: 'missing',
      });

      await expect(harness.manager.select(sampleSelection())).rejects.toThrow(
        'Model is not installed. (missing install metadata)',
      );
      expect(harness.getSettings().selectedModel).toBeNull();

      harness.manager.dispose();
    });
  });

  // -- clearSelection -----------------------------------------------------

  describe('clearSelection()', () => {
    it('sets selectedModel to null', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection(),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      await harness.manager.clearSelection();

      expect(harness.getSettings().selectedModel).toBeNull();

      harness.manager.dispose();
    });
  });

  // -- selection independence from install state --------------------------

  describe('selection / install independence', () => {
    it('selection is independent of install state', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      // Start an install.
      emitInstallUpdate(harness, { modelId: 'whisper_small_en_q5_1', installId: 'install-sel' });
      expect(harness.manager.getState().activeInstall).not.toBeNull();

      // Select a different model.
      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce({
        available: true,
        details: null,
        displayName: 'Whisper Large V3 Turbo Q8_0',
        engineId: 'whisper_cpp',
        installed: true,
        message: 'Model selection is ready.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        resolvedPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
        selection: sampleSelection(),
        sizeBytes: 900,
        status: 'ready',
      });
      await harness.manager.select(sampleSelection());

      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());
      expect(harness.manager.getState().activeInstall?.installUpdate.installId).toBe('install-sel');

      harness.manager.dispose();
    });

    it('install completion never mutates selection', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection(),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness, { modelId: 'whisper_small_en_q5_1', installId: 'install-comp' });
      emitInstallUpdate(harness, {
        modelId: 'whisper_small_en_q5_1',
        installId: 'install-comp',
        state: 'completed',
      });

      expect(harness.manager.getState().activeInstall).toBeNull();
      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());

      harness.manager.dispose();
    });

    it('cancel does not affect selection', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection(),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      emitInstallUpdate(harness, { modelId: 'whisper_small_en_q5_1', installId: 'install-cancel' });
      await harness.manager.cancel();

      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());

      emitInstallUpdate(harness, {
        modelId: 'whisper_small_en_q5_1',
        installId: 'install-cancel',
        state: 'cancelled',
      });
      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());

      harness.manager.dispose();
    });
  });

  // -- getState consistency -----------------------------------------------

  describe('getState()', () => {
    it('returns consistent snapshot', async () => {
      const harness = createManagerHarness({
        selectedModel: sampleSelection(),
      });
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      const state = harness.manager.getState();

      expect(state.loadStatus).toBe('ready');
      expect(state.loadError).toBeNull();
      expect(state.selectedModel).toEqual(sampleSelection());
      expect(state.installedModels).toHaveLength(1);
      expect(state.catalog.models).toHaveLength(2);
      expect(state.modelStore.path).toBe('/models');
      expect(state.supportedEngineIds).toEqual(['whisper_cpp']);
      expect(state.activeInstall).toBeNull();
    });

    it('is synchronous and always returns current state', async () => {
      const harness = createManagerHarness();

      // Before init.
      const preInitState = harness.manager.getState();
      expect(preInitState.loadStatus).toBe('loading');
      expect(preInitState.catalog.models).toHaveLength(0);

      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      // After init.
      const postInitState = harness.manager.getState();
      expect(postInitState.loadStatus).toBe('ready');
      expect(postInitState.catalog.models).toHaveLength(2);

      harness.manager.dispose();
    });
  });

  // -- subscribe / dispose ------------------------------------------------

  describe('subscribe / dispose', () => {
    it('subscribe returns an unsubscribe function', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      const listener = vi.fn();
      const unsub = harness.manager.subscribe(listener);

      emitInstallUpdate(harness);
      expect(listener).toHaveBeenCalledOnce();

      unsub();
      emitInstallUpdate(harness, { downloadedBytes: 400 });
      expect(listener).toHaveBeenCalledOnce();

      harness.manager.dispose();
    });

    it('dispose clears listeners and timers', async () => {
      vi.useFakeTimers();

      try {
        const harness = createManagerHarness();
        configureSidecarForInit(harness.sidecarConnection);
        await harness.manager.init();

        const listener = vi.fn();
        harness.manager.subscribe(listener);

        emitInstallUpdate(harness);
        await harness.manager.cancel();

        harness.manager.dispose();

        // Listeners should no longer fire.
        emitInstallUpdate(harness, { downloadedBytes: 999 });
        expect(listener).toHaveBeenCalledTimes(2); // One for install event, one for cancel.

        // Timer should not fire after dispose.
        vi.advanceTimersByTime(30_000);
        // No error means timer was cleared.
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
