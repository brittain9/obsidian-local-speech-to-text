import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DictationRibbonController } from '../src/ui/dictation-ribbon';

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  return { ...actual, setIcon: vi.fn() };
});

function createFakeElement() {
  const dataset: Record<string, string> = {};
  const setAttribute = vi.fn();
  return {
    element: {
      dataset,
      title: '',
      setAttribute,
      remove: vi.fn(),
    } as unknown as HTMLElement,
    dataset,
    setAttribute,
  };
}

describe('DictationRibbonController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { state: 'idle', icon: 'mic', visual: 'idle' },
    { state: 'starting', icon: 'loader', visual: 'starting' },
    { state: 'listening', icon: 'audio-lines', visual: 'listening' },
    { state: 'speech_detected', icon: 'audio-lines', visual: 'speech_detected' },
    { state: 'speech_ending', icon: 'audio-lines', visual: 'speech_detected' },
    { state: 'transcribing', icon: 'loader', visual: 'working' },
    { state: 'paused', icon: 'loader', visual: 'working' },
    { state: 'error', icon: 'mic-off', visual: 'error' },
  ] as const)('maps $state → icon=$icon, dataset=$visual', async ({ state, icon, visual }) => {
    const { setIcon } = await import('obsidian');
    const { element, dataset } = createFakeElement();
    const controller = new DictationRibbonController(element);

    vi.mocked(setIcon).mockClear();
    controller.setState(state);

    expect(setIcon).toHaveBeenLastCalledWith(element, icon);
    expect(dataset.localSttState).toBe(visual);
  });

  it('maps transcribing and paused to the working ribbon dataset', () => {
    const { element, dataset } = createFakeElement();
    const controller = new DictationRibbonController(element);

    controller.setState('transcribing');
    expect(dataset.localSttState).toBe('working');

    controller.setState('paused');
    expect(dataset.localSttState).toBe('working');
  });

  it('preserves per-state tooltip copy via aria-label and title', () => {
    const { element, setAttribute } = createFakeElement();
    const controller = new DictationRibbonController(element);

    controller.setState('transcribing');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local Transcript: Transcribing...');
    expect(element.title).toBe('Local Transcript: Transcribing...');

    controller.setState('paused');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local Transcript: Transcribing...');
    expect(element.title).toBe('Local Transcript: Transcribing...');

    controller.setState('speech_ending');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local Transcript: Hearing speech');
    expect(element.title).toBe('Local Transcript: Hearing speech');
  });
});
