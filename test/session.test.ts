import type { EditorView } from '@codemirror/view';
import type { App, EventRef, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import type { AppendResult, NotePlacementOptions, ReplaceResult } from '../src/editor/note-surface';
import { Session } from '../src/session/session';
import { transcript } from './fixtures/transcript';

class FakeSurface {
  public readonly appendCalls: Array<{ text: string; utteranceId: string }> = [];
  public readonly replaceCalls: Array<{
    expectedOldText: string;
    newText: string;
    utteranceId: string;
  }> = [];
  public readonly dispose = vi.fn();
  public readonly readNoteGlossary = vi.fn(
    (_maxChars: number): { text: string; truncated: boolean } | null => null,
  );
  public readonly setAnchorMode = vi.fn();
  public readonly validateExternalModification = vi.fn();
  public nextAppendResult: AppendResult | null = null;
  public nextReplaceResult: ReplaceResult | null = null;

  append(utteranceId: string, text: string): AppendResult {
    this.appendCalls.push({ text, utteranceId });

    return (
      this.nextAppendResult ?? {
        kind: 'appended',
        span: {
          end: text.length,
          projectedText: text,
          start: 0,
          textEnd: text.length,
          textStart: 0,
          utteranceId,
        },
      }
    );
  }

  replaceAnchor(utteranceId: string, newText: string, expectedOldText: string): ReplaceResult {
    this.replaceCalls.push({ expectedOldText, newText, utteranceId });

    return (
      this.nextReplaceResult ?? {
        kind: 'replaced',
        span: {
          end: newText.length,
          projectedText: newText,
          start: 0,
          textEnd: newText.length,
          textStart: 0,
          utteranceId,
        },
      }
    );
  }
}

describe('Session', () => {
  it('projects new and revised transcripts through append then replace using last projected text', () => {
    const { session, surface } = createSessionHarness();

    expect(
      session.acceptTranscript(transcript({ revision: 0, text: 'rough', utteranceId: 'u1' })),
    ).toEqual({
      kind: 'accepted',
    });
    expect(
      session.acceptTranscript(transcript({ revision: 1, text: 'polished', utteranceId: 'u1' })),
    ).toEqual({
      kind: 'accepted',
    });

    expect(surface.appendCalls).toEqual([{ text: 'rough', utteranceId: 'u1' }]);
    expect(surface.replaceCalls).toEqual([
      { expectedOldText: 'rough', newText: 'polished', utteranceId: 'u1' },
    ]);
  });

  it('does not project duplicate or stale revisions', () => {
    const { session, surface } = createSessionHarness();

    session.acceptTranscript(transcript({ revision: 1, text: 'current', utteranceId: 'u1' }));
    expect(
      session.acceptTranscript(transcript({ revision: 1, text: 'duplicate', utteranceId: 'u1' })),
    ).toEqual({
      kind: 'duplicate',
    });
    expect(
      session.acceptTranscript(transcript({ revision: 0, text: 'stale', utteranceId: 'u1' })),
    ).toEqual({
      kind: 'stale',
    });

    expect(surface.appendCalls).toHaveLength(1);
    expect(surface.replaceCalls).toHaveLength(0);
  });

  it('latches a denied replace and never queues later retries', () => {
    const { session, surface } = createSessionHarness();

    session.acceptTranscript(transcript({ revision: 0, text: 'manual target', utteranceId: 'u1' }));
    surface.nextReplaceResult = {
      currentText: 'manual edit',
      kind: 'denied',
      reason: 'Projected transcript text no longer matches the note.',
      utteranceId: 'u1',
    };
    session.acceptTranscript(transcript({ revision: 1, text: 'replacement', utteranceId: 'u1' }));
    session.acceptTranscript(
      transcript({ revision: 2, text: 'later replacement', utteranceId: 'u1' }),
    );

    expect(surface.replaceCalls).toHaveLength(1);
  });

  it('does not retry projection after an append denial', () => {
    const { session, surface } = createSessionHarness();

    surface.nextAppendResult = {
      kind: 'denied',
      reason: 'Locked note is not open.',
      utteranceId: 'u1',
    };
    session.acceptTranscript(transcript({ revision: 0, text: 'first', utteranceId: 'u1' }));
    session.acceptTranscript(transcript({ revision: 1, text: 'second', utteranceId: 'u1' }));

    expect(surface.appendCalls).toHaveLength(1);
    expect(surface.replaceCalls).toHaveLength(0);
  });

  it('keeps projecting to the locked background note when the active tab changes', () => {
    const { callbacks, lockedFile, session, surface, workspace } = createSessionHarness();
    const otherFile = fakeFile('other.md');

    workspace.activeEditor = fakeActiveEditor(otherFile);
    workspace.trigger('layout-change');
    session.acceptTranscript(transcript({ text: 'background write', utteranceId: 'u1' }));

    expect(callbacks.onLockedNoteClosed).not.toHaveBeenCalled();
    expect(surface.appendCalls).toEqual([{ text: 'background write', utteranceId: 'u1' }]);
    expect(workspace.leaves[0]?.view?.file).toBe(lockedFile);
  });

  it('requests graceful stop when the locked note is no longer open', () => {
    const { callbacks, session, surface, workspace } = createSessionHarness();

    workspace.leaves = [];
    workspace.trigger('layout-change');
    session.acceptTranscript(transcript({ text: 'drained journal only', utteranceId: 'u1' }));

    expect(callbacks.onLockedNoteClosed).toHaveBeenCalledTimes(1);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(surface.appendCalls).toHaveLength(0);
  });

  it('requests cancel on locked-note delete and never writes later transcripts', () => {
    const { callbacks, lockedFile, session, surface, vault } = createSessionHarness();

    vault.trigger('delete', lockedFile);
    session.acceptTranscript(transcript({ text: 'journal only', utteranceId: 'u1' }));

    expect(callbacks.onLockedNoteDeleted).toHaveBeenCalledTimes(1);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(surface.appendCalls).toHaveLength(0);
  });

  it('follows rename by file identity and validates external modifications on the same file', () => {
    const { lockedFile, session, surface, vault } = createSessionHarness();

    lockedFile.path = 'renamed.md';
    vault.trigger('rename', lockedFile, 'note.md');
    vault.trigger('modify', lockedFile);
    session.acceptTranscript(transcript({ text: 'after rename', utteranceId: 'u1' }));

    expect(surface.validateExternalModification).toHaveBeenCalledTimes(1);
    expect(surface.appendCalls).toEqual([{ text: 'after rename', utteranceId: 'u1' }]);
  });

  it('proxies readNoteContext to the active surface', () => {
    const { session, surface } = createSessionHarness();
    surface.readNoteGlossary.mockReturnValueOnce({
      text: 'Glossary: NVIDIA',
      truncated: true,
    });

    expect(session.readNoteContext(256)).toEqual({
      text: 'Glossary: NVIDIA',
      truncated: true,
    });
    expect(surface.readNoteGlossary).toHaveBeenCalledWith(256);
  });

  it('returns null from readNoteContext when the surface is detached', async () => {
    const { session } = createSessionHarness();
    await session.dispose();

    expect(session.readNoteContext(256)).toBeNull();
  });

  it('persists recovery after accepted transcripts and deletes it on dispose', async () => {
    const { adapter, session } = createSessionHarness();

    session.acceptTranscript(transcript({ text: 'recover me', utteranceId: 'u1' }));

    await vi.waitFor(() => {
      expect(adapter.write).toHaveBeenCalledTimes(1);
    });
    expect(adapter.mkdir).toHaveBeenCalledWith('.obsidian/local-transcript');
    expect(adapter.write.mock.calls[0]?.[0]).toBe(
      '.obsidian/local-transcript/recovery-session-1.json',
    );

    adapter.existing.add('.obsidian/local-transcript/recovery-session-1.json');
    await session.dispose();

    expect(adapter.remove).toHaveBeenCalledWith(
      '.obsidian/local-transcript/recovery-session-1.json',
    );
  });
});

function createSessionHarness(): {
  adapter: FakeAdapter;
  callbacks: {
    onLockedNoteClosed: ReturnType<typeof vi.fn>;
    onLockedNoteDeleted: ReturnType<typeof vi.fn>;
  };
  lockedFile: TFile;
  session: Session;
  surface: FakeSurface;
  vault: FakeEvents & { adapter: FakeAdapter; configDir: string };
  workspace: FakeWorkspace;
} {
  const lockedFile = fakeFile('note.md');
  const surface = new FakeSurface();
  const adapter = new FakeAdapter();
  const vault = Object.assign(new FakeEvents(), {
    adapter,
    configDir: '.obsidian',
  });
  const workspace = new FakeWorkspace(lockedFile);
  const callbacks = {
    onLockedNoteClosed: vi.fn(),
    onLockedNoteDeleted: vi.fn(),
  };
  const app = { vault, workspace } as unknown as Pick<App, 'vault' | 'workspace'>;
  const placement: NotePlacementOptions = { anchor: 'at_cursor', separator: 'space' };
  const session = new Session({
    app,
    callbacks,
    lockedFile,
    noteSurfaceFactory: () => surface,
    placement,
    sessionId: 'session-1',
    view: {} as EditorView,
  });

  return { adapter, callbacks, lockedFile, session, surface, vault, workspace };
}

class FakeEvents {
  private nextRef = 0;
  private readonly handlers = new Map<
    string,
    Array<{ handler: (...args: unknown[]) => void; ref: EventRef }>
  >();

  on(name: string, handler: (...args: unknown[]) => void): EventRef {
    const ref = { id: this.nextRef++ } as unknown as EventRef;
    const handlers = this.handlers.get(name) ?? [];
    handlers.push({ handler, ref });
    this.handlers.set(name, handlers);
    return ref;
  }

  offref(ref: EventRef): void {
    for (const [name, handlers] of this.handlers.entries()) {
      this.handlers.set(
        name,
        handlers.filter((entry) => entry.ref !== ref),
      );
    }
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const entry of this.handlers.get(name) ?? []) {
      entry.handler(...args);
    }
  }
}

