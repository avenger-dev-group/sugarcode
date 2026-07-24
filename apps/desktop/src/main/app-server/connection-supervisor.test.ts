import {
  PROTOCOL_VERSION,
  SUGARCODE_PRODUCT_VERSION,
} from '@sugarcode/app-server-protocol';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from './connection-supervisor';
import { DevelopmentCliError } from './development-cli';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr];
  readonly pid = 42;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = vi.fn(() => {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.signalCode = 'SIGTERM';
    queueMicrotask(() => {
      this.emit('exit', null, 'SIGTERM');
      this.emit('close', null, 'SIGTERM');
    });
    return true;
  });

  asChildProcess = (): ChildProcessWithoutNullStreams =>
    this as unknown as ChildProcessWithoutNullStreams;

  exit = (code: number, signal: NodeJS.Signals | null = null): void => {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  };
}

type InitializeOverrides = Readonly<{
  protocolVersion?: number;
  name?: string;
  version?: string;
  family?: string;
  os?: string;
  arch?: string;
}>;

const attachInitializeServer = (
  child: FakeChild,
  overrides: InitializeOverrides = {},
): void => {
  let input = '';
  child.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    while (input.includes('\n')) {
      const newline = input.indexOf('\n');
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const message = JSON.parse(line) as {
        id?: number;
        method: string;
      };
      if (message.method === 'initialize') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              capabilities: {},
              platform: {
                family: overrides.family ?? 'unix',
                os: overrides.os ?? 'macos',
                arch: overrides.arch ?? 'aarch64',
              },
              protocolVersion:
                overrides.protocolVersion ?? PROTOCOL_VERSION,
              serverInfo: {
                name: overrides.name ?? 'sugarcode',
                version:
                  overrides.version ?? SUGARCODE_PRODUCT_VERSION,
              },
            },
          })}\n`,
        );
      }
    }
  });
};

const createSupervisor = (
  child: FakeChild,
  overrides: InitializeOverrides = {},
) => {
  attachInitializeServer(child, overrides);
  const spawnProcess = vi.fn(() => child.asChildProcess());
  const supervisor = new ConnectionSupervisor({
    arch: 'arm64',
    clientVersion: '1.0.0',
    desktopAppPath: '/workspace/apps/desktop',
    environment: { PATH: '/untrusted' },
    platform: 'darwin',
    resolveCli: async () => ({
      executablePath: '/workspace/target/debug/sugarcode',
      repositoryRoot: '/workspace',
    }),
    spawnProcess,
  });
  return { spawnProcess, supervisor };
};

describe('ConnectionSupervisor', () => {
  it('performs one initialize/initialized handshake for duplicate starts', async () => {
    const child = new FakeChild();
    const { spawnProcess, supervisor } = createSupervisor(child);
    const firstStart = supervisor.start();
    const duplicateStart = supervisor.start();

    expect(duplicateStart).toBe(firstStart);
    await firstStart;
    expect(supervisor.getSnapshot()).toMatchObject({
      revision: 2,
      status: 'ready',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      '/workspace/target/debug/sugarcode',
      ['app-server', '--stdio'],
      expect.objectContaining({
        cwd: '/workspace',
        env: {},
        shell: false,
      }),
    );

    supervisor.shutdown();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(supervisor.getSnapshot().status).toBe('closed');
  });

  it.each([
    [
      { protocolVersion: 99 },
      'protocol-version-mismatch',
    ],
    [
      { version: '9.9.9' },
      'product-version-mismatch',
    ],
    [
      { arch: 'x86_64' },
      'platform-mismatch',
    ],
  ] as const)('fails before initialized on a handshake mismatch', async (
    overrides,
    code,
  ) => {
    const child = new FakeChild();
    const writtenMethods: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        writtenMethods.push((JSON.parse(line) as { method: string }).method);
      }
    });
    const { supervisor } = createSupervisor(child, overrides);

    await supervisor.start();
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'failed',
      diagnostic: { code },
    });
    expect(writtenMethods).toEqual(['initialize']);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('surfaces missing CLI and synchronous spawn failure', async () => {
    const missing = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: '/workspace/apps/desktop',
      resolveCli: async () => {
        throw new DevelopmentCliError(
          'development-cli-missing',
          'missing',
        );
      },
    });
    await missing.start();
    expect(missing.getSnapshot()).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'development-cli-missing' },
    });

    const spawnFailure = new ConnectionSupervisor({
      clientVersion: '1.0.0',
      desktopAppPath: '/workspace/apps/desktop',
      resolveCli: async () => ({
        executablePath: '/workspace/target/debug/sugarcode',
        repositoryRoot: '/workspace',
      }),
      spawnProcess: () => {
        throw new Error('spawn failed');
      },
    });
    await spawnFailure.start();
    expect(spawnFailure.getSnapshot()).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'spawn-failed' },
    });
  });

  it('distinguishes clean close from crash after ready', async () => {
    const cleanChild = new FakeChild();
    const clean = createSupervisor(cleanChild).supervisor;
    await clean.start();
    cleanChild.exit(0);
    expect(clean.getSnapshot()).toMatchObject({
      status: 'closed',
      diagnostic: { code: 'server-closed' },
    });

    const crashedChild = new FakeChild();
    const crashed = createSupervisor(crashedChild).supervisor;
    await crashed.start();
    crashedChild.exit(7);
    expect(crashed.getSnapshot()).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'server-crashed' },
    });
  });

  it('bounds raw stderr diagnostics in Main', async () => {
    const child = new FakeChild();
    const { supervisor } = createSupervisor(child);
    await supervisor.start();
    child.stderr.write('x'.repeat(70 * 1024));

    expect(
      Buffer.byteLength(supervisor.getDiagnosticTailForTesting()),
    ).toBe(64 * 1024);
    supervisor.shutdown();
  });
});
