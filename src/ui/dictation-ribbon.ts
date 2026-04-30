import { setIcon } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-session-controller';
import type { QueueBackpressureTier } from '../sidecar/protocol';

type RibbonIcon = 'audio-lines' | 'loader' | 'mic' | 'mic-off';
type RibbonVisualState =
  | 'idle'
  | 'starting'
  | 'working'
  | 'listening'
  | 'speech_detected'
  | 'error';

export class DictationRibbonController {
  private state: DictationControllerState = 'idle';
  private queueTier: QueueBackpressureTier = 'normal';

  constructor(private readonly element: HTMLElement) {
    this.render();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  setState(state: DictationControllerState): void {
    this.state = state;
    this.render();
  }

  setQueueTier(tier: QueueBackpressureTier): void {
    this.queueTier = tier;
    this.render();
  }

  dispose(): void {
    this.element.remove();
  }

  private render(): void {
    const { icon, label } = buildRibbonState(this.state, this.queueTier);

    setIcon(this.element, icon);
    this.element.setAttribute('aria-label', label);
    this.element.setAttribute('data-tooltip-position', 'top');
    this.element.dataset.localSttState = toVisualState(this.state);
    this.element.title = label;
  }
}

function buildRibbonState(
  state: DictationControllerState,
  queueTier: QueueBackpressureTier,
): {
  icon: RibbonIcon;
  label: string;
} {
  switch (state) {
    case 'idle':
      return { icon: 'mic', label: 'Local Transcript: Click to start' };

    case 'starting':
      return { icon: 'loader', label: 'Local Transcript: Starting...' };

    case 'listening':
      return { icon: 'audio-lines', label: 'Local Transcript: Listening' };

    case 'speech_detected':
      return { icon: 'audio-lines', label: 'Local Transcript: Hearing speech' };

    case 'speech_ending':
      return { icon: 'audio-lines', label: 'Local Transcript: Hearing speech' };

    case 'transcribing':
    case 'paused':
      return queueTier === 'catching_up'
        ? { icon: 'loader', label: 'Local Transcript: Catching up...' }
        : { icon: 'loader', label: 'Local Transcript: Transcribing...' };

    case 'error':
      return { icon: 'mic-off', label: 'Local Transcript: Error' };
  }
}

function toVisualState(state: DictationControllerState): RibbonVisualState {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'listening':
      return 'listening';
    case 'transcribing':
    case 'paused':
      return 'working';
    case 'speech_detected':
    case 'speech_ending':
      return 'speech_detected';
    case 'error':
      return 'error';
  }
}
