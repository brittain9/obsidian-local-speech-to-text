import { describe, expect, it } from 'vitest';

import {
  applyInstallUpdateToSnapshot,
  buildCatalogExplorerRows,
  buildCurrentModelCardState,
  createInstallLifecycleLogMessage,
} from '../src/models/model-management-service';
import type {
  CatalogModelRecord,
  EngineId,
  InstalledModelRecord,
  ModelCatalogRecord,
  ModelInstallUpdateRecord,
  ModelProbeResultRecord,
  SelectedModel,
} from '../src/models/model-management-types';

describe('model management snapshot builders', () => {
  it('orders catalog rows by recommendation and annotates selected installed models', () => {
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
    const activeInstall: ModelInstallUpdateRecord = {
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-1',
      message: 'Downloading',
      modelId: 'whisper_large_v3_turbo_q8_0',
      state: 'downloading',
      totalBytes: 900,
    };

    const rows = buildCatalogExplorerRows(
      catalog,
      installedModels,
      currentSelection,
      activeInstall,
    );
    const [firstRow, secondRow] = rows;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.model.modelId)).toEqual([
      'whisper_large_v3_turbo_q8_0',
      'whisper_small_en_q5_1',
    ]);
    expect(firstRow?.installUpdate?.installId).toBe('install-1');
    expect(secondRow?.isSelected).toBe(true);
    expect(secondRow?.installedModel?.modelId).toBe('whisper_small_en_q5_1');
    expect(secondRow?.installUpdate).toBeNull();
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

  it('applies non-terminal install updates without rebuilding the full snapshot', () => {
    const currentSelection: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const catalog = sampleCatalog();
    const activeInstall: ModelInstallUpdateRecord = {
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-1',
      message: 'Downloading',
      modelId: 'whisper_large_v3_turbo_q8_0',
      state: 'downloading',
      totalBytes: 900,
    };
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

    const nextSnapshot = applyInstallUpdateToSnapshot(snapshot, {
      ...activeInstall,
      downloadedBytes: 400,
    });

    expect(nextSnapshot.activeInstall?.downloadedBytes).toBe(400);
    expect(
      nextSnapshot.rows.find((row) => row.model.modelId === 'whisper_large_v3_turbo_q8_0'),
    ).toMatchObject({
      installUpdate: expect.objectContaining({ downloadedBytes: 400 }),
    });
    expect(
      nextSnapshot.rows.find((row) => row.model.modelId === 'whisper_small_en_q5_1'),
    ).toMatchObject({
      installUpdate: null,
    });
  });

  it('logs only install lifecycle boundaries instead of download percentages', () => {
    const baseUpdate: ModelInstallUpdateRecord = {
      details: null,
      downloadedBytes: 50,
      engineId: 'whisper_cpp',
      installId: 'install-1',
      message: 'Downloading',
      modelId: 'whisper_large_v3_turbo_q8_0',
      state: 'downloading',
      totalBytes: 900,
    };

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
});

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
