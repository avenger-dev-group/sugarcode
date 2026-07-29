import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

import type {
  McpConfiguredServer,
  McpServerTransport,
} from '@/shared/mcp';

import type { ResolvedCli } from '../cli/resolution';

const MAX_INVENTORY_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

type DiscoverMcpServersOptions = Readonly<{
  cli: ResolvedCli;
  environment: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isServerId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value) &&
  Buffer.byteLength(value) <= 32;

const isTransport = (value: unknown): value is McpServerTransport =>
  value === 'stdio' || value === 'loopbackStreamableHttp';

export const parseMcpServerInventory = (
  value: unknown,
): readonly McpConfiguredServer[] => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.servers) ||
    value.servers.length > 2
  ) {
    throw new Error('Invalid MCP server inventory.');
  }
  const seen = new Set<string>();
  const servers = value.servers.map((server): McpConfiguredServer => {
    if (
      !isRecord(server) ||
      Object.keys(server).length !== 2 ||
      !isServerId(server.id) ||
      !isTransport(server.transport) ||
      seen.has(server.id)
    ) {
      throw new Error('Invalid MCP server inventory.');
    }
    seen.add(server.id);
    return { id: server.id, transport: server.transport };
  });
  const sorted = [...servers].sort((left, right) =>
    Buffer.from(left.id).compare(Buffer.from(right.id)),
  );
  if (sorted.some((server, index) => server.id !== servers[index]?.id)) {
    throw new Error('MCP server inventory is not sorted.');
  }
  return servers;
};

export const discoverMcpServers = async (
  options: DiscoverMcpServersOptions,
): Promise<readonly McpConfiguredServer[]> =>
  new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.spawnProcess ?? spawn)(
        options.cli.executablePath,
        ['config', 'mcp', 'list', '--json'],
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
      reject(new Error('MCP configuration discovery could not start.'));
      return;
    }
    child.stdin.end();
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, servers?: readonly McpConfiguredServer[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(servers ?? []);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('MCP configuration discovery timed out.'));
    }, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_INVENTORY_BYTES) {
        child.kill();
        finish(new Error('MCP configuration inventory exceeded its limit.'));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.once('error', () => {
      finish(new Error('MCP configuration discovery failed.'));
    });
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(new Error('MCP configuration discovery was rejected.'));
        return;
      }
      try {
        const text = Buffer.concat(stdout).toString('utf8');
        const bytes = Buffer.from(text, 'utf8');
        if (!bytes.equals(Buffer.concat(stdout)) || !text.endsWith('\n')) {
          throw new Error('Invalid MCP configuration encoding.');
        }
        finish(undefined, parseMcpServerInventory(JSON.parse(text)));
      } catch {
        finish(new Error('MCP configuration discovery returned invalid data.'));
      }
    });
  });
