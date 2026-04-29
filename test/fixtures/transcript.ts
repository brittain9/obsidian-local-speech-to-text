import type { TranscriptRevision, UtteranceId } from '../../src/session/session-journal';

export function transcript(
  overrides: Partial<TranscriptRevision> & { text: string; utteranceId: UtteranceId },
): TranscriptRevision {
  return {
    isFinal: true,
    revision: 0,
    segments: [
      {
        endMs: 100,
        startMs: 0,
        text: overrides.text,
        timestampGranularity: 'segment',
        timestampSource: 'engine',
      },
    ],
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
    utteranceEndMsInSession: 100,
    utteranceIndex: 0,
    utteranceStartMsInSession: 0,
    ...overrides,
  };
}
