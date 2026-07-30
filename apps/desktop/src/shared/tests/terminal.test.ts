import { describe, expect, it } from 'vitest';

import {
  isTerminalActionResult,
  isTerminalCreateRequest,
  isTerminalInputRequest,
  isTerminalSnapshotRequest,
  isTerminalStateSnapshot,
} from '../terminal';

const sessionId = '12345678-1234-4123-8123-123456789abc';

describe('terminal shared contract', () => {
  it('accepts only bounded create dimensions', () => {
    expect(
      isTerminalCreateRequest({ generation: 4, columns: 80, rows: 24 }),
    ).toBe(true);
    expect(
      isTerminalCreateRequest({
        generation: 4,
        columns: 80,
        rows: 24,
        command: 'bash',
      }),
    ).toBe(false);
    expect(
      isTerminalCreateRequest({ generation: 4, columns: 501, rows: 24 }),
    ).toBe(false);
  });

  it('keeps renderer input bounded and strips all command authority', () => {
    expect(
      isTerminalInputRequest({
        generation: 4,
        sessionId,
        data: 'echo rendered text\r',
      }),
    ).toBe(true);
    expect(
      isTerminalInputRequest({
        generation: 4,
        sessionId,
        data: 'x'.repeat(65_537),
      }),
    ).toBe(false);
    expect(
      isTerminalInputRequest({
        generation: 4,
        sessionId,
        data: 'x',
        cwd: '/tmp',
      }),
    ).toBe(false);
  });

  it('validates pull acknowledgements and exact snapshots', () => {
    expect(
      isTerminalSnapshotRequest({
        generation: 4,
        sessionId,
        acknowledgeThrough: 7,
      }),
    ).toBe(true);
    expect(
      isTerminalStateSnapshot({
        revision: 8,
        generation: 4,
        status: 'running',
        sessionId,
        workspaceName: 'sugarcode',
        shell: '/bin/zsh',
        acknowledgedThrough: 7,
        output: [{ sequence: 8, data: 'ready\r\n' }],
      }),
    ).toBe(true);
    expect(
      isTerminalStateSnapshot({
        revision: 8,
        generation: 4,
        status: 'running',
        sessionId,
        workspaceName: 'sugarcode',
        acknowledgedThrough: 7,
        output: [],
        processGroupId: 123,
      }),
    ).toBe(false);
  });

  it('correlates accepted results exactly', () => {
    expect(
      isTerminalActionResult({ accepted: true, reason: 'accepted' }),
    ).toBe(true);
    expect(
      isTerminalActionResult({ accepted: false, reason: 'cancelled' }),
    ).toBe(true);
    expect(
      isTerminalActionResult({ accepted: true, reason: 'busy' }),
    ).toBe(false);
  });
});
