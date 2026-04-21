import type { App } from 'obsidian';
import { Modal, Notice } from 'obsidian';

import { formatBytes, formatErrorMessage } from '../shared/format-utils';
import type { PluginLogger } from '../shared/plugin-logger';
import {
  detectPlatformAssetForCurrentEnv,
  type InstallProgress,
  installSidecar,
  type SidecarInstallVariant,
} from '../sidecar/sidecar-installer';

export interface SidecarInstallModalOptions {
  bodyText: string;
  logger?: PluginLogger | undefined;
  onInstalled: () => Promise<void>;
  pluginDirectory: string;
  primaryButtonText: string;
  successNotice: string;
  title: string;
  variant: SidecarInstallVariant;
  version: string;
}

export class SidecarInstallModal extends Modal {
  private abortController: AbortController | null = null;
  private installInProgress = false;
  private progressLabelEl: HTMLDivElement | null = null;
  private progressBarEl: HTMLDivElement | null = null;
  private primaryButtonEl: HTMLButtonElement | null = null;
  private secondaryButtonEl: HTMLButtonElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  constructor(
    app: App,
    private readonly options: SidecarInstallModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('local-stt-sidecar-install');
    this.titleEl.setText(this.options.title);
    this.contentEl.empty();

    const asset = detectPlatformAssetForCurrentEnv(this.options.variant);

    this.contentEl.createEl('p', { text: this.options.bodyText });

    const details = this.contentEl.createEl('ul', { cls: 'local-stt-sidecar-install__details' });
    details.createEl('li', { text: `Archive: ${asset.assetName}` });
    details.createEl('li', { text: `Release: ${this.options.version}` });

    this.statusEl = this.contentEl.createDiv({ cls: 'local-stt-sidecar-install__status' });
    this.progressLabelEl = this.contentEl.createDiv({
      cls: 'local-stt-sidecar-install__progress-label',
    });
    const progressTrack = this.contentEl.createDiv({
      cls: 'local-stt-sidecar-install__progress',
    });
    this.progressBarEl = progressTrack.createDiv({
      cls: 'local-stt-sidecar-install__progress-bar',
    });
    this.progressBarEl.style.width = '0%';

    const buttons = this.contentEl.createDiv({ cls: 'local-stt-sidecar-install__buttons' });
    this.secondaryButtonEl = buttons.createEl('button', { text: 'Later' });
    this.primaryButtonEl = buttons.createEl('button', {
      cls: 'mod-cta',
      text: this.options.primaryButtonText,
    });

    this.secondaryButtonEl.addEventListener('click', () => {
      this.handleSecondaryClick();
    });
    this.primaryButtonEl.addEventListener('click', () => {
      void this.handlePrimaryClick();
    });
  }

  override onClose(): void {
    this.abortController?.abort();
    this.contentEl.empty();
  }

  private handleSecondaryClick(): void {
    if (this.installInProgress) {
      this.abortController?.abort();
      return;
    }

    this.close();
  }

  private async handlePrimaryClick(): Promise<void> {
    if (this.installInProgress) return;

    this.installInProgress = true;
    this.abortController = new AbortController();

    if (this.primaryButtonEl !== null) {
      this.primaryButtonEl.disabled = true;
      this.primaryButtonEl.setText('Downloading…');
    }

    if (this.secondaryButtonEl !== null) {
      this.secondaryButtonEl.setText('Cancel');
    }

    this.setStatus('Fetching release metadata…', 'info');

    try {
      await installSidecar({
        logger: this.options.logger,
        onProgress: (progress) => {
          this.updateProgress(progress);
        },
        pluginDirectory: this.options.pluginDirectory,
        signal: this.abortController.signal,
        variant: this.options.variant,
        version: this.options.version,
      });

      this.setStatus('Sidecar installed. Starting…', 'success');
      await this.options.onInstalled();
      new Notice(this.options.successNotice);
      this.close();
    } catch (error) {
      this.options.logger?.error('installer', 'sidecar install failed', error);
      this.setStatus(`Install failed: ${formatErrorMessage(error)}`, 'error');

      if (this.primaryButtonEl !== null) {
        this.primaryButtonEl.disabled = false;
        this.primaryButtonEl.setText('Retry download');
      }

      if (this.secondaryButtonEl !== null) {
        this.secondaryButtonEl.setText('Later');
      }
    } finally {
      this.installInProgress = false;
      this.abortController = null;
    }
  }

  private updateProgress(progress: InstallProgress): void {
    if (progress.phase === 'verify') {
      this.setStatus('Verifying checksum…', 'info');
      this.setProgressPercent(100);
      return;
    }

    if (progress.phase === 'extract') {
      this.setStatus('Extracting archive…', 'info');
      this.setProgressPercent(100);
      return;
    }

    const percent =
      progress.totalBytes !== null && progress.totalBytes > 0
        ? (progress.bytesDownloaded / progress.totalBytes) * 100
        : null;

    const label =
      progress.totalBytes !== null
        ? `${formatBytes(progress.bytesDownloaded)} of ${formatBytes(progress.totalBytes)}`
        : formatBytes(progress.bytesDownloaded);

    if (this.progressLabelEl !== null) {
      this.progressLabelEl.setText(label);
    }

    this.setProgressPercent(percent);
  }

  private setProgressPercent(percent: number | null): void {
    if (this.progressBarEl === null) return;

    if (percent === null) {
      this.progressBarEl.style.width = '100%';
      this.progressBarEl.classList.add('local-stt-sidecar-install__progress-bar--indeterminate');
      return;
    }

    this.progressBarEl.classList.remove('local-stt-sidecar-install__progress-bar--indeterminate');
    this.progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  private setStatus(message: string, tone: 'info' | 'success' | 'error'): void {
    if (this.statusEl === null) return;
    this.statusEl.setText(message);
    this.statusEl.removeClass('local-stt-sidecar-install__status--info');
    this.statusEl.removeClass('local-stt-sidecar-install__status--success');
    this.statusEl.removeClass('local-stt-sidecar-install__status--error');
    this.statusEl.addClass(`local-stt-sidecar-install__status--${tone}`);
  }
}
