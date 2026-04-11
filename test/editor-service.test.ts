import type { App, EditorPosition } from 'obsidian';
import { describe, expect, it } from 'vitest';

import { EditorService } from '../src/editor/editor-service';

class FakeEditor {
  public cursor: EditorPosition = { ch: 0, line: 0 };

  constructor(
    private text: string,
    private selectionFrom: EditorPosition = { ch: 0, line: 0 },
    private selectionTo: EditorPosition = selectionFrom,
  ) {}

  getLine(line: number): string {
    return this.text.split('\n')[line] ?? '';
  }

  getText(): string {
    return this.text;
  }

  getValue(): string {
    return this.text;
  }

  lastLine(): number {
    return this.text.split('\n').length - 1;
  }

  replaceRange(text: string, from: EditorPosition, to: EditorPosition = from): void {
    this.applyReplacement(text, from, to);
  }

  replaceSelection(text: string): void {
    this.applyReplacement(text, this.selectionFrom, this.selectionTo);
  }

  setCursor(pos: EditorPosition | number, ch?: number): void {
    this.cursor =
      typeof pos === 'number'
        ? {
            ch: ch ?? 0,
            line: pos,
          }
        : {
            ch: pos.ch,
            line: pos.line,
          };
  }

  private applyReplacement(text: string, from: EditorPosition, to: EditorPosition): void {
    const before = this.text.slice(0, this.positionToOffset(from));
    const after = this.text.slice(this.positionToOffset(to));

    this.text = `${before}${text}${after}`;
    this.selectionFrom = this.selectionTo = offsetToPosition(
      before.length + text.length,
      this.text,
    );
    this.cursor = this.selectionTo;
  }

  private positionToOffset(position: EditorPosition): number {
    const lines = this.text.split('\n');
    let offset = 0;

    for (let lineIndex = 0; lineIndex < position.line; lineIndex += 1) {
      offset += (lines[lineIndex] ?? '').length + 1;
    }

    return offset + position.ch;
  }
}

describe('EditorService', () => {
  it('replaces the active selection in cursor mode', () => {
    const editor = new FakeEditor('hello world', { ch: 6, line: 0 }, { ch: 11, line: 0 });
    const service = createEditorService(editor);

    service.insertTranscript('obsidian', 'insert_at_cursor');

    expect(editor.getText()).toBe('hello obsidian');
  });

  it('appends on a new line at the note end and ignores the current selection', () => {
    const editor = new FakeEditor('line 1', { ch: 0, line: 0 }, { ch: 4, line: 0 });
    const service = createEditorService(editor);

    service.insertTranscript('line 2', 'append_on_new_line');

    expect(editor.getText()).toBe('line 1\nline 2');
  });

  it('moves the caret to the end of appended text', () => {
    const editor = new FakeEditor('line 1');
    const service = createEditorService(editor);

    service.insertTranscript('line 2', 'append_as_new_paragraph');

    expect(editor.getText()).toBe('line 1\n\nline 2');
    expect(editor.cursor).toEqual({ ch: 6, line: 2 });
  });

  it('uses exactly one separator across consecutive append-on-new-line inserts', () => {
    const editor = new FakeEditor('');
    const service = createEditorService(editor);

    service.insertTranscript('first', 'append_on_new_line');
    service.insertTranscript('second', 'append_on_new_line');

    expect(editor.getText()).toBe('first\nsecond');
  });

  it('uses exactly one blank line across consecutive append-as-new-paragraph inserts', () => {
    const editor = new FakeEditor('');
    const service = createEditorService(editor);

    service.insertTranscript('first', 'append_as_new_paragraph');
    service.insertTranscript('second', 'append_as_new_paragraph');

    expect(editor.getText()).toBe('first\n\nsecond');
  });
});

function createEditorService(editor: FakeEditor): EditorService {
  return new EditorService({
    workspace: {
      activeEditor: {
        editor,
      },
    },
  } as unknown as App);
}

function offsetToPosition(offset: number, text: string): EditorPosition {
  const lines = text.split('\n');
  let remainingOffset = offset;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const currentLineLength = lines[lineIndex]?.length ?? 0;

    if (remainingOffset <= currentLineLength) {
      return {
        ch: remainingOffset,
        line: lineIndex,
      };
    }

    remainingOffset -= currentLineLength + 1;
  }

  return {
    ch: 0,
    line: lines.length - 1,
  };
}
