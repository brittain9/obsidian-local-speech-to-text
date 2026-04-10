import { describe, expect, it } from 'vitest';

import { createSidecarStderrLogEntry } from '../src/sidecar/sidecar-logging';

describe('createSidecarStderrLogEntry', () => {
  it('ignores blank stderr lines', () => {
    expect(createSidecarStderrLogEntry('   ')).toBeNull();
  });

  it('treats routine sidecar traces as debug logs', () => {
    expect(createSidecarStderrLogEntry('[local-stt-sidecar] starting sidecar v0.1.0')).toEqual({
      level: 'debug',
      message: 'sidecar: [local-stt-sidecar] starting sidecar v0.1.0',
    });
  });

  it('treats failure lines as warnings', () => {
    expect(
      createSidecarStderrLogEntry('[local-stt-sidecar] failed to parse request: invalid JSON'),
    ).toEqual({
      level: 'warn',
      message: 'sidecar: [local-stt-sidecar] failed to parse request: invalid JSON',
    });
  });
});
