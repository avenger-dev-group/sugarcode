import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import type { ResolvedCli } from './resolution';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type RunCliJsonOptions = Readonly<{
  cli: ResolvedCli;
  environment: NodeJS.ProcessEnv;
  args: readonly string[];
  input?: Buffer;
  timeoutMs?: number;
  outputLimit?: number;
  spawnProcess?: SpawnProcess;
}>;

export class CliOneShotError extends Error {
  constructor(
    readonly kind:
      | 'spawn'
      | 'timeout'
      | 'outputLimit'
      | 'rejected'
      | 'invalidOutput',
  ) {
    super(`SugarCode CLI one-shot command failed (${kind}).`);
    this.name = 'CliOneShotError';
  }
}

export const runCliJson = async (
  options: RunCliJsonOptions,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.spawnProcess ?? spawn)(
        options.cli.executablePath,
        options.args,
        {
          cwd: options.cli.workingDirectory,
          detached: false,
          env: options.environment,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      reject(new CliOneShotError('spawn'));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new CliOneShotError('timeout'));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.outputLimit ?? DEFAULT_OUTPUT_LIMIT)) {
        child.kill();
        finish(new CliOneShotError('outputLimit'));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.once('error', () => finish(new CliOneShotError('spawn')));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new CliOneShotError('rejected'));
        return;
      }
      try {
        const bytes = Buffer.concat(stdout);
        const text = bytes.toString('utf8');
        if (
          !Buffer.from(text, 'utf8').equals(bytes) ||
          !text.endsWith('\n')
        ) {
          throw new Error('invalid encoding');
        }
        finish(undefined, JSON.parse(text));
      } catch {
        finish(new CliOneShotError('invalidOutput'));
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
