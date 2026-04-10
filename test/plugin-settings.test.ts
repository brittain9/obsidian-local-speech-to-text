import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        sidecarPathOverride: '/tmp/sidecar',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
      }),
    ).toEqual({
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
    });
  });

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
      }),
    ).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });
});
