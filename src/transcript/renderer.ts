import type { UtteranceId } from '../session/session-journal';
import type { TranscriptFormattingMode } from '../settings/plugin-settings';

export const SMART_PARAGRAPH_PAUSE_MS = 3000;
export const TIMESTAMP_LANDMARK_INTERVAL_MS = 30_000;

export interface TranscriptRenderOptions {
  readonly showTimestamps: boolean;
  readonly transcriptFormatting: TranscriptFormattingMode;
}

export interface TranscriptAppendInput {
  readonly pauseMsBeforeUtterance: number | null;
  readonly text: string;
  readonly utteranceId: UtteranceId;
  readonly utteranceStartMsInSession: number;
}

export interface TranscriptRenderContext {
  readonly tailContent: string;
}

export interface EmittedTimestamp {
  readonly elapsedMs: number;
  readonly text: string;
}

export interface TranscriptInsertProjection {
  readonly emittedTimestamp: EmittedTimestamp | null;
  readonly insertedText: string;
  readonly projectedText: string;
  readonly textEndOffset: number;
  readonly textStartOffset: number;
}

export class TranscriptRenderer {
  private hasRenderedText = false;
  private lastTimestampMsInSession: number | null = null;

  constructor(private readonly options: TranscriptRenderOptions) {}

  planAppend(
    input: TranscriptAppendInput,
    context: TranscriptRenderContext,
  ): TranscriptInsertProjection {
    const boundary = this.formatBoundary(input, context);
    const emittedTimestamp = this.shouldEmitTimestamp(input)
      ? {
          elapsedMs: input.utteranceStartMsInSession,
          text: formatSessionTimestamp(input.utteranceStartMsInSession),
        }
      : null;
    const timestampPrefix = emittedTimestamp === null ? '' : `${emittedTimestamp.text} `;
    const textStartOffset = boundary.length + timestampPrefix.length;
    const projectedText = `${boundary}${timestampPrefix}${input.text}`;

    return {
      emittedTimestamp,
      insertedText: input.text,
      projectedText,
      textEndOffset: textStartOffset + input.text.length,
      textStartOffset,
    };
  }

  commitAppend(projection: TranscriptInsertProjection): void {
    this.hasRenderedText = true;

    if (projection.emittedTimestamp !== null) {
      this.lastTimestampMsInSession = projection.emittedTimestamp.elapsedMs;
    }
  }

  private formatBoundary(input: TranscriptAppendInput, context: TranscriptRenderContext): string {
    if (!this.hasRenderedText) {
      return spaceIfTailAbutsText(context.tailContent);
    }

    switch (this.resolveFormattingMode(input.pauseMsBeforeUtterance)) {
      case 'space':
        return spaceIfTailAbutsText(context.tailContent);
      case 'new_line':
        return missingNewlines(context.tailContent, 1);
      case 'new_paragraph':
        return missingNewlines(context.tailContent, 2);
    }
  }

  private resolveFormattingMode(
    pauseMsBeforeUtterance: number | null,
  ): Exclude<TranscriptFormattingMode, 'smart'> {
    if (this.options.transcriptFormatting !== 'smart') {
      return this.options.transcriptFormatting;
    }

    return isMeaningfulPause(pauseMsBeforeUtterance) ? 'new_paragraph' : 'space';
  }

  private shouldEmitTimestamp(input: TranscriptAppendInput): boolean {
    if (!this.options.showTimestamps) {
      return false;
    }

    if (this.lastTimestampMsInSession === null) {
      return true;
    }

    return (
      isMeaningfulPause(input.pauseMsBeforeUtterance) ||
      input.utteranceStartMsInSession - this.lastTimestampMsInSession >=
        TIMESTAMP_LANDMARK_INTERVAL_MS
    );
  }
}

export function isMeaningfulPause(pauseMsBeforeUtterance: number | null): boolean {
  return pauseMsBeforeUtterance !== null && pauseMsBeforeUtterance >= SMART_PARAGRAPH_PAUSE_MS;
}

export function formatSessionTimestamp(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `(${hours}:${padTwo(minutes)}:${padTwo(seconds)})`;
  }

  return `(${totalMinutes}:${padTwo(seconds)})`;
}

function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

function spaceIfTailAbutsText(tailContent: string): string {
  if (tailContent.length === 0 || /\s$/u.test(tailContent)) {
    return '';
  }

  return ' ';
}

function missingNewlines(tailContent: string, requiredTrailingNewlines: number): string {
  const existingTrailingNewlines = trailingNewlineCount(tailContent);
  const missing = Math.max(0, requiredTrailingNewlines - existingTrailingNewlines);

  return '\n'.repeat(missing);
}

function trailingNewlineCount(value: string): number {
  let count = 0;

  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value.charAt(index) !== '\n') {
      break;
    }
    count += 1;
  }

  return count;
}
