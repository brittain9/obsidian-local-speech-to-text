import { setIcon } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-session-controller';

type RibbonIcon = 'audio-lines' | 'loader' | 'mic' | 'mic-off';
type RibbonVisualState = 'idle' | 'starting' | 'listening' | 'speech_detected' | 'error';

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
    this.element.dataset.localSttState = toVisualState(state);
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

    case 'speech_ending':
      return { icon: 'audio-lines', label: 'Local STT: Hearing speech' };

    case 'transcribing':
      return { icon: 'audio-lines', label: 'Local STT: Transcribing...' };

    case 'paused':
      return { icon: 'audio-lines', label: 'Local STT: Processing...' };

    case 'error':
      return { icon: 'mic-off', label: 'Local STT: Error' };
  }
}

function toVisualState(state: DictationControllerState): RibbonVisualState {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'listening':
    case 'transcribing':
    case 'paused':
      return 'listening';
    case 'speech_detected':
    case 'speech_ending':
      return 'speech_detected';
    case 'error':
      return 'error';
  }
}
