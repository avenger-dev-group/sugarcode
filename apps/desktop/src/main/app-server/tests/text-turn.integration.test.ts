import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSupervisor } from '../connection/supervisor';

const RESPONSE_BODY = [
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"Durable "},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{"content":"response."},"finish_reason":null}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"desktop-fixture","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n',
].join('');

const REAL_CLI_TEST_TIMEOUT_MS = 30_000;

type ProviderCapture = Readonly<{
  server: Server;
  port: number;
  requests: Array<Readonly<{ headers: string; body: unknown }>>;
  errors: Error[];
}>;

const startProvider = async (
  respond = true,
): Promise<ProviderCapture> => {
  const requests: Array<
    Readonly<{ headers: string; body: unknown }>
  > = [];
  const errors: Error[] = [];
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    let responded = false;
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!respond && error.code === 'ECONNRESET') {
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
      if (!respond) {
        return;
      }
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(RESPONSE_BODY)}\r\nConnection: close\r\n\r\n${RESPONSE_BODY}`,
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
                    text: 'Durable response.',
                    status: 'completed',
                  },
                ],
              },
            ],
          });
        },
        { timeout: 10_000 },
      );
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
                text: 'Durable response.',
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
                  { role: 'agent', text: 'Durable response.' },
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
            content: 'Durable response.',
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

  it('accepts only Core durable interruption after an active process exits', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'sugarcode-turn-test-'));
    temporaryHomes.push(home);
    const provider = await startProvider(false);
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
});
