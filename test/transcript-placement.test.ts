import type { EditorPosition } from 'obsidian';
import { describe, expect, it } from 'vitest';

import {
  createDocumentEndPosition,
  resolveAppendTranscriptPlacement,
} from '../src/editor/transcript-placement';

describe('resolveAppendTranscriptPlacement', () => {
  it('treats an empty note as direct insertion for append-on-new-line mode', () => {
    expect(resolvePlacement('', 'append_on_new_line')).toEqual({
      cursor: { ch: 5, line: 0 },
      range: {
        from: { ch: 0, line: 0 },
        to: { ch: 0, line: 0 },
      },
      text: 'hello',
    });
  });

  it('does not add an extra separator when append-on-new-line already ends at a newline', () => {
    expect(resolvePlacement('alpha\n', 'append_on_new_line')).toEqual({
      cursor: { ch: 5, line: 1 },
      range: {
        from: { ch: 0, line: 1 },
        to: { ch: 0, line: 1 },
      },
      text: 'hello',
    });
  });

  it('adds exactly one newline when append-on-new-line follows inline text', () => {
    expect(resolvePlacement('alpha', 'append_on_new_line')).toEqual({
      cursor: { ch: 5, line: 1 },
      range: {
        from: { ch: 5, line: 0 },
        to: { ch: 5, line: 0 },
      },
      text: '\nhello',
    });
  });

  it('treats an empty note as direct insertion for append-as-new-paragraph mode', () => {
    expect(resolvePlacement('', 'append_as_new_paragraph')).toEqual({
      cursor: { ch: 5, line: 0 },
      range: {
        from: { ch: 0, line: 0 },
        to: { ch: 0, line: 0 },
      },
      text: 'hello',
    });
  });

  it('does not add an extra blank line when the note already ends with one', () => {
    expect(resolvePlacement('alpha\n\n', 'append_as_new_paragraph')).toEqual({
      cursor: { ch: 5, line: 2 },
      range: {
        from: { ch: 0, line: 2 },
        to: { ch: 0, line: 2 },
      },
      text: 'hello',
    });
  });

  it('adds one newline when append-as-new-paragraph follows a trailing newline', () => {
    expect(resolvePlacement('alpha\n', 'append_as_new_paragraph')).toEqual({
      cursor: { ch: 5, line: 2 },
      range: {
        from: { ch: 0, line: 1 },
        to: { ch: 0, line: 1 },
      },
      text: '\nhello',
    });
  });

  it('adds a blank line when append-as-new-paragraph follows inline text', () => {
    expect(resolvePlacement('alpha', 'append_as_new_paragraph')).toEqual({
      cursor: { ch: 5, line: 2 },
      range: {
        from: { ch: 5, line: 0 },
        to: { ch: 5, line: 0 },
      },
      text: '\n\nhello',
    });
  });

  it('treats whitespace-only notes as empty and replaces the full document', () => {
    expect(resolvePlacement(' \n\t', 'append_as_new_paragraph')).toEqual({
      cursor: { ch: 5, line: 0 },
      range: {
        from: { ch: 0, line: 0 },
        to: { ch: 1, line: 1 },
      },
      text: 'hello',
    });
  });
});

function resolvePlacement(
  documentText: string,
  mode: 'append_on_new_line' | 'append_as_new_paragraph',
) {
  return resolveAppendTranscriptPlacement({
    documentEnd: getDocumentEnd(documentText),
    documentText,
    mode,
    transcript: 'hello',
  });
}

function getDocumentEnd(text: string): EditorPosition {
  const lines = text.split('\n');
  const lastLineIndex = lines.length - 1;

  return createDocumentEndPosition(lastLineIndex, lines[lastLineIndex] ?? '');
}
