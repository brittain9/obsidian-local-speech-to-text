import { describe, expect, it } from 'vitest';
import { type SelectedModel, selectedModelEquals } from '../src/models/model-management-types';

describe('selectedModelEquals', () => {
  it('matches identical catalog model selections', () => {
    const left: SelectedModel = {
      familyId: 'whisper',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
      runtimeId: 'whisper_cpp',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects catalog selections with different model IDs', () => {
    const left: SelectedModel = {
      familyId: 'whisper',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
      runtimeId: 'whisper_cpp',
    };
    const right: SelectedModel = {
      familyId: 'whisper',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
      runtimeId: 'whisper_cpp',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });

  it('rejects selections with different kinds', () => {
    const catalog: SelectedModel = {
      familyId: 'whisper',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
      runtimeId: 'whisper_cpp',
    };
    const external: SelectedModel = {
      familyId: 'whisper',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    };

    expect(selectedModelEquals(catalog, external)).toBe(false);
  });

  it('matches identical external file selections', () => {
    const left: SelectedModel = {
      familyId: 'whisper',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects external file selections with different runtimes', () => {
    const left: SelectedModel = {
      familyId: 'whisper',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    };
    const right: SelectedModel = {
      familyId: 'cohere_transcribe',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
      runtimeId: 'onnx_runtime',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });
});
