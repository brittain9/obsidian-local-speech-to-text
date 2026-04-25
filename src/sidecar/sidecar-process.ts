import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';

import { Platform } from 'obsidian';

export interface SidecarLaunchSpec {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface SidecarProcessHandlers {
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderrLine: (line: string) => void;
  onStdoutChunk: (chunk: Uint8Array) => void;
}

export type ResolveSidecarLaunchSpec = () => Promise<SidecarLaunchSpec>;

export class SidecarProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private stderrReader: ReadLineInterface | null = null;
  private stdinDead = false;

  constructor(
    private readonly resolveLaunchSpec: ResolveSidecarLaunchSpec,
    private readonly handlers: SidecarProcessHandlers,
  ) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    if (this.startPromise !== null) {
      return this.startPromise;
    }

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    assertDesktopRuntime();

    const launchSpec = await this.resolveLaunchSpec();
    const child = spawn(launchSpec.command, launchSpec.args ?? [], {
      cwd: launchSpec.cwd,
      env: launchSpec.env ? { ...process.env, ...launchSpec.env } : undefined,
      stdio: 'pipe',
    });

    await waitForSpawn(child);

    this.stdinDead = false;
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      this.stdinDead = true;

      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        this.handlers.onStderrLine(`stdin error: ${error.message} (${error.code})`);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: Uint8Array) => {
      this.handlers.onStdoutChunk(chunk);
    });

    this.child = child;
    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on('line', this.handlers.onStderrLine);

    child.once('exit', (code, signal) => {
      this.disposeReaders();
      child.stdout.removeAllListeners('data');
      this.child = null;
      this.handlers.onExit(code, signal);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;

    if (child === null) {
      return;
    }

    if (child.stdin.writable) {
      child.stdin.end();
    }

    if (child.exitCode !== null) {
      return;
    }

    await waitForExit(child);
  }

  write(frameBytes: Uint8Array): void {
    const child = this.child;

    if (child === null || this.stdinDead || !child.stdin.writable) {
      throw new Error('Sidecar process is not running.');
    }

    child.stdin.write(frameBytes);
  }

  private disposeReaders(): void {
    this.stderrReader?.close();
    this.stderrReader = null;
  }
}

function assertDesktopRuntime(): void {
  if (!Platform.isDesktopApp) {
    throw new Error('Local Transcript sidecar support requires Obsidian desktop.');
  }
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('spawn', onSpawn);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onSpawn = () => {
      cleanup();
      resolve();
    };

    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeoutHandle = globalThis.setTimeout(() => {
      child.kill();
      resolve();
    }, 2_000);

    child.once('exit', () => {
      globalThis.clearTimeout(timeoutHandle);
      resolve();
    });
  });
}
