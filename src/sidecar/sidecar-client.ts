import {
  createRequest,
  type HealthResponsePayload,
  parseResponseLine,
  type RequestPayloadByType,
  type ResponsePayloadByType,
  type SidecarRequestType,
  type SidecarResponse,
  serializeRequest,
  type TranscribeFileRequestPayload,
  type TranscribeFileResponsePayload,
} from './protocol';
import { type ResolveSidecarLaunchSpec, SidecarProcess } from './sidecar-process';

type SidecarLogger = (message: string, error?: unknown) => void;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (payload: unknown) => void;
  timeoutHandle: ReturnType<typeof globalThis.setTimeout>;
  type: SidecarRequestType;
}

interface SidecarClientOptions {
  getRequestTimeoutMs: () => number;
  logger?: SidecarLogger;
  resolveLaunchSpec: ResolveSidecarLaunchSpec;
}

export class SidecarClient {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly process: SidecarProcess;
  private requestCounter = 0;

  constructor(private readonly options: SidecarClientOptions) {
    this.process = new SidecarProcess(options.resolveLaunchSpec, {
      onExit: (code, signal) => {
        this.rejectPendingRequests(
          new Error(
            `Sidecar exited unexpectedly (code: ${String(code)}, signal: ${String(signal)}).`,
          ),
        );
      },
      onStderrLine: (line) => {
        this.log(`sidecar stderr: ${line}`);
      },
      onStdoutLine: (line) => {
        this.handleStdoutLine(line);
      },
    });
  }

  async ensureStarted(): Promise<void> {
    await this.process.start();
  }

  async healthCheck(timeoutMs?: number): Promise<HealthResponsePayload> {
    return this.request('health', {}, timeoutMs);
  }

  async transcribeFile(
    payload: TranscribeFileRequestPayload,
  ): Promise<TranscribeFileResponsePayload> {
    return this.request('transcribe_file', payload);
  }

  async restart(startupTimeoutMs?: number): Promise<HealthResponsePayload> {
    await this.shutdown(startupTimeoutMs);
    await this.ensureStarted();
    return this.healthCheck(startupTimeoutMs);
  }

  async shutdown(timeoutMs?: number): Promise<void> {
    if (!this.process.isRunning()) {
      return;
    }

    try {
      await this.request('shutdown', {}, timeoutMs);
    } finally {
      await this.process.stop();
    }
  }

  private async request<TType extends SidecarRequestType>(
    type: TType,
    payload: RequestPayloadByType[TType],
    timeoutMs = this.options.getRequestTimeoutMs(),
  ): Promise<ResponsePayloadByType[TType]> {
    await this.ensureStarted();

    const requestId = this.nextRequestId();
    const request = createRequest(requestId, type, payload);

    return new Promise<ResponsePayloadByType[TType]>((resolve, reject) => {
      const timeoutHandle = globalThis.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Sidecar request timed out: ${type}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        reject,
        resolve: (responsePayload: unknown) => {
          resolve(responsePayload as ResponsePayloadByType[TType]);
        },
        timeoutHandle,
        type,
      });

      try {
        this.process.writeLine(serializeRequest(request));
      } catch (error) {
        globalThis.clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(asError(error, `Failed to write sidecar request: ${type}`));
      }
    });
  }

  private handleStdoutLine(line: string): void {
    let response: SidecarResponse;

    try {
      response = parseResponseLine(line);
    } catch (error) {
      this.log('failed to parse sidecar stdout line', error);
      return;
    }

    const pendingRequest = this.pendingRequests.get(response.id);

    if (pendingRequest === undefined) {
      this.log(`received sidecar response for unknown request id ${response.id}`);
      return;
    }

    globalThis.clearTimeout(pendingRequest.timeoutHandle);
    this.pendingRequests.delete(response.id);

    if (!response.ok) {
      pendingRequest.reject(
        new Error(
          `${response.error.message}${response.error.details ? ` (${response.error.details})` : ''}`,
        ),
      );
      return;
    }

    pendingRequest.resolve(response.payload);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${String(this.requestCounter).padStart(4, '0')}`;
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pendingRequest] of this.pendingRequests) {
      globalThis.clearTimeout(pendingRequest.timeoutHandle);
      pendingRequest.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private log(message: string, error?: unknown): void {
    this.options.logger?.(message, error);
  }
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
