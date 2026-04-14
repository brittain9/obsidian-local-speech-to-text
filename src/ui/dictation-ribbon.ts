import { setIcon } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-session-controller';

type RibbonIcon = 'audio-lines' | 'loader' | 'mic' | 'mic-off';

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
  icon: RibbonIcon;
  label: string;
} {
  switch (state) {
    case 'idle':
      return { icon: 'mic', label: 'Local STT: Click to start' };

    case 'starting':
      return { icon: 'loader', label: 'Local STT: Starting...' };

    case 'listening':
      return { icon: 'audio-lines', label: 'Local STT: Listening' };

    case 'speech_detected':
      return { icon: 'audio-lines', label: 'Local STT: Hearing speech' };

    case 'transcribing':
      return { icon: 'loader', label: 'Local STT: Transcribing...' };

    case 'paused':
      return { icon: 'loader', label: 'Local STT: Processing...' };

    case 'error':
      return { icon: 'mic-off', label: 'Local STT: Error' };
  }
}
