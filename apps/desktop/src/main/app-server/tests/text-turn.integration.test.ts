import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from '../connection/supervisor';

const DURABLE_MARKDOWN_RESPONSE =
  '## Durable response\n\n- exact restart item\n\n```Rust title="restart-proof"\nfn main() {\n    println!("restart-proof");\n}\n```';

const RESPONSE_BODY = [
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"## Durable response\\n\\n"},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"- exact restart item\\n\\n```Rust title=\\"restart-proof\\"\\n"},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"fn main() {\\n    println!(\\"restart-proof\\");\\n}\\n```"},"finish_reason":null}]}\n\n',
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

const WORKSPACE_PATCH_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_patch","type":"function","function":{"name":"workspace/apply-patch","arguments":"{\\"path\\":\\"notes.txt\\",\\"patch\\":\\"@@ -1,3 +1,3 @@\\\\n one\\\\n-two\\\\n+second\\\\n three\\\\n\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const WORKSPACE_PATCH_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Workspace patch complete."},"finish_reason":null}]}\n\n',
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

const MCP_CALL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_desktop_mcp","type":"function","function":{"name":"mcp__http-fixture__inspect","arguments":"{\\"value\\":7}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const MCP_FINAL_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"MCP call complete."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const REAL_CLI_TEST_TIMEOUT_MS = 30_000;

