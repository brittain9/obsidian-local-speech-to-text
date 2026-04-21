import { join } from 'node:path';

import { assertAbsoluteExistingFilePath, getExistingPathKind } from '../filesystem/path-validation';
import type { AccelerationPreference } from './protocol';

export class SidecarNotInstalledError extends Error {
  override readonly name = 'SidecarNotInstalledError';
}

export type SidecarVariant = 'cpu' | 'cuda';

export type SidecarResolutionSource = 'override' | 'installed' | 'dev';

export interface ResolvedSidecarExecutable {
  path: string;
  source: SidecarResolutionSource;
  variant: SidecarVariant | null;
}

export interface ResolveSidecarExecutablePathOptions {
  accelerationPreference: AccelerationPreference;
  executableName: string;
  pluginDirectory: string;
  sidecarPathOverride: string;
  sidecarProjectDirectory: string;
  supportsCuda: boolean;
}

export async function resolveSidecarExecutablePath(
  options: ResolveSidecarExecutablePathOptions,
): Promise<ResolvedSidecarExecutable> {
  const overridePath = options.sidecarPathOverride.trim();

  if (overridePath.length > 0) {
    const resolvedOverride = await assertAbsoluteExistingFilePath(
      overridePath,
      'Sidecar path override',
    );
    return { path: resolvedOverride, source: 'override', variant: null };
  }

  const installedCpuPath = join(options.pluginDirectory, 'bin', 'cpu', options.executableName);
  const installedCudaPath = join(options.pluginDirectory, 'bin', 'cuda', options.executableName);

  const installed = await pickExistingVariant({
    accelerationPreference: options.accelerationPreference,
    supportsCuda: options.supportsCuda,
    cpuPath: installedCpuPath,
    cudaPath: installedCudaPath,
  });

  if (installed !== null) {
    return { path: installed.path, source: 'installed', variant: installed.variant };
  }

  const devCpuPath = join(
    options.sidecarProjectDirectory,
    'target',
    'debug',
    options.executableName,
  );
  const devCudaPath = options.supportsCuda
    ? join(options.sidecarProjectDirectory, 'target-cuda', 'debug', options.executableName)
    : null;

  const dev = await pickExistingVariant({
    accelerationPreference: options.accelerationPreference,
    supportsCuda: options.supportsCuda,
    cpuPath: devCpuPath,
    cudaPath: devCudaPath,
  });

  if (dev !== null) {
    return { path: dev.path, source: 'dev', variant: dev.variant };
  }

  const searchedDevPaths = devCudaPath !== null ? [devCudaPath, devCpuPath] : [devCpuPath];
  throw new SidecarNotInstalledError(
    `Sidecar executable was not found in ${installedCpuPath} or ${searchedDevPaths.join(', ')}. Install the sidecar, build native first, or configure Sidecar path override.`,
  );
}

interface PickExistingVariantOptions {
  accelerationPreference: AccelerationPreference;
  supportsCuda: boolean;
  cpuPath: string;
  cudaPath: string | null;
}

async function pickExistingVariant(
  options: PickExistingVariantOptions,
): Promise<{ path: string; variant: SidecarVariant } | null> {
  const [cpuKind, cudaKind] = await Promise.all([
    getExistingPathKind(options.cpuPath),
    options.cudaPath !== null
      ? getExistingPathKind(options.cudaPath)
      : Promise.resolve('missing' as const),
  ]);
  const hasCpu = cpuKind === 'file';
  const hasCuda = cudaKind === 'file';

  if (options.accelerationPreference === 'cpu_only') {
    return hasCpu ? { path: options.cpuPath, variant: 'cpu' } : null;
  }

  if (options.supportsCuda && hasCuda && options.cudaPath !== null) {
    return { path: options.cudaPath, variant: 'cuda' };
  }

  if (hasCpu) {
    return { path: options.cpuPath, variant: 'cpu' };
  }

  return null;
}
