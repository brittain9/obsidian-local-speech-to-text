import type { EditorView } from '@codemirror/view';
import type { App, Editor, EventRef, TAbstractFile, TFile } from 'obsidian';
import type { DictationAnchorMode } from '../editor/dictation-anchor-extension';
import {
  type AppendResult,
  type NotePlacementOptions,
  NoteSurface,
  type ReplaceResult,
} from '../editor/note-surface';
import type { PluginLogger } from '../shared/plugin-logger';
import { SessionJournal, type TranscriptRevision } from './session-journal';

interface EditorWithCm extends Editor {
  cm?: EditorView;
}

interface MarkdownFileInfoLike {
  editor?: EditorWithCm;
  file: TFile | null;
}

interface MarkdownLeafLike {
  view?: MarkdownFileInfoLike;
}

type ProjectionState =
  | { kind: 'unprojected' }
  | { kind: 'projected'; lastRevision: number; projectedText: string }
  | { kind: 'latched'; lastProjectedRevision?: number; reason: string }
  | { kind: 'denied'; lastAttemptedRevision: number; reason: string };

export type SessionAcceptResult =
  | { kind: 'accepted' }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'stale' };

export interface SessionLifecycleCallbacks {
  onLockedNoteClosed: () => void;
  onLockedNoteDeleted: () => void;
}

export interface SessionDependencies {
  app: Pick<App, 'vault' | 'workspace'>;
  callbacks: SessionLifecycleCallbacks;
  logger?: PluginLogger;
  lockedFile: TFile;
  noteSurfaceFactory?: (view: EditorView, placement: NotePlacementOptions) => NoteSurfaceLike;
  placement: NotePlacementOptions;
  sessionId: string;
  view: EditorView;
}

interface NoteSurfaceLike {
  append(utteranceId: string, text: string): AppendResult;
  dispose(): void;
  readContextBefore(maxChars: number): { text: string; truncated: boolean } | null;
  replaceAnchor(utteranceId: string, newText: string, expectedOldText: string): ReplaceResult;
  setAnchorMode(mode: DictationAnchorMode): void;
  validateExternalModification(): void;
}

export class Session {
  private readonly journal: SessionJournal;
  private disposed = false;
  private noteDeleted = false;
  private noteOpen = true;
  private readonly projectionByUtterance = new Map<string, ProjectionState>();
  private readonly recoveryFilePath: string;
  private recoveryWrite = Promise.resolve();
  private readonly refs: Array<{ offref: (ref: EventRef) => void; ref: EventRef }> = [];
  private surface: NoteSurfaceLike | null;

