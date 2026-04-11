import type { EditorPosition } from 'obsidian';

import type { InsertionMode } from '../settings/plugin-settings';

type AppendInsertionMode = Exclude<InsertionMode, 'insert_at_cursor'>;

interface TranscriptPlacementEdit {
  cursor: EditorPosition;
  range: {
    from: EditorPosition;
    to: EditorPosition;
  };
  text: string;
}

export function createDocumentEndPosition(
  lastLineNumber: number,
  lastLineText: string,
): EditorPosition {
  return {
    ch: lastLineText.length,
    line: lastLineNumber,
  };
}

export function resolveAppendTranscriptPlacement({
  documentEnd,
  documentText,
  mode,
  transcript,
}: {
  documentEnd: EditorPosition;
  documentText: string;
  mode: AppendInsertionMode;
  transcript: string;
}): TranscriptPlacementEdit {
  if (documentText.trim().length === 0) {
    const start = { ch: 0, line: 0 };

    return {
      cursor: advancePosition(start, transcript),
      range: {
        from: start,
        to: copyPosition(documentEnd),
      },
      text: transcript,
    };
  }

  const insertedText = `${resolveAppendSeparator(documentText, mode)}${transcript}`;

  return {
    cursor: advancePosition(documentEnd, insertedText),
    range: {
      from: copyPosition(documentEnd),
      to: copyPosition(documentEnd),
    },
    text: insertedText,
  };
}

function advancePosition(start: EditorPosition, text: string): EditorPosition {
  const lines = text.split('\n');

  if (lines.length === 1) {
    return {
      ch: start.ch + text.length,
      line: start.line,
    };
  }

  return {
    ch: lines.at(-1)?.length ?? 0,
    line: start.line + lines.length - 1,
  };
}

function copyPosition(position: EditorPosition): EditorPosition {
  return {
    ch: position.ch,
    line: position.line,
  };
}

function resolveAppendSeparator(documentText: string, mode: AppendInsertionMode): string {
  switch (mode) {
    case 'append_on_new_line':
      return documentText.endsWith('\n') ? '' : '\n';

    case 'append_as_new_paragraph':
      if (documentText.endsWith('\n\n')) {
        return '';
      }

      return documentText.endsWith('\n') ? '\n' : '\n\n';
  }
}
