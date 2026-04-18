import type { ModelManagerState } from './model-install-manager';
import type {
  EngineCapabilitiesRecord,
  ModelFamilyCapabilitiesRecord,
  ModelFamilyId,
  RuntimeId,
  SelectedModelCapabilities,
} from './model-management-types';

export interface CapabilityRow {
  label: string;
  value: string;
}

export type CapabilityView =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'unavailable'; message: string }
  | { status: 'ready'; rows: CapabilityRow[] };

export function buildCapabilityView(state: ModelManagerState): CapabilityView {
  const caps = state.selectedModelCapabilities;

  switch (caps.status) {
    case 'none':
      return { status: 'none' };
    case 'pending':
      return { status: 'pending' };
    case 'unavailable':
      return { message: describeUnavailableReason(caps), status: 'unavailable' };
    case 'ready':
      return { rows: buildReadyCapabilityRows(state, caps.capabilities), status: 'ready' };
  }
}

function describeUnavailableReason(
  caps: Extract<SelectedModelCapabilities, { status: 'unavailable' }>,
): string {
  switch (caps.reason) {
    case 'invalid':
      return caps.details ?? 'Selected model file is invalid.';
    case 'missing':
      return caps.details ?? 'Selected model is not installed.';
    case 'probe_failed':
      return 'Capability detection failed.';
  }
}

function buildReadyCapabilityRows(
  state: ModelManagerState,
  capabilities: EngineCapabilitiesRecord,
): CapabilityRow[] {
  const rows: CapabilityRow[] = [
    { label: 'Runtime', value: resolveRuntimeDisplayName(state, capabilities.runtimeId) },
    {
      label: 'Model family',
      value: resolveFamilyDisplayName(state, capabilities.runtimeId, capabilities.familyId),
    },
    {
      label: 'Accelerators',
      value:
        capabilities.runtime.availableAccelerators.length > 0
          ? capabilities.runtime.availableAccelerators.join(', ')
          : 'CPU only',
    },
    { label: 'Model formats', value: capabilities.runtime.supportedModelFormats.join(', ') },
    { label: 'Timed segments', value: yesNo(capabilities.family.supportsTimedSegments) },
    { label: 'Initial prompt', value: yesNo(capabilities.family.supportsInitialPrompt) },
    { label: 'Language support', value: describeLanguageSupport(capabilities.family) },
    { label: 'Punctuation', value: yesNo(capabilities.family.producesPunctuation) },
  ];

  if (capabilities.family.maxAudioDurationSecs !== null) {
    rows.push({
      label: 'Max audio duration',
      value: `${Math.round(capabilities.family.maxAudioDurationSecs)} s`,
    });
  }

  return rows;
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function describeLanguageSupport(family: ModelFamilyCapabilitiesRecord): string {
  switch (family.supportedLanguages.kind) {
    case 'all':
      return 'Any language';
    case 'english_only':
      return 'English only';
    case 'list':
      return `${family.supportedLanguages.tags.length} languages`;
    case 'unknown':
      return family.supportsLanguageSelection
        ? 'Selectable (language list unknown)'
        : 'Single language (no selection)';
  }
}

function resolveRuntimeDisplayName(state: ModelManagerState, runtimeId: RuntimeId): string {
  return state.compiledRuntimes.find((r) => r.runtimeId === runtimeId)?.displayName ?? runtimeId;
}

function resolveFamilyDisplayName(
  state: ModelManagerState,
  runtimeId: RuntimeId,
  familyId: ModelFamilyId,
): string {
  return (
    state.compiledAdapters.find((a) => a.runtimeId === runtimeId && a.familyId === familyId)
      ?.displayName ?? familyId
  );
}
