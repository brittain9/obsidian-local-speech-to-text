import { join } from 'node:path';

import { assertAbsoluteExistingFilePath, getExistingPathKind } from '../filesystem/path-validation';
import type { AccelerationPreference } from './protocol';

export type SidecarVariant = 'cpu' | 'cuda';

export type SidecarResolutionSource = 'override' | 'installed' | 'dev';

export interface InstalledSidecarPath {
  path: string;
  variant: SidecarVariant;
}

export interface ResolvedSidecarExecutable {
  path: string;
  source: SidecarResolutionSource;
  variant: SidecarVariant | null;
}

interface ResolveInstalledSidecarExecutablePathOptions {
  accelerationPreference: AccelerationPreference;
  executableName: string;
  pluginDirectory: string;
  supportsCuda: boolean;
}

export interface ResolveSidecarExecutablePathOptions {
  accelerationPreference: AccelerationPreference;
  executableName: string;
  pluginDirectory: string;
  sidecarPathOverride: string;
  sidecarProjectDirectory: string;
  supportsCuda: boolean;
}

export function getInstalledSidecarExecutablePath(
  pluginDirectory: string,
  variant: SidecarVariant,
  executableName: string,
): string {
  return join(pluginDirectory, 'bin', variant, executableName);
}

export function getDevSidecarExecutablePath(
  sidecarProjectDirectory: string,
  variant: SidecarVariant,
  executableName: string,
): string {
  return variant === 'cuda'
    ? join(sidecarProjectDirectory, 'target-cuda', 'debug', executableName)
    : join(sidecarProjectDirectory, 'target', 'debug', executableName);
}

export async function resolveInstalledSidecarExecutablePath(
  options: ResolveInstalledSidecarExecutablePathOptions,
): Promise<InstalledSidecarPath | null> {
  const cpuPath = getInstalledSidecarExecutablePath(
    options.pluginDirectory,
    'cpu',
    options.executableName,
  );
  const cudaPath = getInstalledSidecarExecutablePath(
    options.pluginDirectory,
    'cuda',
    options.executableName,
  );
  const [hasCpu, hasCuda] = await Promise.all([
    hasExistingFile(cpuPath),
    hasExistingFile(cudaPath),
  ]);
  const variant = pickSidecarVariant(options.accelerationPreference, {
    hasCpu,
    hasCuda,
    supportsCuda: options.supportsCuda,
  });

  if (variant === null) {
    return null;
  }

  return {
    path: variant === 'cuda' ? cudaPath : cpuPath,
    variant,
  };
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

  const installedExecutable = await resolveInstalledSidecarExecutablePath({
    accelerationPreference: options.accelerationPreference,
    executableName: options.executableName,
    pluginDirectory: options.pluginDirectory,
    supportsCuda: options.supportsCuda,
  });

  if (installedExecutable !== null) {
    return {
      path: installedExecutable.path,
      source: 'installed',
      variant: installedExecutable.variant,
    };
  }

  const cpuDevPath = getDevSidecarExecutablePath(
    options.sidecarProjectDirectory,
    'cpu',
    options.executableName,
  );
  const cudaDevPath = options.supportsCuda
    ? getDevSidecarExecutablePath(options.sidecarProjectDirectory, 'cuda', options.executableName)
    : null;
  const [cpuDevKind, cudaDevKind] = await Promise.all([
    getExistingPathKind(cpuDevPath),
    cudaDevPath !== null ? getExistingPathKind(cudaDevPath) : Promise.resolve('missing' as const),
  ]);
  const devVariant = pickSidecarVariant(options.accelerationPreference, {
    hasCpu: cpuDevKind === 'file',
    hasCuda: cudaDevKind === 'file',
    supportsCuda: options.supportsCuda,
  });

  if (devVariant === 'cuda' && cudaDevPath !== null) {
    return { path: cudaDevPath, source: 'dev', variant: 'cuda' };
  }

  if (devVariant === 'cpu') {
    if (cpuDevKind !== 'file') {
      throw new Error(`Sidecar executable path must point to a file: ${cpuDevPath}`);
    }

    return { path: cpuDevPath, source: 'dev', variant: 'cpu' };
  }

  const installedCpuPath = getInstalledSidecarExecutablePath(
    options.pluginDirectory,
    'cpu',
    options.executableName,
  );
  const searchedDevPaths = cudaDevPath !== null ? [cudaDevPath, cpuDevPath] : [cpuDevPath];

  throw new Error(
    `Sidecar executable was not found in ${installedCpuPath} or ${searchedDevPaths.join(', ')}. Install the sidecar, build native first, or configure Sidecar path override.`,
  );
}

export function pickSidecarVariant(
  accelerationPreference: AccelerationPreference,
  options: {
    hasCpu: boolean;
    hasCuda: boolean;
    supportsCuda: boolean;
  },
): SidecarVariant | null {
  if (accelerationPreference === 'cpu_only') {
    return options.hasCpu ? 'cpu' : null;
  }

  if (options.supportsCuda && options.hasCuda) {
    return 'cuda';
  }

  if (options.hasCpu) {
    return 'cpu';
  }

  return null;
}

async function hasExistingFile(path: string): Promise<boolean> {
  return (await getExistingPathKind(path)) === 'file';
}
