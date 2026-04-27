import type { Extension } from '@codemirror/state';
import { Transaction } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

import type { UtteranceId } from '../session/session-journal';
import type { DictationAnchor, PhraseSeparator } from '../settings/plugin-settings';
import {
  clearAnchorEffect,
  type DictationAnchorMode,
  setAnchorEffect,
  setAnchorModeEffect,
} from './dictation-anchor-extension';
import { computeFirstPhrasePrefix, computePhraseSeparators } from './transcript-placement';

export interface NotePlacementOptions {
  anchor: DictationAnchor;
  separator: PhraseSeparator;
}

export interface ProjectedSpan {
  end: number;
  latchedReason?: string;
  projectedText: string;
  start: number;
  textEnd: number;
  textStart: number;
  utteranceId: UtteranceId;
}

export type AppendResult =
  | {
      kind: 'appended';
      span: ProjectedSpan;
    }
  | {
      kind: 'denied';
      reason: string;
      utteranceId: UtteranceId;
    };

export type ReplaceResult =
  | {
      kind: 'replaced';
      span: ProjectedSpan;
    }
  | {
      currentText?: string;
      kind: 'denied';
      reason: string;
      utteranceId: UtteranceId;
    };

export interface RewriteRange {
  from: number;
  to: number;
}

export interface PreservedSpan {
  utteranceId: UtteranceId;
}

export type RewriteResult =
  | {
      kind: 'rewritten';
      range: RewriteRange;
    }
  | {
      kind: 'denied';
      reason: string;
    };

let activeNoteSurface: NoteSurface | null = null;

export function setActiveNoteSurface(surface: NoteSurface | null): void {
  activeNoteSurface = surface;
}

export function noteSurfaceUpdateListenerExtension(): Extension {
  return EditorView.updateListener.of((update) => {
    if (activeNoteSurface !== null && update.view === activeNoteSurface.view) {
      activeNoteSurface.observeTransaction(update);
    }
  });
}

export class NoteSurface {
  private disposed = false;
  private firstPhrase = true;
  private initialAnchorPos: number;
  private pendingTrailingContent = '';
  private readonly spans = new Map<UtteranceId, ProjectedSpan>();

  constructor(
    readonly view: EditorView,
    private readonly placement: NotePlacementOptions,
  ) {
    this.initialAnchorPos = this.computePinPosition();
    this.insertInitialPrefix();
    this.view.dispatch({ effects: setAnchorEffect.of(this.initialAnchorPos) });
    setActiveNoteSurface(this);
  }

  observeTransaction(update: ViewUpdate): void {
    if (this.disposed || update.view !== this.view || !update.docChanged) {
      return;
    }

    const spansBefore = [...this.spans.values()].map(cloneSpan);

    this.mapSpans(update);

    if (!this.hasLatchableUserChange(update)) {
      return;
    }

    for (const before of spansBefore) {
      const current = this.spans.get(before.utteranceId);

      if (current === undefined || current.latchedReason !== undefined) {
        continue;
      }

      if (changeIntersectsSpan(update, before)) {
        current.latchedReason = 'User edited projected transcript text.';
      }
    }
  }

  append(utteranceId: UtteranceId, text: string): AppendResult {
    if (this.disposed) {
      return { kind: 'denied', reason: 'Note surface is disposed.', utteranceId };
    }

    if (this.spans.has(utteranceId)) {
      return { kind: 'denied', reason: 'Utterance is already projected.', utteranceId };
    }

    const { prefix, trailing } = computePhraseSeparators({
      isFirstPhrase: this.firstPhrase,
      separator: this.placement.separator,
    });
    const from = this.writingRegionTail();
    const insertedText = `${prefix}${text}${trailing}`;
    const textStart = from + prefix.length;
    const textEnd = textStart + text.length;
    const to = from + insertedText.length;

    this.view.dispatch({
      changes: { from, insert: insertedText },
      effects: [setAnchorEffect.of(to), EditorView.scrollIntoView(to, { y: 'nearest' })],
    });

    const span: ProjectedSpan = {
      end: to,
      projectedText: text,
      start: from,
      textEnd,
      textStart,
      utteranceId,
    };
    this.spans.set(utteranceId, span);
    this.pendingTrailingContent = trailing;
    this.firstPhrase = false;

    return { kind: 'appended', span: cloneSpan(span) };
  }

