import {
  EditorSelection,
  EditorState,
  type Extension,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { NoteSurface } from '../src/editor/note-surface';
import type { DictationAnchor, PhraseSeparator } from '../src/settings/plugin-settings';

class FakeEditorView {
  public state: EditorState;

  constructor(doc: string, selectionHead: number, extensions: Extension = []) {
    this.state = EditorState.create({
      doc,
      extensions,
      selection: EditorSelection.cursor(selectionHead),
    });
  }

  dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state;
  }

  apply(spec: TransactionSpec): ViewUpdate {
    const transaction = this.state.update(spec);
    this.state = transaction.state;

    return {
      changes: transaction.changes,
      docChanged: transaction.docChanged,
      transactions: [transaction],
      view: this,
    } as unknown as ViewUpdate;
  }
}

function createSurface({
  anchor = 'at_cursor',
  doc = '',
  selectionHead = 0,
  separator = 'space',
}: {
  anchor?: DictationAnchor;
  doc?: string;
  selectionHead?: number;
  separator?: PhraseSeparator;
} = {}): { surface: NoteSurface; view: FakeEditorView } {
  const view = new FakeEditorView(doc, selectionHead);
  const surface = new NoteSurface(view as unknown as EditorView, { anchor, separator });

  return { surface, view };
}

function doc(view: FakeEditorView): string {
  return view.state.doc.toString();
}

describe('NoteSurface', () => {
  it('appends dictated text at the writing-region tail after user text typed at the old anchor', () => {
    const { surface, view } = createSurface({ doc: 'start ', selectionHead: 6 });

    expect(surface.append('u1', 'first').kind).toBe('appended');
    surface.observeTransaction(
      view.apply({
        annotations: Transaction.userEvent.of('input.type'),
        changes: { from: 11, insert: ' USER' },
      }),
    );
    expect(surface.append('u2', 'second').kind).toBe('appended');

    expect(doc(view)).toBe('start first USER second');
  });

  it('preserves phrase separator and trailing cleanup behavior', () => {
    const { surface, view } = createSurface({ separator: 'new_paragraph' });

    expect(surface.append('u1', 'first').kind).toBe('appended');
    expect(surface.append('u2', 'second').kind).toBe('appended');
    expect(doc(view)).toBe('first\n\nsecond\n\n');

    surface.trimPendingTrailingContent();

    expect(doc(view)).toBe('first\n\nsecond');
  });

  it('applies and trims the eager end-of-note first phrase prefix', () => {
    const { surface, view } = createSurface({
      anchor: 'end_of_note',
      doc: 'alpha',
      selectionHead: 0,
    });

    expect(doc(view)).toBe('alpha\n');

    surface.trimPendingTrailingContent();

    expect(doc(view)).toBe('alpha');
  });

  it('maps spans when text is inserted before them', () => {
    const { surface, view } = createSurface({ doc: 'tail', selectionHead: 4 });

    expect(surface.append('u1', 'voice ').kind).toBe('appended');
    surface.observeTransaction(
      view.apply({
        annotations: Transaction.userEvent.of('input.type'),
        changes: { from: 0, insert: 'HEAD ' },
      }),
    );

    expect(surface.replaceAnchor('u1', 'dictated ', 'voice ').kind).toBe('replaced');
    expect(doc(view)).toBe('HEAD taildictated ');
  });

  it('latches only spans intersected by a user edit', () => {
    const { surface, view } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    expect(surface.append('u2', 'second').kind).toBe('appended');
    surface.observeTransaction(
      view.apply({
        annotations: Transaction.userEvent.of('input.type'),
        changes: { from: 1, to: 2, insert: 'X' },
      }),
    );

    expect(surface.replaceAnchor('u1', 'FIRST', 'first').kind).toBe('denied');
    expect(surface.replaceAnchor('u2', 'SECOND', 'second').kind).toBe('replaced');
    expect(doc(view)).toBe('fXrst SECOND');
  });

  it('does not latch on undo or redo user events', () => {
    const { surface, view } = createSurface({ doc: 'tail', selectionHead: 4 });

    expect(surface.append('u1', 'first').kind).toBe('appended');
    surface.observeTransaction(
      view.apply({
        annotations: Transaction.userEvent.of('undo.selection'),
        changes: { from: 0, insert: '!' },
      }),
    );

    expect(surface.replaceAnchor('u1', 'FIRST', 'first').kind).toBe('replaced');
  });

  it('treats IME composition commits as latchable user edits', () => {
    const { surface, view } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    surface.observeTransaction(
      view.apply({
        annotations: Transaction.userEvent.of('input.type.compose'),
        changes: { from: 2, insert: 'X' },
      }),
    );

    expect(surface.replaceAnchor('u1', 'FIRST', 'first').kind).toBe('denied');
  });

  it('denies replace when the recorded bytes no longer match the note', () => {
    const { surface, view } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    surface.observeTransaction(view.apply({ changes: { from: 0, to: 1, insert: 'F' } }));

    const result = surface.replaceAnchor('u1', 'FIRST', 'first');

    expect(result.kind).toBe('denied');
    expect(result).toMatchObject({ currentText: 'First' });
  });

  it('selectively latches externally modified spans by byte identity', () => {
    const { surface, view } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    expect(surface.append('u2', 'second').kind).toBe('appended');
    surface.observeTransaction(view.apply({ changes: { from: 0, to: 1, insert: 'F' } }));
    surface.validateExternalModification();

    expect(surface.replaceAnchor('u1', 'FIRST', 'first').kind).toBe('denied');
    expect(surface.replaceAnchor('u2', 'SECOND', 'second').kind).toBe('replaced');
  });

  it('latches all spans on request', () => {
    const { surface } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    surface.latchAll('closed');

    expect(surface.replaceAnchor('u1', 'FIRST', 'first')).toMatchObject({
      kind: 'denied',
      reason: 'closed',
    });
  });

  it('rewrites an intact region and drops old anchors', () => {
    const { surface, view } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');
    expect(surface.append('u2', 'second').kind).toBe('appended');

    expect(surface.rewriteRegion({ from: 0, to: 5 }, 'FIRST', [])).toEqual({
      kind: 'rewritten',
      range: { from: 0, to: 5 },
    });
    expect(doc(view)).toBe('FIRST second');
    expect(surface.replaceAnchor('u1', 'next', 'first').kind).toBe('denied');
    expect(surface.replaceAnchor('u2', 'SECOND', 'second').kind).toBe('replaced');
  });

  it('denies rewrites that cut through an utterance span', () => {
    const { surface } = createSurface();

    expect(surface.append('u1', 'first').kind).toBe('appended');

    expect(surface.rewriteRegion({ from: 1, to: 4 }, 'ir', [])).toEqual({
      kind: 'denied',
      reason: 'Rewrite range intersects a partial utterance span.',
    });
  });
});
