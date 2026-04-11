import type { App, EditorPosition } from 'obsidian';

import type { InsertionMode } from '../settings/plugin-settings';
import {
  createDocumentEndPosition,
  resolveAppendTranscriptPlacement,
} from './transcript-placement';

interface TranscriptEditor {
  getLine(line: number): string;
  getValue(): string;
  lastLine(): number;
  replaceRange(text: string, from: EditorPosition, to?: EditorPosition): void;
  replaceSelection(text: string): void;
  setCursor(pos: EditorPosition | number, ch?: number): void;
}

export class EditorService {
  constructor(private readonly app: App) {}

  assertActiveEditorAvailable(): void {
    this.getActiveEditor();
  }

  insertTranscript(text: string, mode: InsertionMode): void {
    const editor = this.getActiveEditor();

    if (mode === 'insert_at_cursor') {
      editor.replaceSelection(text);
      return;
    }

    const lastLineNumber = editor.lastLine();
    const placement = resolveAppendTranscriptPlacement({
      documentEnd: createDocumentEndPosition(lastLineNumber, editor.getLine(lastLineNumber)),
      documentText: editor.getValue(),
      mode,
      transcript: text,
    });

    editor.replaceRange(placement.text, placement.range.from, placement.range.to);
    editor.setCursor(placement.cursor);
  }

  private getActiveEditor(): TranscriptEditor {
    const activeEditor = this.app.workspace.activeEditor?.editor;

    if (activeEditor === undefined) {
      throw new Error('No active Markdown editor is available.');
    }

    return activeEditor;
  }
}
