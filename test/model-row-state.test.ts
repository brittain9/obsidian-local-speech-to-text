import { describe, expect, it } from 'vitest';
import type { ActiveInstallInfo, ModelManagerState } from '../src/models/model-install-manager';
import type {
  CatalogModelRecord,
  InstalledModelRecord,
  ModelCatalogRecord,
  ModelInstallUpdateRecord,
  SelectedModel,
} from '../src/models/model-management-types';
import {
  deriveCurrentModelDisplay,
  deriveModelRowStates,
  type ModelRowState,
} from '../src/models/model-row-state';

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

function sampleInstalledModel(modelId = 'whisper_large_v3_turbo_q8_0'): InstalledModelRecord {
  return {
    catalogVersion: 1,
    engineId: 'whisper_cpp',
    installPath: `/models/whisper_cpp/${modelId}`,
    installedAtUnixMs: 1_700_000_000_000,
    modelId,
    runtimePath: `/models/whisper_cpp/${modelId}/model.bin`,
    totalSizeBytes: modelId === 'whisper_large_v3_turbo_q8_0' ? 900 : 100,
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

function sampleActiveInstall(phase: ActiveInstallInfo['phase'] = 'installing'): ActiveInstallInfo {
  return {
    installUpdate: sampleInstallUpdate(),
    lastError: null,
    phase,
  };
}

function buildState(overrides?: Partial<ModelManagerState>): ModelManagerState {
  return {
    activeInstall: null,
    catalog: sampleCatalog(),
    installedModels: [],
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: null,
    supportedEngineIds: ['whisper_cpp'],
    ...overrides,
  };
}

/** Retrieve a row by modelId, throwing if not found so tests fail clearly. */
function getRow(rows: ModelRowState[], modelId: string): ModelRowState {
  const row = rows.find((r) => r.model.modelId === modelId);

  if (row === undefined) {
    throw new Error(`Row not found for modelId: ${modelId}`);
  }

  return row;
}

// ---------------------------------------------------------------------------
// deriveModelRowStates — action rules
// ---------------------------------------------------------------------------

describe('deriveModelRowStates', () => {
  it('sorts rows smallest to largest by total artifact size', () => {
    const rows = deriveModelRowStates(buildState());

    expect(rows.map((r) => r.model.modelId)).toEqual([
      'whisper_small_en_q5_1',
      'whisper_large_v3_turbo_q8_0',
    ]);
  });

  describe('action rules — not installed, no active install', () => {
    it('allows install and details', () => {
      const rows = deriveModelRowStates(buildState());
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.installed).toBe(false);
      expect(row.isInstalling).toBe(false);
      expect(row.isCanceling).toBe(false);
      expect(row.allowedActions).toEqual(['install', 'details']);
    });
  });

  describe('action rules — not installed, different model installing', () => {
    it('allows details only (install blocked)', () => {
      const activeInstall = sampleActiveInstall();
      // Large model is installing; small model is not installed.
      const rows = deriveModelRowStates(buildState({ activeInstall }));
      const smallRow = getRow(rows, 'whisper_small_en_q5_1');

      expect(smallRow.installed).toBe(false);
      expect(smallRow.isInstalling).toBe(false);
      expect(smallRow.allowedActions).toEqual(['details']);
    });
  });

  describe('action rules — currently installing', () => {
    it('allows cancel and details', () => {
      const activeInstall = sampleActiveInstall('installing');
      const rows = deriveModelRowStates(buildState({ activeInstall }));
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.isInstalling).toBe(true);
      expect(row.isCanceling).toBe(false);
      expect(row.allowedActions).toEqual(['cancel', 'details']);
    });
  });

  describe('action rules — currently canceling', () => {
    it('allows details only', () => {
      const activeInstall = sampleActiveInstall('canceling');
      const rows = deriveModelRowStates(buildState({ activeInstall }));
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.isInstalling).toBe(false);
      expect(row.isCanceling).toBe(true);
      expect(row.allowedActions).toEqual(['details']);
    });
  });

  describe('action rules — cancelStuck', () => {
    it('allows details only', () => {
      const activeInstall = sampleActiveInstall('cancelStuck');
      const rows = deriveModelRowStates(buildState({ activeInstall }));
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.isCanceling).toBe(true);
      expect(row.allowedActions).toEqual(['details']);
    });
  });

  describe('action rules — installed, not selected', () => {
    it('allows use, remove, and details', () => {
      const rows = deriveModelRowStates(buildState({ installedModels: [sampleInstalledModel()] }));
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.installed).toBe(true);
      expect(row.isSelected).toBe(false);
      expect(row.allowedActions).toEqual(['use', 'remove', 'details']);
    });
  });

  describe('action rules — installed, selected', () => {
    it('allows selected (disabled) and details', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
      };
      const rows = deriveModelRowStates(
        buildState({ installedModels: [sampleInstalledModel()], selectedModel }),
      );
      const row = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(row.installed).toBe(true);
      expect(row.isSelected).toBe(true);
      expect(row.allowedActions).toEqual(['selected', 'details']);
    });
  });

  describe('active install effects on other rows', () => {
    it('use remains allowed on installed non-selected model during another install', () => {
      const activeInstall = sampleActiveInstall('installing');
      // Large model is installing; small model is installed but not selected.
      const rows = deriveModelRowStates(
        buildState({
          activeInstall,
          installedModels: [sampleInstalledModel('whisper_small_en_q5_1')],
        }),
      );
      const smallRow = getRow(rows, 'whisper_small_en_q5_1');

      expect(smallRow.installed).toBe(true);
      expect(smallRow.isSelected).toBe(false);
      expect(smallRow.allowedActions).toContain('use');
      expect(smallRow.allowedActions).toContain('remove');
    });

    it('selected action remains allowed on currently selected model during another install', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_small_en_q5_1',
      };
      const activeInstall = sampleActiveInstall('installing');
      const rows = deriveModelRowStates(
        buildState({
          activeInstall,
          installedModels: [sampleInstalledModel('whisper_small_en_q5_1')],
          selectedModel,
        }),
      );
      const smallRow = getRow(rows, 'whisper_small_en_q5_1');

      expect(smallRow.isSelected).toBe(true);
      expect(smallRow.allowedActions).toContain('selected');
    });

    it('cancel is only allowed on the actively installing model', () => {
      const activeInstall = sampleActiveInstall('installing');
      const rows = deriveModelRowStates(
        buildState({
          activeInstall,
          installedModels: [sampleInstalledModel('whisper_small_en_q5_1')],
        }),
      );
      const largeRow = getRow(rows, 'whisper_large_v3_turbo_q8_0');
      const smallRow = getRow(rows, 'whisper_small_en_q5_1');

      expect(largeRow.allowedActions).toContain('cancel');
      expect(smallRow.allowedActions).not.toContain('cancel');
    });

    it('install is blocked on all models when any install is active', () => {
      const activeInstall = sampleActiveInstall('installing');
      const rows = deriveModelRowStates(buildState({ activeInstall }));

      for (const row of rows) {
        expect(row.allowedActions).not.toContain('install');
      }
    });

    it('remove is blocked on the actively installing model', () => {
      const activeInstall = sampleActiveInstall('installing');
      // Install model is in installed list to verify remove logic
      const rows = deriveModelRowStates(
        buildState({
          activeInstall,
          installedModels: [sampleInstalledModel('whisper_large_v3_turbo_q8_0')],
        }),
      );
      // The installing model gets cancel+details, not remove.
      const largeRow = getRow(rows, 'whisper_large_v3_turbo_q8_0');

      expect(largeRow.allowedActions).not.toContain('remove');
      expect(largeRow.allowedActions).toContain('cancel');
    });
  });
});

