import type {
  InitializeParams,
  InitializeResponse,
  JsonValue,
  RequestId,
} from '@sugarcode/app-server-protocol';
import { JSON_RPC_VERSION } from '@sugarcode/app-server-protocol';
import type { Readable, Writable } from 'node:stream';

import {
  parseInitializeResponse,
  parseServerMessage,
  type ServerMessage,
} from './server-message';

const DEFAULT_MAX_LINE_BYTES = 6 * 1024 * 1024;
const MAX_ABORTED_IDS = 256;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
};

type JsonlClientOptions = Readonly<{
  stdin: Writable;
  stdout: Readable;
  maxLineBytes?: number;
  onNotification?: (message: Extract<
    ServerMessage,
    { kind: 'notification' }
  >) => void;
  onServerRequest?: (message: Extract<
    ServerMessage,
    { kind: 'request' }
  >) => void;
  onFatalError?: (error: Error) => void;
  onTransportEnd?: () => void;
}>;

export class ConnectionClosedError extends Error {
  constructor(message = 'The app-server connection is closed.') {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

export class RpcResponseError extends Error {
  readonly code: number;
  readonly data?: JsonValue;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = 'RpcResponseError';
    this.code = code;
    this.data = data;
  }
}

const createAbortError = (): Error => {
  const error = new Error('The local request wait was aborted.');
  error.name = 'AbortError';
  return error;
};

export class JsonlClient {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly maxLineBytes: number;
  private readonly onNotification?: JsonlClientOptions['onNotification'];
  private readonly onServerRequest?: JsonlClientOptions['onServerRequest'];
  private readonly onFatalError?: JsonlClientOptions['onFatalError'];
  private readonly onTransportEnd?: JsonlClientOptions['onTransportEnd'];
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly abortedIds = new Set<RequestId>();
  private buffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private initializationState: 'idle' | 'responded' | 'ready' = 'idle';

  constructor(options: JsonlClientOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onFatalError = options.onFatalError;
    this.onTransportEnd = options.onTransportEnd;

    this.stdout.on('data', this.handleData);
    this.stdout.once('end', this.handleEnd);
    this.stdout.once('error', this.handleStreamError);
    this.stdin.once('error', this.handleStreamError);
  }

  initialize = async (
    params: InitializeParams,
    signal?: AbortSignal,
  ): Promise<InitializeResponse> => {
    if (this.initializationState !== 'idle') {
      throw new Error('Initialize may only be requested once.');
    }
    const result = await this.request('initialize', params, signal);
    const response = parseInitializeResponse(result);
    this.initializationState = 'responded';
    return response;
  };

  initialized = async (): Promise<void> => {
    if (this.initializationState !== 'responded') {
      throw new Error('Initialized must follow a successful initialize response.');
    }
    await this.enqueueMessage({
      jsonrpc: JSON_RPC_VERSION,
      method: 'initialized',
    });
    this.initializationState = 'ready';
  };

  requestReady = (
    method: string,
    params: JsonValue,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (this.initializationState !== 'ready') {
      return Promise.reject(
        new Error('App-server requests require a ready connection.'),
      );
    }
    return this.request(method, params, signal);
  };

  respond = (id: RequestId, result: JsonValue): Promise<void> =>
    this.enqueueMessage({
      jsonrpc: JSON_RPC_VERSION,
      id,
      result,
    });

  close = (error: Error = new ConnectionClosedError()): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdout.off('data', this.handleData);
    this.stdout.off('end', this.handleEnd);
    this.stdout.off('error', this.handleStreamError);
    this.stdin.off('error', this.handleStreamError);
    for (const pending of this.pending.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stdin.destroyed && !this.stdin.writableEnded) {
      this.stdin.end();
    }
  };