  static createFromActiveEditor(
    app: Pick<App, 'vault' | 'workspace'>,
    options: {
      callbacks: SessionLifecycleCallbacks;
      logger?: PluginLogger;
      placement: NotePlacementOptions;
      sessionId: string;
    },
  ): Session {
    const target = resolveActiveEditorTarget(app);

    if (target === null) {
      throw new Error('No active Markdown editor is available.');
    }

    return new Session({
      app,
      callbacks: options.callbacks,
      lockedFile: target.file,
      placement: options.placement,
      sessionId: options.sessionId,
      view: target.view,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
  }

  constructor(private readonly dependencies: SessionDependencies) {
    this.journal = new SessionJournal(dependencies.sessionId);
    this.recoveryFilePath = `${dependencies.app.vault.configDir}/local-transcript/recovery-${dependencies.sessionId}.json`;
    this.surface = (dependencies.noteSurfaceFactory ?? createNoteSurface)(
      dependencies.view,
      dependencies.placement,
    );
    this.registerLifecycleSubscriptions();
  }

  acceptTranscript(revision: TranscriptRevision): SessionAcceptResult {
    const result = this.journal.upsert(revision);

    if (result.kind !== 'accepted') {
      if (result.kind === 'rejected') {
        this.dependencies.logger?.warn('session', result.reason);
      }
      return result.kind === 'rejected'
        ? { kind: 'rejected', reason: result.reason }
        : { kind: result.kind };
    }

    this.projectRevision(result.revision);
    this.queueRecoveryPersistence();

    return { kind: 'accepted' };
  }

  readNoteContext(maxChars: number): { text: string; truncated: boolean } | null {
    return this.surface?.readContextBefore(maxChars) ?? null;
  }

  setAnchorMode(mode: DictationAnchorMode): void {
    this.surface?.setAnchorMode(mode);
  }

  async dispose(options: { deleteRecovery: boolean } = { deleteRecovery: true }): Promise<void> {
    this.disposed = true;
    this.journal.finalize();
    this.surface?.dispose();
    this.surface = null;
    this.releaseSubscriptions();
    await this.recoveryWrite;

    if (options.deleteRecovery) {
      await this.deleteRecovery();
    }
  }

  private projectRevision(revision: TranscriptRevision): void {
    if (this.noteDeleted) {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'denied',
        lastAttemptedRevision: revision.revision,
        reason: 'Locked note was deleted.',
      });
      return;
    }

    if (!this.noteOpen || this.surface === null) {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'denied',
        lastAttemptedRevision: revision.revision,
        reason: 'Locked note is not open.',
      });
      return;
    }

    const state = this.projectionByUtterance.get(revision.utteranceId) ?? { kind: 'unprojected' };

    if (state.kind === 'latched' || state.kind === 'denied') {
      return;
    }

    if (state.kind === 'projected') {
      this.applyReplace(revision, state);
      return;
    }

    this.applyAppend(revision);
  }

  private applyAppend(revision: TranscriptRevision): void {
    const result = this.surface?.append(revision.utteranceId, revision.text);

    if (result === undefined) {
      return;
    }

    if (result.kind === 'appended') {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'projected',
        lastRevision: revision.revision,
        projectedText: revision.text,
      });
      return;
    }

    this.projectionByUtterance.set(revision.utteranceId, {
      kind: 'denied',
      lastAttemptedRevision: revision.revision,
      reason: result.reason,
    });
    this.dependencies.logger?.debug('session', `projection append denied: ${result.reason}`);
  }

  private applyReplace(
    revision: TranscriptRevision,
    state: Extract<ProjectionState, { kind: 'projected' }>,
  ): void {
    if (revision.revision <= state.lastRevision) {
      return;
    }

    const result = this.surface?.replaceAnchor(
      revision.utteranceId,
      revision.text,
      state.projectedText,
    );

    if (result === undefined) {
      return;
    }

    if (result.kind === 'replaced') {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'projected',
        lastRevision: revision.revision,
        projectedText: revision.text,
      });
      return;
    }

    if (isLatchReason(result.reason)) {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'latched',
        lastProjectedRevision: state.lastRevision,
        reason: result.reason,
      });
    } else {
      this.projectionByUtterance.set(revision.utteranceId, {
        kind: 'denied',
        lastAttemptedRevision: revision.revision,
        reason: result.reason,
      });
    }
    this.dependencies.logger?.debug('session', `projection replace denied: ${result.reason}`);
  }

  private registerLifecycleSubscriptions(): void {
    const { vault, workspace } = this.dependencies.app;

    this.refs.push({
      offref: (ref) => workspace.offref(ref),
      ref: workspace.on('layout-change', () => {
        this.handleLayoutChange();
      }),
    });
    this.refs.push({
      offref: (ref) => vault.offref(ref),
      ref: vault.on('delete', (file) => {
        this.handleDelete(file);
      }),
    });
    this.refs.push({
      offref: (ref) => vault.offref(ref),
      ref: vault.on('modify', (file) => {
        this.handleModify(file);
      }),
    });
    this.refs.push({
      offref: (ref) => vault.offref(ref),
      ref: vault.on('rename', (file, oldPath) => {
        this.handleRename(file, oldPath);
      }),
    });
  }

  private releaseSubscriptions(): void {
    while (this.refs.length > 0) {
      const subscription = this.refs.pop();
      if (subscription !== undefined) {
        subscription.offref(subscription.ref);
      }
    }
  }

  private handleLayoutChange(): void {
    if (this.noteDeleted || !this.noteOpen) {
      return;
    }

    if (this.hasOpenLockedFile()) {
      return;
    }

    this.noteOpen = false;
    this.surface?.dispose();
    this.surface = null;
    this.dependencies.callbacks.onLockedNoteClosed();
  }

  private handleDelete(file: TAbstractFile): void {
    if (file !== this.dependencies.lockedFile || this.noteDeleted) {
      return;
    }

    this.noteDeleted = true;
    this.noteOpen = false;
    this.surface?.dispose();
    this.surface = null;
    this.dependencies.callbacks.onLockedNoteDeleted();
  }

  private handleModify(file: TAbstractFile): void {
    if (file === this.dependencies.lockedFile) {
      this.surface?.validateExternalModification();
    }
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (file === this.dependencies.lockedFile) {
      this.dependencies.logger?.debug(
        'session',
        `locked note renamed from ${oldPath} to ${file.path}`,
      );
    }
  }

  private hasOpenLockedFile(): boolean {
    return (
      findOpenMarkdownViewForFile(this.dependencies.app, this.dependencies.lockedFile) !== null
    );
  }

  private queueRecoveryPersistence(): void {
    this.recoveryWrite = this.recoveryWrite.then(async () => {
      if (!this.disposed) {
        await this.persistRecovery();
      }
    });
  }

  private async persistRecovery(): Promise<void> {
    const adapter = this.dependencies.app.vault.adapter;
    const directoryPath = `${this.dependencies.app.vault.configDir}/local-transcript`;

    try {
      if (!(await adapter.exists(directoryPath))) {
        await adapter.mkdir(directoryPath);
      }

      await adapter.write(this.recoveryFilePath, JSON.stringify(this.createRecoverySnapshot()));
    } catch (error) {
      this.dependencies.logger?.warn('session', 'failed to persist recovery journal', error);
    }
  }

  private async deleteRecovery(): Promise<void> {
    const adapter = this.dependencies.app.vault.adapter;

    try {
      if (await adapter.exists(this.recoveryFilePath)) {
        await adapter.remove(this.recoveryFilePath);
      }
    } catch (error) {
      this.dependencies.logger?.warn('session', 'failed to delete recovery journal', error);
    }
  }

  private createRecoverySnapshot(): unknown {
    const latest = this.journal.allUtterancesInOrder();

    return {
      latest,
      lockedFilePath: this.dependencies.lockedFile.path,
      projection: Object.fromEntries(this.projectionByUtterance.entries()),
      sessionId: this.dependencies.sessionId,
    };
  }
}

function createNoteSurface(view: EditorView, placement: NotePlacementOptions): NoteSurface {
  return new NoteSurface(view, placement);
}

function resolveActiveEditorTarget(
  app: Pick<App, 'workspace'>,
): { file: TFile; view: EditorView } | null {
  const activeEditor = app.workspace.activeEditor as MarkdownFileInfoLike | null;
  const file = activeEditor?.file ?? null;
  const view = activeEditor?.editor?.cm ?? null;

  if (file === null || view === null) {
    return null;
  }

  return { file, view };
}

function findOpenMarkdownViewForFile(
  app: Pick<App, 'workspace'>,
  lockedFile: TFile,
): MarkdownFileInfoLike | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown') as unknown as MarkdownLeafLike[]) {
    if (leaf.view?.file === lockedFile) {
      return leaf.view;
    }
  }

  return null;
}

function isLatchReason(reason: string): boolean {
  return reason.includes('User edited') || reason.includes('no longer matches');
}
