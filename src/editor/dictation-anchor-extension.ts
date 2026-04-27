import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export type DictationAnchorMode = 'hidden' | 'visible';

export interface DictationAnchorState {
  pos: number | null;
  mode: DictationAnchorMode;
}

const INITIAL_STATE: DictationAnchorState = {
  pos: null,
  mode: 'hidden',
};

export const setAnchorEffect = StateEffect.define<number>();
export const clearAnchorEffect = StateEffect.define<null>();
export const setAnchorModeEffect = StateEffect.define<DictationAnchorMode>();

export const dictationAnchorStateField = StateField.define<DictationAnchorState>({
  create: () => INITIAL_STATE,
  update(value, tr) {
    if (tr.effects.length === 0 && tr.changes.empty) {
      return value;
    }

    let next: DictationAnchorState = value;
    if (value.pos !== null && !tr.changes.empty) {
      // Tail bias: insertions at the anchor extend the writing region (D-014).
      const mapped = tr.changes.mapPos(value.pos, 1);
      if (mapped !== value.pos) {
        next = { ...next, pos: mapped };
      }
    }

    for (const effect of tr.effects) {
      if (effect.is(setAnchorEffect)) {
        next = { ...next, pos: effect.value };
      } else if (effect.is(clearAnchorEffect)) {
        next = INITIAL_STATE;
      } else if (effect.is(setAnchorModeEffect)) {
        next = { ...next, mode: effect.value };
      }
    }

    return next;
  },
});

class DictationAnchorWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof DictationAnchorWidget;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'local-stt-dictation-anchor local-stt-dictation-anchor--visible';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

const EMPTY_DECORATIONS: DecorationSet = Decoration.none;

const VISIBLE_DECORATION = Decoration.widget({
  widget: new DictationAnchorWidget(),
  side: -1,
});

export const dictationAnchorDecorationsField = StateField.define<DecorationSet>({
  create(state) {
    return decorationsFor(state);
  },
  update(value, tr) {
    const prev = tr.startState.field(dictationAnchorStateField, false);
    const next = tr.state.field(dictationAnchorStateField, false);
    if (prev === next) {
      return value;
    }
    return decorationsFor(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorationsFor(state: EditorState): DecorationSet {
  const anchor = state.field(dictationAnchorStateField, false);

  if (anchor === undefined || anchor.pos === null || anchor.mode === 'hidden') {
    return EMPTY_DECORATIONS;
  }

  return Decoration.set([VISIBLE_DECORATION.range(anchor.pos)]);
}

export function dictationAnchorExtension(): Extension {
  return [dictationAnchorStateField, dictationAnchorDecorationsField];
}
