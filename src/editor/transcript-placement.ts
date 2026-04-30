import type { DictationAnchor } from '../settings/plugin-settings';

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
