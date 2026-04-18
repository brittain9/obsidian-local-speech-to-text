import { describe, expect, it } from 'vitest';

import { buildCapabilityView } from '../src/models/capability-view';
import type { ActiveInstallInfo, ModelManagerState } from '../src/models/model-install-manager';
import type {
  EngineCapabilitiesRecord,
  SelectedModel,
  SelectedModelCapabilities,
} from '../src/models/model-management-types';
import { sampleCatalog } from './fixtures/catalog';

function catalogSelection(): SelectedModel {
  return {
    familyId: 'whisper',
    kind: 'catalog_model',
    modelId: 'whisper_large_v3_turbo_q8_0',
    runtimeId: 'whisper_cpp',
  };
}

function externalFileSelection(): SelectedModel {
  return {
    familyId: 'whisper',
    filePath: '/tmp/external.bin',
    kind: 'external_file',
    runtimeId: 'whisper_cpp',
  };
}

function sampleMergedCapabilities(
  overrides?: Partial<EngineCapabilitiesRecord>,
): EngineCapabilitiesRecord {
  return {
    family: {
      maxAudioDurationSecs: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'english_only' },
      supportsInitialPrompt: true,
      supportsLanguageSelection: false,
      supportsTimedSegments: true,
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
    ...overrides,
  };
}

function buildState(overrides: {
  selectedModel?: SelectedModel | null;
  selectedModelCapabilities: SelectedModelCapabilities;
  activeInstall?: ActiveInstallInfo | null;
}): ModelManagerState {
  return {
    activeInstall: overrides.activeInstall ?? null,
    catalog: sampleCatalog(),
    compiledAdapters: [
      {
        displayName: 'Whisper',
        familyCapabilities: sampleMergedCapabilities().family,
        familyId: 'whisper',
        runtimeId: 'whisper_cpp',
      },
    ],
    compiledRuntimes: [
      {
        displayName: 'whisper.cpp',
        runtimeCapabilities: sampleMergedCapabilities().runtime,
        runtimeId: 'whisper_cpp',
      },
    ],
    installedModels: [],
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: overrides.selectedModel ?? null,
    selectedModelCapabilities: overrides.selectedModelCapabilities,
  };
}

describe('buildCapabilityView', () => {
  it('returns none when nothing is selected', () => {
    const view = buildCapabilityView(buildState({ selectedModelCapabilities: { status: 'none' } }));

    expect(view).toEqual({ status: 'none' });
  });

  it('returns pending while a probe is in flight', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          selection: catalogSelection(),
          status: 'pending',
        },
      }),
    );

    expect(view).toEqual({ status: 'pending' });
  });

  it('surfaces missing-model details as the unavailable message', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          details: 'Model is not installed.',
          reason: 'missing',
          selection: catalogSelection(),
          status: 'unavailable',
        },
      }),
    );

    expect(view).toEqual({
      message: 'Model is not installed.',
      status: 'unavailable',
    });
  });

  it('surfaces invalid-file details as the unavailable message', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: externalFileSelection(),
        selectedModelCapabilities: {
          details: 'File is not a valid whisper model.',
          reason: 'invalid',
          selection: externalFileSelection(),
          status: 'unavailable',
        },
      }),
    );

    expect(view).toEqual({
      message: 'File is not a valid whisper model.',
      status: 'unavailable',
    });
  });

  it('uses a generic message when a probe exception has no details', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          reason: 'probe_failed',
          selection: catalogSelection(),
          status: 'unavailable',
        },
      }),
    );

    expect(view).toEqual({
      message: 'Capability detection failed.',
      status: 'unavailable',
    });
  });

  it('builds rows for a ready capability using registry display names', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          capabilities: sampleMergedCapabilities(),
          selection: catalogSelection(),
          status: 'ready',
        },
      }),
    );

    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.rows).toContainEqual({ label: 'Runtime', value: 'whisper.cpp' });
    expect(view.rows).toContainEqual({ label: 'Model family', value: 'Whisper' });
    expect(view.rows).toContainEqual({ label: 'Accelerators', value: 'cpu' });
    expect(view.rows).toContainEqual({ label: 'Model formats', value: 'ggml' });
    expect(view.rows).toContainEqual({ label: 'Timed segments', value: 'Yes' });
    expect(view.rows).toContainEqual({
      label: 'Language support',
      value: 'English only',
    });
    expect(view.rows).not.toContainEqual(expect.objectContaining({ label: 'Max audio duration' }));
  });

  it('omits Max audio duration when the adapter does not advertise one', () => {
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          capabilities: sampleMergedCapabilities(),
          selection: catalogSelection(),
          status: 'ready',
        },
      }),
    );

    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.rows.find((r) => r.label === 'Max audio duration')).toBeUndefined();
  });

  it('emits rounded Max audio duration when the adapter advertises one', () => {
    const capabilities = sampleMergedCapabilities({
      family: {
        ...sampleMergedCapabilities().family,
        maxAudioDurationSecs: 30.4,
      },
    });
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          capabilities,
          selection: catalogSelection(),
          status: 'ready',
        },
      }),
    );

    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.rows).toContainEqual({ label: 'Max audio duration', value: '30 s' });
  });

  it('reports "CPU only" when no accelerator is advertised', () => {
    const capabilities = sampleMergedCapabilities({
      runtime: {
        acceleratorDetails: {},
        availableAccelerators: [],
        supportedModelFormats: ['ggml'],
      },
    });
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          capabilities,
          selection: catalogSelection(),
          status: 'ready',
        },
      }),
    );

    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.rows).toContainEqual({ label: 'Accelerators', value: 'CPU only' });
  });

  it('maps language list kind to a count description', () => {
    const capabilities = sampleMergedCapabilities({
      family: {
        ...sampleMergedCapabilities().family,
        supportedLanguages: { kind: 'list', tags: ['en', 'es', 'fr'] },
        supportsLanguageSelection: true,
      },
    });
    const view = buildCapabilityView(
      buildState({
        selectedModel: catalogSelection(),
        selectedModelCapabilities: {
          capabilities,
          selection: catalogSelection(),
          status: 'ready',
        },
      }),
    );

    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.rows).toContainEqual({ label: 'Language support', value: '3 languages' });
  });

  it('falls back to ids when registry has no matching display name (external-file unknown family)', () => {
    const capabilities: EngineCapabilitiesRecord = {
      family: {
        maxAudioDurationSecs: null,
        producesPunctuation: false,
        supportedLanguages: { kind: 'unknown' },
        supportsInitialPrompt: false,
        supportsLanguageSelection: false,
        supportsTimedSegments: false,
      },
      familyId: 'cohere_transcribe',
      runtime: {
        acceleratorDetails: {
          cpu: { available: true, unavailableReason: null },
        },
        availableAccelerators: ['cpu'],
        supportedModelFormats: ['onnx'],
      },
      runtimeId: 'onnx_runtime',
    };
    const view = buildCapabilityView(
      buildState({
        selectedModel: externalFileSelection(),
        selectedModelCapabilities: {
          capabilities,
          selection: externalFileSelection(),
          status: 'ready',
        },
      }),
    );

    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.rows).toContainEqual({ label: 'Runtime', value: 'onnx_runtime' });
    expect(view.rows).toContainEqual({ label: 'Model family', value: 'cohere_transcribe' });
  });
});
