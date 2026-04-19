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
import { computeFirstPhrasePrefix, computePhraseSeparators } from './transcript-placement';

interface EditorWithCm extends Editor {
  cm?: EditorView;
}

export class EditorService {
  private activeAnchor = false;
  private anchorPreference: DictationAnchor = 'at_cursor';
  private firstPhrase = true;
  private pendingTrailingContent = '';
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
    this.pinAnchorOn(view);
  }

  setAnchorMode(mode: DictationAnchorMode): void {
    if (!this.activeAnchor) {
      return;
    }
    const view = this.storedView;
    if (view === null || !this.isStoredViewActive()) {
      return;
    }
    if (view.state.field(dictationAnchorStateField).mode === mode) {
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
    const { prefix, trailing } = computePhraseSeparators({
      separator,
      isFirstPhrase: this.firstPhrase,
    });
    const insertedText = `${prefix}${text}${trailing}`;
    const newPos = oldPos + insertedText.length;

    view.dispatch({
      changes: { from: oldPos, insert: insertedText },
      effects: [setAnchorEffect.of(newPos), EditorView.scrollIntoView(newPos, { y: 'nearest' })],
    });

    this.pendingTrailingContent = trailing;
    this.firstPhrase = false;
  }

  endAnchor(): void {
    const view = this.storedView;
    this.activeAnchor = false;
    this.firstPhrase = true;
    this.storedView = null;

    if (view !== null && this.isViewAlive(view)) {
      this.trimPendingAndClear(view);
    }
    this.pendingTrailingContent = '';
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
      this.trimPendingAndClear(previousView);
    }

    if (newView === null) {
      this.storedView = null;
      this.pendingTrailingContent = '';
      return;
    }

    const fileName = this.app.workspace.activeEditor?.file?.basename ?? 'new note';
    new Notice(`Dictation anchor moved to "${fileName}"`);

    this.storedView = newView;
    this.firstPhrase = true;
    this.pinAnchorOn(newView);
  }

  private pinAnchorOn(view: EditorView): void {
    const originalPos = this.computePinPosition(view, this.anchorPreference);
    const charBeforeAnchor =
      originalPos > 0 ? view.state.doc.sliceString(originalPos - 1, originalPos) : null;
    const prefix = computeFirstPhrasePrefix({
      anchor: this.anchorPreference,
      charBeforeAnchor,
    });
    const pinPos = originalPos + prefix.length;

    view.dispatch({
      ...(prefix.length > 0 ? { changes: { from: originalPos, insert: prefix } } : {}),
      effects: [setAnchorEffect.of(pinPos)],
    });

    this.pendingTrailingContent = prefix;
  }

  private trimPendingAndClear(view: EditorView): void {
    const pending = this.pendingTrailingContent;
    if (pending.length > 0) {
      const anchorPos = view.state.field(dictationAnchorStateField).pos;
      if (anchorPos !== null && anchorPos === view.state.doc.length) {
        const start = anchorPos - pending.length;
        if (start >= 0 && view.state.doc.sliceString(start, anchorPos) === pending) {
          view.dispatch({
            changes: { from: start, to: anchorPos, insert: '' },
            effects: clearAnchorEffect.of(null),
          });
          return;
        }
      }
    }
    view.dispatch({ effects: clearAnchorEffect.of(null) });
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
