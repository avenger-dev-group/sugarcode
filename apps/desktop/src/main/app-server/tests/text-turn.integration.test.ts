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

type ProviderCapture = Readonly<{
  server: Server;
  port: number;
  request: Promise<Readonly<{ headers: string; body: unknown }>>;
}>;

const startProvider = async (): Promise<ProviderCapture> => {
  let resolveRequest!: (
    value: Readonly<{ headers: string; body: unknown }>,
  ) => void;
  const request = new Promise<
    Readonly<{ headers: string; body: unknown }>
  >((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    let responded = false;
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
      resolveRequest({
        headers,
        body: JSON.parse(
          bytes.subarray(bodyStart, bodyStart + length).toString('utf8'),
        ) as unknown,
      });
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
  return { server, port: address.port, request };
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
  it('projects one durable streamed Turn from the repository CLI', async () => {
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
      expect(supervisor.getSnapshot().status).toBe('ready');
      await expect(
        supervisor.conversation.startTurn('Keep this input exact: 雪'),
      ).resolves.toEqual({ accepted: true, reason: 'accepted' });
      await vi.waitFor(
        () => {
          expect(supervisor.conversation.getSnapshot()).toMatchObject({
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
      const captured = await provider.request;
      expect(captured.headers).toMatch(
        /^POST \/v1\/chat\/completions HTTP\/1\.1\r\n/,
      );
      expect(captured.headers.toLowerCase()).not.toContain('authorization:');
      expect(captured.body).toMatchObject({
        model: 'desktop-fixture-model',
        messages: [
          {
            role: 'user',
            content: 'Keep this input exact: 雪',
          },
        ],
      });
    } finally {
      supervisor.shutdown();
    }
  });
});
