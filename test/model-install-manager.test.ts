import { describe, expect, it, vi } from 'vitest';
import {
  createInstallId,
  createInstallLifecycleLogMessage,
  isTerminalInstallState,
  ModelInstallManager,
} from '../src/models/model-install-manager';
import type {
  CatalogModelSelection,
  EngineCapabilitiesRecord,
  InstalledModelRecord,
  ModelInstallUpdateRecord,
  ModelStoreRecord,
} from '../src/models/model-management-types';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type { SidecarEvent } from '../src/sidecar/protocol';
import { sampleCatalog } from './fixtures/catalog';

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
  sidecarConnection.getSystemInfo.mockResolvedValue(sampleSystemInfo());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleInstalledModel(): InstalledModelRecord {
  return {
    catalogVersion: 1,
    familyId: 'whisper',
    installPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0',
    installedAtUnixMs: 1_700_000_000_000,
    modelId: 'whisper_large_v3_turbo_q8_0',
    runtimeId: 'whisper_cpp',
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

function sampleSystemInfo() {
  return {
    compiledAdapters: [
      {
        displayName: 'Whisper',
        familyCapabilities: {
          maxAudioDurationSecs: null,
          producesPunctuation: true,
          supportedLanguages: { kind: 'all' as const },
          supportsInitialPrompt: true,
          supportsLanguageSelection: true,
          supportsSegmentTimestamps: true,
          supportsWordTimestamps: false,
        },
        familyId: 'whisper' as const,
        runtimeId: 'whisper_cpp' as const,
      },
    ],
    compiledRuntimes: [
      {
        displayName: 'Whisper.cpp',
        runtimeCapabilities: {
          acceleratorDetails: {
            cpu: { available: true, unavailableReason: null },
          },
          availableAccelerators: ['cpu' as const],
          supportedModelFormats: ['ggml' as const, 'gguf' as const],
        },
        runtimeId: 'whisper_cpp' as const,
      },
    ],
    sidecarVersion: '0.0.0-test',
    systemInfo: 'stub',
    type: 'system_info' as const,
  };
}

function sampleInstallUpdate(
  overrides?: Partial<ModelInstallUpdateRecord>,
): ModelInstallUpdateRecord {
  return {
    details: null,
    downloadedBytes: 50,
    familyId: 'whisper',
    installId: 'install-1',
    message: 'Downloading',
    modelId: 'whisper_large_v3_turbo_q8_0',
    runtimeId: 'whisper_cpp',
    state: 'downloading',
    totalBytes: 900,
    ...overrides,
  };
}

function sampleSelection(modelId = 'whisper_large_v3_turbo_q8_0'): CatalogModelSelection {
  return {
    familyId: 'whisper',
    kind: 'catalog_model',
    modelId,
    runtimeId: 'whisper_cpp',
  };
}

function sampleMergedCapabilities(): EngineCapabilitiesRecord {
  return {
    family: {
      maxAudioDurationSecs: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'english_only' },
      supportsInitialPrompt: true,
      supportsLanguageSelection: false,
      supportsSegmentTimestamps: true,
      supportsWordTimestamps: false,
    },
    familyId: 'whisper',
    runtime: {
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu'],
      supportedModelFormats: ['ggml'],
    },
    runtimeId: 'whisper_cpp',
  };
}

function sampleReadyProbeResult(selection = sampleSelection()) {
  return {
    available: true,
    details: null,
    displayName: 'Whisper Large V3 Turbo Q8_0',
    familyId: selection.familyId,
    installed: true,
    mergedCapabilities: sampleMergedCapabilities(),
    message: 'Model selection is ready.',
    modelId: 'modelId' in selection ? selection.modelId : null,
    resolvedPath: '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
    runtimeId: selection.runtimeId,
    selection,
    sizeBytes: 900,
    status: 'ready' as const,
  };
}

function emitInstallUpdate(
  harness: ReturnType<typeof createManagerHarness>,
  overrides?: Partial<ModelInstallUpdateRecord>,
) {
  harness.emit({
    ...sampleInstallUpdate(overrides),
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
      expect(state.compiledRuntimes.map((r) => r.runtimeId)).toEqual(['whisper_cpp']);
      expect(state.compiledAdapters.map((a) => `${a.runtimeId}:${a.familyId}`)).toEqual([
        'whisper_cpp:whisper',
      ]);

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
          familyId: 'whisper',
          modelId: 'whisper_large_v3_turbo_q8_0',
          runtimeId: 'whisper_cpp',
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

      // completed triggers an async refresh — mock the listInstalledModels call
      harness.sidecarConnection.listInstalledModels.mockResolvedValueOnce({
        models: [sampleInstalledModel()],
      });

      emitInstallUpdate(harness, { state: 'completed' });
      expect(harness.manager.getState().activeInstall).toBeNull();

      // Wait for the async refresh to complete.
      await vi.waitFor(() => {
        expect(harness.sidecarConnection.listInstalledModels).toHaveBeenCalledTimes(2);
      });

      harness.manager.dispose();
    });

    it('refreshes installed models after completed event', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      // Before install: one model installed.
      expect(harness.manager.getState().installedModels).toHaveLength(1);

      emitInstallUpdate(harness, {
        modelId: 'whisper_small_en_q5_1',
        installId: 'install-refresh',
      });

      // After completion the sidecar reports the new model as installed.
      harness.sidecarConnection.listInstalledModels.mockResolvedValueOnce({
        models: [
          sampleInstalledModel(),
          {
            ...sampleInstalledModel(),
            installPath: '/models/whisper_cpp/whisper_small_en_q5_1',
            modelId: 'whisper_small_en_q5_1',
            totalSizeBytes: 100,
          },
        ],
      });

      emitInstallUpdate(harness, {
        installId: 'install-refresh',
        modelId: 'whisper_small_en_q5_1',
        state: 'completed',
      });

      // Wait for the async refresh.
      await vi.waitFor(() => {
        expect(harness.manager.getState().installedModels).toHaveLength(2);
      });

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

      // completed triggers an async refresh — mock listInstalledModels
      harness.sidecarConnection.listInstalledModels.mockResolvedValueOnce({
        models: [sampleInstalledModel()],
      });

      emitInstallUpdate(harness, { downloadedBytes: 100 });
      emitInstallUpdate(harness, { downloadedBytes: 400 });
      emitInstallUpdate(harness, { state: 'completed' });

      // 2 synchronous notifications for progress ticks.
      expect(listener).toHaveBeenCalledTimes(2);

      // 3rd notification arrives after the async installed-models refresh.
      await vi.waitFor(() => {
        expect(listener).toHaveBeenCalledTimes(3);
      });

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

      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce(sampleReadyProbeResult());

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
        familyId: 'whisper',
        installed: false,
        mergedCapabilities: null,
        message: 'Model is not installed.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        resolvedPath: null,
        runtimeId: 'whisper_cpp',
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
      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce(sampleReadyProbeResult());
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

      harness.sidecarConnection.listInstalledModels.mockResolvedValueOnce({
        models: [sampleInstalledModel()],
      });

      emitInstallUpdate(harness, { modelId: 'whisper_small_en_q5_1', installId: 'install-comp' });
      emitInstallUpdate(harness, {
        modelId: 'whisper_small_en_q5_1',
        installId: 'install-comp',
        state: 'completed',
      });

      expect(harness.manager.getState().activeInstall).toBeNull();
      expect(harness.getSettings().selectedModel).toEqual(sampleSelection());

      // Wait for the async refresh triggered by completed event.
      await vi.waitFor(() => {
        expect(harness.sidecarConnection.listInstalledModels).toHaveBeenCalledTimes(2);
      });

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

  // -- selectedModelCapabilities -----------------------------------------

  describe('selectedModelCapabilities', () => {
    it('is none when no model is selected', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({ status: 'none' });

      harness.manager.dispose();
    });

    it('transitions from pending to ready on restart probe success', async () => {
      const harness = createManagerHarness({ selectedModel: sampleSelection() });
      configureSidecarForInit(harness.sidecarConnection);

      let resolveProbe!: (result: ReturnType<typeof sampleReadyProbeResult>) => void;
      harness.sidecarConnection.probeModelSelection.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
      );

      await harness.manager.init();

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({
        selection: sampleSelection(),
        status: 'pending',
      });

      resolveProbe(sampleReadyProbeResult());

      await vi.waitFor(() => {
        const caps = harness.manager.getState().selectedModelCapabilities;
        expect(caps.status).toBe('ready');
      });

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({
        capabilities: sampleMergedCapabilities(),
        selection: sampleSelection(),
        status: 'ready',
      });

      harness.manager.dispose();
    });

    it('maps missing probe result to unavailable with the failure message', async () => {
      const harness = createManagerHarness({ selectedModel: sampleSelection() });
      configureSidecarForInit(harness.sidecarConnection);
      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce({
        available: false,
        details: 'file not found',
        displayName: null,
        familyId: 'whisper',
        installed: false,
        mergedCapabilities: null,
        message: 'Model is not installed.',
        modelId: 'whisper_large_v3_turbo_q8_0',
        resolvedPath: null,
        runtimeId: 'whisper_cpp',
        selection: sampleSelection(),
        sizeBytes: null,
        status: 'missing',
      });

      await harness.manager.init();

      await vi.waitFor(() => {
        const caps = harness.manager.getState().selectedModelCapabilities;
        expect(caps.status).toBe('unavailable');
      });

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({
        details: 'Model is not installed. (file not found)',
        reason: 'missing',
        selection: sampleSelection(),
        status: 'unavailable',
      });

      harness.manager.dispose();
    });

    it('maps probe exceptions to unavailable probe_failed', async () => {
      const harness = createManagerHarness({ selectedModel: sampleSelection() });
      configureSidecarForInit(harness.sidecarConnection);
      harness.sidecarConnection.probeModelSelection.mockRejectedValueOnce(
        new Error('sidecar pipe closed'),
      );

      await harness.manager.init();

      await vi.waitFor(() => {
        const caps = harness.manager.getState().selectedModelCapabilities;
        expect(caps.status).toBe('unavailable');
      });

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({
        reason: 'probe_failed',
        selection: sampleSelection(),
        status: 'unavailable',
      });

      harness.manager.dispose();
    });

    it('populates ready directly from the select() probe result without a second probe', async () => {
      const harness = createManagerHarness();
      configureSidecarForInit(harness.sidecarConnection);
      await harness.manager.init();

      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce(sampleReadyProbeResult());
      await harness.manager.select(sampleSelection());

      expect(harness.sidecarConnection.probeModelSelection).toHaveBeenCalledTimes(1);
      expect(harness.manager.getState().selectedModelCapabilities).toEqual({
        capabilities: sampleMergedCapabilities(),
        selection: sampleSelection(),
        status: 'ready',
      });

      harness.manager.dispose();
    });

    it('clearSelection resets capabilities to none and notifies', async () => {
      const harness = createManagerHarness({ selectedModel: sampleSelection() });
      configureSidecarForInit(harness.sidecarConnection);
      harness.sidecarConnection.probeModelSelection.mockResolvedValueOnce(sampleReadyProbeResult());
      await harness.manager.init();
      await vi.waitFor(() => {
        expect(harness.manager.getState().selectedModelCapabilities.status).toBe('ready');
      });

      const listener = vi.fn();
      harness.manager.subscribe(listener);

      await harness.manager.clearSelection();

      expect(harness.manager.getState().selectedModelCapabilities).toEqual({ status: 'none' });
      expect(listener).toHaveBeenCalled();

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
      expect(state.compiledRuntimes.map((r) => r.runtimeId)).toEqual(['whisper_cpp']);
      expect(state.compiledAdapters.map((a) => `${a.runtimeId}:${a.familyId}`)).toEqual([
        'whisper_cpp:whisper',
      ]);
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
