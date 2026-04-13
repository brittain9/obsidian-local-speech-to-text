import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        accelerationPreference: 'cpu_only',
        cudaLibraryPath: ' /run/host/usr/lib64 ',
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
      accelerationPreference: 'cpu_only',
      cudaLibraryPath: '/run/host/usr/lib64',
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

  it('ignores legacy useGpu false and defaults to auto', () => {
    expect(resolvePluginSettings({ useGpu: false }).accelerationPreference).toBe('auto');
  });

  it('ignores legacy useGpu true and defaults to auto', () => {
    expect(resolvePluginSettings({ useGpu: true }).accelerationPreference).toBe('auto');
  });

  it('falls back accelerationPreference to auto when persisted value is invalid', () => {
    expect(resolvePluginSettings({ accelerationPreference: 'gpu' }).accelerationPreference).toBe(
      'auto',
    );
  });
});
