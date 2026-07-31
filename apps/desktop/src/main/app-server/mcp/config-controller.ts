import {
  isMcpConfigInspection,
  isMcpConfigSaveRequest,
  type McpConfigActionResult,
  type McpConfigInspection,
} from '@/shared/mcp';

import { CliOneShotError, runCliJson } from '../cli/one-shot';
import type { ConnectionSupervisor } from '../connection/supervisor';

type McpConfigControllerOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  runCliJson?: typeof runCliJson;
}>;

const rejected = (
  reason: McpConfigActionResult['reason'],
  inspection?: McpConfigInspection,
): McpConfigActionResult => ({
  accepted: false,
  reason,
  ...(inspection ? { inspection } : {}),
});

export class McpConfigController {
  private readonly run: typeof runCliJson;

  constructor(private readonly options: McpConfigControllerOptions) {
    this.run = options.runCliJson ?? runCliJson;
  }

  inspect = async (): Promise<McpConfigInspection> => {
    const value = await this.runCommand([
      'config',
      'mcp',
      'inspect',
      '--json',
    ]);
    if (!isMcpConfigInspection(value)) {
      throw new Error('The MCP configuration receipt was invalid.');
    }
    return value;
  };

  save = async (request: unknown): Promise<McpConfigActionResult> => {
    if (!isMcpConfigSaveRequest(request)) {
      return rejected('invalid');
    }
    const session = this.options.supervisor.mcpSession.getSnapshot();
    if (
      session.status !== 'disabled' ||
      session.activeServerIds.length > 0
    ) {
      return rejected('sessionActive');
    }
    const lease = this.options.supervisor.beginConfigWrite();
    if (typeof lease === 'string') {
      return rejected(lease);
    }
    try {
      try {
        await this.runCommand(
          ['config', 'mcp', 'validate', '--stdin', '--json'],
          Buffer.from(
            JSON.stringify({
              contractVersion: 1,
              servers: request.servers,
            }),
            'utf8',
          ),
        );
      } catch {
        return rejected('invalid');
      }
      try {
        const value = await this.runCommand(
          ['config', 'mcp', 'set', '--stdin', '--json'],
          Buffer.from(
            JSON.stringify({
              contractVersion: 1,
              expectedRevision: request.expectedRevision,
              servers: request.servers,
            }),
            'utf8',
          ),
        );
        if (!isMcpConfigInspection(value)) {
          return rejected('unavailable');
        }
        this.options.supervisor.mcpSession.initialize(
          value.servers.map(({ id, transport }) => ({ id, transport })),
        );
        return { accepted: true, reason: 'accepted', inspection: value };
      } catch {
        const current = await this.inspect().catch(
          (): undefined => undefined,
        );
        return current?.revision !== request.expectedRevision
          ? rejected('stale', current)
          : rejected('unavailable', current);
      }
    } finally {
      lease.release();
    }
  };

  private runCommand = async (
    args: readonly string[],
    input?: Buffer,
  ): Promise<unknown> => {
    const cli = this.options.supervisor.getResolvedCli();
    if (!cli) {
      throw new CliOneShotError('spawn');
    }
    return this.run({
      cli,
      environment: this.options.supervisor.getCliEnvironment(),
      args,
      ...(input ? { input } : {}),
    });
  };
}
