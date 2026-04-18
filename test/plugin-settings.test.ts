import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLUGIN_SETTINGS,
  resolvePluginSettings,
  SETTINGS_SCHEMA_VERSION,
} from '../src/settings/plugin-settings';

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('stamps the current schema version on fresh settings', () => {
    expect(resolvePluginSettings(undefined).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        accelerationPreference: 'cpu_only',
        cudaLibraryPath: ' /run/host/usr/lib64 ',
        insertionMode: 'append_as_new_paragraph',
        listeningMode: 'always_on',
        modelStorePathOverride: ' /tmp/models ',
        pauseWhileProcessing: false,
        schemaVersion: 2,
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
      }),
    ).toEqual({
      accelerationPreference: 'cpu_only',
      cudaLibraryPath: '/run/host/usr/lib64',
      developerMode: false,
      insertionMode: 'append_as_new_paragraph',
      listeningMode: 'always_on',
      modelStorePathOverride: '/tmp/models',
      pauseWhileProcessing: false,
      schemaVersion: 2,
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
    });
  });

  it.each([
    'insert_at_cursor',
    'append_on_new_line',
    'append_as_new_paragraph',
  ] as const)('accepts the supported insertion mode %s', (insertionMode) => {
    expect(resolvePluginSettings({ insertionMode }).insertionMode).toBe(insertionMode);
  });

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

  it('migrates a legacy whisper_cpp catalog selection into runtime+family', () => {
    const resolved = resolvePluginSettings({
      selectedModel: {
        engineId: 'whisper_cpp',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
      },
    });

    expect(resolved.selectedModel).toEqual({
      familyId: 'whisper',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
      runtimeId: 'whisper_cpp',
    });
  });

  it('migrates a legacy cohere_onnx catalog selection into onnx_runtime + cohere_transcribe', () => {
    const resolved = resolvePluginSettings({
      selectedModel: {
        engineId: 'cohere_onnx',
        kind: 'catalog_model',
        modelId: 'cohere_transcribe_v1',
      },
    });

    expect(resolved.selectedModel).toEqual({
      familyId: 'cohere_transcribe',
      kind: 'catalog_model',
      modelId: 'cohere_transcribe_v1',
      runtimeId: 'onnx_runtime',
    });
  });

  it('migrates a legacy external_file selection', () => {
    const resolved = resolvePluginSettings({
      selectedModel: {
        engineId: 'whisper_cpp',
        filePath: '/tmp/custom-model.bin',
        kind: 'external_file',
      },
    });

    expect(resolved.selectedModel).toEqual({
      familyId: 'whisper',
      filePath: '/tmp/custom-model.bin',
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    });
  });

  it('resets an unknown legacy engineId to null', () => {
    const resolved = resolvePluginSettings({
      selectedModel: {
        engineId: 'deprecated_engine',
        kind: 'catalog_model',
        modelId: 'x',
      },
    });

    expect(resolved.selectedModel).toBeNull();
  });

  it('migrates a legacy schemaVersion forward to the current schema', () => {
    expect(resolvePluginSettings({ schemaVersion: 1 }).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('preserves a newer schemaVersion to avoid erasing a downgrade marker', () => {
    const futureVersion = SETTINGS_SCHEMA_VERSION + 1;
    expect(resolvePluginSettings({ schemaVersion: futureVersion }).schemaVersion).toBe(
      futureVersion,
    );
  });
});
