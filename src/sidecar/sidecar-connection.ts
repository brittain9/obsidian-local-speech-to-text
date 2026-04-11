import {
  createCancelSessionCommand,
  createHealthCommand,
  createSetGateCommand,
  createShutdownCommand,
  createStartSessionCommand,
  createStopSessionCommand,
  type ErrorEvent,
  encodeAudioFrame,
  encodeJsonFrame,
  FramedMessageParser,
  type HealthOkEvent,
  JSON_FRAME_KIND,
  parseEventFrame,
  type SessionStartedEvent,
  type SessionStoppedEvent,
  type SidecarCommand,
  type SidecarEvent,
  type StartSessionCommand,
} from './protocol';
import { createSidecarStderrLogEntry, type SidecarLogEntry } from './sidecar-logging';
import { type ResolveSidecarLaunchSpec, SidecarProcess } from './sidecar-process';

type SidecarEventListener = (event: SidecarEvent) => void;
type SidecarLogger = (entry: SidecarLogEntry) => void;

interface PendingEventWaiter {
  description: string;
  matches: (event: SidecarEvent) => boolean;
  rejectOnError: (event: ErrorEvent) => boolean;
  reject: (error: Error) => void;
  resolve: (event: SidecarEvent) => void;
  timeoutHandle: ReturnType<typeof globalThis.setTimeout>;
}

interface SidecarConnectionOptions {
  getRequestTimeoutMs: () => number;
  logger?: SidecarLogger;
  resolveLaunchSpec: ResolveSidecarLaunchSpec;
}

export class SidecarConnection {
  private readonly eventListeners = new Set<SidecarEventListener>();
  private readonly frameParser = new FramedMessageParser(parseEventFrame);
  private readonly pendingWaiters = new Set<PendingEventWaiter>();
  private readonly process: SidecarProcess;

  constructor(private readonly options: SidecarConnectionOptions) {
    this.process = new SidecarProcess(options.resolveLaunchSpec, {
      onExit: (code, signal) => {
        this.rejectPendingWaiters(
          new Error(
            `Sidecar exited unexpectedly (code: ${String(code)}, signal: ${String(signal)}).`,
          ),
        );
      },
      onStderrLine: (line) => {
        const entry = createSidecarStderrLogEntry(line);

        if (entry !== null) {
          this.log(entry);
        }
      },
      onStdoutChunk: (chunk) => {
        this.handleStdoutChunk(chunk);
      },
    });
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
    );
  }

  async stopSession(timeoutMs = this.options.getRequestTimeoutMs()): Promise<SessionStoppedEvent> {
    return this.sendCommandAndWait(
      createStopSessionCommand(),
      (event): event is SessionStoppedEvent => event.type === 'session_stopped',
      'session_stopped',
      timeoutMs,
    );
  }

  async cancelSession(
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<SessionStoppedEvent> {
    return this.sendCommandAndWait(
      createCancelSessionCommand(),
      (event): event is SessionStoppedEvent => event.type === 'session_stopped',
      'session_stopped',
      timeoutMs,
    );
  }

  async restart(startupTimeoutMs = this.options.getRequestTimeoutMs()): Promise<HealthOkEvent> {
    await this.shutdown(startupTimeoutMs);
    await this.ensureStarted();
    return this.healthCheck(startupTimeoutMs);
  }

  async shutdown(_timeoutMs = this.options.getRequestTimeoutMs()): Promise<void> {
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
  ): PendingEventWaiter {
    const waiter: PendingEventWaiter = {
      description,
      matches,
      reject,
      rejectOnError: () => true,
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
      this.log({
        level: 'warn',
        message: 'failed to parse sidecar stdout chunk',
        error,
      });
      return;
    }

    for (const frame of parsedFrames) {
      if (frame.kind !== JSON_FRAME_KIND) {
        this.log({
          level: 'warn',
          message: 'received an unexpected audio frame from the sidecar',
        });
        continue;
      }

      this.dispatchEvent(frame.envelope);
    }
  }

  private dispatchEvent(event: SidecarEvent): void {
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
    for (const waiter of this.pendingWaiters) {
      globalThis.clearTimeout(waiter.timeoutHandle);
      waiter.reject(error);
      this.pendingWaiters.delete(waiter);
    }
  }

  private log(entry: SidecarLogEntry): void {
    this.options.logger?.(entry);
  }
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
