import { EditorView } from '@codemirror/view';
import type { App, Editor, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import type { DictationAnchor, PhraseSeparator } from '../settings/plugin-settings';
import {
  clearAnchorEffect,
  type DictationAnchorMode,
  dictationAnchorStateField,
  setAnchorEffect,
  setAnchorModeEffect,
} from './dictation-anchor-extension';
import { computePhrasePrefix } from './transcript-placement';

interface EditorWithCm extends Editor {
  cm?: EditorView;
}

export class EditorService {
  private activeAnchor = false;
  private anchorPreference: DictationAnchor = 'at_cursor';
  private firstPhrase = true;
  private storedView: EditorView | null = null;

  constructor(
    private readonly app: App,
    plugin: Plugin,
  ) {
    plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.handleActiveLeafChange();
      }),
    );
  }

  assertActiveEditorAvailable(): void {
    this.getActiveEditorView();
  }

  beginAnchor(anchor: DictationAnchor): void {
    this.anchorPreference = anchor;
    this.firstPhrase = true;
    this.activeAnchor = true;

    const view = this.getActiveEditorView();
    this.storedView = view;
    const pinPos = this.computePinPosition(view, anchor);

    view.dispatch({ effects: setAnchorEffect.of(pinPos) });
  }

  setAnchorMode(mode: DictationAnchorMode): void {
    if (!this.activeAnchor) {
      return;
    }
    const view = this.storedView;
    if (view === null || !this.isStoredViewActive()) {
      return;
    }
    view.dispatch({ effects: setAnchorModeEffect.of(mode) });
  }

  insertPhrase(text: string, separator: PhraseSeparator): void {
    if (!this.activeAnchor) {
      return;
    }
    const view = this.storedView;
    if (view === null || !this.isStoredViewActive()) {
      new Notice('Local STT: no active editor for dictation anchor; transcript dropped.');
      return;
    }

    const anchorState = view.state.field(dictationAnchorStateField);
    if (anchorState.pos === null) {
      return;
    }

    const oldPos = anchorState.pos;
    const doc = view.state.doc;
    const charBeforeAnchor = oldPos > 0 ? doc.sliceString(oldPos - 1, oldPos) : null;
    const prefix = computePhrasePrefix({
      anchor: this.anchorPreference,
      separator,
      isFirstPhrase: this.firstPhrase,
      charBeforeAnchor,
    });
    const insertedText = `${prefix}${text}`;
    const newPos = oldPos + insertedText.length;

    view.dispatch({
      changes: { from: oldPos, insert: insertedText },
      effects: [
        setAnchorModeEffect.of('hidden'),
        setAnchorEffect.of(newPos),
        EditorView.scrollIntoView(newPos, { y: 'nearest' }),
      ],
    });

    this.firstPhrase = false;
  }

  endAnchor(): void {
    const view = this.storedView;
    this.activeAnchor = false;
    this.firstPhrase = true;
    this.storedView = null;

    if (view !== null && this.isViewAlive(view)) {
      view.dispatch({ effects: clearAnchorEffect.of(null) });
    }
  }

  private handleActiveLeafChange(): void {
    if (!this.activeAnchor) {
      return;
    }

    const newView = this.getActiveEditorViewOrNull();
    if (newView === this.storedView) {
      return;
    }

    const previousView = this.storedView;
    if (previousView !== null && this.isViewAlive(previousView)) {
      previousView.dispatch({ effects: clearAnchorEffect.of(null) });
    }

    if (newView === null) {
      this.storedView = null;
      return;
    }

    const fileName = this.app.workspace.activeEditor?.file?.basename ?? 'new note';
    new Notice(`Dictation anchor moved to "${fileName}"`);

    this.storedView = newView;
    this.firstPhrase = true;
    const pinPos = this.computePinPosition(newView, this.anchorPreference);
    newView.dispatch({ effects: setAnchorEffect.of(pinPos) });
  }

  private isStoredViewActive(): boolean {
    return this.storedView !== null && this.getActiveEditorViewOrNull() === this.storedView;
  }

  private computePinPosition(view: EditorView, anchor: DictationAnchor): number {
    if (anchor === 'end_of_note') {
      return view.state.doc.length;
    }
    return view.state.selection.main.head;
  }

  private isViewAlive(view: EditorView): boolean {
    return view.dom?.isConnected === true;
  }

  private getActiveEditorView(): EditorView {
    const view = this.getActiveEditorViewOrNull();
    if (view === null) {
      throw new Error('No active Markdown editor is available.');
    }
    return view;
  }

  private getActiveEditorViewOrNull(): EditorView | null {
    const editor = this.app.workspace.activeEditor?.editor as EditorWithCm | undefined;
    return editor?.cm ?? null;
  }
}
