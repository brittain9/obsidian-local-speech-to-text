import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import { formatBytes, formatErrorMessage } from '../shared/format-utils';
import type { ModelInstallManager } from './model-install-manager';
import { type CatalogModelRecord, getTotalModelSize } from './model-management-types';

interface ExternalModelFileModalDependencies {
  manager: ModelInstallManager;
  onChanged: () => Promise<void>;
}

export class ExternalModelFileModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    private readonly currentPath: string,
    private readonly dependencies: ExternalModelFileModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('Use external file');
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: 'Validate an absolute model file path. External files bypass managed downloads and managed updates.',
    });

    new Setting(this.contentEl)
      .setName('Model file path')
      .setDesc('Enter an absolute whisper.cpp-compatible model file path.')
      .addText((text) => {
        text.setPlaceholder('/absolute/path/to/ggml-small.en-q5_1.bin');
        text.setValue(this.currentPath);
        this.inputEl = text.inputEl;
      });

    this.inputEl?.focus();

    new Setting(this.contentEl).addButton((button) => {
      button
        .setCta()
        .setButtonText('Validate and use')
        .onClick(async () => {
          const nextPath = this.inputEl?.value.trim() ?? '';

          try {
            await this.dependencies.manager.validateAndSelectExternalFile(nextPath);
            await this.dependencies.onChanged();
            new Notice('Local STT: External model file validated and selected.');
            this.close();
          } catch (error) {
            new Notice(`Local STT: ${formatErrorMessage(error)}`);
          }
        });
    });
  }
}

export class ModelDetailsModal extends Modal {
  constructor(
    app: App,
    private readonly model: CatalogModelRecord,
    private readonly installPath: string | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.model.displayName);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.model.summary });

    const dl = this.contentEl.createEl('dl', { cls: 'local-stt-details-grid' });

    const totalSize = getTotalModelSize(this.model);
    if (totalSize > 0) {
      dl.createEl('dt', { text: 'Total size' });
      dl.createEl('dd', { text: formatBytes(totalSize) });
    }

    dl.createEl('dt', { text: 'Source' });
    appendDetailsLink(dl.createEl('dd'), this.model.sourceUrl, this.model.sourceUrl, true);

    dl.createEl('dt', { text: 'License' });
    appendDetailsLink(dl.createEl('dd'), this.model.licenseLabel, this.model.licenseUrl);

    if (this.installPath !== null) {
      dl.createEl('dt', { text: 'Install path' });
      dl.createEl('dd', { text: this.installPath, cls: 'local-stt-mono' });
    }

    if (this.model.artifacts.length > 0) {
      const table = this.contentEl.createEl('table', { cls: 'local-stt-artifact-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: `Files (${this.model.artifacts.length})` });
      headerRow.createEl('th', { text: 'Size' });

      const tbody = table.createEl('tbody');
      for (const artifact of this.model.artifacts) {
        const tr = tbody.createEl('tr');
        tr.createEl('td', { text: artifact.filename, cls: 'local-stt-mono' });
        tr.createEl('td', { text: formatBytes(artifact.sizeBytes) });
      }
    }
  }
}

function appendDetailsLink(
  container: HTMLElement,
  label: string,
  href: string,
  monospace = false,
): void {
  const link = container.createEl('a', {
    href,
    text: label,
  });

  link.setAttr('target', '_blank');
  link.setAttr('rel', 'noopener noreferrer');
  if (monospace) {
    link.addClass('local-stt-mono');
  }
}
