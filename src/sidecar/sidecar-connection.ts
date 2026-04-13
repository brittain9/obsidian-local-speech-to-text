import { asError } from '../shared/error-utils';
import type { PluginLogger } from '../shared/plugin-logger';
import {
  createCancelModelInstallCommand,
  createCancelSessionCommand,
  createGetModelStoreCommand,
  createGetSystemInfoCommand,
  createHealthCommand,
  createInstallModelCommand,
  createListInstalledModelsCommand,
  createListModelCatalogCommand,
  createProbeModelSelectionCommand,
  createRemoveModelCommand,
  createSetGateCommand,
  createShutdownCommand,
  createStartSessionCommand,
  createStopSessionCommand,
  type ErrorEvent,
  encodeAudioFrame,
  encodeJsonFrame,
  FramedMessageParser,
  type HealthOkEvent,
  type InstalledModelsEvent,
  JSON_FRAME_KIND,
  type ModelCatalogEvent,
  type ModelInstallUpdateEvent,
  type ModelProbeResultEvent,
  type ModelRemovedEvent,
  type ModelStoreEvent,
  parseEventFrame,
  type SessionStartedEvent,
  type SessionStoppedEvent,
  type SidecarCommand,
  type SidecarEvent,
  type StartSessionCommand,
  type SystemInfoEvent,
} from './protocol';
import { createSidecarStderrLogEntry } from './sidecar-logging';
import { type ResolveSidecarLaunchSpec, SidecarProcess } from './sidecar-process';

type SidecarEventListener = (event: SidecarEvent) => void;

interface PendingEventWaiter {
  description: string;
  matches: (event: SidecarEvent) => boolean;
  rejectOnError: (event: ErrorEvent) => boolean;
  reject: (error: Error) => void;
  resolve: (event: SidecarEvent) => void;
  timeoutHandle: ReturnType<typeof globalThis.setTimeout>;
}

interface SidecarProcessLike {
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  write(frameBytes: Uint8Array): void;
}

interface SidecarConnectionOptions {
  createProcess?: (
    resolveLaunchSpec: ResolveSidecarLaunchSpec,
    handlers: ConstructorParameters<typeof SidecarProcess>[1],
  ) => SidecarProcessLike;
  getRequestTimeoutMs: () => number;
  logger?: PluginLogger;
  resolveLaunchSpec: ResolveSidecarLaunchSpec;
}

export class SidecarConnection {
  private readonly eventListeners = new Set<SidecarEventListener>();
  private readonly frameParser = new FramedMessageParser(parseEventFrame);
  private readonly pendingWaiters = new Set<PendingEventWaiter>();
  private readonly process: SidecarProcessLike;

  constructor(private readonly options: SidecarConnectionOptions) {
    const handlers = {
      onExit: (code: number | null, signal: NodeJS.Signals | null) => {
        this.rejectPendingWaiters(
          new Error(
            `Sidecar exited unexpectedly (code: ${String(code)}, signal: ${String(signal)}).`,
          ),
        );
      },
      onStderrLine: (line: string) => {
        const entry = createSidecarStderrLogEntry(line);

        if (entry !== null) {
          if (entry.level === 'warn') {
            this.options.logger?.warn('sidecar', entry.message);
          } else {
            this.options.logger?.debug('sidecar', entry.message);
          }
        }
      },
      onStdoutChunk: (chunk: Uint8Array) => {
        this.handleStdoutChunk(chunk);
      },
    };

    this.process =
      options.createProcess?.(options.resolveLaunchSpec, handlers) ??
      new SidecarProcess(options.resolveLaunchSpec, handlers);
  }

  async ensureStarted(): Promise<void> {
    await this.process.start();
  }

  async healthCheck(timeoutMs = this.options.getRequestTimeoutMs()): Promise<HealthOkEvent> {
    return this.sendCommandAndWait(
      createHealthCommand(),
      (event): event is HealthOkEvent => event.type === 'health_ok',
      'health_ok',
      timeoutMs,
    );
  }

  async getSystemInfo(timeoutMs = this.options.getRequestTimeoutMs()): Promise<SystemInfoEvent> {
    return this.sendCommandAndWait(
      createGetSystemInfoCommand(),
      (event): event is SystemInfoEvent => event.type === 'system_info',
      'system_info',
      timeoutMs,
    );
  }

