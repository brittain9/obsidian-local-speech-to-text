import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  clearAnchorEffect,
  dictationAnchorStateField,
  setAnchorEffect,
  setAnchorModeEffect,
} from '../src/editor/dictation-anchor-extension';

function createState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [dictationAnchorStateField] });
}

describe('dictationAnchorStateField', () => {
  it('starts with pos null and hidden mode', () => {
    const state = createState('hello');
    expect(state.field(dictationAnchorStateField)).toEqual({ pos: null, mode: 'hidden' });
  });

  it('setAnchorEffect pins the anchor position', () => {
    const state = createState('hello world');
    const next = state.update({ effects: setAnchorEffect.of(6) }).state;
    expect(next.field(dictationAnchorStateField).pos).toBe(6);
  });

  it('setAnchorModeEffect updates the mode without moving pos', () => {
    const state = createState('hello world');
    const pinned = state.update({ effects: setAnchorEffect.of(6) }).state;
    const next = pinned.update({ effects: setAnchorModeEffect.of('speaking') }).state;
    expect(next.field(dictationAnchorStateField)).toEqual({ pos: 6, mode: 'speaking' });
  });

  it('clearAnchorEffect resets pos to null and mode to hidden', () => {
    const state = createState('hello world');
    const pinned = state.update({
      effects: [setAnchorEffect.of(6), setAnchorModeEffect.of('speaking')],
    }).state;
    const next = pinned.update({ effects: clearAnchorEffect.of(null) }).state;
    expect(next.field(dictationAnchorStateField)).toEqual({ pos: null, mode: 'hidden' });
  });

  it('maps the anchor left (bias -1) through edits at the anchor position', () => {
    const state = createState('hello world');
    const pinned = state.update({ effects: setAnchorEffect.of(6) }).state;
    const edited = pinned.update({ changes: { from: 6, insert: 'NEW ' } }).state;
    expect(edited.field(dictationAnchorStateField).pos).toBe(6);
    expect(edited.doc.toString()).toBe('hello NEW world');
  });

  it('shifts the anchor forward when text is inserted before it', () => {
    const state = createState('hello world');
    const pinned = state.update({ effects: setAnchorEffect.of(6) }).state;
    const edited = pinned.update({ changes: { from: 0, insert: '!!! ' } }).state;
    expect(edited.field(dictationAnchorStateField).pos).toBe(10);
  });

  it('applies setAnchor and change in the same transaction with setAnchor taking precedence', () => {
    const state = createState('hello world');
    const pinned = state.update({ effects: setAnchorEffect.of(6) }).state;
    const edited = pinned.update({
      changes: { from: 6, insert: 'phrase' },
      effects: setAnchorEffect.of(12),
    }).state;
    expect(edited.doc.toString()).toBe('hello phraseworld');
    expect(edited.field(dictationAnchorStateField).pos).toBe(12);
  });
});
