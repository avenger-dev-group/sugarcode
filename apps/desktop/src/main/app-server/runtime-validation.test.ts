import { describe, expect, it } from 'vitest';

import {
  parseInitializeResponse,
  parseServerMessage,
} from './runtime-validation';

describe('parseServerMessage', () => {
  it('distinguishes results, errors, notifications, and requests', () => {
    expect(
      parseServerMessage({ jsonrpc: '2.0', id: 1, result: {} }),
    ).toEqual({ kind: 'result', id: 1, result: {} });
    expect(
      parseServerMessage({
        jsonrpc: '2.0',
        id: 'one',
        error: { code: -32602, message: 'Invalid params' },
      }),
    ).toEqual({
      kind: 'error',
      id: 'one',
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(
      parseServerMessage({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: {},
      }),
    ).toEqual({
      kind: 'notification',
      method: 'thread/started',
      params: {},
    });
    expect(
      parseServerMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'approval/request',
        params: {},
      }),
    ).toEqual({
      kind: 'request',
      id: 2,
      method: 'approval/request',
      params: {},
    });
  });

  it.each([
    null,
    [],
    { jsonrpc: '1.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 1, result: {}, error: {} },
    { jsonrpc: '2.0', id: 1, result: {}, extra: true },
    { jsonrpc: '2.0', id: 1.5, result: {} },
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid', extra: true },
    },
  ])('rejects invalid or conflicting envelopes', (value) => {
    expect(() => parseServerMessage(value)).toThrow();
  });
});

describe('parseInitializeResponse', () => {
  it('constructs a typed response while ignoring future optional fields', () => {
    expect(
      parseInitializeResponse({
        protocolVersion: 1,
        serverInfo: {
          name: 'sugarcode',
          version: '1.0.0',
          futureField: true,
        },
        platform: {
          family: 'unix',
          os: 'macos',
          arch: 'aarch64',
        },
        capabilities: { futureCapability: true },
        futureTopLevel: true,
      }),
    ).toEqual({
      protocolVersion: 1,
      serverInfo: { name: 'sugarcode', version: '1.0.0' },
      platform: { family: 'unix', os: 'macos', arch: 'aarch64' },
      capabilities: {},
    });
  });

  it.each([
    {},
    {
      protocolVersion: 1,
      serverInfo: { name: '', version: '1.0.0' },
      platform: { family: 'unix', os: 'macos', arch: 'aarch64' },
      capabilities: {},
    },
    {
      protocolVersion: 1.5,
      serverInfo: { name: 'sugarcode', version: '1.0.0' },
      platform: { family: 'unix', os: 'macos', arch: 'aarch64' },
      capabilities: {},
    },
  ])('rejects invalid initialize results', (value) => {
    expect(() => parseInitializeResponse(value)).toThrow();
  });
});