class FakeWorkspace extends FakeEvents {
  public activeEditor: unknown;
  public leaves: Array<{ view: { editor: { cm: EditorView }; file: TFile } }> = [];

  constructor(file: TFile) {
    super();
    this.activeEditor = fakeActiveEditor(file);
    this.leaves = [this.activeEditor as { view: { editor: { cm: EditorView }; file: TFile } }];
  }

  getLeavesOfType(viewType: string): Array<{ view: { editor: { cm: EditorView }; file: TFile } }> {
    return viewType === 'markdown' ? this.leaves : [];
  }
}

class FakeAdapter {
  public readonly existing = new Set<string>();
  public readonly mkdir = vi.fn(async (path: string) => {
    this.existing.add(path);
  });
  public readonly remove = vi.fn(async (path: string) => {
    this.existing.delete(path);
  });
  public readonly write = vi.fn(async (path: string, _data: string) => {
    this.existing.add(path);
  });

  async exists(path: string): Promise<boolean> {
    return this.existing.has(path);
  }
}

function fakeActiveEditor(file: TFile): { view: { editor: { cm: EditorView }; file: TFile } } {
  return {
    view: {
      editor: { cm: {} as EditorView },
      file,
    },
  };
}

function fakeFile(path: string): TFile {
  return {
    name: path.split('/').at(-1) ?? path,
    parent: null,
    path,
    vault: null,
  } as unknown as TFile;
}
