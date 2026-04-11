import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        insertionMode: 'insert_at_cursor',
        listeningMode: 'press_and_hold',
        modelFilePath: ' /tmp/models/ggml-large-v3-turbo.bin ',
        pauseWhileProcessing: false,
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
      }),
    ).toEqual({
      insertionMode: 'insert_at_cursor',
      listeningMode: 'press_and_hold',
      modelFilePath: '/tmp/models/ggml-large-v3-turbo.bin',
      pauseWhileProcessing: false,
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
    });
  });

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        insertionMode: 'append_to_end',
        listeningMode: 'unsupported',
        modelFilePath: 42,
        pauseWhileProcessing: 'sometimes',
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
      }),
    ).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('uses the new one-sentence default mode with pause-while-processing enabled', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.listeningMode).toBe('one_sentence');
    expect(DEFAULT_PLUGIN_SETTINGS.pauseWhileProcessing).toBe(true);
  });
});
