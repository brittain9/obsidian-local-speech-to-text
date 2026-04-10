import { describe, expect, it } from 'vitest';

import {
  createRequest,
  parseResponseLine,
  SIDECAR_PROTOCOL_VERSION,
  serializeRequest,
} from '../src/sidecar/protocol';

describe('sidecar protocol', () => {
  it('serializes requests with the pinned protocol version', () => {
    const request = createRequest('req-0001', 'health', {});

    expect(JSON.parse(serializeRequest(request))).toEqual({
      id: 'req-0001',
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      type: 'health',
      payload: {},
    });
  });

  it('parses a successful health response', () => {
    const response = parseResponseLine(
      JSON.stringify({
        id: 'req-0001',
        ok: true,
        payload: {
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          sidecarVersion: '0.1.0',
          status: 'ready',
        },
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        type: 'health',
      }),
    );

    expect(response).toEqual({
      id: 'req-0001',
      ok: true,
      payload: {
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        sidecarVersion: '0.1.0',
        status: 'ready',
      },
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      type: 'health',
    });
  });

  it('rejects responses with an unexpected protocol version', () => {
    expect(() =>
      parseResponseLine(
        JSON.stringify({
          id: 'req-0001',
          ok: true,
          payload: {
            protocolVersion: 'v0',
            sidecarVersion: '0.1.0',
            status: 'ready',
          },
          protocolVersion: 'v0',
          type: 'health',
        }),
      ),
    ).toThrow('Unsupported sidecar protocol version');
  });
});
