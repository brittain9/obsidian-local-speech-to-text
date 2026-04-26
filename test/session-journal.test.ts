import { describe, expect, it } from 'vitest';

import {
  SessionJournal,
  type TranscriptRevision,
  type UtteranceId,
} from '../src/session/session-journal';

describe('SessionJournal', () => {
  it('accepts newer revisions and returns the previous revision', () => {
    const journal = new SessionJournal('session-1');
    const first = transcript({ revision: 0, text: 'rough text', utteranceId: 'u1' });
    const second = transcript({ revision: 1, text: 'polished text', utteranceId: 'u1' });

    expect(journal.upsert(first)).toEqual({ kind: 'accepted', revision: first });
    expect(journal.upsert(second)).toEqual({
      kind: 'accepted',
      previous: first,
      revision: second,
    });
    expect(journal.latestForUtterance('u1')).toBe(second);
  });

  it('reports duplicate and stale revisions without changing the latest revision', () => {
    const journal = new SessionJournal('session-1');
    const revision0 = transcript({ revision: 0, text: 'first', utteranceId: 'u1' });
    const revision1 = transcript({ revision: 1, text: 'second', utteranceId: 'u1' });
    const duplicate = transcript({ revision: 1, text: 'second again', utteranceId: 'u1' });
    const stale = transcript({ revision: 0, text: 'late first', utteranceId: 'u1' });

    journal.upsert(revision0);
    journal.upsert(revision1);

    expect(journal.upsert(duplicate)).toEqual({
      existing: revision1,
      incoming: duplicate,
      kind: 'duplicate',
    });
    expect(journal.upsert(stale)).toEqual({
      incoming: stale,
      kind: 'stale',
      latest: revision1,
    });
    expect(journal.latestForUtterance('u1')).toBe(revision1);
    expect(journal.revisionHistoryFor('u1')).toEqual([revision0, revision1]);
  });

  it('retains revision history and returns latest utterances in dictation order', () => {
    const journal = new SessionJournal('session-1');
    const u1r0 = transcript({ revision: 0, text: 'one draft', utteranceId: 'u1' });
    const u2r0 = transcript({ revision: 0, text: 'two', utteranceId: 'u2' });
    const u1r1 = transcript({ revision: 1, text: 'one final', utteranceId: 'u1' });

    journal.upsert(u1r0);
    journal.upsert(u2r0);
    journal.upsert(u1r1);

    expect(journal.revisionHistoryFor('u1')).toEqual([u1r0, u1r1]);
    expect(journal.allUtterancesInOrder()).toEqual([u1r1, u2r0]);
  });

  it('assembles context from finalized utterances only', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(transcript({ isFinal: true, text: 'first final', utteranceId: 'u1' }));
    journal.upsert(transcript({ isFinal: false, text: 'partial draft', utteranceId: 'u2' }));
    journal.upsert(transcript({ isFinal: true, text: 'third final', utteranceId: 'u3' }));

    expect(journal.assembleContext({ maxChars: 100 })).toEqual({
      budgetChars: 100,
      sources: [
        {
          endRevision: 0,
          kind: 'session_utterance',
          text: 'first final',
          truncated: false,
          utteranceId: 'u1',
        },
        {
          endRevision: 0,
          kind: 'session_utterance',
          text: 'third final',
          truncated: false,
          utteranceId: 'u3',
        },
      ],
      text: 'first final\nthird final',
      truncated: false,
    });
  });

  it('selects the newest finalized utterances within budget and emits chronological text', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(transcript({ isFinal: true, text: 'old text', utteranceId: 'u1' }));
    journal.upsert(transcript({ isFinal: true, text: 'middle text', utteranceId: 'u2' }));
    journal.upsert(transcript({ isFinal: true, text: 'new text', utteranceId: 'u3' }));

    const context = journal.assembleContext({ maxChars: 'middle text\nnew text'.length });

    expect(context?.text).toBe('middle text\nnew text');
    expect(context?.sources.map((source) => source.utteranceId)).toEqual(['u2', 'u3']);
    expect(context?.truncated).toBe(false);
  });

  it('truncates an oversized newest utterance at a word boundary', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(
      transcript({
        isFinal: true,
        text: 'alpha bravo charlie delta',
        utteranceId: 'u1',
      }),
    );

    const context = journal.assembleContext({ maxChars: 18 });

    expect(context?.text).toBe('alpha bravo');
    expect(context?.truncated).toBe(true);
    expect(context?.sources).toEqual([
      {
        endRevision: 0,
        kind: 'session_utterance',
        text: 'alpha bravo',
        truncated: true,
        utteranceId: 'u1',
      },
    ]);
  });

  it('keeps a word when truncation budget ends exactly at that word boundary', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(
      transcript({
        isFinal: true,
        text: 'alpha bravo charlie',
        utteranceId: 'u1',
      }),
    );

    expect(journal.assembleContext({ maxChars: 'alpha bravo'.length })?.text).toBe('alpha bravo');
  });

  it('returns null when no finalized utterance fits the context budget', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(transcript({ isFinal: false, text: 'draft', utteranceId: 'u1' }));

    expect(journal.assembleContext({ maxChars: 100 })).toBeNull();
    expect(journal.assembleContext({ maxChars: 0 })).toBeNull();
  });

  it('returns null rather than splitting the only available word', () => {
    const journal = new SessionJournal('session-1');

    journal.upsert(transcript({ isFinal: true, text: 'oversized', utteranceId: 'u1' }));

    expect(journal.assembleContext({ maxChars: 4 })).toBeNull();
  });

  it('notifies subscribers only for accepted revisions', () => {
    const journal = new SessionJournal('session-1');
    const seen: TranscriptRevision[] = [];
    const first = transcript({ text: 'first', utteranceId: 'u1' });
    const duplicate = transcript({ text: 'duplicate', utteranceId: 'u1' });
    const second = transcript({ text: 'second', utteranceId: 'u2' });
    const unsubscribe = journal.subscribe((revision) => {
      seen.push(revision);
    });

    journal.upsert(first);
    journal.upsert(duplicate);
    unsubscribe();
    journal.upsert(second);

    expect(seen).toEqual([first]);
  });

  it('rejects revisions after finalize freezes the journal', () => {
    const journal = new SessionJournal('session-1');
    const accepted = transcript({ text: 'accepted', utteranceId: 'u1' });
    const late = transcript({ text: 'late', utteranceId: 'u2' });

    journal.upsert(accepted);
    journal.finalize();

    expect(journal.finalized).toBe(true);
    expect(journal.upsert(late)).toEqual({
      incoming: late,
      kind: 'rejected',
      reason: 'Session journal is finalized.',
    });
    expect(journal.allUtterancesInOrder()).toEqual([accepted]);
  });

  it('rejects impossible identity and revision inputs', () => {
    const journal = new SessionJournal('session-1');
    const wrongSession = transcript({
      sessionId: 'session-2',
      text: 'wrong session',
      utteranceId: 'u1',
    });
    const emptyUtterance = transcript({ text: 'empty', utteranceId: '' });
    const invalidRevision = transcript({ revision: -1, text: 'bad revision', utteranceId: 'u2' });

    expect(journal.upsert(wrongSession)).toEqual({
      incoming: wrongSession,
      kind: 'rejected',
      reason: 'Revision session session-2 does not match journal session session-1.',
    });
    expect(journal.upsert(emptyUtterance)).toEqual({
      incoming: emptyUtterance,
      kind: 'rejected',
      reason: 'Revision utteranceId must not be empty.',
    });
    expect(journal.upsert(invalidRevision)).toEqual({
      incoming: invalidRevision,
      kind: 'rejected',
      reason: 'Revision number must be a non-negative integer.',
    });
  });
});

function transcript(
  overrides: Partial<TranscriptRevision> & { text: string; utteranceId: UtteranceId },
): TranscriptRevision {
  return {
    isFinal: true,
    revision: 0,
    segments: [{ endMs: 100, startMs: 0, text: overrides.text }],
    sessionId: 'session-1',
    stageResults: [
      {
        durationMs: 10,
        revisionIn: 0,
        revisionOut: overrides.revision ?? 0,
        stageId: 'engine',
        status: { kind: 'ok' },
      },
    ],
    ...overrides,
  };
}
