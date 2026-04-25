import type { SidecarInstallVariant } from '../sidecar/sidecar-installer';

export type InstallIntent = 'first-run' | 'install' | 'reinstall';

export interface InstallCopy {
  bodyText: string;
  primaryButtonText: string;
  successNotice: string;
  title: string;
}

const CPU_FIRST_RUN: InstallCopy = {
  bodyText:
    'Local Transcript needs a one-time download of the CPU speech-to-text sidecar. Transcription stays local on your machine after this completes.',
  primaryButtonText: 'Download CPU sidecar',
  successNotice: 'Local Transcript sidecar installed and started.',
  title: 'Finish setting up Local Transcript',
};

const CPU_INSTALL: InstallCopy = {
  bodyText:
    'Download the CPU speech-to-text sidecar from GitHub releases. Transcription stays local on your machine after this completes.',
  primaryButtonText: 'Download CPU sidecar',
  successNotice: 'CPU sidecar installed and started.',
  title: 'Install CPU sidecar',
};

const CPU_REINSTALL: InstallCopy = {
  bodyText:
    'Re-download the CPU speech-to-text sidecar from GitHub releases. This replaces the current CPU install.',
  primaryButtonText: 'Redownload CPU sidecar',
  successNotice: 'CPU sidecar reinstalled and restarted.',
  title: 'Reinstall CPU sidecar',
};

const CUDA_INSTALL: InstallCopy = {
  bodyText:
    'Download the CUDA-accelerated sidecar for NVIDIA GPUs. This replaces the CPU sidecar while active. The CPU sidecar remains installed as a fallback.',
  primaryButtonText: 'Download CUDA sidecar',
  successNotice: 'CUDA sidecar installed and started.',
  title: 'Install CUDA acceleration',
};

export function getInstallCopy(variant: SidecarInstallVariant, intent: InstallIntent): InstallCopy {
  if (variant === 'cuda') {
    return CUDA_INSTALL;
  }

  if (intent === 'first-run') return CPU_FIRST_RUN;
  if (intent === 'reinstall') return CPU_REINSTALL;
  return CPU_INSTALL;
}