  private request = async (
    method: string,
    params: JsonValue,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (this.closed) {
      throw new ConnectionClosedError();
    }
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      throw new Error('JSON-RPC request ID sequence exhausted.');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (signal) {
        const handleAbort = (): void => {
          if (!this.pending.delete(id)) {
            return;
          }
          this.rememberAbortedId(id);
          reject(createAbortError());
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        pending.removeAbortListener = () =>
          signal.removeEventListener('abort', handleAbort);
      }
      this.pending.set(id, pending);
    });

    try {
      await this.enqueueMessage({
        jsonrpc: JSON_RPC_VERSION,
        id,
        method,
        params,
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.removeAbortListener?.();
        pending.reject(
          error instanceof Error ? error : new Error('Failed to write request.'),
        );
      }
    }
    return response;
  };

  private enqueueMessage = (message: JsonValue): Promise<void> => {
    if (this.closed) {
      return Promise.reject(new ConnectionClosedError());
    }
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeQueue.then(() => this.writeLine(line));
    this.writeQueue = write.catch((): undefined => undefined);
    return write;
  };

  private writeLine = (line: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (
        this.closed ||
        this.stdin.destroyed ||
        this.stdin.writableEnded ||
        !this.stdin.writable
      ) {
        reject(new ConnectionClosedError('App-server stdin is not writable.'));
        return;
      }

      let callbackComplete = false;
      let drainComplete = false;
      let settled = false;
      const cleanup = (): void => {
        this.stdin.off('error', handleError);
        this.stdin.off('drain', handleDrain);
      };
      const finish = (): void => {
        if (!settled && callbackComplete && drainComplete) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const handleError = (error: Error): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const handleDrain = (): void => {
        drainComplete = true;
        finish();
      };

      this.stdin.once('error', handleError);
      const accepted = this.stdin.write(line, 'utf8', (error?: Error | null) => {
        if (error) {
          handleError(error);
          return;
        }
        callbackComplete = true;
        finish();
      });
      drainComplete = accepted;
      if (!accepted) {
        this.stdin.once('drain', handleDrain);
      }
      finish();
    });

  private handleData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);

    while (!this.closed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxLineBytes) {
          this.fail(new Error('App-server stdout line exceeded the size limit.'));
        }
        return;
      }
      if (newline > this.maxLineBytes) {
        this.fail(new Error('App-server stdout line exceeded the size limit.'));
        return;
      }
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0) {
        this.fail(new Error('App-server stdout contained an empty line.'));
        return;
      }
      this.processLine(line);
    }
  };

  private processLine = (line: Buffer): void => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      const value: unknown = JSON.parse(text);
      this.dispatch(parseServerMessage(value));
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error('Invalid app-server stdout message.'),
      );
    }
  };

  private dispatch = (message: ServerMessage): void => {
    if (message.kind === 'notification') {
      this.onNotification?.(message);
      return;
    }
    if (message.kind === 'request') {
      this.onServerRequest?.(message);
      return;
    }

    if (message.id === null) {
      this.fail(new Error('Uncorrelated JSON-RPC error response.'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (this.abortedIds.delete(message.id)) {
        return;
      }
      this.fail(new Error('Unknown JSON-RPC response ID.'));
      return;
    }

    this.pending.delete(message.id);
    pending.removeAbortListener?.();
    if (message.kind === 'result') {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new RpcResponseError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    }
  };

  private rememberAbortedId = (id: RequestId): void => {
    this.abortedIds.add(id);
    if (this.abortedIds.size > MAX_ABORTED_IDS) {
      const oldest = this.abortedIds.values().next().value;
      if (oldest !== undefined) {
        this.abortedIds.delete(oldest);
      }
    }
  };

  private handleEnd = (): void => {
    if (this.closed) {
      return;
    }
    if (this.buffer.length > 0) {
      this.fail(new Error('App-server stdout ended with a partial line.'));
      return;
    }
    this.close(new ConnectionClosedError('App-server stdout ended.'));
    this.onTransportEnd?.();
  };

  private handleStreamError = (error: Error): void => {
    this.fail(error);
  };

  private fail = (error: Error): void => {
    if (this.closed) {
      return;
    }
    this.close(error);
    this.onFatalError?.(error);
  };
}
