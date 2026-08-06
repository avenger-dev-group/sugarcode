import { randomUUID } from 'node:crypto';

import {
  isMcpConfigSaveRequest,
  type McpConfigActionResult,
  type McpConfigInspection,
} from '../../shared/mcp.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

export class RuntimeMcpConfigController {
  private readonly runtime: RuntimeSupervisor;
  private readonly initializeSession: (inspection: McpConfigInspection) => void;

  constructor(
    runtime: RuntimeSupervisor,
    initializeSession: (inspection: McpConfigInspection) => void,
  ) {
    this.runtime = runtime;
    this.initializeSession = initializeSession;
  }

  inspect = async (): Promise<McpConfigInspection> => {
    const event = await this.runtime.request(
      { type: 'mcp.configInspect', requestId: randomUUID() },
      'mcp.configInspection',
    );
    this.initializeSession(event.inspection);
    return event.inspection;
  };

  save = async (request: unknown): Promise<McpConfigActionResult> => {
    if (!isMcpConfigSaveRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.runtime.request(
        { type: 'mcp.configSave', requestId: randomUUID(), request },
        'mcp.configAction',
      );
      if (event.action.inspection) {
        this.initializeSession(event.action.inspection);
      }
      return event.action;
    } catch {
      return { accepted: false, reason: 'unavailable' };
    }
  };
}
