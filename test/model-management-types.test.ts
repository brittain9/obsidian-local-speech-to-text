import { describe, expect, it } from 'vitest';
import { type SelectedModel, selectedModelEquals } from '../src/models/model-management-types';

describe('selectedModelEquals', () => {
  it('matches identical catalog model selections', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects catalog selections with different model IDs', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const right: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_large_v3_turbo_q8_0',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });

  it('rejects selections with different kinds', () => {
    const catalog: SelectedModel = {
      engineId: 'whisper_cpp',
      kind: 'catalog_model',
      modelId: 'whisper_small_en_q5_1',
    };
    const external: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };

    expect(selectedModelEquals(catalog, external)).toBe(false);
  });

  it('matches identical external file selections', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };
    const right: SelectedModel = { ...left };

    expect(selectedModelEquals(left, right)).toBe(true);
  });

  it('rejects external file selections with different engine IDs', () => {
    const left: SelectedModel = {
      engineId: 'whisper_cpp',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };
    const right: SelectedModel = {
      engineId: 'cohere_onnx',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
    };

    expect(selectedModelEquals(left, right)).toBe(false);
  });
});
