import type {
  CatalogModelRecord,
  ModelCatalogRecord,
} from '../../src/models/model-management-types';

export function sampleCatalogModel(input: {
  displayName: string;
  modelId: string;
  sizeBytes: number;
}): CatalogModelRecord {
  return {
    artifacts: [
      {
        artifactId: 'transcription',
        downloadUrl: `https://example.com/${input.modelId}.bin`,
        filename: `${input.modelId}.bin`,
        required: true,
        role: 'transcription_model',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        sizeBytes: input.sizeBytes,
      },
    ],
    collectionId: 'english_cpu_first',
    displayName: input.displayName,
    familyId: 'whisper',
    languageTags: ['en'],
    licenseLabel: 'MIT',
    licenseUrl: 'https://example.com/license',
    modelCardUrl: null,
    modelId: input.modelId,
    notes: [],
    runtimeId: 'whisper_cpp',
    sourceUrl: 'https://example.com/source',
    summary: 'Test model',
    uxTags: [],
  };
}

export function sampleCatalog(): ModelCatalogRecord {
  return {
    catalogVersion: 1,
    collections: [
      {
        collectionId: 'english_cpu_first',
        displayName: 'English CPU First',
        summary: 'summary',
      },
    ],
    families: [
      {
        displayName: 'Whisper',
        familyId: 'whisper',
        runtimeId: 'whisper_cpp',
        summary: 'summary',
      },
    ],
    models: [
      sampleCatalogModel({
        displayName: 'Whisper Large V3 Turbo Q8_0',
        modelId: 'whisper_large_v3_turbo_q8_0',
        sizeBytes: 900,
      }),
      sampleCatalogModel({
        displayName: 'Whisper Small English Q5_1',
        modelId: 'whisper_small_en_q5_1',
        sizeBytes: 100,
      }),
    ],
  };
}