  replaceAnchor(utteranceId: UtteranceId, newText: string, expectedOldText: string): ReplaceResult {
    if (this.disposed) {
      return { kind: 'denied', reason: 'Note surface is disposed.', utteranceId };
    }

    const span = this.spans.get(utteranceId);

    if (span === undefined) {
      return { kind: 'denied', reason: 'Utterance anchor was not found.', utteranceId };
    }

    if (span.latchedReason !== undefined) {
      return { kind: 'denied', reason: span.latchedReason, utteranceId };
    }

    const currentText = this.view.state.doc.sliceString(span.textStart, span.textEnd);

    if (currentText !== expectedOldText || currentText !== span.projectedText) {
      span.latchedReason = 'Projected transcript text no longer matches the note.';
      return {
        currentText,
        kind: 'denied',
        reason: span.latchedReason,
        utteranceId,
      };
    }

    this.view.dispatch({
      changes: { from: span.textStart, to: span.textEnd, insert: newText },
      effects: [
        setAnchorEffect.of(span.textStart + newText.length),
        EditorView.scrollIntoView(span.textStart + newText.length, { y: 'nearest' }),
      ],
    });

    const delta = newText.length - span.projectedText.length;
    span.textEnd = span.textStart + newText.length;
    span.end += delta;
    span.projectedText = newText;
    this.pendingTrailingContent = this.trailingContentFor(span);

    return { kind: 'replaced', span: cloneSpan(span) };
  }

  rewriteRegion(
    range: RewriteRange,
    newText: string,
    preservedSpans: PreservedSpan[],
  ): RewriteResult {
    if (this.disposed) {
      return { kind: 'denied', reason: 'Note surface is disposed.' };
    }

    if (!this.isValidRange(range)) {
      return { kind: 'denied', reason: 'Rewrite range is outside the current document.' };
    }

    const preserved = new Set(preservedSpans.map((span) => span.utteranceId));
    const overlappingSpans = [...this.spans.values()].filter((span) =>
      rangeIntersects(range.from, range.to, span.start, span.end),
    );
    const spansInRange = overlappingSpans.filter(
      (span) => span.start >= range.from && span.end <= range.to,
    );

    if (overlappingSpans.length !== spansInRange.length) {
      return { kind: 'denied', reason: 'Rewrite range intersects a partial utterance span.' };
    }

    for (const span of spansInRange) {
      if (span.latchedReason !== undefined && !preserved.has(span.utteranceId)) {
        return { kind: 'denied', reason: span.latchedReason };
      }

      if (this.view.state.doc.sliceString(span.textStart, span.textEnd) !== span.projectedText) {
        span.latchedReason = 'Projected transcript text no longer matches the note.';
        return { kind: 'denied', reason: span.latchedReason };
      }
    }

    this.view.dispatch({ changes: { from: range.from, to: range.to, insert: newText } });
    for (const span of spansInRange) {
      this.spans.delete(span.utteranceId);
    }
    this.pendingTrailingContent = '';

    return { kind: 'rewritten', range };
  }

  validateExternalModification(): void {
    if (this.disposed) {
      return;
    }

    for (const span of this.spans.values()) {
      if (span.latchedReason !== undefined) {
        continue;
      }

      if (this.view.state.doc.sliceString(span.textStart, span.textEnd) !== span.projectedText) {
        span.latchedReason = 'Projected transcript text no longer matches the note.';
      }
    }
  }

  latchAll(reason: string): void {
    for (const span of this.spans.values()) {
      span.latchedReason = reason;
    }
  }

  setAnchorMode(mode: DictationAnchorMode): void {
    if (!this.disposed) {
      this.view.dispatch({ effects: setAnchorModeEffect.of(mode) });
    }
  }

  trimPendingTrailingContent(): void {
    if (this.disposed || this.pendingTrailingContent.length === 0) {
      return;
    }

    const pending = this.pendingTrailingContent;
    const tail = this.writingRegionTail();
    const start = tail - pending.length;

    if (start >= 0 && this.view.state.doc.sliceString(start, tail) === pending) {
      this.view.dispatch({ changes: { from: start, to: tail, insert: '' } });

      const lastSpan = this.lastSpan();

      if (lastSpan !== null && lastSpan.end === tail) {
        lastSpan.end = start;
      }
    }

    this.pendingTrailingContent = '';
  }

