import { describe, expect, it } from 'vitest';

import {
  computeFirstPhrasePrefix,
  computePhraseSeparators,
} from '../src/editor/transcript-placement';

describe('computeFirstPhrasePrefix', () => {
  it('returns empty for at_cursor', () => {
    expect(computeFirstPhrasePrefix({ anchor: 'at_cursor', charBeforeAnchor: 'o' })).toBe('');
  });

  it('returns empty for end_of_note when doc is empty', () => {
    expect(computeFirstPhrasePrefix({ anchor: 'end_of_note', charBeforeAnchor: null })).toBe('');
  });

  it('returns empty for end_of_note when doc already ends in a newline', () => {
    expect(computeFirstPhrasePrefix({ anchor: 'end_of_note', charBeforeAnchor: '\n' })).toBe('');
  });

  it('returns a newline for end_of_note when doc ends mid-line', () => {
    expect(computeFirstPhrasePrefix({ anchor: 'end_of_note', charBeforeAnchor: 'a' })).toBe('\n');
  });
});

describe('computePhraseSeparators', () => {
  describe('first phrase', () => {
    it('no prefix, no trailing for space', () => {
      expect(
        computePhraseSeparators({
          separator: 'space',
          isFirstPhrase: true,
          charBeforeTail: null,
        }),
      ).toEqual({
        prefix: '',
        trailing: '',
      });
    });

    it('no prefix, single newline trailing for new_line', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_line',
          isFirstPhrase: true,
          charBeforeTail: null,
        }),
      ).toEqual({
        prefix: '',
        trailing: '\n',
      });
    });

    it('no prefix, double newline trailing for new_paragraph', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_paragraph',
          isFirstPhrase: true,
          charBeforeTail: null,
        }),
      ).toEqual({
        prefix: '',
        trailing: '\n\n',
      });
    });
  });

  describe('subsequent phrase', () => {
    it('space prefix, no trailing for space', () => {
      expect(
        computePhraseSeparators({
          separator: 'space',
          isFirstPhrase: false,
          charBeforeTail: null,
        }),
      ).toEqual({
        prefix: ' ',
        trailing: '',
      });
    });

    it('no prefix, single newline trailing for new_line', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_line',
          isFirstPhrase: false,
          charBeforeTail: null,
        }),
      ).toEqual({
        prefix: '',
        trailing: '\n',
      });
    });

    it('no prefix, double newline trailing for new_paragraph', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_paragraph',
          isFirstPhrase: false,
          charBeforeTail: null,
        }),
      ).toEqual({ prefix: '', trailing: '\n\n' });
    });
  });

  describe('auto-space when tail abuts non-whitespace', () => {
    it('prepends a space on the first phrase when char-before is a letter', () => {
      expect(
        computePhraseSeparators({
          separator: 'space',
          isFirstPhrase: true,
          charBeforeTail: 'o',
        }),
      ).toEqual({ prefix: ' ', trailing: '' });
    });

    it('does not double-space when char-before is already whitespace', () => {
      expect(
        computePhraseSeparators({
          separator: 'space',
          isFirstPhrase: true,
          charBeforeTail: ' ',
        }),
      ).toEqual({ prefix: '', trailing: '' });
    });

    it('treats newline as whitespace and skips the auto-space', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_line',
          isFirstPhrase: true,
          charBeforeTail: '\n',
        }),
      ).toEqual({ prefix: '', trailing: '\n' });
    });

    it('falls back to a space when a line-separator phrase abuts user text', () => {
      expect(
        computePhraseSeparators({
          separator: 'new_line',
          isFirstPhrase: false,
          charBeforeTail: 'X',
        }),
      ).toEqual({ prefix: ' ', trailing: '\n' });
    });

    it('does not override the existing space prefix on subsequent space-separated phrases', () => {
      expect(
        computePhraseSeparators({
          separator: 'space',
          isFirstPhrase: false,
          charBeforeTail: 'X',
        }),
      ).toEqual({ prefix: ' ', trailing: '' });
    });
  });
});
