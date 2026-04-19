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
    { state: 'transcribing', icon: 'audio-lines', visual: 'listening' },
    { state: 'paused', icon: 'audio-lines', visual: 'listening' },
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

  it('never writes transcribing or paused to the ribbon dataset', () => {
    const { element, dataset } = createFakeElement();
    const controller = new DictationRibbonController(element);

    controller.setState('transcribing');
    expect(dataset.localSttState).toBe('listening');

    controller.setState('paused');
    expect(dataset.localSttState).toBe('listening');
  });

  it('preserves per-state tooltip copy via aria-label', () => {
    const { element, setAttribute } = createFakeElement();
    const controller = new DictationRibbonController(element);

    controller.setState('transcribing');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local STT: Transcribing...');

    controller.setState('paused');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local STT: Processing...');

    controller.setState('speech_ending');
    expect(setAttribute).toHaveBeenCalledWith('aria-label', 'Local STT: Hearing speech');
  });
});
