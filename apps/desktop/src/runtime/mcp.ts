import {
  BaseTool,
  MCPToolset,
  type MCPConnectionParams,
  type RunAsyncToolRequest,
} from '@google/adk';
import { createHash } from 'node:crypto';

import type {
  McpConfigInspection,
  McpServerConfig,
  McpSessionActionResult,
} from '../shared/mcp.ts';

export type McpToolApproval = Readonly<{
  serverId: string;
  name: string;
  argumentsValue: Readonly<Record<string, unknown>>;
  inventorySha256: string;
  execute: () => Promise<unknown>;
}>;

type ActiveServer = Readonly<{
  id: string;
  toolset: MCPToolset;
  tools: readonly BaseTool[];
  inventorySha256: string;
}>;

const result = (
  reason: McpSessionActionResult['reason'],
): McpSessionActionResult => ({ accepted: reason === 'accepted', reason });

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableValue(item)]),
  );
};

const inventoryRevision = (tools: readonly BaseTool[]): string => {
  const inventory = tools
    .map((tool) => ({ name: tool.name, declaration: tool._getDeclaration() }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  return createHash('sha256')
    .update(JSON.stringify(stableValue(inventory)))
    .digest('hex');
};

const connectionParams = (server: McpServerConfig): MCPConnectionParams =>
  server.transport === 'stdio'
    ? {
        type: 'StdioConnectionParams',
        serverParams: {
          command: server.executable,
          args: [...server.argv],
          cwd: server.cwd,
          stderr: 'inherit',
        },
        timeout: 15_000,
      }
    : {
        type: 'StreamableHTTPConnectionParams',
        url: server.endpoint,
        timeout: 15_000,
        sseReadTimeout: 120_000,
        terminateOnClose: true,
      };

class ApprovedMcpTool extends BaseTool {
  private readonly delegate: BaseTool;
  private readonly serverId: string;
  private readonly inventorySha256: string;
  private readonly approve: (request: McpToolApproval) => Promise<unknown>;

  constructor(
    delegate: BaseTool,
    serverId: string,
    inventorySha256: string,
    approve: (request: McpToolApproval) => Promise<unknown>,
  ) {
    super({
      name: delegate.name,
      description: delegate.description,
      isLongRunning: delegate.isLongRunning,
    });
    this.delegate = delegate;
    this.serverId = serverId;
    this.inventorySha256 = inventorySha256;
    this.approve = approve;
  }

  override _getDeclaration() {
    return this.delegate._getDeclaration();
  }

  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.approve({
      serverId: this.serverId,
      name: this.name,
      argumentsValue: request.args,
      inventorySha256: this.inventorySha256,
      execute: () => this.delegate.runAsync(request),
    });
  }
}

export class RuntimeMcpManager {
  private inspection: McpConfigInspection | null = null;
  private active: readonly ActiveServer[] = [];

  configure = (inspection: McpConfigInspection): void => {
    this.inspection = inspection;
  };

  getActiveServerIds = (): readonly string[] =>
    this.active.map((server) => server.id);

  setActive = async (
    serverIds: readonly string[],
  ): Promise<McpSessionActionResult> => {
    if (!this.inspection) {
      return result('unavailable');
    }
    const servers = serverIds.map((id) =>
      this.inspection?.servers.find((server) => server.id === id),
    );
    if (servers.some((server) => !server)) {
      return result('invalid');
    }
    const selected = servers as McpServerConfig[];
    const httpCount = selected.filter(
      (server) => server.transport === 'loopbackStreamableHttp',
    ).length;
    if ((httpCount > 0 && selected.length !== 1) || selected.length > 2) {
      return result('incompatibleSelection');
    }
    const next: ActiveServer[] = [];
    try {
      for (const server of selected) {
        const toolset = new MCPToolset(
          connectionParams(server),
          [],
          `mcp__${server.id}_`,
        );
        const tools = await toolset.getTools();
        next.push({
          id: server.id,
          toolset,
          tools,
          inventorySha256: inventoryRevision(tools),
        });
      }
    } catch {
      await Promise.allSettled(next.map(({ toolset }) => toolset.close()));
      return result('unavailable');
    }
    const previous = this.active;
    this.active = next;
    await Promise.allSettled(previous.map(({ toolset }) => toolset.close()));
    return result('accepted');
  };

  toolsForTurn = (
    approve: (request: McpToolApproval) => Promise<unknown>,
  ): readonly BaseTool[] =>
    this.active.flatMap((server) =>
      server.tools.map(
        (tool) =>
          new ApprovedMcpTool(
            tool,
            server.id,
            server.inventorySha256,
            approve,
          ),
      ),
    );

  executeRecovered = async (
    serverId: string,
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    inventorySha256: string,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const server = this.active.find((candidate) => candidate.id === serverId);
    if (!server || server.inventorySha256 !== inventorySha256) {
      throw new Error('The recovered MCP inventory is no longer active.');
    }
    const tool = server.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error('The recovered MCP tool is no longer available.');
    }
    return tool.runAsync({
      args: argumentsValue,
      toolContext: { abortSignal: signal } as never,
    });
  };

  close = async (): Promise<void> => {
    const active = this.active;
    this.active = [];
    await Promise.allSettled(active.map(({ toolset }) => toolset.close()));
  };
}
