export interface EditorWriter {
  replaceSelection(text: string): void;
}

export function insertSelectionText(editor: EditorWriter, text: string): void {
  editor.replaceSelection(text);
}
