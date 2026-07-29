import type {
  McpConfiguredServer,
  McpServerTransport,
} from '@/shared/mcp';

import type { ResolvedCli } from '../cli/resolution';
import {
  runCliJson,
  type SpawnProcess,
} from '../cli/one-shot';

const MAX_INVENTORY_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

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
): Promise<readonly McpConfiguredServer[]> => {
  const value = await runCliJson({
    cli: options.cli,
    environment: options.environment,
    args: ['config', 'mcp', 'list', '--json'],
    timeoutMs: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    outputLimit: MAX_INVENTORY_BYTES,
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
  });
  return parseMcpServerInventory(value);
};
