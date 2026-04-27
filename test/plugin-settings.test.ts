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
        dictationAnchor: 'end_of_note',
        listeningMode: 'always_on',
        modelStorePathOverride: ' /tmp/models ',
        pauseWhileProcessing: false,
        phraseSeparator: 'new_paragraph',
        selectedModel: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'whisper_large_v3_turbo_q8_0',
          runtimeId: 'whisper_cpp',
        },
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
        speakingStyle: 'patient',
        useNoteAsContext: false,
      }),
    ).toEqual({
      accelerationPreference: 'cpu_only',
      cudaLibraryPath: '/run/host/usr/lib64',
      developerMode: false,
      dictationAnchor: 'end_of_note',
      listeningMode: 'always_on',
      modelStorePathOverride: '/tmp/models',
      pauseWhileProcessing: false,
      phraseSeparator: 'new_paragraph',
      selectedModel: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
      speakingStyle: 'patient',
      useNoteAsContext: false,
    });
  });

  it.each([
    'at_cursor',
    'end_of_note',
  ] as const)('accepts the supported dictation anchor %s', (dictationAnchor) => {
    expect(resolvePluginSettings({ dictationAnchor }).dictationAnchor).toBe(dictationAnchor);
  });

  it.each([
    'space',
    'new_line',
    'new_paragraph',
  ] as const)('accepts the supported phrase separator %s', (phraseSeparator) => {
    expect(resolvePluginSettings({ phraseSeparator }).phraseSeparator).toBe(phraseSeparator);
  });

  it('silently drops the legacy insertionMode field without migrating it', () => {
    const resolved = resolvePluginSettings({ insertionMode: 'append_as_new_paragraph' });

    expect(resolved.dictationAnchor).toBe(DEFAULT_PLUGIN_SETTINGS.dictationAnchor);
    expect(resolved.phraseSeparator).toBe(DEFAULT_PLUGIN_SETTINGS.phraseSeparator);
    expect(resolved).not.toHaveProperty('insertionMode');
  });

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        dictationAnchor: 'at_end',
        listeningMode: 'unsupported',
        modelStorePathOverride: 42,
        pauseWhileProcessing: 'sometimes',
        phraseSeparator: 'tab',
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
        useNoteAsContext: 'yes',
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

  it.each([
    'responsive',
    'balanced',
    'patient',
  ] as const)('accepts the supported speaking style %s', (speakingStyle) => {
    expect(resolvePluginSettings({ speakingStyle }).speakingStyle).toBe(speakingStyle);
  });

  it('falls back speakingStyle to balanced when persisted value is invalid', () => {
    expect(resolvePluginSettings({ speakingStyle: 'loud' }).speakingStyle).toBe('balanced');
  });
});
