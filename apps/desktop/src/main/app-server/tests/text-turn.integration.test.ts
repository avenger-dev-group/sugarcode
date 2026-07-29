import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from '../connection/supervisor';

const DURABLE_MARKDOWN_RESPONSE =
  '## Durable response\n\n- exact restart item';

const RESPONSE_BODY = [
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"## Durable response\\n\\n"},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"- exact restart item"},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_READ_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_read","type":"function","function":{"name":"workspace/read","arguments":"{\\"path\\":\\"context.txt\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_READ_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Workspace read complete."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_LIST_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_list","type":"function","function":{"name":"workspace/list","arguments":"{\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_LIST_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Workspace list complete."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_SEARCH_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_search","type":"function","function":{"name":"workspace/search","arguments":"{\\"path\\":\\".\\",\\"query\\":\\"needle\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_SEARCH_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Workspace search complete."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const SHELL_COMMAND_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_command","type":"function","function":{"name":"shell/exec","arguments":"{\\"command\\":\\"/usr/bin/printf\\",\\"arguments\\":[\\"private-command-argument\\"],\\"cwd\\":\\".\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const SHELL_COMMAND_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Command approval recorded."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const REAL_CLI_TEST_TIMEOUT_MS = 30_000;

type ProviderCapture = Readonly<{
  server: Server;
  port: number;
  requests: Array<Readonly<{ headers: string; body: unknown }>>;
  errors: Error[];
}>;

type ProviderMode =
  | 'success'
  | 'hang'
  | 'rateLimited'
  | 'workspaceRead'
  | 'workspaceList'
  | 'workspaceSearch'
  | 'shellApproval';

const startProvider = async (
  mode: ProviderMode = 'success',
): Promise<ProviderCapture> => {
  const requests: Array<
    Readonly<{ headers: string; body: unknown }>
  > = [];
  const errors: Error[] = [];
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    let responded = false;
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (mode === 'hang' && error.code === 'ECONNRESET') {
        return;
      }
      errors.push(error);
    });
    socket.on('data', (chunk: Buffer) => {
      if (responded) {
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const headerIndex = bytes.indexOf('\r\n\r\n');
      if (headerIndex < 0) {
        return;
      }
      const headers = bytes.subarray(0, headerIndex + 4).toString('utf8');
      const contentLength = headers
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('content-length:'))
        ?.split(':', 2)[1]
        ?.trim();
      const length = Number(contentLength);
      const bodyStart = headerIndex + 4;
      if (!Number.isSafeInteger(length) || bytes.length - bodyStart < length) {
        return;
      }
      responded = true;
      requests.push({
        headers,
        body: JSON.parse(
          bytes.subarray(bodyStart, bodyStart + length).toString('utf8'),
        ) as unknown,
      });
      if (mode === 'hang') {
        return;
      }
      if (mode === 'rateLimited') {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      const responseBody = (() => {
        if (mode === 'workspaceRead') {
          return requests.length === 1
            ? WORKSPACE_READ_CALL_BODY
            : WORKSPACE_READ_FINAL_BODY;
        }
        if (mode === 'workspaceList') {
          return requests.length === 1
            ? WORKSPACE_LIST_CALL_BODY
            : WORKSPACE_LIST_FINAL_BODY;
        }
        if (mode === 'workspaceSearch') {
          return requests.length === 1
            ? WORKSPACE_SEARCH_CALL_BODY
            : WORKSPACE_SEARCH_FINAL_BODY;
        }
        if (mode === 'shellApproval') {
          return requests.length === 1
            ? SHELL_COMMAND_CALL_BODY
            : SHELL_COMMAND_FINAL_BODY;
        }
        return RESPONSE_BODY;
      })();
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Loopback provider did not expose a TCP port.');
  }
  return { server, port: address.port, requests, errors };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const temporaryHomes: string[] = [];
const providers: Server[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map(closeServer));
  await Promise.all(
    temporaryHomes.splice(0).map((home) =>
      rm(home, { force: true, recursive: true }),
    ),
  );
});

describe('real Desktop text Agent Turn', () => {
  it('restores and continues one durable Thread across Desktop CLI processes', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    temporaryHomes.push(home);
    const provider = await startProvider();
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      expect(first.getSnapshot().status).toBe('ready');
      await expect(
        first.conversation.startTurn('Keep this input exact: 雪'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                messages: [
                  {
                    role: 'user',
                    text: 'Keep this input exact: 雪',
                    status: 'completed',
                  },
                  {
                    role: 'agent',
                    text: DURABLE_MARKDOWN_RESPONSE,
                    status: 'completed',
                  },
                ],
              },
            ],
          });
        },
        { timeout: 10_000 },
      );
      const durableThreadId = first.conversation.getSnapshot().threadId;
      const durableTurnId =
        first.conversation.getSnapshot().turns[0]?.id;
      const durableUserItemId =
        first.conversation.getSnapshot().turns[0]?.messages[0]?.id;
      const durableAgentItemId =
        first.conversation.getSnapshot().turns[0]?.messages[1]?.id;
      expect(durableThreadId).toMatch(/^thr_[0-9a-f]{16}$/);
      expect(durableTurnId).toMatch(/^turn_[0-9a-f]{16}$/);
      expect(durableUserItemId).toMatch(/^item_[0-9a-f]{16}$/);
      expect(durableAgentItemId).toMatch(/^item_[0-9a-f]{16}$/);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.headers).toMatch(
        /^POST \/v1\/chat\/completions HTTP\/1\.1\r\n/,
      );
      expect(provider.requests[0]?.headers.toLowerCase()).not.toContain(
        'authorization:',
      );
      expect(provider.requests[0]?.body).toMatchObject({
        model: 'desktop-fixture-model',
        messages: [
          {
            role: 'user',
            content: 'Keep this input exact: 雪',
          },
        ],
      });

      first.shutdown();
      second = createSupervisor();
      await second.start();
      expect(second.getSnapshot().status).toBe('ready');
      expect(second.conversation.getSnapshot()).toMatchObject({
        phase: 'ready',
        threadId: durableThreadId,
        turns: [
          {
            id: durableTurnId,
            status: 'completed',
            messages: [
              {
                id: durableUserItemId,
                role: 'user',
                text: 'Keep this input exact: 雪',
                status: 'completed',
              },
              {
                id: durableAgentItemId,
                role: 'agent',
                text: DURABLE_MARKDOWN_RESPONSE,
                status: 'completed',
              },
            ],
          },
        ],
      });

      await expect(
        second.conversation.startTurn('Continue after restart.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(second?.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              { status: 'completed' },
              {
                status: 'completed',
                messages: [
                  { role: 'user', text: 'Continue after restart.' },
                  { role: 'agent', text: DURABLE_MARKDOWN_RESPONSE },
                ],
              },
            ],
          });
          expect(provider.requests).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      expect(provider.requests[1]?.body).toMatchObject({
        messages: [
          {
            role: 'user',
            content: 'Keep this input exact: 雪',
          },
          {
            role: 'assistant',
            content: DURABLE_MARKDOWN_RESPONSE,
          },
          {
            role: 'user',
            content: 'Continue after restart.',
          },
        ],
      });
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('restores one durable workspace read without replaying tool or provider work', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-workspace-test-'),
    );
    temporaryHomes.push(home, workspace);
    await writeFile(path.join(workspace, 'context.txt'), 'fixture context');
    const provider = await startProvider('workspaceRead');
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
        spawnProcess: (command, arguments_, options) =>
          spawn(
            command,
            [...arguments_, '--workspace', workspace],
            { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
          ),
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      expect(first.getSnapshot().status).toBe('ready');
      await expect(
        first.conversation.startTurn('Read context.txt.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                workspaceRead: {
                  path: 'context.txt',
                  callStatus: 'completed',
                  result: {
                    status: 'completed',
                    outcome: { type: 'success', bytes: 15 },
                  },
                },
              },
            ],
          });
          expect(provider.requests).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      const firstSnapshot = first.conversation.getSnapshot();
      expect(JSON.stringify(firstSnapshot)).not.toContain('fixture context');
      const durableActivity = firstSnapshot.turns[0]?.workspaceRead;

      first.shutdown();
      second = createSupervisor();
      await second.start();
      expect(second.getSnapshot().status).toBe('ready');
      expect(second.conversation.getSnapshot().turns[0]?.workspaceRead)
        .toEqual(durableActivity);
      expect(provider.requests).toHaveLength(2);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('restores one durable workspace list count without exposing entry names', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-workspace-test-'),
    );
    temporaryHomes.push(home, workspace);
    await writeFile(path.join(workspace, 'private-plan.txt'), 'private');
    await writeFile(path.join(workspace, 'secret-notes.txt'), 'secret');
    const provider = await startProvider('workspaceList');
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
        spawnProcess: (command, arguments_, options) =>
          spawn(
            command,
            [...arguments_, '--workspace', workspace],
            { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
          ),
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      await expect(
        first.conversation.startTurn('List the workspace root.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                workspaceList: {
                  path: '.',
                  callStatus: 'completed',
                  result: {
                    status: 'completed',
                    outcome: { type: 'success', entries: 2 },
                  },
                },
              },
            ],
          });
          expect(provider.requests).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      const firstSnapshot = first.conversation.getSnapshot();
      expect(JSON.stringify(firstSnapshot)).not.toContain('private-plan.txt');
      expect(JSON.stringify(firstSnapshot)).not.toContain('secret-notes.txt');
      const durableActivity = firstSnapshot.turns[0]?.workspaceList;

      first.shutdown();
      second = createSupervisor();
      await second.start();
      expect(second.conversation.getSnapshot().turns[0]?.workspaceList)
        .toEqual(durableActivity);
      expect(provider.requests).toHaveLength(2);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('restores one durable workspace search summary without replaying matches', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-workspace-test-'),
    );
    temporaryHomes.push(home, workspace);
    const privateMatchPath = path.join(workspace, 'private-search-marker.txt');
    await writeFile(
      privateMatchPath,
      `${Array.from({ length: 201 }, (_, index) => `needle ${index}`).join('\n')}\n`,
    );
    const provider = await startProvider('workspaceSearch');
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
        spawnProcess: (command, arguments_, options) =>
          spawn(
            command,
            [...arguments_, '--workspace', workspace],
            { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
          ),
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      await expect(
        first.conversation.startTurn('Search for the marker.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                workspaceSearch: {
                  path: '.',
                  query: 'needle',
                  callStatus: 'completed',
                  result: {
                    status: 'completed',
                    outcome: {
                      type: 'success',
                      matches: 200,
                      truncated: true,
                    },
                  },
                },
              },
            ],
          });
          expect(provider.requests).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      const firstSnapshot = first.conversation.getSnapshot();
      expect(JSON.stringify(firstSnapshot)).not.toContain(
        'private-search-marker.txt',
      );
      expect(JSON.stringify(firstSnapshot)).not.toContain('"line"');
      const durableActivity = firstSnapshot.turns[0]?.workspaceSearch;

      first.shutdown();
      await writeFile(privateMatchPath, 'replacement without the query\n');
      second = createSupervisor();
      await second.start();
      expect(second.conversation.getSnapshot().turns[0]?.workspaceSearch)
        .toEqual(durableActivity);
      expect(provider.requests).toHaveLength(2);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('restores exact durable failure details without replaying the provider', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    temporaryHomes.push(home);
    const provider = await startProvider('rateLimited');
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      await expect(
        first.conversation.startTurn('Preserve this failed Turn.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'failed',
                messages: [
                  {
                    role: 'user',
                    text: 'Preserve this failed Turn.',
                    status: 'completed',
                  },
                  {
                    role: 'agent',
                    text: '',
                    status: 'completed',
                  },
                ],
                error: { kind: 'rateLimited', retryable: true },
              },
            ],
          });
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 },
      );

      first.shutdown();
      second = createSupervisor();
      await second.start();
      expect(second.getSnapshot().status).toBe('ready');
      expect(second.conversation.getSnapshot()).toMatchObject({
        phase: 'ready',
        turns: [
          {
            status: 'failed',
            messages: [
              {
                role: 'user',
                text: 'Preserve this failed Turn.',
                status: 'completed',
              },
              {
                role: 'agent',
                text: '',
                status: 'completed',
              },
            ],
            error: { kind: 'rateLimited', retryable: true },
          },
        ],
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('accepts only Core durable interruption after an active process exits', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    temporaryHomes.push(home);
    const provider = await startProvider('hang');
    providers.push(provider.server);
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '',
      ].join('\n'),
    );
    const createSupervisor = (): ConnectionSupervisor =>
      new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
      });
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      await expect(
        first.conversation.startTurn('Recover this interrupted Turn.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot().phase).toBe(
            'inProgress',
          );
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 },
      );

      first.shutdown();
      expect(first.conversation.getSnapshot()).toMatchObject({
        phase: 'unavailable',
        activeTurnId: expect.any(String),
        turns: [
          {
            status: 'inProgress',
            messages: [
              {
                role: 'user',
                text: 'Recover this interrupted Turn.',
                status: 'completed',
              },
            ],
          },
        ],
      });
      second = createSupervisor();
      await second.start();
      expect(second.getSnapshot().status).toBe('ready');
      expect(second.conversation.getSnapshot()).toMatchObject({
        phase: 'ready',
        turns: [
          {
            status: 'interrupted',
            messages: [
              {
                role: 'user',
                text: 'Recover this interrupted Turn.',
                status: 'completed',
              },
            ],
          },
        ],
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it.skipIf(process.platform === 'win32')(
    'restores a real CLI command execution attempt audit without replaying arguments or results',
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
      const workspace = await mkdtemp(
        path.join(tmpdir(), 'sugarcode-workspace-test-'),
      );
      temporaryHomes.push(home, workspace);
      const provider = await startProvider('shellApproval');
      providers.push(provider.server);
      await writeFile(
        path.join(home, 'config.toml'),
        [
          'schema_version = 1',
          '[model]',
          'api_format = "openai-chat-completions"',
          `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
          'model = "desktop-fixture-model"',
          '',
        ].join('\n'),
      );
      const createSupervisor = (): ConnectionSupervisor =>
        new ConnectionSupervisor({
          clientVersion: '1.0.0',
          desktopAppPath: process.cwd(),
          environment: {
            SUGARCODE_HOME: home,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          },
          spawnProcess: (command, arguments_, options) =>
            spawn(command, [...arguments_, '--workspace', workspace], {
              ...options,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
        });
      const first = createSupervisor();
      let second: ConnectionSupervisor | null = null;

      try {
        await first.start();
        first.commandApprovals.markSurfaceReady();
        await first.conversation.startTurn('Request a command approval.');
        await vi.waitFor(
          () => expect(first.commandApprovals.getSnapshot().status).toBe('pending'),
          { timeout: 10_000 },
        );
        const presentationId = first.commandApprovals.getSnapshot().request
          ?.presentationId;
        if (!presentationId) {
          throw new Error('Real CLI approval did not expose a presentation.');
        }
        await expect(
          first.commandApprovals.approve(presentationId),
        ).resolves.toEqual({ accepted: true, reason: 'accepted' });
        await vi.waitFor(
          () =>
            expect(first.conversation.getSnapshot()).toMatchObject({
              phase: 'ready',
              turns: [
                {
                  status: 'completed',
                  commandApproval: {
                    command: '/usr/bin/printf',
                    argumentCount: 1,
                    decision: { value: 'approved', status: 'completed' },
                    executionAttempt: { status: 'completed' },
                  },
                },
              ],
            }),
          { timeout: 10_000 },
        );
        const durableActivity =
          first.conversation.getSnapshot().turns[0]?.commandApproval;
        expect(JSON.stringify(durableActivity)).not.toContain(
          'private-command-argument',
        );
        expect(JSON.stringify(durableActivity)).not.toContain('stdout');
        expect(JSON.stringify(durableActivity)).not.toContain('exitCode');

        first.shutdown();
        second = createSupervisor();
        await second.start();
        expect(second.conversation.getSnapshot().turns[0]?.commandApproval)
          .toEqual(durableActivity);
        expect(provider.requests).toHaveLength(2);
        expect(provider.errors).toEqual([]);
      } finally {
        first.shutdown();
        second?.shutdown();
      }
    },
    REAL_CLI_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== 'win32')(
    'omits shell/exec from the real Windows CLI tool inventory',
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
      const workspace = await mkdtemp(
        path.join(tmpdir(), 'sugarcode-workspace-test-'),
      );
      temporaryHomes.push(home, workspace);
      const provider = await startProvider();
      providers.push(provider.server);
      await writeFile(
        path.join(home, 'config.toml'),
        [
          'schema_version = 1',
          '[model]',
          'api_format = "openai-chat-completions"',
          `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
          'model = "desktop-fixture-model"',
          '',
        ].join('\n'),
      );
      const supervisor = new ConnectionSupervisor({
        clientVersion: '1.0.0',
        desktopAppPath: process.cwd(),
        environment: {
          SUGARCODE_HOME: home,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
        spawnProcess: (command, arguments_, options) =>
          spawn(command, [...arguments_, '--workspace', workspace], {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
      });
      try {
        await supervisor.start();
        await supervisor.conversation.startTurn('Inspect the tools.');
        await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
          timeout: 10_000,
        });
        expect(JSON.stringify(provider.requests[0]?.body)).not.toContain(
          'shell/exec',
        );
      } finally {
        supervisor.shutdown();
      }
    },
    REAL_CLI_TEST_TIMEOUT_MS,
  );
});
