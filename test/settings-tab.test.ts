import { describe, expect, it } from 'vitest';
import {
  buildAccelerationSummary,
  buildEffectiveBackendLines,
  buildRuntimeAcceleratorLines,
  formatAcceleratorLabel,
} from '../src/settings/acceleration-info';
import type {
  CompiledAdapterInfo,
  CompiledRuntimeInfo,
  SystemInfoEvent,
} from '../src/sidecar/protocol';

function whisperRuntime(
  overrides: Partial<CompiledRuntimeInfo['runtimeCapabilities']> = {},
): CompiledRuntimeInfo {
  return {
    displayName: 'whisper.cpp',
    runtimeCapabilities: {
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu'],
      supportedModelFormats: ['ggml'],
      ...overrides,
    },
    runtimeId: 'whisper_cpp',
  };
}

function whisperAdapter(): CompiledAdapterInfo {
  return {
    displayName: 'Whisper',
    familyCapabilities: {
      maxAudioDurationSecs: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'english_only' },
      supportsInitialPrompt: true,
      supportsLanguageSelection: false,
      supportsTimedSegments: true,
    },
    familyId: 'whisper',
    runtimeId: 'whisper_cpp',
  };
}

function systemInfo(
  runtimes: CompiledRuntimeInfo[],
  adapters: CompiledAdapterInfo[] = [whisperAdapter()],
): SystemInfoEvent {
  return {
    compiledAdapters: adapters,
    compiledRuntimes: runtimes,
    sidecarVersion: '0.0.0-test',
    systemInfo: 'stub',
    type: 'system_info',
  };
}

describe('formatAcceleratorLabel', () => {
  it('maps every accelerator to its canonical display label', () => {
    expect(formatAcceleratorLabel('cpu')).toBe('CPU');
    expect(formatAcceleratorLabel('cuda')).toBe('CUDA');
    expect(formatAcceleratorLabel('direct_ml')).toBe('DirectML');
    expect(formatAcceleratorLabel('metal')).toBe('Metal');
  });
});

describe('buildAccelerationSummary', () => {
  it('reports missing sidecar data when system info is null', () => {
    expect(buildAccelerationSummary(null)).toContain('unavailable until the sidecar');
  });

  it('reports CPU-only builds when no runtime exposes a non-CPU accelerator', () => {
    expect(buildAccelerationSummary(systemInfo([whisperRuntime()]))).toBe(
      'This sidecar build is CPU-only.',
    );
  });

  it('advertises GPU acceleration when at least one runtime lists a non-CPU accelerator', () => {
    const runtime = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });

    expect(buildAccelerationSummary(systemInfo([runtime]))).toContain('GPU acceleration');
  });
});

describe('buildRuntimeAcceleratorLines', () => {
  it('forces CPU when the user preference is cpu_only even with a GPU available', () => {
    const runtime = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });

    expect(buildRuntimeAcceleratorLines(runtime, 'cpu_only')).toBe(
      'whisper.cpp: CPU (GPU disabled)',
    );
  });

  it('reports CPU when the runtime advertises no non-CPU accelerator', () => {
    expect(buildRuntimeAcceleratorLines(whisperRuntime(), 'auto')).toBe('whisper.cpp: CPU');
  });

  it('reports availability + reason for each GPU accelerator under auto preference', () => {
    const runtime = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
        metal: { available: false, unavailableReason: 'not built with metal' },
      },
      availableAccelerators: ['cpu', 'cuda', 'metal'],
    });

    const line = buildRuntimeAcceleratorLines(runtime, 'auto');
    expect(line).toContain('CUDA (available)');
    expect(line).toContain('Metal (unavailable: not built with metal)');
  });
});

describe('buildEffectiveBackendLines', () => {
  it('returns no lines when system info is unavailable', () => {
    expect(buildEffectiveBackendLines(null, 'auto')).toEqual([]);
  });

  it('emits one line per compiled runtime in the order reported by the sidecar', () => {
    const whisper = whisperRuntime();
    const onnx: CompiledRuntimeInfo = {
      displayName: 'ONNX Runtime',
      runtimeCapabilities: {
        acceleratorDetails: {
          cpu: { available: true, unavailableReason: null },
        },
        availableAccelerators: ['cpu'],
        supportedModelFormats: ['onnx'],
      },
      runtimeId: 'onnx_runtime',
    };

    expect(buildEffectiveBackendLines(systemInfo([whisper, onnx]), 'auto')).toEqual([
      'whisper.cpp: CPU',
      'ONNX Runtime: CPU',
    ]);
  });
});
