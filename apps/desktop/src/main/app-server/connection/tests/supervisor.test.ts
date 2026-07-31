import {
  PROTOCOL_VERSION,
  SUGARCODE_PRODUCT_VERSION,
} from '@sugarcode/app-server-protocol';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from '../supervisor';
import { CliResolutionError } from '../../cli/resolution';

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
  mcpToolCallApprovals?: boolean;
  workspace?: boolean;
  latestThread?: Readonly<{
    id: string;
    turns: readonly unknown[];
  }>;
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
              capabilities: {
                commandApprovals: true,
                commandWorkspaceWriteApprovals: true,
                ...(overrides.mcpToolCallApprovals !== undefined
                  ? {
                      mcpToolCallApprovals:
                        overrides.mcpToolCallApprovals,
                    }
                  : {}),
                ...(overrides.workspace
                  ? {
                      workspaceBrowser: true,
                      workspaceGit: true,
                    }
                  : {}),
              },
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
              ...(overrides.workspace
                ? { workspace: { id: 'a'.repeat(64) } }
                : {}),
            },
          })}\n`,
        );
      } else if (message.method === 'thread/list') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              data: overrides.latestThread
                ? [{ id: overrides.latestThread.id }]
                : [],
              nextCursor: null,
            },
          })}\n`,
        );
      } else if (
        message.method === 'thread/resume' &&
        overrides.latestThread
      ) {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              thread: { id: overrides.latestThread.id },
              turns: overrides.latestThread.turns,
            },
          })}\n`,
        );
      } else if (message.method === 'workspace/list') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              path: '',
              entries: [
                { name: 'src', path: 'src', kind: 'directory' },
              ],
            },
          })}\n`,
        );
      } else if (message.method === 'workspace/inspect') {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              status: 'complete',
              path: 'README.md',
              content: '# Workspace\n',
              bytes: 12,
              lines: 1,
              hasUtf8Bom: false,
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
      workingDirectory: '/workspace',
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

  it('binds an explicit workspace to argv, cwd, and browser RPCs', async () => {
    const child = new FakeChild();
    const { spawnProcess, supervisor } = createSupervisor(child, {
      workspace: true,
    });
    expect(
      supervisor.configureInitialWorkspace('/projects/sugar code'),
    ).toBe(true);
    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/workspace/target/debug/sugarcode',
      [
        'app-server',
        '--stdio',
        '--workspace',
        '/projects/sugar code',
      ],
      expect.objectContaining({
        cwd: '/projects/sugar code',
        shell: false,
      }),
    );
    await expect(supervisor.listWorkspace('')).resolves.toMatchObject({
      entries: [{ path: 'src', kind: 'directory' }],
    });
    await expect(
      supervisor.inspectWorkspace('README.md'),
    ).resolves.toMatchObject({
      status: 'complete',
      content: '# Workspace\n',
    });
    supervisor.shutdown();
  });

  it('exposes a chat directory while keeping its durable Threads unbound', async () => {
    const child = new FakeChild();
    const { spawnProcess, supervisor } = createSupervisor(child, {
      workspace: true,
    });
    expect(
      supervisor.configureInitialWorkspace(
        '/Users/simon/Documents/SugarCode/2026-07-31/chat-140509',
        undefined,
        'chat',
      ),
    ).toBe(true);

    await supervisor.start();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/workspace/target/debug/sugarcode',
      [
        'app-server',
        '--stdio',
        '--workspace',
        '/Users/simon/Documents/SugarCode/2026-07-31/chat-140509',
        '--unbound-threads',
      ],
      expect.objectContaining({
        cwd: '/Users/simon/Documents/SugarCode/2026-07-31/chat-140509',
        shell: false,
      }),
    );
    supervisor.shutdown();
  });

  it('loads the active durable Thread index without selecting a transcript', async () => {
    const child = new FakeChild();
    const { supervisor } = createSupervisor(child, {
      latestThread: {
        id: 'thr_0000000000000001',
        turns: [
          {
            id: 'turn_0000000000000001',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'item_0000000000000001',
                text: 'Recovered in Main.',
              },
              {
                type: 'agentMessage',
                id: 'item_0000000000000002',
                text: 'Durable response.',
              },
            ],
          },
        ],
      },
    });

    await supervisor.start();
    expect(supervisor.getSnapshot().status).toBe('ready');
    expect(supervisor.conversation.getSnapshot()).toMatchObject({
      phase: 'idle',
      turns: [],
      navigator: {
        status: 'ready',
        activeThreadIds: ['thr_0000000000000001'],
      },
    });
    expect(
      supervisor.conversation.getSnapshot().threadId,
    ).toBeUndefined();
    supervisor.shutdown();
  });

  it('denies the known command approval request without exposing Renderer UI', async () => {
    const child = new FakeChild();
    const { supervisor } = createSupervisor(child);
    await supervisor.start();
    const response = new Promise<Record<string, unknown>>((resolve) => {
      child.stdin.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').trim().split('\n')) {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 'approval/desktop') {
            resolve(message);
          }
        }
      });
    });
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'approval/desktop',
        method: 'item/commandExecution/requestApproval',
        params: {
          approvalId: 'approval/desktop',
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          callId: 'call_1',
          command: '/bin/echo',
          arguments: [],
          cwd: '.',
          approvalScope: 'command',
          environmentPolicy: 'minimalV1',
          sandboxed: true,
          sandboxPolicy: 'filesystemReadOnlyV1',
          networkPolicy: 'networkDeniedV1',
        },
      })}\n`,
    );

    await expect(response).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'approval/desktop',
      result: { decision: 'denied' },
    });
    expect(supervisor.getSnapshot().status).toBe('ready');
    supervisor.shutdown();
  });

  it('writes one correlated decision and waits for the durable decision item', async () => {
    const child = new FakeChild();
    const { supervisor } = createSupervisor(child);
    await supervisor.start();
    supervisor.commandApprovals.markSurfaceReady();

    const response = new Promise<Record<string, unknown>>((resolve) => {
      child.stdin.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').trim().split('\n')) {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 'approval/desktop-ui') {
            resolve(message);
          }
        }
      });
    });
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'approval/desktop-ui',
        method: 'item/commandExecution/requestApproval',
        params: {
          approvalId: 'approval/desktop-ui',
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          callId: 'call_1',
          command: '/bin/echo',
          arguments: ['hello'],
          cwd: '.',
          approvalScope: 'command',
          environmentPolicy: 'minimalV1',
          sandboxed: true,
          sandboxPolicy: 'filesystemReadOnlyV1',
          networkPolicy: 'networkDeniedV1',
        },
      })}\n`,
    );
    await vi.waitFor(() =>
      expect(
        supervisor.commandApprovals.getSnapshot().status,
      ).toBe('pending'),
    );
    const presentationId =
      supervisor.commandApprovals.getSnapshot().request?.presentationId;
    expect(presentationId).toBeTypeOf('string');

    await expect(
      supervisor.commandApprovals.approve(presentationId),
    ).resolves.toEqual({ accepted: true, reason: 'accepted' });
    await expect(response).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'approval/desktop-ui',
      result: { decision: 'approved' },
    });
    expect(supervisor.commandApprovals.getSnapshot().status).toBe(
      'pending',
    );

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId: 'thr_0000000000000001',
          turnId: 'turn_0000000000000001',
          item: {
            type: 'commandApprovalDecision',
            id: 'item_decision_1',
            approvalId: 'approval/desktop-ui',
            decision: 'approved',
          },
        },
      })}\n`,
    );
    await vi.waitFor(() =>
      expect(
        supervisor.commandApprovals.getSnapshot().status,
      ).toBe('approved'),
    );
    supervisor.shutdown();
  });

  it('restarts with an explicit MCP selection and restores the current Thread', async () => {
    const initialChild = new FakeChild();
    const mcpChild = new FakeChild();
    const thread = {
      id: 'thr_0000000000000001',
      turns: [
        {
          id: 'turn_0000000000000001',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: 'item_0000000000000001',
              text: 'Keep this Thread.',
            },
            {
              type: 'agentMessage',
              id: 'item_0000000000000002',
              text: 'Restored without replay.',
            },
          ],
        },
      ],
    };
    attachInitializeServer(initialChild, { latestThread: thread });
    attachInitializeServer(mcpChild, {
      latestThread: thread,
      mcpToolCallApprovals: true,
    });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(initialChild.asChildProcess())
      .mockReturnValueOnce(mcpChild.asChildProcess());
    const supervisor = new ConnectionSupervisor({
      arch: 'arm64',
      clientVersion: '1.0.0',
      desktopAppPath: '/workspace/apps/desktop',
      environment: {},
      platform: 'darwin',
      resolveCli: async () => ({
        executablePath: '/workspace/target/debug/sugarcode',
        workingDirectory: '/workspace',
      }),
      discoverMcpServers: async () => [
        { id: 'alpha', transport: 'stdio' },
      ],
      spawnProcess,
    });

    await supervisor.start();
    await expect(
      supervisor.conversation.selectThread(thread.id),
    ).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    const conversationSnapshots: ReturnType<
      typeof supervisor.conversation.getSnapshot
    >[] = [];
    const unsubscribeConversation = supervisor.conversation.subscribe(
      (snapshot) => conversationSnapshots.push(snapshot),
    );
    supervisor.mcpApprovals.markSurfaceReady();
    expect(supervisor.mcpSession.toggle('alpha').accepted).toBe(true);
    await expect(supervisor.mcpSession.enable()).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      '/workspace/target/debug/sugarcode',
      ['app-server', '--stdio', '--mcp-server', 'alpha'],
      expect.objectContaining({ env: {}, shell: false }),
    );
    expect(supervisor.mcpSession.getSnapshot()).toMatchObject({
      status: 'enabled',
      activeServerIds: ['alpha'],
    });
    expect(supervisor.conversation.getSnapshot()).toMatchObject({
      phase: 'ready',
      threadId: thread.id,
      turns: [
        {
          messages: [
            { text: 'Keep this Thread.' },
            { text: 'Restored without replay.' },
          ],
        },
      ],
    });
    expect(
      conversationSnapshots.every(
        (snapshot) => snapshot.notice?.kind !== 'connectionLost',
      ),
    ).toBe(true);
    unsubscribeConversation();
    supervisor.shutdown();
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
        throw new CliResolutionError(
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
        workingDirectory: '/workspace',
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

  it('passes the packaged resources boundary to the CLI resolver', async () => {
    const child = new FakeChild();
    attachInitializeServer(child);
    const resolveCli = vi.fn(async () => ({
      executablePath: '/package/resources/sugarcode-sidecar/bin/sugarcode',
      workingDirectory: '/package/resources',
    }));
    const supervisor = new ConnectionSupervisor({
      arch: 'arm64',
      clientVersion: SUGARCODE_PRODUCT_VERSION,
      desktopAppPath: '/package/resources/app.asar',
      environment: {},
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/package/resources',
      resolveCli,
      spawnProcess: () => child.asChildProcess(),
    });

    await supervisor.start();
    expect(resolveCli).toHaveBeenCalledWith({
      desktopAppPath: '/package/resources/app.asar',
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/package/resources',
    });
    expect(supervisor.getSnapshot().status).toBe('ready');
    supervisor.shutdown();
  });

  it('rejects a mismatched Desktop product version before resolving the CLI', async () => {
    const resolveCli = vi.fn();
    const supervisor = new ConnectionSupervisor({
      clientVersion: '9.9.9',
      desktopAppPath: '/workspace/apps/desktop',
      resolveCli,
    });

    await supervisor.start();
    expect(resolveCli).not.toHaveBeenCalled();
    expect(supervisor.getSnapshot()).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'product-version-mismatch' },
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
