import { describe, expect, it } from 'vitest';

import { computeFirstPhrasePrefix } from '../src/editor/transcript-placement';

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
