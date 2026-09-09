import {
  BaseTool,
  MCPTool,
  type MCPSessionManager,
  type RunAsyncToolRequest,
} from '@google/adk';
import { Type } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client';
// The MCP package's wildcard export needs its runtime .js suffix. The current
// ESLint resolver does not understand that conditional package-export shape.
// eslint-disable-next-line import/no-unresolved
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// eslint-disable-next-line import/no-unresolved
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';

import type {
  McpConfigInspection,
  McpServerConfig,
  McpSessionActionResult,
} from '../../shared/mcp.ts';

export type McpToolApproval = Readonly<{
  serverId: string;
  name: string;
  purpose: string;
  argumentsValue: Readonly<Record<string, unknown>>;
  inventorySha256: string;
  execute: () => Promise<unknown>;
}>;

const APPROVAL_PURPOSE_ARGUMENT = 'sugarcodeApprovalPurpose';
const MAX_APPROVAL_PURPOSE_BYTES = 512;

const approvalPurpose = (
  value: unknown,
  serverId: string,
  toolName: string,
): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      trimmed.length > 0 &&
      Buffer.byteLength(trimmed, 'utf8') <= MAX_APPROVAL_PURPOSE_BYTES
    ) {
      return trimmed;
    }
  }
  const prefix = `mcp__${serverId}__`;
  const displayName = toolName.startsWith(prefix)
    ? toolName.slice(prefix.length)
    : toolName;
  return `使用 ${serverId} 的 ${displayName} 完成当前任务。`;
};

type ActiveServer = Readonly<{
  id: string;
  client: Client;
  tools: readonly BaseTool[];
  inventorySha256: string;
}>;

const MCP_REQUEST_TIMEOUT_MS = 15_000;

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

const connect = async (server: McpServerConfig): Promise<Client> => {
  const client = new Client({
    name: 'SugarCode Desktop MCP',
    version: '1.0.0',
  });
  const transport = server.transport === 'stdio'
    ? new StdioClientTransport({
        command: server.executable,
        args: [...server.argv],
        cwd: server.cwd,
        stderr: 'inherit',
      })
    : new StreamableHTTPClientTransport(new URL(server.endpoint));
  try {
    await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
    return client;
  } catch (error) {
    await client.close().catch((): undefined => undefined);
    throw error;
  }
};

const toolsFrom = async (
  server: McpServerConfig,
  client: Client,
): Promise<readonly BaseTool[]> => {
  const inventory = await client.listTools(
    undefined,
    { timeout: MCP_REQUEST_TIMEOUT_MS },
  );
  // ADK's MCPTool only needs this small session-manager surface. Keeping the
  // already-negotiated client here is important for stateful local servers
  // such as Figma Desktop, and avoids ADK's optional runtime require of the
  // MCP SDK (which is not present as a loose node_module in packaged builds).
  const sessionManager = {
    createSession: async (): Promise<Client> => client,
    closeSession: async (): Promise<void> => undefined,
    getActiveSessions: () => [client],
  } as unknown as MCPSessionManager;
  return inventory.tools.map((tool) =>
    new MCPTool(
      { ...tool, name: `mcp__${server.id}__${tool.name}` },
      sessionManager,
      tool.name,
    ),
  );
};

const isFigmaDesktopServer = (server: McpServerConfig): boolean => {
  if (server.id.toLocaleLowerCase().includes('figma')) {
    return true;
  }
  if (server.transport !== 'loopbackStreamableHttp') {
    return false;
  }
  try {
    const endpoint = new URL(server.endpoint);
    return (
      ['127.0.0.1', 'localhost'].includes(endpoint.hostname) &&
      endpoint.port === '3845' &&
      endpoint.pathname === '/mcp'
    );
  } catch {
    return false;
  }
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
    const declaration = this.delegate._getDeclaration();
    const parameters = declaration.parameters;
    return {
      ...declaration,
      parameters: {
        ...parameters,
        properties: {
          ...(parameters?.properties ?? {}),
          [APPROVAL_PURPOSE_ARGUMENT]: {
            type: Type.STRING,
            description:
              '用用户当前使用的语言，简洁说明本次调用将完成什么、为什么需要它以及可见结果。写 1–2 句具体的人话，不要复述工具名、参数或实现机制。此说明会直接显示在授权提示中。',
          },
        },
        required: [
          ...new Set([
            ...(parameters?.required ?? []),
            APPROVAL_PURPOSE_ARGUMENT,
          ]),
        ],
      },
    };
  }

  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const {
      [APPROVAL_PURPOSE_ARGUMENT]: purposeValue,
      ...argumentsValue
    } = request.args;
    return this.approve({
      serverId: this.serverId,
      name: this.name,
      purpose: approvalPurpose(purposeValue, this.serverId, this.name),
      argumentsValue,
      inventorySha256: this.inventorySha256,
      execute: () => this.delegate.runAsync({
        ...request,
        args: argumentsValue,
      }),
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

  ensureApplicationActive = async (
    application: string,
  ): Promise<McpSessionActionResult> => {
    if (application !== 'figma' || !this.inspection) {
      return result('unavailable');
    }
    const server =
      this.inspection.servers.find(
        (candidate) =>
          candidate.transport === 'loopbackStreamableHttp' &&
          isFigmaDesktopServer(candidate),
      ) ?? this.inspection.servers.find(isFigmaDesktopServer);
    if (!server) {
      return result('unavailable');
    }
    if (this.active.some((candidate) => candidate.id === server.id)) {
      return result('accepted');
    }
    return this.setActive([server.id]);
  };

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
        const client = await connect(server);
        let tools: readonly BaseTool[];
        try {
          tools = await toolsFrom(server, client);
        } catch (error) {
          await client.close().catch((): undefined => undefined);
          throw error;
        }
        next.push({
          id: server.id,
          client,
          tools,
          inventorySha256: inventoryRevision(tools),
        });
      }
    } catch {
      await Promise.allSettled(next.map(({ client }) => client.close()));
      return result(
        selected.some(
          (server) => server.transport === 'loopbackStreamableHttp',
        )
          ? 'connectionFailed'
          : 'unavailable',
      );
    }
    const previous = this.active;
    this.active = next;
    await Promise.allSettled(previous.map(({ client }) => client.close()));
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
    await Promise.allSettled(active.map(({ client }) => client.close()));
  };
}