// ---------------------------------------------------------------------------
// deriveCurrentModelDisplay — empty state
// ---------------------------------------------------------------------------

describe('deriveCurrentModelDisplay', () => {
  describe('empty state — no selected model', () => {
    it('returns the no-model-selected empty state', () => {
      const display = deriveCurrentModelDisplay(buildState());

      expect(display.displayName).toBe('No model selected');
      expect(display.engineLabel).toBe('');
      expect(display.detail).toBe('Choose an installed model or validate an external file.');
      expect(display.installedLabel).toBe('Not selected');
      expect(display.sourceLabel).toBe('');
      expect(display.sizeBytes).toBeNull();
      expect(display.installLocation).toBeNull();
      expect(display.resolvedPath).toBeNull();
    });
  });

  describe('catalog model — installed', () => {
    it('returns installed model details from installed records', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
      };
      const installed = sampleInstalledModel('whisper_large_v3_turbo_q8_0');
      const display = deriveCurrentModelDisplay(
        buildState({ selectedModel, installedModels: [installed] }),
      );

      expect(display.displayName).toBe('Whisper Large V3 Turbo Q8_0');
      expect(display.engineLabel).toBe('Whisper');
      expect(display.installedLabel).toBe('Installed');
      expect(display.sourceLabel).toBe('Managed download');
      expect(display.sizeBytes).toBe(900);
      expect(display.installLocation).toBe('/models/whisper_cpp/whisper_large_v3_turbo_q8_0');
      expect(display.resolvedPath).toBe(
        '/models/whisper_cpp/whisper_large_v3_turbo_q8_0/model.bin',
      );
    });
  });

  describe('catalog model — not installed', () => {
    it('shows not-installed label and falls back to catalog size', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_small_en_q5_1',
      };
      const display = deriveCurrentModelDisplay(buildState({ selectedModel, installedModels: [] }));

      expect(display.displayName).toBe('Whisper Small English Q5_1');
      expect(display.installedLabel).toBe('Not installed');
      expect(display.sizeBytes).toBe(100);
      expect(display.installLocation).toBeNull();
      expect(display.resolvedPath).toBeNull();
    });

    it('falls back to modelId as displayName when catalog entry is absent', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'unknown_model_xyz',
      };
      const display = deriveCurrentModelDisplay(buildState({ selectedModel }));

      expect(display.displayName).toBe('unknown_model_xyz');
      expect(display.sizeBytes).toBeNull();
    });
  });

  describe('external file model', () => {
    it('uses basename as displayName and filePath as resolvedPath', () => {
      const selectedModel: SelectedModel = {
        engineId: 'whisper_cpp',
        filePath: '/tmp/models/custom-model.bin',
        kind: 'external_file',
      };
      const display = deriveCurrentModelDisplay(buildState({ selectedModel }));

      expect(display.displayName).toBe('custom-model.bin');
      expect(display.engineLabel).toBe('Whisper');
      expect(display.installedLabel).toBe('External file');
      expect(display.sourceLabel).toBe('External file');
      expect(display.sizeBytes).toBeNull();
      expect(display.installLocation).toBeNull();
      expect(display.resolvedPath).toBe('/tmp/models/custom-model.bin');
    });
  });
});
