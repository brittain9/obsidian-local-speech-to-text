import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LLM_TRANSFORM_PROMPT,
  DEFAULT_PLUGIN_SETTINGS,
  resolvePluginSettings,
} from '../src/settings/plugin-settings';

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
        llmTransformDeveloperMode: true,
        llmTransformEnabled: true,
        llmTransformModel: ' llama3.2:latest ',
        llmTransformPrompt: '  Keep this exact prompt whitespace.  ',
        modelStorePathOverride: ' /tmp/models ',
        selectedModel: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'whisper_large_v3_turbo_q8_0',
          runtimeId: 'whisper_cpp',
        },
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutMs: 12_000,
        sidecarStartupTimeoutMs: 6_000,
        showTimestamps: true,
        speakingStyle: 'patient',
        transcriptFormatting: 'new_paragraph',
        useNoteAsContext: false,
      }),
    ).toEqual({
      accelerationPreference: 'cpu_only',
      cudaLibraryPath: '/run/host/usr/lib64',
      developerMode: false,
      dictationAnchor: 'end_of_note',
      listeningMode: 'always_on',
      llmTransformDeveloperMode: true,
      llmTransformEnabled: true,
      llmTransformModel: 'llama3.2:latest',
      llmTransformPrompt: '  Keep this exact prompt whitespace.  ',
      modelStorePathOverride: '/tmp/models',
      selectedModel: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutMs: 12_000,
      sidecarStartupTimeoutMs: 6_000,
      showTimestamps: true,
      speakingStyle: 'patient',
      transcriptFormatting: 'new_paragraph',
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
    'smart',
    'space',
    'new_line',
    'new_paragraph',
  ] as const)('accepts the supported transcript formatting mode %s', (transcriptFormatting) => {
    expect(resolvePluginSettings({ transcriptFormatting }).transcriptFormatting).toBe(
      transcriptFormatting,
    );
  });

  it('silently drops legacy formatting fields without migrating them', () => {
    const resolved = resolvePluginSettings({
      insertionMode: 'append_as_new_paragraph',
      phraseSeparator: 'new_paragraph',
    });

    expect(resolved.dictationAnchor).toBe(DEFAULT_PLUGIN_SETTINGS.dictationAnchor);
    expect(resolved.transcriptFormatting).toBe(DEFAULT_PLUGIN_SETTINGS.transcriptFormatting);
    expect(resolved).not.toHaveProperty('insertionMode');
    expect(resolved).not.toHaveProperty('phraseSeparator');
  });

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        dictationAnchor: 'at_end',
        listeningMode: 'unsupported',
        llmTransformDeveloperMode: 'yes',
        llmTransformEnabled: 'yes',
        llmTransformModel: 123,
        llmTransformPrompt: false,
        modelStorePathOverride: 42,
        sidecarPathOverride: 12,
        sidecarRequestTimeoutMs: -1,
        sidecarStartupTimeoutMs: 'fast',
        showTimestamps: 'yes',
        transcriptFormatting: 'tab',
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

  it('uses one default prompt constant for persisted fallback', () => {
    expect(resolvePluginSettings({ llmTransformPrompt: null }).llmTransformPrompt).toBe(
      DEFAULT_LLM_TRANSFORM_PROMPT,
    );
  });
});
