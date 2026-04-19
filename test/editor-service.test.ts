import {
  EditorSelection,
  EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import type { App, EventRef, Plugin } from 'obsidian';
import { describe, expect, it } from 'vitest';

import {
  dictationAnchorExtension,
  dictationAnchorStateField,
} from '../src/editor/dictation-anchor-extension';
import { EditorService } from '../src/editor/editor-service';

type LeafChangeHandler = () => void;

class FakeEditorView {
  public state: EditorState;
  public readonly dom = { isConnected: true } as unknown as HTMLElement;

  constructor(doc: string, selectionHead: number, extensions: Extension = []) {
    this.state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(selectionHead),
      extensions: [extensions, dictationAnchorExtension()],
    });
  }

  dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state;
  }
}

class FakeEditor {
  constructor(public readonly cm: FakeEditorView) {}
}

interface FakeWorkspace {
  activeEditor: { editor: FakeEditor; file: { basename: string } | null } | null;
  on(name: 'active-leaf-change', handler: LeafChangeHandler): EventRef;
}

function createEditorService(
  view: FakeEditorView,
  basename: string | null = 'note',
): {
  service: EditorService;
  setActiveEditor: (next: FakeEditorView | null, basename?: string | null) => void;
  triggerLeafChange: () => void;
} {
  let active: FakeWorkspace['activeEditor'] =
    view !== null
      ? {
          editor: new FakeEditor(view),
          file: basename === null ? null : { basename },
        }
      : null;
  let leafHandler: LeafChangeHandler = () => {};

  const workspace: FakeWorkspace = {
    get activeEditor() {
      return active;
    },
    set activeEditor(next) {
      active = next;
    },
    on(_name, handler) {
      leafHandler = handler;
      return {} as EventRef;
    },
  };

  const app = { workspace } as unknown as App;
  const plugin = {
    registerEvent: (_ref: EventRef) => {},
  } as unknown as Plugin;

  const service = new EditorService(app, plugin);

  return {
    service,
    setActiveEditor: (next, nextBasename = basename) => {
      active =
        next === null
          ? null
          : {
              editor: new FakeEditor(next),
              file: nextBasename === null ? null : { basename: nextBasename },
            };
    },
    triggerLeafChange: () => leafHandler(),
  };
}

describe('EditorService', () => {
  it('beginAnchor pins at_cursor to the current selection head', () => {
    const view = new FakeEditorView('hello world', 6);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');

    expect(view.state.field(dictationAnchorStateField)).toEqual({ pos: 6, mode: 'hidden' });
  });

  it('beginAnchor pins end_of_note at doc end', () => {
    const view = new FakeEditorView('hello world', 0);
    const { service } = createEditorService(view);

    service.beginAnchor('end_of_note');

    expect(view.state.field(dictationAnchorStateField).pos).toBe(view.state.doc.length);
  });

  it('inserts three phrases with the space separator at_cursor', () => {
    const view = new FakeEditorView('start ', 6);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.insertPhrase('first', 'space');
    service.insertPhrase('second', 'space');
    service.insertPhrase('third', 'space');

    expect(view.state.doc.toString()).toBe('start first second third');
  });

  it('inserts three phrases with the new_line separator at_cursor', () => {
    const view = new FakeEditorView('', 0);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.insertPhrase('first', 'new_line');
    service.insertPhrase('second', 'new_line');
    service.insertPhrase('third', 'new_line');

    expect(view.state.doc.toString()).toBe('first\nsecond\nthird');
  });

  it('inserts three phrases with the new_paragraph separator at_cursor and dedups adjacent newlines', () => {
    const view = new FakeEditorView('', 0);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.insertPhrase('first', 'new_paragraph');
    service.insertPhrase('second', 'new_paragraph');
    service.insertPhrase('third', 'new_paragraph');

    expect(view.state.doc.toString()).toBe('first\n\nsecond\n\nthird');
  });

  it('prefixes the first end_of_note insertion with a newline when doc ends mid-line', () => {
    const view = new FakeEditorView('alpha', 0);
    const { service } = createEditorService(view);

    service.beginAnchor('end_of_note');
    service.insertPhrase('beta', 'space');
    service.insertPhrase('gamma', 'space');

    expect(view.state.doc.toString()).toBe('alpha\nbeta gamma');
  });

  it('does not prefix the first end_of_note insertion when doc is empty', () => {
    const view = new FakeEditorView('', 0);
    const { service } = createEditorService(view);

    service.beginAnchor('end_of_note');
    service.insertPhrase('first', 'space');
    service.insertPhrase('second', 'space');

    expect(view.state.doc.toString()).toBe('first second');
  });

  it('keeps insertions aligned when the user inserts text above the anchor mid-session', () => {
    const view = new FakeEditorView('header\n', 7);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.insertPhrase('first', 'space');
    view.dispatch({ changes: { from: 0, insert: '!!!' } });
    service.insertPhrase('second', 'space');

    expect(view.state.doc.toString()).toBe('!!!header\nfirst second');
  });

  it('does not move the user selection when inserting a phrase', () => {
    const view = new FakeEditorView('prefix suffix', 13);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    service.insertPhrase('hello', 'space');

    expect(view.state.selection.main.head).toBe(0);
  });

  it('setAnchorMode updates the mode on the stored view', () => {
    const view = new FakeEditorView('hello', 5);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.setAnchorMode('speaking');

    expect(view.state.field(dictationAnchorStateField).mode).toBe('speaking');
  });

  it('setAnchorMode is a no-op when the active editor differs from the stored view', () => {
    const view = new FakeEditorView('hello', 5);
    const { service, setActiveEditor } = createEditorService(view);

    service.beginAnchor('at_cursor');
    const other = new FakeEditorView('other', 0);
    setActiveEditor(other);
    service.setAnchorMode('speaking');

    expect(view.state.field(dictationAnchorStateField).mode).toBe('hidden');
  });

  it('insertPhrase is a no-op when the active editor differs from the stored view', () => {
    const view = new FakeEditorView('hello', 5);
    const { service, setActiveEditor } = createEditorService(view);

    service.beginAnchor('at_cursor');
    const other = new FakeEditorView('other', 0);
    setActiveEditor(other);
    service.insertPhrase('drop', 'space');

    expect(view.state.doc.toString()).toBe('hello');
    expect(other.state.doc.toString()).toBe('other');
  });

  it('endAnchor clears the widget state on the stored view', () => {
    const view = new FakeEditorView('hello', 5);
    const { service } = createEditorService(view);

    service.beginAnchor('at_cursor');
    service.endAnchor();

    expect(view.state.field(dictationAnchorStateField)).toEqual({ pos: null, mode: 'hidden' });
  });

  it('re-anchors to the new active editor when the user switches notes mid-session', () => {
    const view = new FakeEditorView('old note', 0);
    const { service, setActiveEditor, triggerLeafChange } = createEditorService(view, 'old');

    service.beginAnchor('at_cursor');
    const other = new FakeEditorView('new note', 3);
    setActiveEditor(other, 'new');
    triggerLeafChange();

    expect(view.state.field(dictationAnchorStateField)).toEqual({ pos: null, mode: 'hidden' });
    expect(other.state.field(dictationAnchorStateField)).toEqual({ pos: 3, mode: 'hidden' });

    service.insertPhrase('first', 'space');
    expect(other.state.doc.toString()).toBe('newfirst note');
  });
});
