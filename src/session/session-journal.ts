export type UtteranceId = string;

export const STAGE_IDS = [
  'engine',
  'hallucination_filter',
  'llm_transform',
  'punctuation',
  'user_rules',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface TranscriptSegment {
  endMs: number;
  speaker?: string;
  startMs: number;
  text: string;
  timestampGranularity: 'segment' | 'utterance' | 'word';
  timestampSource: 'engine' | 'interpolated' | 'none' | 'vad';
}

export type StageStatus =
  | { kind: 'failed'; error: string }
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: string };

export interface StageOutcome {
  durationMs: number;
  isFinal: boolean;
  payload?: Record<string, unknown>;
  revisionIn: number;
  revisionOut?: number;
  stageId: StageId;
  status: StageStatus;
}

export interface TranscriptRevision {
  isFinal: boolean;
  pauseMsBeforeUtterance: number | null;
  revision: number;
  segments: readonly TranscriptSegment[];
  sessionId: string;
  stageResults: readonly StageOutcome[];
  text: string;
  utteranceEndMsInSession: number;
  utteranceId: UtteranceId;
  utteranceIndex: number;
  utteranceStartMsInSession: number;
}

export type SessionJournalSubscriber = (revision: TranscriptRevision) => void;

export type SessionJournalUpsertResult =
  | {
      kind: 'accepted';
      previous?: TranscriptRevision;
      revision: TranscriptRevision;
    }
  | {
      existing: TranscriptRevision;
      incoming: TranscriptRevision;
      kind: 'duplicate';
    }
  | {
      incoming: TranscriptRevision;
      kind: 'stale';
      latest: TranscriptRevision;
    }
  | {
      incoming: TranscriptRevision;
      kind: 'rejected';
      reason: string;
    };

export class SessionJournal {
  private readonly historyByUtterance = new Map<UtteranceId, TranscriptRevision[]>();
  private readonly latestByUtterance = new Map<UtteranceId, TranscriptRevision>();
  private readonly order: UtteranceId[] = [];
  private readonly subscribers = new Set<SessionJournalSubscriber>();
  private frozen = false;

  constructor(private readonly sessionId: string) {}

  upsert(incoming: TranscriptRevision): SessionJournalUpsertResult {
    const rejectionReason = this.getRejectionReason(incoming);

    if (rejectionReason !== null) {
      return { incoming, kind: 'rejected', reason: rejectionReason };
    }

    const latest = this.latestByUtterance.get(incoming.utteranceId);

    if (latest !== undefined) {
      if (!incoming.isFinal && this.hasAcceptedFinal(incoming.utteranceId)) {
        return { incoming, kind: 'stale', latest };
      }

      if (incoming.revision < latest.revision) {
        return { incoming, kind: 'stale', latest };
      }

      if (incoming.revision === latest.revision) {
        return { existing: latest, incoming, kind: 'duplicate' };
      }
    }

    if (latest === undefined) {
      this.order.push(incoming.utteranceId);
      this.historyByUtterance.set(incoming.utteranceId, []);
    }

    const history = this.historyByUtterance.get(incoming.utteranceId);

    if (history === undefined) {
      return {
        incoming,
        kind: 'rejected',
        reason: `Missing history for utterance ${incoming.utteranceId}.`,
      };
    }

    history.push(incoming);
    this.latestByUtterance.set(incoming.utteranceId, incoming);
    this.notify(incoming);

    if (latest === undefined) {
      return { kind: 'accepted', revision: incoming };
    }

    return { kind: 'accepted', previous: latest, revision: incoming };
  }

  latestForUtterance(utteranceId: UtteranceId): TranscriptRevision | undefined {
    return this.latestByUtterance.get(utteranceId);
  }

  allUtterancesInOrder(): TranscriptRevision[] {
    return this.order
      .map((utteranceId) => this.latestByUtterance.get(utteranceId))
      .filter((revision): revision is TranscriptRevision => revision !== undefined);
  }

  revisionHistoryFor(utteranceId: UtteranceId): TranscriptRevision[] {
    return [...(this.historyByUtterance.get(utteranceId) ?? [])];
  }

  subscribe(callback: SessionJournalSubscriber): () => void {
    this.subscribers.add(callback);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  finalize(): void {
    this.frozen = true;
  }

  get finalized(): boolean {
    return this.frozen;
  }

  private getRejectionReason(revision: TranscriptRevision): string | null {
    if (this.frozen) {
      return 'Session journal is finalized.';
    }

    if (revision.sessionId !== this.sessionId) {
      return `Revision session ${revision.sessionId} does not match journal session ${this.sessionId}.`;
    }

    if (revision.utteranceId.length === 0) {
      return 'Revision utteranceId must not be empty.';
    }

    if (!Number.isInteger(revision.revision) || revision.revision < 0) {
      return 'Revision number must be a non-negative integer.';
    }

    return null;
  }

  private notify(revision: TranscriptRevision): void {
    for (const subscriber of this.subscribers) {
      subscriber(revision);
    }
  }

  private hasAcceptedFinal(utteranceId: UtteranceId): boolean {
    return (this.historyByUtterance.get(utteranceId) ?? []).some((revision) => revision.isFinal);
  }
}
