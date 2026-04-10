import type { App } from 'obsidian';
import { MarkdownView } from 'obsidian';

import { type EditorWriter, insertSelectionText } from './insert-selection-text';

export class EditorService {
  constructor(private readonly app: App) {}

  assertActiveEditorAvailable(): void {
    this.getActiveEditor();
  }

  insertTextAtCursor(text: string): void {
    insertSelectionText(this.getActiveEditor(), text);
  }

  private getActiveEditor(): EditorWriter {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeView === null) {
      throw new Error('No active Markdown editor is available.');
    }

    return activeView.editor;
  }
}
