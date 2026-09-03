import { randomUUID } from 'node:crypto';

import {
  isModelConfigSaveRequest,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelDiscoveryResult,
} from '../../../shared/model-config.ts';
import type { RuntimeSupervisor } from '../connection/supervisor.ts';

const invalid = (): ModelConfigActionResult => ({
  accepted: false,
  state: 'blocked',
  reason: 'invalid',
});

export class RuntimeModelConfigController {
  constructor(private readonly runtime: RuntimeSupervisor) {}

  inspect = async (): Promise<ModelConfigInspection> => {
    const event = await this.runtime.request(
      { type: 'model.inspect', requestId: randomUUID() },
      'model.configInspection',
    );
    return event.inspection;
  };

  save = async (request: unknown): Promise<ModelConfigActionResult> => {
    if (!isModelConfigSaveRequest(request)) {
      return invalid();
    }
    try {
      const event = await this.runtime.request(
        { type: 'model.save', requestId: randomUUID(), request },
        'model.configAction',
      );
      return event.action;
    } catch {
      return { accepted: false, state: 'failed', reason: 'unavailable' };
    }
  };

  deleteApiKey = async (
    connectionId: unknown,
    expectedRevision: unknown,
  ): Promise<ModelConfigActionResult> => {
    if (
      typeof connectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(connectionId) ||
      typeof expectedRevision !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expectedRevision)
    ) {
      return invalid();
    }
    try {
      const event = await this.runtime.request(
        {
          type: 'model.deleteApiKey',
          requestId: randomUUID(),
          connectionId,
          expectedRevision,
        },
        'model.configAction',
      );
      return event.action;
    } catch {
      return { accepted: false, state: 'failed', reason: 'unavailable' };
    }
  };

  discover = async (connectionId: unknown): Promise<ModelDiscoveryResult> => {
    if (
      typeof connectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(connectionId)
    ) {
      throw new Error('The model connection identifier was invalid.');
    }
    const event = await this.runtime.request(
      {
        type: 'model.discover',
        requestId: randomUUID(),
        connectionId,
      },
      'model.discovery',
    );
    return event.discovery;
  };
}
