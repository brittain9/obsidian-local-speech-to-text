import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('node:child_process');
const { detectNvidiaDriver } = await import('../src/sidecar/gpu-precheck');

class FakeChild extends EventEmitter {
  kill = vi.fn();
}

const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

function queueChild(): FakeChild {
  const child = new FakeChild();
  mockedSpawn.mockReturnValueOnce(child);
  return child;
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('detectNvidiaDriver', () => {
  it('returns "present" when nvidia-smi exits successfully', async () => {
    const child = queueChild();
    const promise = detectNvidiaDriver();
    child.emit('exit', 0, null);
    await expect(promise).resolves.toBe('present');
  });

  it('returns "absent" when nvidia-smi is not on PATH', async () => {
    const child = queueChild();
    const promise = detectNvidiaDriver();
    const enoentError = Object.assign(new Error('spawn ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;
    child.emit('error', enoentError);
    await expect(promise).resolves.toBe('absent');
  });

  it('returns "unknown" when nvidia-smi exits with a non-zero code', async () => {
    const child = queueChild();
    const promise = detectNvidiaDriver();
    child.emit('exit', 1, null);
    await expect(promise).resolves.toBe('unknown');
  });

  it('returns "unknown" when spawn errors with something other than ENOENT', async () => {
    const child = queueChild();
    const promise = detectNvidiaDriver();
    const permissionError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    }) as NodeJS.ErrnoException;
    child.emit('error', permissionError);
    await expect(promise).resolves.toBe('unknown');
  });

  it('returns "absent" when spawn itself throws synchronously', async () => {
    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('synchronous failure');
    });
    await expect(detectNvidiaDriver()).resolves.toBe('absent');
  });
});