const selectDurableThread = async (
  supervisor: ConnectionSupervisor,
  threadId: string | undefined,
): Promise<void> => {
  expect(threadId).toMatch(/^thr_[0-9a-f]{16}$/);
  await expect(
    supervisor.conversation.selectThread(threadId),
  ).resolves.toEqual({
    accepted: true,
    reason: 'accepted',
  });
};

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
  | 'workspacePatch'
  | 'shellApproval'
  | 'mcp';

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
        if (mode === 'workspacePatch') {
          return requests.length === 1
            ? WORKSPACE_PATCH_CALL_BODY
            : WORKSPACE_PATCH_FINAL_BODY;
        }
        if (mode === 'shellApproval') {
          return requests.length === 1
            ? SHELL_COMMAND_CALL_BODY
            : SHELL_COMMAND_FINAL_BODY;
        }
        if (mode === 'mcp') {
          return requests.length === 1 ? MCP_CALL_BODY : MCP_FINAL_BODY;
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
const mcpServers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map(closeServer));
  await Promise.all(
    mcpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    temporaryHomes.splice(0).map((home) =>
      rm(home, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

describe('real Desktop text Agent Turn', () => {
  it('enables, approves and recovers one real loopback MCP call without replay', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-mcp-test-'));
    temporaryHomes.push(home);
    const provider = await startProvider('mcp');
    providers.push(provider.server);
    const capturedMcpMethods: string[] = [];
    let session = 0;
    const mcpServer = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.method === 'DELETE') {
          capturedMcpMethods.push('DELETE');
          response.writeHead(200).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number;
          method: string;
        };
        capturedMcpMethods.push(body.method);
        if (body.method === 'notifications/initialized') {
          response.writeHead(202).end();
          return;
        }
        const result =
          body.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'desktop-http-fixture', version: '1.0.0' },
              }
            : body.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'inspect',
                      description: 'Inspect one integer',
                      inputSchema: {
                        type: 'object',
                        properties: { value: { type: 'integer' } },
                        required: ['value'],
                        additionalProperties: false,
                      },
                    },
                  ],
                }
              : {
                  content: [{ type: 'text', text: 'private MCP result' }],
                  isError: false,
                };
        const encoded = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result,
        });
        const headers: Record<string, string | number> = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded),
        };
        if (body.method === 'initialize') {
          session += 1;
          headers['Mcp-Session-Id'] = `desktop-session-${session}`;
        }
        response.writeHead(200, headers).end(encoded);
      });
    });
    await new Promise<void>((resolve, reject) => {
      mcpServer.once('error', reject);
      mcpServer.listen(0, '127.0.0.1', () => resolve());
    });
    mcpServers.push(mcpServer);
    const mcpAddress = mcpServer.address();
    if (!mcpAddress || typeof mcpAddress === 'string') {
      throw new Error('MCP fixture did not expose a port.');
    }
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'schema_version = 1',
        '[model]',
        'api_format = "openai-chat-completions"',
        `endpoint = "http://127.0.0.1:${provider.port}/v1/chat/completions"`,
        'model = "desktop-fixture-model"',
        '[[mcp.servers]]',
        'id = "http-fixture"',
        'transport = "streamable-http"',
        `endpoint = "http://127.0.0.1:${mcpAddress.port}/mcp"`,
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
      expect(first.mcpSession.getSnapshot()).toMatchObject({
        status: 'disabled',
        servers: [
          {
            id: 'http-fixture',
            transport: 'loopbackStreamableHttp',
          },
        ],
      });
      first.mcpApprovals.markSurfaceReady();
      expect(first.mcpSession.toggle('http-fixture').accepted).toBe(true);
      await expect(first.mcpSession.enable()).resolves.toEqual({
        accepted: true,
        reason: 'accepted',
      });
      await expect(
        first.conversation.startTurn('Use the configured MCP tool.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => expect(first.mcpApprovals.getSnapshot().status).toBe('pending'),
        { timeout: 10_000 },
      );
      const presentationId =
        first.mcpApprovals.getSnapshot().request?.presentationId;
      await expect(first.mcpApprovals.approve(presentationId)).resolves.toEqual({
        accepted: true,
        reason: 'accepted',
      });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                mcpActivities: [
                  {
                    serverId: 'http-fixture',
                    name: 'mcp__http-fixture__inspect',
                    decision: { value: 'approved' },
                    executionAttempt: { status: 'completed' },
                    result: {
                      status: 'completed',
                      receipt: { type: 'completed', isError: false },
                    },
                  },
                ],
              },
            ],
          });
        },
        { timeout: 10_000 },
      );
      const durableThreadId = first.conversation.getSnapshot().threadId;
      const durableActivity =
        first.conversation.getSnapshot().turns[0]?.mcpActivities;
      expect(JSON.stringify(first.conversation.getSnapshot())).not.toContain(
        'private MCP result',
      );
      expect(provider.requests).toHaveLength(2);
      expect(capturedMcpMethods).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'DELETE',
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
        'DELETE',
      ]);

      first.shutdown();
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
      expect(second.mcpSession.getSnapshot()).toMatchObject({
        status: 'disabled',
        activeServerIds: [],
      });
      expect(second.conversation.getSnapshot()).toMatchObject({
        threadId: durableThreadId,
      });
      expect(second.conversation.getSnapshot().turns[0]?.mcpActivities).toEqual(
        durableActivity,
      );
      expect(provider.requests).toHaveLength(2);
      expect(capturedMcpMethods).toHaveLength(9);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

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
      await expect(
        first.conversation.searchThreads('durable response'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      expect(first.conversation.getSnapshot().navigator.search).toMatchObject({
        query: 'durable response',
        status: 'ready',
        threadIds: [durableThreadId],
      });
      await expect(
        first.conversation.selectThread(durableThreadId),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
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
            role: 'developer',
            content: expect.stringContaining(
              'You are SugarCode, a coding agent',
            ),
          },
          {
            role: 'user',
            content: 'Keep this input exact: 雪',
          },
        ],
      });

      first.shutdown();
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
      expect(second.getSnapshot().status).toBe('ready');
      expect(second.conversation.getSnapshot()).toMatchObject({
        phase: 'ready',
        threadId: durableThreadId,
        navigator: {
          status: 'ready',
          activeThreadIds: [durableThreadId],
        },
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
            role: 'developer',
            content: expect.stringContaining(
              'You are SugarCode, a coding agent',
            ),
          },
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
      await expect(
        second.conversation.forkThread(durableThreadId),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      const forkedThreadId = second.conversation.getSnapshot().threadId;
      expect(forkedThreadId).toMatch(/^thr_[0-9a-f]{16}$/);
      expect(forkedThreadId).not.toBe(durableThreadId);
      expect(second.conversation.getSnapshot().turns).toHaveLength(2);

      await expect(
        second.conversation.archiveThread(forkedThreadId),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      expect(second.conversation.getSnapshot()).toMatchObject({
        threadId: durableThreadId,
        navigator: {
          archivedUndoThreadId: forkedThreadId,
          activeThreadIds: [durableThreadId],
        },
      });
      await expect(
        second.conversation.unarchiveThread(forkedThreadId),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      expect(second.conversation.getSnapshot().threadId).toBe(
        forkedThreadId,
      );

      await expect(
        second.conversation.deleteThread(forkedThreadId),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      expect(second.conversation.getSnapshot()).toMatchObject({
        threadId: durableThreadId,
        navigator: {
          activeThreadIds: [durableThreadId],
        },
      });
      expect(
        second.conversation.getSnapshot().navigator.archivedUndoThreadId,
      ).toBeUndefined();
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
    const createSupervisor = (): ConnectionSupervisor => {
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
          spawn(command, arguments_, {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
      });
      supervisor.configureInitialWorkspace(workspace);
      return supervisor;
    };
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
      const durableThreadId = firstSnapshot.threadId;
      const durableActivity = firstSnapshot.turns[0]?.workspaceRead;

      first.shutdown();
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
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
    const createSupervisor = (): ConnectionSupervisor => {
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
          spawn(command, arguments_, {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
      });
      supervisor.configureInitialWorkspace(workspace);
      return supervisor;
    };
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
      const durableThreadId = firstSnapshot.threadId;
      const durableActivity = firstSnapshot.turns[0]?.workspaceList;

      first.shutdown();
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
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
    const createSupervisor = (): ConnectionSupervisor => {
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
          spawn(command, arguments_, {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
      });
      supervisor.configureInitialWorkspace(workspace);
      return supervisor;
    };
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
      const durableThreadId = firstSnapshot.threadId;
      const durableActivity = firstSnapshot.turns[0]?.workspaceSearch;

      first.shutdown();
      await writeFile(privateMatchPath, 'replacement without the query\n');
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
      expect(second.conversation.getSnapshot().turns[0]?.workspaceSearch)
        .toEqual(durableActivity);
      expect(provider.requests).toHaveLength(2);
      expect(provider.errors).toEqual([]);
    } finally {
      first.shutdown();
      second?.shutdown();
    }
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('restores one durable file change review without replaying the write', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    const workspace = await mkdtemp(
      path.join(tmpdir(), 'sugarcode-workspace-test-'),
    );
    temporaryHomes.push(home, workspace);
    const filePath = path.join(workspace, 'notes.txt');
    await writeFile(filePath, 'one\ntwo\nthree\n');
    const provider = await startProvider('workspacePatch');
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
    const createSupervisor = (): ConnectionSupervisor => {
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
          spawn(
            command,
            [
              ...arguments_,
              '--allow-workspace-write',
            ],
            { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
          ),
      });
      supervisor.configureInitialWorkspace(workspace);
      return supervisor;
    };
    const first = createSupervisor();
    let second: ConnectionSupervisor | null = null;

    try {
      await first.start();
      await expect(
        first.conversation.startTurn('Update notes.txt.'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(first.conversation.getSnapshot()).toMatchObject({
            phase: 'ready',
            turns: [
              {
                status: 'completed',
                fileChange: {
                  path: 'notes.txt',
                  callStatus: 'completed',
                  change: {
                    status: 'completed',
                    kind: 'update',
                    diff: expect.stringContaining('-two\n+second\n'),
                    newlineStyle: 'lf',
                    finalNewline: true,
                  },
                  result: {
                    status: 'completed',
                    outcome: {
                      type: 'success',
                      path: 'notes.txt',
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
      expect(await readFile(filePath, 'utf8')).toBe('one\nsecond\nthree\n');
      const firstSnapshot = first.conversation.getSnapshot();
      const durableThreadId = firstSnapshot.threadId;
      const durableActivity = firstSnapshot.turns[0]?.fileChange;

      first.shutdown();
      await writeFile(filePath, 'changed after durable result\n');
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
      expect(second.conversation.getSnapshot().turns[0]?.fileChange)
        .toEqual(durableActivity);
      expect(await readFile(filePath, 'utf8')).toBe(
        'changed after durable result\n',
      );
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
      const durableThreadId =
        first.conversation.getSnapshot().threadId;

      first.shutdown();
      second = createSupervisor();
      await second.start();
      await selectDurableThread(second, durableThreadId);
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
      const durableThreadId =
        first.conversation.getSnapshot().threadId;

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
      await selectDurableThread(second, durableThreadId);
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
    'restores a real CLI command result summary without replaying arguments or output',
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
      const createSupervisor = (): ConnectionSupervisor => {
        const supervisor = new ConnectionSupervisor({
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
            spawn(command, arguments_, {
              ...options,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
        });
        supervisor.configureInitialWorkspace(workspace);
        return supervisor;
      };
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
                    executionResult: {
                      status: 'completed',
                      outcome: {
                        type: 'process',
                        stdoutBytes: 24,
                        stderrBytes: 0,
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        encoding: 'utf8Lossy',
                        outcome: { type: 'exitCode', code: 0 },
                        sandboxPolicy: 'filesystemReadOnlyV1',
                        networkPolicy: 'networkDeniedV1',
                      },
                    },
                  },
                },
              ],
            }),
          { timeout: 10_000 },
        );
        const durableActivity =
          first.conversation.getSnapshot().turns[0]?.commandApproval;
        const durableThreadId =
          first.conversation.getSnapshot().threadId;
        expect(JSON.stringify(durableActivity)).not.toContain(
          'private-command-argument',
        );
        expect(JSON.stringify(durableActivity)).not.toContain('"stdout":');
        expect(JSON.stringify(durableActivity)).not.toContain('"stderr":');
        expect(
          durableActivity?.executionResult?.outcome.type === 'process' &&
            durableActivity.executionResult.outcome.durationMs,
        ).toBeGreaterThanOrEqual(0);

        first.shutdown();
        second = createSupervisor();
        await second.start();
        await selectDurableThread(second, durableThreadId);
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
      });
      try {
        await supervisor.start();
        await supervisor.conversation.startTurn('Inspect the tools.');
        await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
          timeout: 10_000,
        });
        expect(provider.requests[0]?.body).not.toMatchObject({
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: 'function',
              function: expect.objectContaining({
                name: 'shell/exec',
              }),
            }),
          ]),
        });
      } finally {
        supervisor.shutdown();
      }
    },
    REAL_CLI_TEST_TIMEOUT_MS,
  );
});