  async getModelStore(
    modelStorePathOverride?: string,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelStoreEvent> {
    return this.sendCommandAndWait(
      createGetModelStoreCommand(modelStorePathOverride),
      (event): event is ModelStoreEvent => event.type === 'model_store',
      'model_store',
      timeoutMs,
    );
  }

  async listModelCatalog(
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelCatalogEvent> {
    return this.sendCommandAndWait(
      createListModelCatalogCommand(),
      (event): event is ModelCatalogEvent => event.type === 'model_catalog',
      'model_catalog',
      timeoutMs,
    );
  }

  async listInstalledModels(
    modelStorePathOverride?: string,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<InstalledModelsEvent> {
    return this.sendCommandAndWait(
      createListInstalledModelsCommand(modelStorePathOverride),
      (event): event is InstalledModelsEvent => event.type === 'installed_models',
      'installed_models',
      timeoutMs,
    );
  }

  async probeModelSelection(
    payload: Parameters<typeof createProbeModelSelectionCommand>[0],
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelProbeResultEvent> {
    return this.sendCommandAndWait(
      createProbeModelSelectionCommand(payload),
      (event): event is ModelProbeResultEvent => event.type === 'model_probe_result',
      'model_probe_result',
      timeoutMs,
    );
  }

  async removeModel(
    payload: Parameters<typeof createRemoveModelCommand>[0],
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelRemovedEvent> {
    return this.sendCommandAndWait(
      createRemoveModelCommand(payload),
      (event): event is ModelRemovedEvent =>
        event.type === 'model_removed' &&
        event.engineId === payload.engineId &&
        event.modelId === payload.modelId,
      `model_removed:${payload.engineId}:${payload.modelId}`,
      timeoutMs,
    );
  }

  async installModel(
    payload: Parameters<typeof createInstallModelCommand>[0],
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelInstallUpdateEvent> {
    return this.sendCommandAndWait(
      createInstallModelCommand(payload),
      (event): event is ModelInstallUpdateEvent =>
        event.type === 'model_install_update' &&
        event.installId === payload.installId &&
        (event.state === 'failed' || event.state === 'queued'),
      `model_install_update:${payload.installId}`,
      timeoutMs,
      (event) => event.sessionId === undefined,
    );
  }

  async cancelModelInstall(
    installId: string,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ModelInstallUpdateEvent> {
    return this.sendCommandAndWait(
      createCancelModelInstallCommand(installId),
      (event): event is ModelInstallUpdateEvent =>
        event.type === 'model_install_update' &&
        event.installId === installId &&
        (event.state === 'cancelled' || event.state === 'failed'),
      `model_install_update:${installId}`,
      timeoutMs,
      (event) => event.sessionId === undefined,
    );
  }

  async startSession(
    payload: Omit<StartSessionCommand, 'protocolVersion' | 'type'>,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<SessionStartedEvent> {
    return this.sendCommandAndWait(
      createStartSessionCommand(payload),
      (event): event is SessionStartedEvent =>
        event.type === 'session_started' && event.sessionId === payload.sessionId,
      `session_started:${payload.sessionId}`,
      timeoutMs,
      (event) => !('sessionId' in event) || event.sessionId === payload.sessionId,
    );
  }

  async stopSession(
    sessionId: string,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<SessionStoppedEvent> {
    return this.sendCommandAndWait(
      createStopSessionCommand(),
      (event): event is SessionStoppedEvent =>
        event.type === 'session_stopped' && event.sessionId === sessionId,
      `session_stopped:${sessionId}`,
      timeoutMs,
      (event) => event.sessionId === undefined || event.sessionId === sessionId,
    );
  }

  async cancelSession(
    sessionId: string,
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<SessionStoppedEvent> {
    return this.sendCommandAndWait(
      createCancelSessionCommand(),
      (event): event is SessionStoppedEvent =>
        event.type === 'session_stopped' && event.sessionId === sessionId,
      `session_stopped:${sessionId}`,
      timeoutMs,
      (event) => event.sessionId === undefined || event.sessionId === sessionId,
    );
  }

  async restart(startupTimeoutMs = this.options.getRequestTimeoutMs()): Promise<HealthOkEvent> {
    await this.shutdown();
    await this.ensureStarted();
    return this.healthCheck(startupTimeoutMs);
  }

  async shutdown(): Promise<void> {
    if (!this.process.isRunning()) {
      return;
    }

    try {
      this.process.write(encodeJsonFrame(createShutdownCommand()));
    } finally {
      await this.process.stop();
    }
  }

  sendAudioFrame(frameBytes: Uint8Array): void {
    this.process.write(encodeAudioFrame(frameBytes));
  }

  async setGate(open: boolean): Promise<void> {
    await this.ensureStarted();
    this.process.write(encodeJsonFrame(createSetGateCommand(open)));
  }

  dispose(): void {
    this.eventListeners.clear();
    this.rejectPendingWaiters(new Error('SidecarConnection disposed'));
  }

  subscribe(listener: SidecarEventListener): () => void {
    this.eventListeners.add(listener);

    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private async sendCommandAndWait<TEvent extends SidecarEvent>(
    command: SidecarCommand,
    matches: (event: SidecarEvent) => event is TEvent,
    description: string,
    timeoutMs: number,
    rejectOnError?: (event: ErrorEvent) => boolean,
  ): Promise<TEvent> {
    await this.ensureStarted();

    return new Promise<TEvent>((resolve, reject) => {
      const waiter = this.createPendingWaiter(
        matches,
        description,
        timeoutMs,
        (event) => {
          resolve(event as TEvent);
        },
        reject,
        rejectOnError,
      );

      try {
        this.process.write(encodeJsonFrame(command));
      } catch (error) {
        globalThis.clearTimeout(waiter.timeoutHandle);
        this.pendingWaiters.delete(waiter);
        reject(asError(error, `Failed to write sidecar command: ${command.type}`));
      }
    });
  }

  private createPendingWaiter(
    matches: (event: SidecarEvent) => boolean,
    description: string,
    timeoutMs: number,
    resolve: (event: SidecarEvent) => void,
    reject: (error: Error) => void,
    rejectOnError?: (event: ErrorEvent) => boolean,
  ): PendingEventWaiter {
    const waiter: PendingEventWaiter = {
      description,
      matches,
      reject,
      rejectOnError: rejectOnError ?? (() => true),
      resolve,
      timeoutHandle: globalThis.setTimeout(() => {
        this.pendingWaiters.delete(waiter);
        waiter.reject(new Error(`Timed out waiting for sidecar event: ${description}`));
      }, timeoutMs),
    };

    this.pendingWaiters.add(waiter);
    return waiter;
  }

  private handleStdoutChunk(chunk: Uint8Array): void {
    let parsedFrames: ReturnType<typeof this.frameParser.pushChunk>;

    try {
      parsedFrames = this.frameParser.pushChunk(chunk);
    } catch (error) {
      this.options.logger?.warn('protocol', 'failed to parse sidecar stdout chunk', error);
      this.frameParser.reset();
      return;
    }

    for (const frame of parsedFrames) {
      if (frame.kind !== JSON_FRAME_KIND) {
        this.options.logger?.warn(
          'protocol',
          'received an unexpected audio frame from the sidecar',
        );
        continue;
      }

      this.dispatchEvent(frame.envelope);
    }
  }

  private dispatchEvent(event: SidecarEvent): void {
    if (shouldLogProtocolEvent(event)) {
      this.options.logger?.debug('protocol', summarizeProtocolEvent(event));
    }

    if (event.type === 'model_install_update' && event.state === 'failed') {
      this.options.logger?.warn(
        'model',
        `install ${event.modelId} (${event.installId}) failed`,
        event.message,
        event.details,
      );
    }

    for (const listener of this.eventListeners) {
      listener(event);
    }

    for (const waiter of [...this.pendingWaiters]) {
      if (waiter.matches(event)) {
        globalThis.clearTimeout(waiter.timeoutHandle);
        this.pendingWaiters.delete(waiter);
        waiter.resolve(event);
        continue;
      }

      if (event.type === 'error' && waiter.rejectOnError(event)) {
        globalThis.clearTimeout(waiter.timeoutHandle);
        this.pendingWaiters.delete(waiter);
        waiter.reject(new Error(`${event.message}${event.details ? ` (${event.details})` : ''}`));
      }
    }
  }

  private rejectPendingWaiters(error: Error): void {
    for (const waiter of [...this.pendingWaiters]) {
      globalThis.clearTimeout(waiter.timeoutHandle);
      this.pendingWaiters.delete(waiter);
      waiter.reject(error);
    }
  }
}

function shouldLogProtocolEvent(event: SidecarEvent): boolean {
  switch (event.type) {
    case 'error':
    case 'session_started':
    case 'session_state_changed':
    case 'session_stopped':
    case 'transcript_ready':
    case 'warning':
      return true;
    case 'model_install_update':
      return false;
    default:
      return false;
  }
}

function summarizeProtocolEvent(event: SidecarEvent): string {
  switch (event.type) {
    case 'model_install_update':
      return `event: model_install_update (${event.modelId}, ${event.state})`;
    case 'session_started':
      return `event: session_started (${event.sessionId})`;
    case 'session_state_changed':
      return `event: session_state_changed (${event.sessionId}, ${event.state})`;
    case 'session_stopped':
      return `event: session_stopped (${event.sessionId}, ${event.reason})`;
    case 'transcript_ready':
      return `event: transcript_ready (${event.sessionId}, ${event.text.length} chars)`;
    case 'warning':
      return `event: warning (${event.code})`;
    case 'error':
      return `event: error (${event.code})`;
    default:
      return `event: ${event.type}`;
  }
}
