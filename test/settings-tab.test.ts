import { describe, expect, it } from 'vitest';
import { describeAcceleration, formatAcceleratorLabel } from '../src/settings/acceleration-info';
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

function onnxRuntime(
  overrides: Partial<CompiledRuntimeInfo['runtimeCapabilities']> = {},
): CompiledRuntimeInfo {
  return {
    displayName: 'ONNX Runtime',
    runtimeCapabilities: {
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu'],
      supportedModelFormats: ['onnx'],
      ...overrides,
    },
    runtimeId: 'onnx_runtime',
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
      supportsSegmentTimestamps: true,
      supportsWordTimestamps: false,
    },
    familyId: 'whisper',
    runtimeId: 'whisper_cpp',
  };
}

function cohereAdapter(): CompiledAdapterInfo {
  return {
    displayName: 'Cohere Transcribe',
    familyCapabilities: {
      maxAudioDurationSecs: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'all' },
      supportsInitialPrompt: false,
      supportsLanguageSelection: true,
      supportsSegmentTimestamps: false,
      supportsWordTimestamps: false,
    },
    familyId: 'cohere_transcribe',
    runtimeId: 'onnx_runtime',
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

describe('describeAcceleration', () => {
  it('reports a pending state when system info is unavailable', () => {
    expect(describeAcceleration(null, 'auto')).toEqual({
      fallbacks: [],
      label: 'pending (sidecar not ready)',
    });
  });

  it('returns CPU when the toggle is off, even with a GPU available', () => {
    const runtime = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });

    expect(describeAcceleration(systemInfo([runtime]), 'cpu_only')).toEqual({
      fallbacks: [],
      label: 'CPU',
    });
  });

  it('collapses to a single backend name when every engine agrees', () => {
    const whisper = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });
    const onnx = onnxRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });

    expect(
      describeAcceleration(systemInfo([whisper, onnx], [whisperAdapter(), cohereAdapter()]), 'auto')
        .label,
    ).toBe('CUDA');
  });

  it('uses adapter order to choose the primary when engines land on different GPUs', () => {
    // Adapter order below is [Whisper/CUDA, Cohere/Metal], so Whisper's CUDA wins.
    const whisper = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });
    const onnx = onnxRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        metal: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'metal'],
    });

    expect(
      describeAcceleration(systemInfo([whisper, onnx], [whisperAdapter(), cohereAdapter()]), 'auto')
        .label,
    ).toBe('CUDA (Cohere Transcribe: Metal)');
  });

  it('names the primary backend and lists engines using a different accelerator', () => {
    const whisper = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        metal: { available: true, unavailableReason: null },
      },
      availableAccelerators: ['cpu', 'metal'],
    });

    expect(
      describeAcceleration(
        systemInfo([whisper, onnxRuntime()], [whisperAdapter(), cohereAdapter()]),
        'auto',
      ).label,
    ).toBe('Metal (Cohere Transcribe: CPU)');
  });

  it('reports a compact CPU fallback label without the reason when every engine falls back', () => {
    const whisper = whisperRuntime({
      acceleratorDetails: {
        cpu: { available: true, unavailableReason: null },
        cuda: { available: false, unavailableReason: 'NVIDIA device nodes not found' },
      },
      availableAccelerators: ['cpu', 'cuda'],
    });

    expect(describeAcceleration(systemInfo([whisper]), 'auto')).toEqual({
      fallbacks: [
        {
          accelerator: 'cuda',
          engine: 'Whisper',
          reason: 'NVIDIA device nodes not found',
        },
      ],
      label: 'CPU (CUDA unavailable)',
    });
  });

  it('reports plain CPU when no GPU is compiled in', () => {
    expect(describeAcceleration(systemInfo([whisperRuntime()]), 'auto')).toEqual({
      fallbacks: [],
      label: 'CPU',
    });
  });
});
