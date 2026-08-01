import {
  isModelConfigInspection,
  isModelConfigSaveRequest,
  isModelDiscoveryResult,
  type ModelConfigActionResult,
  type ModelConfigInspection,
  type ModelDiscoveryResult,
} from '@/shared/model-config';

import { CliOneShotError, runCliJson } from '../cli/one-shot';
import type { ConnectionSupervisor } from '../connection/supervisor';

type ModelConfigControllerOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  runCliJson?: typeof runCliJson;
}>;

const blocked = (
  reason: 'reconnectPending' | 'unavailable' | 'invalid' | 'stale',
): ModelConfigActionResult => ({
  accepted: false,
  state: 'blocked',
  reason,
});

const failed = (
  reason: 'unavailable' | 'invalid' = 'unavailable',
): ModelConfigActionResult => ({
  accepted: false,
  state: 'failed',
  reason,
});

export class ModelConfigController {
  private readonly run: typeof runCliJson;

  constructor(private readonly options: ModelConfigControllerOptions) {
    this.run = options.runCliJson ?? runCliJson;
  }

  inspect = async (): Promise<ModelConfigInspection> => {
    const value = await this.runCommand([
      'config',
      'model',
      'inspect',
      '--json',
    ]);
    if (!isModelConfigInspection(value)) {
      throw new Error('The model configuration receipt was invalid.');
    }
    return value;
  };

  discover = async (
    connectionId: unknown,
  ): Promise<ModelDiscoveryResult> => {
    if (
      typeof connectionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(connectionId)
    ) {
      throw new Error('The model connection identifier was invalid.');
    }
    const value = await this.runCommand([
      'config',
      'model',
      'discover',
      '--connection-id',
      connectionId,
      '--json',
    ]);
    if (!isModelDiscoveryResult(value)) {
      throw new Error('The model discovery receipt was invalid.');
    }
    return value;
  };

  save = async (request: unknown): Promise<ModelConfigActionResult> => {
    if (!isModelConfigSaveRequest(request)) {
      return blocked('invalid');
    }
    const lease = this.options.supervisor.beginConfigWrite();
    if (typeof lease === 'string') {
      return blocked(lease);
    }
    try {
      try {
        await this.runCommand(
          ['config', 'model', 'validate', '--stdin', '--json'],
          Buffer.from(
            JSON.stringify({
              contractVersion: 1,
              config: request.config,
            }),
            'utf8',
          ),
        );
      } catch {
        return failed('invalid');
      }

      let inspection: ModelConfigInspection;
      const input = Buffer.from(
        JSON.stringify({
          contractVersion: 1,
          expectedRevision: request.expectedRevision,
          config: request.config,
          credentialUpdates: request.credentialUpdates,
        }),
        'utf8',
      );
      try {
        try {
          const value = await this.runCommand(
            ['config', 'model', 'set', '--stdin', '--json'],
            input,
          );
          if (!isModelConfigInspection(value)) {
            return failed();
          }
          inspection = value;
        } catch {
          const current = await this.inspect().catch(
            (): undefined => undefined,
          );
          if (current?.revision !== request.expectedRevision) {
            return blocked('stale');
          }
          return {
            accepted: false,
            state: 'failed',
            reason: 'unavailable',
            ...(current ? { inspection: current } : {}),
          };
        }
      } finally {
        input.fill(0);
      }

      return { accepted: true, state: 'saved', inspection };
    } finally {
      lease.release();
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
      return blocked('invalid');
    }
    const lease = this.options.supervisor.beginConfigWrite();
    if (typeof lease === 'string') {
      return blocked(lease);
    }
    try {
      const current = await this.inspect().catch(
        (): undefined => undefined,
      );
      if (!current) {
        return failed();
      }
      if (current.revision !== expectedRevision) {
        return blocked('stale');
      }
      const status = current.credentialStatuses.find(
        (credential) => credential.connectionId === connectionId,
      );
      if (!current.config || status?.status !== 'present') {
        return failed('invalid');
      }
      let inspection: ModelConfigInspection;
      try {
        const value = await this.runCommand(
          [
            'config',
            'model',
            'delete-api-key',
            '--connection-id',
            connectionId,
            '--expected-revision',
            expectedRevision,
            '--json',
          ],
        );
        if (!isModelConfigInspection(value)) {
          return failed();
        }
        inspection = value;
      } catch {
        return failed();
      }
      return { accepted: true, state: 'saved', inspection };
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
