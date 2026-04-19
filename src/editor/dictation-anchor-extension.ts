import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { setIcon } from 'obsidian';

export type DictationAnchorMode = 'hidden' | 'speaking' | 'processing';

export interface DictationAnchorState {
  hideWhenCursorOverlaps: boolean;
  pos: number | null;
  mode: DictationAnchorMode;
}

const INITIAL_STATE: DictationAnchorState = {
  hideWhenCursorOverlaps: false,
  pos: null,
  mode: 'hidden',
};

export const setAnchorEffect = StateEffect.define<number>();
export const clearAnchorEffect = StateEffect.define<null>();
export const setAnchorModeEffect = StateEffect.define<DictationAnchorMode>();
export const setAnchorHideWhenCursorOverlapsEffect = StateEffect.define<boolean>();

export const dictationAnchorStateField = StateField.define<DictationAnchorState>({
  create: () => INITIAL_STATE,
  update(value, tr) {
    let next: DictationAnchorState = {
      hideWhenCursorOverlaps: value.hideWhenCursorOverlaps,
      pos: value.pos === null ? null : tr.changes.mapPos(value.pos, -1),
      mode: value.mode,
    };

    for (const effect of tr.effects) {
      if (effect.is(setAnchorEffect)) {
        next = { ...next, pos: effect.value };
      } else if (effect.is(clearAnchorEffect)) {
        next = INITIAL_STATE;
      } else if (effect.is(setAnchorModeEffect)) {
        next = { ...next, mode: effect.value };
      } else if (effect.is(setAnchorHideWhenCursorOverlapsEffect)) {
        next = { ...next, hideWhenCursorOverlaps: effect.value };
      }
    }

    return next;
  },
});

class DictationAnchorWidget extends WidgetType {
  constructor(private readonly mode: Exclude<DictationAnchorMode, 'hidden'>) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof DictationAnchorWidget && other.mode === this.mode;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `local-stt-dictation-anchor local-stt-dictation-anchor--${this.mode}`;
    span.setAttribute('aria-hidden', 'true');
    if (this.mode === 'processing') {
      setIcon(span, 'loader-2');
    }
    return span;
  }
}

const EMPTY_DECORATIONS: DecorationSet = Decoration.none;

export const dictationAnchorDecorationsField = StateField.define<DecorationSet>({
  create(state) {
    return decorationsFor(state);
  },
  update(value, tr) {
    void value;
    return decorationsFor(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorationsFor(state: EditorState): DecorationSet {
  const anchor = state.field(dictationAnchorStateField);

  if (anchor.pos === null || anchor.mode === 'hidden') {
    return EMPTY_DECORATIONS;
  }

  if (
    anchor.mode === 'speaking' &&
    anchor.hideWhenCursorOverlaps &&
    state.selection.main.empty &&
    state.selection.main.head === anchor.pos
  ) {
    return EMPTY_DECORATIONS;
  }

  const widget = Decoration.widget({
    widget: new DictationAnchorWidget(anchor.mode),
    side: -1,
  });
  return Decoration.set([widget.range(anchor.pos)]);
}

export function dictationAnchorExtension(): Extension {
  return [dictationAnchorStateField, dictationAnchorDecorationsField];
}
