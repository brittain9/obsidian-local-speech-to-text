import { formatAcceleratorLabel } from '../settings/acceleration-info';
import type { CompiledAdapterInfo, CompiledRuntimeInfo } from '../sidecar/protocol';
import type {
  EngineCapabilitiesRecord,
  ModelFamilyCapabilitiesRecord,
  ModelFamilyId,
  ModelFormat,
  RuntimeId,
} from './model-management-types';

const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  ggml: 'GGML',
  gguf: 'GGUF',
  onnx: 'ONNX',
};

export function resolveEngineCapabilities(
  compiledRuntimes: readonly CompiledRuntimeInfo[],
  compiledAdapters: readonly CompiledAdapterInfo[],
  runtimeId: RuntimeId,
  familyId: ModelFamilyId,
): EngineCapabilitiesRecord | null {
  const runtime = compiledRuntimes.find((r) => r.runtimeId === runtimeId);
  const adapter = compiledAdapters.find(
    (a) => a.runtimeId === runtimeId && a.familyId === familyId,
  );
  if (runtime === undefined || adapter === undefined) return null;
  return {
    family: adapter.familyCapabilities,
    familyId,
    runtime: runtime.runtimeCapabilities,
    runtimeId,
  };
}

export function buildCapabilityLabels(caps: EngineCapabilitiesRecord): string[] {
  const labels: string[] = [];

  const accelerators =
    caps.runtime.availableAccelerators.length > 0
      ? caps.runtime.availableAccelerators
      : (['cpu'] as const);
  for (const id of accelerators) {
    labels.push(formatAcceleratorLabel(id));
  }

  for (const format of caps.runtime.supportedModelFormats) {
    labels.push(MODEL_FORMAT_LABELS[format]);
  }

  if (caps.family.supportsSegmentTimestamps) labels.push('Segment timestamps');
  if (caps.family.supportsWordTimestamps) labels.push('Word timestamps');
  if (caps.family.supportsInitialPrompt) labels.push('Initial prompt');
  if (caps.family.producesPunctuation) labels.push('Punctuation');

  const languageLabel = describeLanguageSupport(caps.family);
  if (languageLabel !== null) labels.push(languageLabel);

  if (caps.family.maxAudioDurationSecs !== null) {
    labels.push(`Max audio: ${Math.round(caps.family.maxAudioDurationSecs)}s`);
  }

  return labels;
}

function describeLanguageSupport(family: ModelFamilyCapabilitiesRecord): string | null {
  switch (family.supportedLanguages.kind) {
    case 'all':
      return 'Any language';
    case 'english_only':
      return 'English only';
    case 'list':
      return `${family.supportedLanguages.tags.length} languages`;
    case 'unknown':
      return family.supportsLanguageSelection ? 'Language selection' : null;
  }
}