  dispose(): void {
    this.trimPendingTrailingContent();
    this.view.dispatch({ effects: clearAnchorEffect.of(null) });
    this.disposed = true;

    if (activeNoteSurface === this) {
      setActiveNoteSurface(null);
    }
  }

  getSpan(utteranceId: UtteranceId): ProjectedSpan | undefined {
    const span = this.spans.get(utteranceId);
    return span === undefined ? undefined : cloneSpan(span);
  }

  readContextBefore(maxChars: number): { text: string; truncated: boolean } | null {
    if (this.disposed || maxChars <= 0) {
      return null;
    }

    const tail = this.writingRegionTail();
    const rawStart = Math.max(0, tail - maxChars);
    const raw = this.view.state.doc.sliceString(rawStart, tail);
    const cutFromStart = rawStart > 0;

    const text = cutFromStart ? trimLeadingPartialWord(raw) : raw.trimStart();

    if (text.length === 0) {
      return null;
    }

    return { text, truncated: cutFromStart };
  }

  private insertInitialPrefix(): void {
    const charBeforeAnchor =
      this.initialAnchorPos > 0
        ? this.view.state.doc.sliceString(this.initialAnchorPos - 1, this.initialAnchorPos)
        : null;
    const prefix = computeFirstPhrasePrefix({
      anchor: this.placement.anchor,
      charBeforeAnchor,
    });

    if (prefix.length === 0) {
      return;
    }

    const from = this.initialAnchorPos;
    this.view.dispatch({ changes: { from, insert: prefix } });
    this.initialAnchorPos += prefix.length;
    this.pendingTrailingContent = prefix;
  }

  private computePinPosition(): number {
    if (this.placement.anchor === 'end_of_note') {
      return this.view.state.doc.length;
    }

    return this.view.state.selection.main.head;
  }

  private writingRegionTail(): number {
    return Math.max(this.initialAnchorPos, ...[...this.spans.values()].map((span) => span.end));
  }

  private lastSpan(): ProjectedSpan | null {
    let last: ProjectedSpan | null = null;

    for (const span of this.spans.values()) {
      if (last === null || span.end > last.end) {
        last = span;
      }
    }

    return last;
  }

  private mapSpans(update: ViewUpdate): void {
    for (const span of this.spans.values()) {
      span.start = update.changes.mapPos(span.start, -1);
      span.textStart = update.changes.mapPos(span.textStart, -1);
      span.textEnd = update.changes.mapPos(span.textEnd, 1);
      span.end = update.changes.mapPos(span.end, 1);
    }

    this.initialAnchorPos = update.changes.mapPos(this.initialAnchorPos, -1);
  }

  private hasLatchableUserChange(update: ViewUpdate): boolean {
    return update.transactions.some((transaction) => {
      if (transaction.annotation(Transaction.userEvent) === undefined) {
        return false;
      }

      return !transaction.isUserEvent('undo') && !transaction.isUserEvent('redo');
    });
  }

  private isValidRange(range: RewriteRange): boolean {
    return (
      Number.isInteger(range.from) &&
      Number.isInteger(range.to) &&
      range.from >= 0 &&
      range.to >= range.from &&
      range.to <= this.view.state.doc.length
    );
  }

  private trailingContentFor(span: ProjectedSpan): string {
    if (span.end <= span.textEnd) {
      return '';
    }

    return this.view.state.doc.sliceString(span.textEnd, span.end);
  }
}

function changeIntersectsSpan(update: ViewUpdate, span: ProjectedSpan): boolean {
  let intersects = false;

  update.changes.iterChangedRanges((fromA, toA) => {
    if (intersects) {
      return;
    }

    intersects = rangeIntersects(fromA, toA, span.start, span.end);
  });

  return intersects;
}

function rangeIntersects(
  changeFrom: number,
  changeTo: number,
  spanFrom: number,
  spanTo: number,
): boolean {
  if (changeFrom === changeTo) {
    return changeFrom > spanFrom && changeFrom < spanTo;
  }

  return changeFrom < spanTo && changeTo > spanFrom;
}

function cloneSpan(span: ProjectedSpan): ProjectedSpan {
  return { ...span };
}

function trimLeadingPartialWord(text: string): string {
  if (text.length === 0) {
    return text;
  }

  if (/\s/u.test(text.charAt(0))) {
    return text.trimStart();
  }

  const match = text.search(/\s/u);

  return match === -1 ? '' : text.slice(match).trimStart();
}
