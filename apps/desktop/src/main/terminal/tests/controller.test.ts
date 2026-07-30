import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalController } from '../controller';

const sessionId = '12345678-1234-4123-8123-123456789abc';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  autoCloseOnKill = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    if (this.autoCloseOnKill) {
      queueMicrotask(() => this.close(1));
    }
    return true;
  });

  close(exitCode: number): void {
    this.exitCode = exitCode;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', exitCode, null);
  }

  bridge(event: unknown): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

const fixture = (confirmation = 0) => {
  const child = new FakeChild();
  const spawnProcess = vi.fn(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  let approvalPending = false;
  const dialog = {
    showMessageBox: vi.fn(async () => ({
      response: confirmation,
      checkboxChecked: false,
    })),
  };
  const controller = new TerminalController({
    dialog,
    getMainWindow: () =>
      ({ isDestroyed: () => false }) as Electron.BrowserWindow,
    getWorkspace: () => ({
      generation: 4,
      path: '/canonical/workspace',
      name: 'workspace',
    }),
    getResolvedCli: () => ({
      executablePath: '/app/sugarcode',
      workingDirectory: '/app',
    }),
    getCliEnvironment: () => ({ PATH: '/usr/bin' }),
    isApprovalPending: () => approvalPending,
    spawnProcess,
    createSessionId: () => sessionId,
  });
  return {
    child,
    controller,
    dialog,
    spawnProcess,
    setApprovalPending: (pending: boolean) => {
      approvalPending = pending;
    },
  };
};

const snapshotRequest = (acknowledgeThrough = 0) => ({
  generation: 4,
  sessionId,
  acknowledgeThrough,
});

const ready = (child: FakeChild): void => {
  child.bridge({
    type: 'ready',
    version: 1,
    shell: '/bin/zsh',
    encoding: 'utf-8-replacement',
    processGroupId: null,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalController', () => {
  it('uses native confirmation with Cancel focused before spawning', async () => {
    const cancelled = fixture(1);
    await expect(
      cancelled.controller.create({
        generation: 4,
        columns: 80,
        rows: 24,
      }),
    ).resolves.toEqual({ accepted: false, reason: 'cancelled' });
    expect(cancelled.spawnProcess).not.toHaveBeenCalled();
    expect(cancelled.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ['Open real shell', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      }),
    );
  });

  it('owns the bridge sequence and pauses all input for approvals', async () => {
    const test = fixture();
    const writes: string[] = [];
    test.child.stdin.on('data', (chunk: Buffer) => {
      writes.push(chunk.toString('utf8'));
    });
    await expect(
      test.controller.create({
        generation: 4,
        columns: 80,
        rows: 24,
      }),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    expect(test.spawnProcess).toHaveBeenCalledWith(
      '/app/sugarcode',
      [
        '__desktop-terminal',
        '--workspace',
        '/canonical/workspace',
        '--columns',
        '80',
        '--rows',
        '24',
      ],
      expect.objectContaining({
        cwd: '/app',
        env: { PATH: '/usr/bin' },
        windowsHide: true,
      }),
    );
    ready(test.child);
    expect(test.controller.getSnapshot(snapshotRequest())).toMatchObject({
      status: 'running',
      shell: '/bin/zsh',
    });

    expect(
      test.controller.input({
        generation: 4,
        sessionId,
        data: 'echo one\r',
      }),
    ).toEqual({ accepted: true, reason: 'accepted' });
    expect(
      test.controller.resize({
        generation: 4,
        sessionId,
        columns: 100,
        rows: 40,
      }),
    ).toEqual({ accepted: true, reason: 'accepted' });
    expect(writes.join('')).toContain(
      '{"type":"input","data":"echo one\\r","sequence":1}\n',
    );
    expect(writes.join('')).toContain(
      '{"type":"resize","columns":100,"rows":40,"sequence":2}\n',
    );

    test.setApprovalPending(true);
    test.controller.pauseForApproval();
    expect(test.controller.getSnapshot(snapshotRequest())).toMatchObject({
      status: 'paused',
    });
    expect(
      test.controller.input({
        generation: 4,
        sessionId,
        data: 'blocked',
      }),
    ).toEqual({ accepted: false, reason: 'busy' });
    test.setApprovalPending(false);
    test.controller.resumeAfterApproval();
    expect(test.controller.getSnapshot(snapshotRequest())).toMatchObject({
      status: 'running',
    });
  });

  it('pauses bridge output at the high-water mark and resumes after acknowledgement', async () => {
    const test = fixture();
    await test.controller.create({
      generation: 4,
      columns: 80,
      rows: 24,
    });
    ready(test.child);
    for (let sequence = 1; sequence <= 96; sequence += 1) {
      test.child.bridge({
        type: 'output',
        sequence,
        data: 'x'.repeat(8_192),
      });
    }
    expect(test.child.stdout.isPaused()).toBe(true);
    const queued = test.controller.getSnapshot(snapshotRequest());
    expect(queued).toMatchObject({ status: 'paused' });
    expect(queued.output).toHaveLength(96);

    const drained = test.controller.getSnapshot(snapshotRequest(96));
    expect(drained.output).toHaveLength(0);
    expect(drained.status).toBe('running');
    expect(test.child.stdout.isPaused()).toBe(false);
  });

  it('fails closed on unknown bridge fields and unexpected bridge exit', async () => {
    const invalid = fixture();
    await invalid.controller.create({
      generation: 4,
      columns: 80,
      rows: 24,
    });
    invalid.child.bridge({
      type: 'ready',
      version: 1,
      shell: '/bin/zsh',
      encoding: 'utf-8-replacement',
      processGroupId: null,
      command: 'bash',
    });
    expect(invalid.controller.getSnapshot(snapshotRequest())).toMatchObject({
      status: 'failed',
      error: 'protocolInvalid',
    });
    expect(invalid.child.kill).toHaveBeenCalled();

    const crashed = fixture();
    await crashed.controller.create({
      generation: 4,
      columns: 80,
      rows: 24,
    });
    ready(crashed.child);
    crashed.child.close(2);
    expect(crashed.controller.getSnapshot(snapshotRequest())).toMatchObject({
      status: 'failed',
      error: 'bridgeCrashed',
    });
  });

  it('kills the owned session when the renderer disappears', async () => {
    const test = fixture();
    test.child.autoCloseOnKill = true;
    await test.controller.create({
      generation: 4,
      columns: 80,
      rows: 24,
    });
    ready(test.child);
    test.controller.rendererUnavailable();
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(
      test.controller.getSnapshot({
        generation: 4,
        acknowledgeThrough: 0,
      }),
    ).toMatchObject({ status: 'closed' });
  });
});
