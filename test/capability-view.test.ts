import { describe, expect, it } from 'vitest';

import { buildCapabilityLabels } from '../src/models/capability-view';
import type { EngineCapabilitiesRecord } from '../src/models/model-management-types';

function sampleCapabilities(
  overrides?: Partial<EngineCapabilitiesRecord>,
): EngineCapabilitiesRecord {
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
    ...overrides,
  };
}

describe('buildCapabilityLabels', () => {
  it('lists accelerators, formats, positive feature flags, and language support', () => {
    const labels = buildCapabilityLabels(sampleCapabilities());

    expect(labels).toEqual([
      'CPU',
      'GGML',
      'Segment timestamps',
      'Initial prompt',
      'Punctuation',
      'English only',
    ]);
  });

  it('display-cases each accelerator in order', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        runtime: {
          acceleratorDetails: {},
          availableAccelerators: ['metal', 'cuda', 'direct_ml', 'cpu'],
          supportedModelFormats: ['gguf', 'onnx'],
        },
      }),
    );

    expect(labels.slice(0, 6)).toEqual(['Metal', 'CUDA', 'DirectML', 'CPU', 'GGUF', 'ONNX']);
  });

  it('falls back to CPU when no accelerators are advertised', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        runtime: {
          acceleratorDetails: {},
          availableAccelerators: [],
          supportedModelFormats: ['ggml'],
        },
      }),
    );

    expect(labels[0]).toBe('CPU');
  });

  it('omits feature flags that are false', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          maxAudioDurationSecs: null,
          producesPunctuation: false,
          supportedLanguages: { kind: 'english_only' },
          supportsInitialPrompt: false,
          supportsLanguageSelection: false,
          supportsSegmentTimestamps: false,
          supportsWordTimestamps: false,
        },
      }),
    );

    expect(labels).not.toContain('Segment timestamps');
    expect(labels).not.toContain('Initial prompt');
    expect(labels).not.toContain('Punctuation');
  });

  it('emits a rounded max-audio label when the family advertises one', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          ...sampleCapabilities().family,
          maxAudioDurationSecs: 30.4,
        },
      }),
    );

    expect(labels).toContain('Max audio: 30s');
  });

  it('describes the language list size when kind is "list"', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          ...sampleCapabilities().family,
          supportedLanguages: { kind: 'list', tags: ['en', 'es', 'fr'] },
          supportsLanguageSelection: true,
        },
      }),
    );

    expect(labels).toContain('3 languages');
  });

  it('describes any-language support', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          ...sampleCapabilities().family,
          supportedLanguages: { kind: 'all' },
          supportsLanguageSelection: true,
        },
      }),
    );

    expect(labels).toContain('Any language');
  });

  it('emits "Language selection" when kind is unknown but selection is supported', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          ...sampleCapabilities().family,
          supportedLanguages: { kind: 'unknown' },
          supportsLanguageSelection: true,
        },
      }),
    );

    expect(labels).toContain('Language selection');
  });

  it('omits the language label when kind is unknown and selection is not supported', () => {
    const labels = buildCapabilityLabels(
      sampleCapabilities({
        family: {
          ...sampleCapabilities().family,
          supportedLanguages: { kind: 'unknown' },
          supportsLanguageSelection: false,
        },
      }),
    );

    expect(labels.some((l) => l.toLowerCase().includes('language'))).toBe(false);
  });
});
