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
        modelFilePath: ' /tmp/models/ggml-large-v3-turbo.bin ',
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
        tempAudioDirectoryOverride: ' /tmp/local-stt-audio ',
      }),
    ).toEqual({
      insertionMode: 'insert_at_cursor',
      modelFilePath: '/tmp/models/ggml-large-v3-turbo.bin',
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
      tempAudioDirectoryOverride: '/tmp/local-stt-audio',
    });
  });

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        insertionMode: 'append_to_end',
        modelFilePath: 42,
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
        tempAudioDirectoryOverride: false,
      }),
    ).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('uses the new CPU-realistic request timeout by default', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.sidecarRequestTimeoutMs).toBe(300_000);
  });
});
