import { describe, expect, it } from 'vitest';

import { computePhrasePrefix } from '../src/editor/transcript-placement';

describe('computePhrasePrefix', () => {
  describe('first phrase', () => {
    it('adds no prefix for at_cursor', () => {
      expect(
        computePhrasePrefix({
          anchor: 'at_cursor',
          separator: 'space',
          isFirstPhrase: true,
          charBeforeAnchor: 'o',
        }),
      ).toBe('');
    });

    it('adds no prefix for end_of_note when doc is empty', () => {
      expect(
        computePhrasePrefix({
          anchor: 'end_of_note',
          separator: 'space',
          isFirstPhrase: true,
          charBeforeAnchor: null,
        }),
      ).toBe('');
    });

    it('adds no prefix for end_of_note when doc already ends in a newline', () => {
      expect(
        computePhrasePrefix({
          anchor: 'end_of_note',
          separator: 'new_paragraph',
          isFirstPhrase: true,
          charBeforeAnchor: '\n',
        }),
      ).toBe('');
    });

    it('adds a newline prefix for end_of_note when doc ends mid-line', () => {
      expect(
        computePhrasePrefix({
          anchor: 'end_of_note',
          separator: 'space',
          isFirstPhrase: true,
          charBeforeAnchor: 'a',
        }),
      ).toBe('\n');
    });
  });

  describe('subsequent phrases', () => {
    it('uses a single space for the space separator', () => {
      expect(
        computePhrasePrefix({
          anchor: 'at_cursor',
          separator: 'space',
          isFirstPhrase: false,
          charBeforeAnchor: 'x',
        }),
      ).toBe(' ');
    });

    it('uses a single newline for the new_line separator', () => {
      expect(
        computePhrasePrefix({
          anchor: 'at_cursor',
          separator: 'new_line',
          isFirstPhrase: false,
          charBeforeAnchor: 'x',
        }),
      ).toBe('\n');
    });

    it('uses a blank line for the new_paragraph separator', () => {
      expect(
        computePhrasePrefix({
          anchor: 'at_cursor',
          separator: 'new_paragraph',
          isFirstPhrase: false,
          charBeforeAnchor: 'x',
        }),
      ).toBe('\n\n');
    });

    it('dedups the new_paragraph separator when the char before the anchor is already a newline', () => {
      expect(
        computePhrasePrefix({
          anchor: 'at_cursor',
          separator: 'new_paragraph',
          isFirstPhrase: false,
          charBeforeAnchor: '\n',
        }),
      ).toBe('\n');
    });
  });
});
