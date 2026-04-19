import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  clearAnchorEffect,
  dictationAnchorDecorationsField,
  dictationAnchorStateField,
  setAnchorEffect,
  setAnchorHideWhenCursorOverlapsEffect,
  setAnchorModeEffect,
} from '../src/editor/dictation-anchor-extension';

function createState(doc: string, selectionHead = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(selectionHead),
    extensions: [dictationAnchorStateField, dictationAnchorDecorationsField],
  });
}

function countDecorations(state: EditorState): number {
  let count = 0;
  state
    .field(dictationAnchorDecorationsField)
    .between(0, state.doc.length + 1, () => count += 1);
  return count;
}

describe('dictationAnchorStateField', () => {
  it('starts with pos null and hidden mode', () => {
    const state = createState('hello');
    expect(state.field(dictationAnchorStateField)).toEqual({
      hideWhenCursorOverlaps: false,
      pos: null,
      mode: 'hidden',
    });
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
    expect(next.field(dictationAnchorStateField)).toEqual({
      hideWhenCursorOverlaps: false,
      pos: 6,
      mode: 'speaking',
    });
  });

  it('clearAnchorEffect resets pos to null and mode to hidden', () => {
    const state = createState('hello world');
    const pinned = state.update({
      effects: [setAnchorEffect.of(6), setAnchorModeEffect.of('speaking')],
    }).state;
    const next = pinned.update({ effects: clearAnchorEffect.of(null) }).state;
    expect(next.field(dictationAnchorStateField)).toEqual({
      hideWhenCursorOverlaps: false,
      pos: null,
      mode: 'hidden',
    });
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

  it('hides the speaking widget when the cursor overlaps an at_cursor anchor', () => {
    const state = createState('hello world', 6).update({
      effects: [
        setAnchorEffect.of(6),
        setAnchorHideWhenCursorOverlapsEffect.of(true),
        setAnchorModeEffect.of('speaking'),
      ],
    }).state;

    expect(countDecorations(state)).toBe(0);
  });

  it('keeps the speaking widget visible when an end_of_note anchor overlaps the cursor', () => {
    const state = createState('hello world', 11).update({
      effects: [
        setAnchorEffect.of(11),
        setAnchorHideWhenCursorOverlapsEffect.of(false),
        setAnchorModeEffect.of('speaking'),
      ],
    }).state;

    expect(countDecorations(state)).toBe(1);
  });

  it('recomputes decorations when selection moves onto and away from an at_cursor anchor', () => {
    const initial = createState('hello world', 0).update({
      effects: [
        setAnchorEffect.of(6),
        setAnchorHideWhenCursorOverlapsEffect.of(true),
        setAnchorModeEffect.of('speaking'),
      ],
    }).state;
    expect(countDecorations(initial)).toBe(1);

    const overlapping = initial.update({ selection: EditorSelection.cursor(6) }).state;
    expect(countDecorations(overlapping)).toBe(0);

    const movedAway = overlapping.update({ selection: EditorSelection.cursor(0) }).state;
    expect(countDecorations(movedAway)).toBe(1);
  });

  it('does not hide the processing spinner when the cursor overlaps the anchor', () => {
    const state = createState('hello world', 6).update({
      effects: [
        setAnchorEffect.of(6),
        setAnchorHideWhenCursorOverlapsEffect.of(true),
        setAnchorModeEffect.of('processing'),
      ],
    }).state;

    expect(countDecorations(state)).toBe(1);
  });
});
