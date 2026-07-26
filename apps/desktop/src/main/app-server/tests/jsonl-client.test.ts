import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { JsonlClient } from '../jsonl-client';

const initializeParams = {
  protocolVersion: 1,
  clientInfo: {
    name: 'desktop-test',
    version: '1.0.0',
  },
};

const initializeResult = {
  capabilities: { commandApprovals: true },
  platform: {
    family: 'unix',
    os: 'macos',
    arch: 'aarch64',
  },
  protocolVersion: 1,
  serverInfo: {
    name: 'sugarcode',
    version: '1.0.0',
  },
};

const readLine = async (stream: PassThrough): Promise<string> => {
  const [chunk] = await once(stream, 'data');
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
};

class ManualBackpressureWriter extends Writable {
  readonly writes: string[] = [];
  private completeWrite: (() => void) | null = null;

  constructor() {
    super({ highWaterMark: 1 });
  }

  flush = (): void => {
    const completeWrite = this.completeWrite;
    this.completeWrite = null;
    completeWrite?.();
  };

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(chunk.toString('utf8'));
    this.completeWrite = callback;
    this.emit('captured');
  }
}

describe('JsonlClient', () => {
  it('writes a correlated response to one server request', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonlClient({
      stdin,
      stdout,
      onServerRequest: (request) => {
        void client.respond(request.id, { decision: 'denied' });
      },
    });

    const responseLine = readLine(stdin);
    stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'approval/one',
        method: 'item/commandExecution/requestApproval',
        params: {},
      })}\n`,
    );

    await expect(responseLine).resolves.toContain(
      '"id":"approval/one","result":{"decision":"denied"}',
    );
    client.close();
  });

  it('frames partial and multi-line chunks and preserves initialize order', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const notification = vi.fn();
    const client = new JsonlClient({
      stdin,
      stdout,
      onNotification: notification,
    });

    const initialize = client.initialize(initializeParams);
    const request = JSON.parse(await readLine(stdin)) as { id: number };
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: initializeResult,
    });
    const notificationLine = JSON.stringify({
      jsonrpc: '2.0',
      method: 'future/notification',
      params: {},
    });
    stdout.write(response.slice(0, 12));
    stdout.write(`${response.slice(12)}\n${notificationLine}\n`);

    await expect(initialize).resolves.toEqual(initializeResult);
    expect(notification).toHaveBeenCalledOnce();

    const initializedWrite = readLine(stdin);
    await client.initialized();
    await expect(initializedWrite).resolves.toContain(
      '"method":"initialized"',
    );
    client.close();
  });

  it.each([
    ['empty line', Buffer.from('\n')],
    ['malformed JSON', Buffer.from('{broken\n')],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
  ])('fails safely on %s', async (_name, bytes) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const client = new JsonlClient({
      stdin,
      stdout,
      onFatalError: fatal,
    });

    const initialize = client.initialize(initializeParams);
    await readLine(stdin);
    stdout.write(bytes);

    await expect(initialize).rejects.toBeInstanceOf(Error);
    expect(fatal).toHaveBeenCalledOnce();
    client.close();
  });

  it('rejects an oversized unterminated line', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const client = new JsonlClient({
      stdin,
      stdout,
      maxLineBytes: 4,
      onFatalError: fatal,
    });

    const initialize = client.initialize(initializeParams);
    await readLine(stdin);
    stdout.write('12345');

    await expect(initialize).rejects.toThrow('size limit');
    expect(fatal).toHaveBeenCalledOnce();
  });

  it('rejects unknown and duplicate response IDs', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const client = new JsonlClient({
      stdin,
      stdout,
      onFatalError: fatal,
    });

    const initialize = client.initialize(initializeParams);
    const request = JSON.parse(await readLine(stdin)) as { id: number };
    const response = `${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: initializeResult,
    })}\n`;
    stdout.write(response);
    await initialize;
    stdout.write(response);

    expect(fatal).toHaveBeenCalledOnce();
  });

  it('aborts before writing without leaving a pending request', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const controller = new AbortController();
    controller.abort();
    const client = new JsonlClient({ stdin, stdout });

    await expect(
      client.initialize(initializeParams, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stdin.readableLength).toBe(0);
    client.close();
  });

  it('locally aborts after writing and ignores one late response', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fatal = vi.fn();
    const controller = new AbortController();
    const client = new JsonlClient({
      stdin,
      stdout,
      onFatalError: fatal,
    });

    const initialize = client.initialize(
      initializeParams,
      controller.signal,
    );
    const request = JSON.parse(await readLine(stdin)) as { id: number };
    controller.abort();
    await expect(initialize).rejects.toMatchObject({ name: 'AbortError' });

    stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: initializeResult,
      })}\n`,
    );
    expect(fatal).not.toHaveBeenCalled();
    client.close();
  });

  it('rejects every pending request once when closed', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonlClient({ stdin, stdout });
    const initialize = client.initialize(initializeParams);
    await readLine(stdin);

    client.close();
    client.close();
    await expect(initialize).rejects.toThrow('connection is closed');
  });

  it('waits for stdin backpressure to drain before the next write', async () => {
    const stdin = new ManualBackpressureWriter();
    const stdout = new PassThrough();
    const client = new JsonlClient({ stdin, stdout });
    const firstWrite = once(stdin, 'captured');
    const initialize = client.initialize(initializeParams);
    await firstWrite;
    expect(stdin.writes).toHaveLength(1);
    const request = JSON.parse(stdin.writes[0]) as { id: number };
    stdin.flush();
    stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: initializeResult,
      })}\n`,
    );
    await initialize;

    let initializedComplete = false;
    const secondWrite = once(stdin, 'captured');
    const initialized = client.initialized().then(() => {
      initializedComplete = true;
    });
    await secondWrite;
    expect(stdin.writes).toHaveLength(2);
    expect(initializedComplete).toBe(false);
    stdin.flush();
    await initialized;
    expect(initializedComplete).toBe(true);
    client.close();
  });

  it('rejects initialized when stdin has already closed', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new JsonlClient({ stdin, stdout });
    const initialize = client.initialize(initializeParams);
    const request = JSON.parse(await readLine(stdin)) as { id: number };
    stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: initializeResult,
      })}\n`,
    );
    await initialize;
    stdin.end();

    await expect(client.initialized()).rejects.toThrow('not writable');
    client.close();
  });
});
