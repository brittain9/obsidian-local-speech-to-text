export type UtteranceId = string;

export const STAGE_IDS = ['engine', 'hallucination_filter', 'punctuation', 'user_rules'] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface TranscriptSegment {
  endMs: number;
  speaker?: string;
  startMs: number;
  text: string;
}

export type StageStatus =
  | { kind: 'failed'; error: string }
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: string };

export interface StageOutcome {
  durationMs: number;
  payload?: Record<string, unknown>;
  revisionIn: number;
  revisionOut?: number;
  stageId: StageId;
  status: StageStatus;
}

export interface TranscriptRevision {
  isFinal: boolean;
  revision: number;
  segments: readonly TranscriptSegment[];
  sessionId: string;
  stageResults: readonly StageOutcome[];
  text: string;
  utteranceId: UtteranceId;
}

export interface ContextWindowSpec {
  maxChars: number;
}

export interface ContextWindowSource {
  endRevision: number;
  kind: 'session_utterance';
  text: string;
  truncated: boolean;
  utteranceId: UtteranceId;
}

export interface ContextWindow {
  budgetChars: number;
  sources: readonly ContextWindowSource[];
  text: string;
  truncated: boolean;
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

  assembleContext(spec: ContextWindowSpec): ContextWindow | null {
    const budgetChars = Math.max(0, Math.floor(spec.maxChars));

    if (budgetChars === 0) {
      return null;
    }

    const finalized = this.allUtterancesInOrder().filter((revision) => revision.isFinal);
    const selected: ContextWindowSource[] = [];
    let remaining = budgetChars;
    let truncated = false;

    for (let index = finalized.length - 1; index >= 0; index -= 1) {
      const revision = finalized[index];

      if (revision === undefined) {
        continue;
      }

      const separatorChars = selected.length === 0 ? 0 : 1;
      const availableForText = remaining - separatorChars;

      if (availableForText <= 0) {
        break;
      }

      if (revision.text.length <= availableForText) {
        selected.unshift(toContextSource(revision, revision.text, false));
        remaining -= revision.text.length + separatorChars;
        continue;
      }

      if (selected.length === 0) {
        const truncatedText = truncateAtWordBoundary(revision.text, availableForText);

        if (truncatedText.length > 0) {
          selected.unshift(toContextSource(revision, truncatedText, true));
          truncated = true;
        }
      }

      break;
    }

    if (selected.length === 0) {
      return null;
    }

    return {
      budgetChars,
      sources: selected,
      text: selected.map((source) => source.text).join('\n'),
      truncated,
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
}

function toContextSource(
  revision: TranscriptRevision,
  text: string,
  truncated: boolean,
): ContextWindowSource {
  return {
    endRevision: revision.revision,
    kind: 'session_utterance',
    text,
    truncated,
    utteranceId: revision.utteranceId,
  };
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  const candidate = text.slice(0, maxChars).trimEnd();

  if (candidate.length === text.length) {
    return candidate;
  }

  const nextCharacter = text.charAt(candidate.length);

  if (nextCharacter.length === 0 || /\s/u.test(nextCharacter)) {
    return candidate;
  }

  const boundary = candidate.lastIndexOf(' ');

  if (boundary > 0) {
    return candidate.slice(0, boundary).trimEnd();
  }

  return '';
}
