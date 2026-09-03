import {
  BaseTool,
  MCPToolset,
  type MCPConnectionParams,
  type RunAsyncToolRequest,
} from '@google/adk';
import { Type } from '@google/genai';
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
