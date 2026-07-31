import {
  isModelConfigInspection,
  isModelConfigSaveRequest,
  type ModelConfigActionResult,
  type ModelConfigInspection,
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

      if (request.apiKey !== undefined && request.apiKey.length === 0) {
        return failed('invalid');
      }

      let inspection: ModelConfigInspection;
      const input = Buffer.from(
        JSON.stringify({
          contractVersion: 1,
          expectedRevision: request.expectedRevision,
          config: request.config,
          apiKeyUpdate:
            request.apiKey === undefined
              ? { action: 'preserve' }
              : { action: 'set', value: request.apiKey },
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
    expectedRevision: unknown,
  ): Promise<ModelConfigActionResult> => {
    if (
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
      if (!current.config || current.apiKeyStatus === 'notConfigured') {
        return failed('invalid');
      }
      const input = Buffer.from(
        JSON.stringify({
          contractVersion: 1,
          expectedRevision,
          config: current.config,
          apiKeyUpdate: { action: 'delete' },
        }),
        'utf8',
      );
      let inspection: ModelConfigInspection;
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
        return failed();
      } finally {
        input.fill(0);
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
