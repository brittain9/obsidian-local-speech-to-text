import type { App } from 'obsidian';

import type { PluginLogger } from '../shared/plugin-logger';
import { getInstallCopy } from './sidecar-install-copy';
import { SidecarInstallModal } from './sidecar-install-modal';

export interface FirstRunSetupOptions {
  logger?: PluginLogger | undefined;
  onInstalled: () => Promise<void>;
  pluginDirectory: string;
  version: string;
}

export function openFirstRunSetupModal(app: App, options: FirstRunSetupOptions): void {
  new SidecarInstallModal(app, {
    copy: getInstallCopy('cpu', 'first-run'),
    logger: options.logger,
    onInstalled: options.onInstalled,
    pluginDirectory: options.pluginDirectory,
    variant: 'cpu',
    version: options.version,
  }).open();
}
