import type { App } from 'obsidian';

import type { PluginLogger } from '../shared/plugin-logger';
import { SidecarInstallModal } from './sidecar-install-modal';

export interface FirstRunSetupOptions {
  logger?: PluginLogger | undefined;
  onInstalled: () => Promise<void>;
  pluginDirectory: string;
  version: string;
}

export function openFirstRunSetupModal(app: App, options: FirstRunSetupOptions): void {
  new SidecarInstallModal(app, {
    bodyText:
      'Local Transcript needs a one-time download of the CPU speech-to-text sidecar. Transcription stays local on your machine after this completes.',
    logger: options.logger,
    onInstalled: options.onInstalled,
    pluginDirectory: options.pluginDirectory,
    primaryButtonText: 'Download CPU sidecar',
    successNotice: 'Local Transcript sidecar installed and started.',
    title: 'Finish setting up Local Transcript',
    variant: 'cpu',
    version: options.version,
  }).open();
}
