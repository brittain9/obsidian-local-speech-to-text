import type { DictationAnchor, PhraseSeparator } from '../settings/plugin-settings';

export function computeFirstPhrasePrefix({
  anchor,
  charBeforeAnchor,
}: {
  anchor: DictationAnchor;
  charBeforeAnchor: string | null;
}): string {
  if (anchor === 'end_of_note' && charBeforeAnchor !== null && charBeforeAnchor !== '\n') {
    return '\n';
  }
  return '';
}

export interface PhraseInsertSeparators {
  prefix: string;
  trailing: string;
}

export function computePhraseSeparators({
  separator,
  isFirstPhrase,
  charBeforeTail,
}: {
  separator: PhraseSeparator;
  isFirstPhrase: boolean;
  charBeforeTail: string | null;
}): PhraseInsertSeparators {
  const basePrefix = !isFirstPhrase && separator === 'space' ? ' ' : '';
  const needsAutoSpace =
    basePrefix.length === 0 &&
    charBeforeTail !== null &&
    charBeforeTail.length > 0 &&
    !/\s/u.test(charBeforeTail);

  return {
    prefix: needsAutoSpace ? ' ' : basePrefix,
    trailing: eagerTrailingSeparator(separator),
  };
}

function eagerTrailingSeparator(separator: PhraseSeparator): string {
  switch (separator) {
    case 'space':
      return '';
    case 'new_line':
      return '\n';
    case 'new_paragraph':
      return '\n\n';
  }
}
