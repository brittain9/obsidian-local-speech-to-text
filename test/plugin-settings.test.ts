import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        insertionMode: 'append_as_new_paragraph',
        listeningMode: 'press_and_hold',
        modelStorePathOverride: ' /tmp/models ',
        pauseWhileProcessing: false,
        selectedModel: {
          engineId: 'whisper_cpp',
          kind: 'catalog_model',
          modelId: 'whisper_large_v3_turbo_q8_0',
        },
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
      }),
    ).toEqual({
      developerMode: false,
      insertionMode: 'append_as_new_paragraph',
      listeningMode: 'press_and_hold',
      modelStorePathOverride: '/tmp/models',
      pauseWhileProcessing: false,
      selectedModel: {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
      },
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
      useGpu: false,
    });
  });

  it.each(['insert_at_cursor', 'append_on_new_line', 'append_as_new_paragraph'] as const)(
    'accepts the supported insertion mode %s',
    (insertionMode) => {
      expect(resolvePluginSettings({ insertionMode }).insertionMode).toBe(insertionMode);
    },
  );

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        insertionMode: 'append_to_end',
        listeningMode: 'unsupported',
        modelStorePathOverride: 42,
        pauseWhileProcessing: 'sometimes',
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
      }),
    ).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('defaults useGpu to false', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.useGpu).toBe(false);
    expect(resolvePluginSettings({}).useGpu).toBe(false);
  });

  it('persists useGpu false when explicitly set', () => {
    expect(resolvePluginSettings({ useGpu: false }).useGpu).toBe(false);
  });

  it('falls back useGpu to default when persisted value is not a boolean', () => {
    expect(resolvePluginSettings({ useGpu: 'yes' }).useGpu).toBe(false);
  });

  it('uses the new one-sentence default mode with pause-while-processing enabled', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.listeningMode).toBe('one_sentence');
    expect(DEFAULT_PLUGIN_SETTINGS.pauseWhileProcessing).toBe(true);
  });
});
