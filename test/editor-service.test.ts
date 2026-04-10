import { describe, expect, it } from 'vitest';

import { insertSelectionText } from '../src/editor/insert-selection-text';

class FakeEditor {
  public insertedText = '';

  replaceSelection(text: string): void {
    this.insertedText += text;
  }
}

describe('insertSelectionText', () => {
  it('writes text through the editor interface', () => {
    const editor = new FakeEditor();

    insertSelectionText(editor, 'hello world');

    expect(editor.insertedText).toBe('hello world');
  });
});
