import { setIcon } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-session-controller';

export class DictationRibbonController {
  constructor(private readonly element: HTMLElement) {
    this.setState('idle');
  }

  getElement(): HTMLElement {
    return this.element;
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
    case 'idle':
      return {
        icon: 'mic',
        label: 'Local STT: Start Dictation Session',
      };

    case 'starting':
      return {
        icon: 'square',
        label: 'Local STT: Starting Dictation Session',
      };

    case 'listening':
      return {
        icon: 'square',
        label: 'Local STT: Stop Dictation Session',
      };

    case 'speech_detected':
      return {
        icon: 'square',
        label: 'Local STT: Dictation Speech Detected',
      };

    case 'transcribing':
      return {
        icon: 'square',
        label: 'Local STT: Dictation Session Transcribing',
      };

    case 'paused':
      return {
        icon: 'square',
        label: 'Local STT: Dictation Session Paused',
      };

    case 'error':
      return {
        icon: 'mic',
        label: 'Local STT: Dictation Session Error',
      };
  }
}
