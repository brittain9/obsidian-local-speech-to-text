import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { setIcon } from 'obsidian';

export type DictationAnchorMode = 'hidden' | 'speaking' | 'processing';

export interface DictationAnchorState {
  pos: number | null;
  mode: DictationAnchorMode;
}

const INITIAL_STATE: DictationAnchorState = { pos: null, mode: 'hidden' };

export const setAnchorEffect = StateEffect.define<number>();
export const clearAnchorEffect = StateEffect.define<null>();
export const setAnchorModeEffect = StateEffect.define<DictationAnchorMode>();

export const dictationAnchorStateField = StateField.define<DictationAnchorState>({
  create: () => INITIAL_STATE,
  update(value, tr) {
    let next: DictationAnchorState = {
      pos: value.pos === null ? null : tr.changes.mapPos(value.pos, -1),
      mode: value.mode,
    };

    for (const effect of tr.effects) {
      if (effect.is(setAnchorEffect)) {
        next = { ...next, pos: effect.value };
      } else if (effect.is(clearAnchorEffect)) {
        next = { pos: null, mode: 'hidden' };
      } else if (effect.is(setAnchorModeEffect)) {
        next = { ...next, mode: effect.value };
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
    return decorationsFor(state.field(dictationAnchorStateField));
  },
  update(value, tr) {
    const prev = tr.startState.field(dictationAnchorStateField);
    const next = tr.state.field(dictationAnchorStateField);
    if (prev.pos === next.pos && prev.mode === next.mode) {
      return value;
    }
    return decorationsFor(next);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorationsFor(state: DictationAnchorState): DecorationSet {
  if (state.pos === null || state.mode === 'hidden') {
    return EMPTY_DECORATIONS;
  }

  const widget = Decoration.widget({
    widget: new DictationAnchorWidget(state.mode),
    side: -1,
  });
  return Decoration.set([widget.range(state.pos)]);
}

export function dictationAnchorExtension(): Extension {
  return [dictationAnchorStateField, dictationAnchorDecorationsField];
}
