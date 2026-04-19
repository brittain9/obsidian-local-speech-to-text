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
}: {
  separator: PhraseSeparator;
  isFirstPhrase: boolean;
}): PhraseInsertSeparators {
  return {
    prefix: !isFirstPhrase && separator === 'space' ? ' ' : '',
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
