import { setIcon } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-controller';

export class DictationRibbonController {
  constructor(private readonly element: HTMLElement) {
    this.setState('idle');
  }

  setState(state: DictationControllerState): void {
    const { icon, label } = buildRibbonState(state);

    setIcon(this.element, icon);
    this.element.setAttribute('aria-label', label);
    this.element.setAttribute('data-tooltip-position', 'top');
    this.element.dataset.localSttState = state;
    this.element.title = label;
  }

  dispose(): void {
    this.element.remove();
  }
}

function buildRibbonState(state: DictationControllerState): {
  icon: 'mic' | 'square';
  label: string;
} {
  switch (state) {
    case 'recording':
      return {
        icon: 'square',
        label: 'Local STT: Stop And Transcribe',
      };

    case 'transcribing':
      return {
        icon: 'mic',
        label: 'Local STT: Transcribing',
      };

    case 'error':
      return {
        icon: 'mic',
        label: 'Local STT: Error',
      };

    case 'idle':
      return {
        icon: 'mic',
        label: 'Local STT: Start Dictation',
      };
  }
}
