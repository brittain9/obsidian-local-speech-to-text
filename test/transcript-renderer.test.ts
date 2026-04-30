import { describe, expect, it } from 'vitest';

import {
  formatSessionTimestamp,
  isMeaningfulPause,
  SMART_PARAGRAPH_PAUSE_MS,
  TIMESTAMP_LANDMARK_INTERVAL_MS,
  type TranscriptAppendInput,
  TranscriptRenderer,
} from '../src/transcript/renderer';

describe('formatSessionTimestamp', () => {
  it.each([
    [0, '(0:00)'],
    [999, '(0:00)'],
    [65_999, '(1:05)'],
    [3_599_999, '(59:59)'],
    [3_600_000, '(1:00:00)'],
    [3_723_000, '(1:02:03)'],
  ])('formats %i ms as %s', (elapsedMs, expected) => {
    expect(formatSessionTimestamp(elapsedMs)).toBe(expected);
  });
});

describe('isMeaningfulPause', () => {
  it('uses the shared smart paragraph threshold', () => {
    expect(isMeaningfulPause(null)).toBe(false);
    expect(isMeaningfulPause(SMART_PARAGRAPH_PAUSE_MS - 1)).toBe(false);
    expect(isMeaningfulPause(SMART_PARAGRAPH_PAUSE_MS)).toBe(true);
  });
});

describe('TranscriptRenderer', () => {
  it('renders the first timestamp and then suppresses short-interval timestamps', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: true,
      transcriptFormatting: 'space',
    });

    const first = planAndCommit(renderer, { text: 'first', utteranceStartMsInSession: 0 });
    const second = planAndCommit(
      renderer,
      {
        pauseMsBeforeUtterance: 250,
        text: 'second',
        utteranceStartMsInSession: 10_000,
      },
      't',
    );

    expect(first.projectedText).toBe('(0:00) first');
    expect(second.projectedText).toBe(' second');
  });

  it('emits a timestamp at the next utterance boundary after the landmark interval', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: true,
      transcriptFormatting: 'space',
    });

    planAndCommit(renderer, { text: 'first', utteranceStartMsInSession: 0 });
    const second = planAndCommit(
      renderer,
      {
        pauseMsBeforeUtterance: 250,
        text: 'later',
        utteranceStartMsInSession: TIMESTAMP_LANDMARK_INTERVAL_MS,
      },
      't',
    );

    expect(second.projectedText).toBe(' (0:30) later');
  });

  it('emits one timestamp when a long pause and landmark interval co-occur', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: true,
      transcriptFormatting: 'new_paragraph',
    });

    planAndCommit(renderer, { text: 'first', utteranceStartMsInSession: 0 });
    const second = planAndCommit(renderer, {
      pauseMsBeforeUtterance: SMART_PARAGRAPH_PAUSE_MS,
      text: 'later',
      utteranceStartMsInSession: TIMESTAMP_LANDMARK_INTERVAL_MS,
    });

    expect(second.projectedText).toBe('\n\n(0:30) later');
    expect(second.projectedText.match(/\(0:30\)/gu)).toHaveLength(1);
  });

  it.each([
    ['space', ' second'],
    ['new_line', '\nsecond'],
    ['new_paragraph', '\n\nsecond'],
  ] as const)('renders %s formatting as a prefix', (transcriptFormatting, expectedSecond) => {
    const renderer = new TranscriptRenderer({ showTimestamps: false, transcriptFormatting });

    expect(planAndCommit(renderer, { text: 'first' }).projectedText).toBe('first');
    expect(planAndCommit(renderer, { text: 'second' }, 't').projectedText).toBe(expectedSecond);
  });

  it('normalizes existing whitespace and newline tails', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: false,
      transcriptFormatting: 'new_paragraph',
    });

    planAndCommit(renderer, { text: 'first' });

    expect(planAndCommit(renderer, { text: 'second' }, '\n').projectedText).toBe('\nsecond');
    expect(planAndCommit(renderer, { text: 'third' }, '\n\n').projectedText).toBe('third');
  });

  it('uses the meaningful pause threshold for smart paragraphs', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: false,
      transcriptFormatting: 'smart',
    });

    expect(planAndCommit(renderer, { text: 'first' }).projectedText).toBe('first');
    expect(
      planAndCommit(
        renderer,
        {
          pauseMsBeforeUtterance: SMART_PARAGRAPH_PAUSE_MS - 1,
          text: 'short',
        },
        't',
      ).projectedText,
    ).toBe(' short');
    expect(
      planAndCommit(renderer, {
        pauseMsBeforeUtterance: SMART_PARAGRAPH_PAUSE_MS,
        text: 'long',
      }).projectedText,
    ).toBe('\n\nlong');
  });

  it('treats null pause as continuation while still allowing interval timestamps', () => {
    const renderer = new TranscriptRenderer({
      showTimestamps: true,
      transcriptFormatting: 'smart',
    });

    planAndCommit(renderer, { text: 'first', utteranceStartMsInSession: 0 });
    const split = planAndCommit(
      renderer,
      {
        pauseMsBeforeUtterance: null,
        text: 'split',
        utteranceStartMsInSession: 30_000,
      },
      't',
    );

    expect(split.projectedText).toBe(' (0:30) split');
  });
});

function planAndCommit(
  renderer: TranscriptRenderer,
  input: Partial<TranscriptAppendInput> & { text: string },
  tailContent = '',
) {
  const projection = renderer.planAppend(
    {
      pauseMsBeforeUtterance: null,
      utteranceId: 'utt',
      utteranceStartMsInSession: 0,
      ...input,
    },
    { tailContent },
  );
  renderer.commitAppend(projection);

  return projection;
}
