import type { AcceleratorId } from '../models/model-management-types';
import type {
  AccelerationPreference,
  CompiledRuntimeInfo,
  SystemInfoEvent,
} from '../sidecar/protocol';

export function formatAcceleratorLabel(accelerator: AcceleratorId): string {
  switch (accelerator) {
    case 'cpu':
      return 'CPU';
    case 'cuda':
      return 'CUDA';
    case 'direct_ml':
      return 'DirectML';
    case 'metal':
      return 'Metal';
  }
}

function formatAcceleratorReason(reason: string | null): string {
  if (reason === null) {
    return 'unknown reason';
  }
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : 'unknown reason';
}

export function buildAccelerationSummary(systemInfo: SystemInfoEvent | null): string {
  if (systemInfo === null) {
    return 'Sidecar capability data is unavailable until the sidecar starts successfully.';
  }

  const gpuRuntimes = systemInfo.compiledRuntimes.filter((runtime) =>
    runtime.runtimeCapabilities.availableAccelerators.some((id) => id !== 'cpu'),
  );

  if (gpuRuntimes.length === 0) {
    return 'This sidecar build is CPU-only.';
  }

  return 'GPU acceleration is available for the runtimes listed below.';
}

export function buildRuntimeAcceleratorLines(
  runtime: CompiledRuntimeInfo,
  accelerationPreference: AccelerationPreference,
): string {
  const { displayName, runtimeCapabilities } = runtime;

  if (accelerationPreference === 'cpu_only') {
    return `${displayName}: CPU (GPU disabled)`;
  }

  const gpuEntries = runtimeCapabilities.availableAccelerators.filter((id) => id !== 'cpu');

  if (gpuEntries.length === 0) {
    return `${displayName}: CPU`;
  }

  const parts = gpuEntries.map((acceleratorId) => {
    const details = runtimeCapabilities.acceleratorDetails[acceleratorId] ?? null;
    const label = formatAcceleratorLabel(acceleratorId);

    if (details === null) {
      return `${label} (status unknown)`;
    }

    if (details.available) {
      return `${label} (available)`;
    }

    return `${label} (unavailable: ${formatAcceleratorReason(details.unavailableReason)})`;
  });

  return `${displayName}: ${parts.join(', ')}`;
}

export function buildEffectiveBackendLines(
  systemInfo: SystemInfoEvent | null,
  accelerationPreference: AccelerationPreference,
): string[] {
  if (systemInfo === null) {
    return [];
  }

  return systemInfo.compiledRuntimes.map((runtime) =>
    buildRuntimeAcceleratorLines(runtime, accelerationPreference),
  );
}
