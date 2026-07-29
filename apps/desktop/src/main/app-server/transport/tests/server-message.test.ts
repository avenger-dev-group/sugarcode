import { describe, expect, it } from 'vitest';

import {
  parseInitializeResponse,
  parseServerMessage,
  parseWorkspaceInspectResponse,
  parseWorkspaceListResponse,
} from '../server-message';

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
        capabilities: {
          commandApprovals: true,
          commandWorkspaceWriteApprovals: true,
          futureCapability: true,
        },
        futureTopLevel: true,
      }),
    ).toEqual({
      protocolVersion: 1,
      serverInfo: { name: 'sugarcode', version: '1.0.0' },
      platform: { family: 'unix', os: 'macos', arch: 'aarch64' },
      capabilities: {
        commandApprovals: true,
        commandWorkspaceWriteApprovals: true,
      },
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

describe('workspace browser responses', () => {
  it('accepts only exact bounded list and inspection results', () => {
    expect(
      parseWorkspaceListResponse(
        {
          path: 'src',
          entries: [
            {
              name: 'main.ts',
              path: 'src/main.ts',
              kind: 'file',
            },
          ],
        },
        'src',
      ),
    ).toMatchObject({ path: 'src' });
    expect(
      parseWorkspaceInspectResponse(
        {
          status: 'complete',
          path: 'src/main.ts',
          content: 'one\n',
          bytes: 4,
          lines: 1,
          hasUtf8Bom: false,
        },
        'src/main.ts',
      ),
    ).toMatchObject({ status: 'complete', lines: 1 });
    expect(
      parseWorkspaceInspectResponse(
        {
          status: 'truncated',
          path: 'large.txt',
          content: 'preview\n',
          bytes: 1_048_577,
          returnedBytes: 8,
          lines: 20_001,
          hasUtf8Bom: false,
        },
        'large.txt',
      ),
    ).toMatchObject({ status: 'truncated', returnedBytes: 8 });
  });

  it.each([
    () =>
      parseWorkspaceListResponse(
        {
          path: '',
          entries: [
            {
              name: 'escape',
              path: '../escape',
              kind: 'file',
            },
          ],
        },
        '',
      ),
    () =>
      parseWorkspaceListResponse(
        {
          path: '',
          entries: [],
          absolutePath: '/private/workspace',
        },
        '',
      ),
    () =>
      parseWorkspaceInspectResponse(
        {
          status: 'complete',
          path: 'notes.txt',
          content: 'secret',
          bytes: 6,
          lines: 1,
          hasUtf8Bom: false,
          diagnostic: 'unexpected',
        },
        'notes.txt',
      ),
    () =>
      parseWorkspaceInspectResponse(
        {
          status: 'complete',
          path: 'notes.txt',
          content: 'x'.repeat(1_048_577),
          bytes: 1_048_577,
          lines: 1,
          hasUtf8Bom: false,
        },
        'notes.txt',
      ),
  ])('rejects malformed, escaping, unknown, or oversized data', (parse) => {
    expect(parse).toThrow();
  });
});
