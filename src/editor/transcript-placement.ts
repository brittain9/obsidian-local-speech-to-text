import type { DictationAnchor, PhraseSeparator } from '../settings/plugin-settings';

export function computePhrasePrefix({
  anchor,
  separator,
  isFirstPhrase,
  charBeforeAnchor,
}: {
  anchor: DictationAnchor;
  separator: PhraseSeparator;
  isFirstPhrase: boolean;
  charBeforeAnchor: string | null;
}): string {
  if (isFirstPhrase) {
    if (anchor === 'end_of_note' && charBeforeAnchor !== null && charBeforeAnchor !== '\n') {
      return '\n';
    }

    return '';
  }

  switch (separator) {
    case 'space':
      return ' ';

    case 'new_line':
      return '\n';

    case 'new_paragraph':
      return charBeforeAnchor === '\n' ? '\n' : '\n\n';
  }
}
