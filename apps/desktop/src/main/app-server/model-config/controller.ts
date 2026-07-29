import {
  isModelConfigInspection,
  isModelConfigSaveRequest,
  type ModelConfigActionResult,
  type ModelConfigInspection,
} from '@/shared/model-config';

import { CliOneShotError, runCliJson } from '../cli/one-shot';
import type {
  ConnectionSupervisor,
  ModelConfigRestartBlock,
} from '../connection/supervisor';

type ModelConfigControllerOptions = Readonly<{
  supervisor: ConnectionSupervisor;
  runCliJson?: typeof runCliJson;
}>;

const blocked = (
  reason: ModelConfigRestartBlock | 'invalid' | 'stale',
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
    const lease = this.options.supervisor.beginModelConfigTransaction();
    if (typeof lease === 'string') {
      return blocked(lease);
    }
    let credentialStored = false;
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

      if (request.credential !== undefined) {
        if (request.credential.length === 0) {
          return failed('invalid');
        }
        const secret = Buffer.from(request.credential, 'utf8');
        try {
          await this.runCommand(
            [
              'config',
              'model',
              'credential',
              'set',
              request.config.credentialReference ?? '',
              '--stdin',
              '--json',
            ],
            secret,
          );
          credentialStored = true;
        } catch {
          return failed();
        } finally {
          secret.fill(0);
        }
      }

      let inspection: ModelConfigInspection;
      try {
        const value = await this.runCommand(
          ['config', 'model', 'set', '--stdin', '--json'],
          Buffer.from(
            JSON.stringify({
              contractVersion: 1,
              expectedRevision: request.expectedRevision,
              config: request.config,
            }),
            'utf8',
          ),
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
          state: credentialStored
            ? 'credentialStoredConfigUnchanged'
            : 'failed',
          reason: 'unavailable',
          ...(current ? { inspection: current } : {}),
        };
      }

      if (
        await this.options.supervisor.activateSavedModelConfiguration()
      ) {
        return { accepted: true, state: 'active', inspection };
      }
      return {
        accepted: false,
        state: 'savedNotActive',
        reason: 'unavailable',
        inspection,
      };
    } finally {
      lease.release();
    }
  };

  deleteCredential = async (
    expectedRevision: unknown,
  ): Promise<ModelConfigActionResult> => {
    if (
      typeof expectedRevision !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expectedRevision)
    ) {
      return blocked('invalid');
    }
    const lease = this.options.supervisor.beginModelConfigTransaction();
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
      const reference = current.config?.credentialReference;
      if (!reference) {
        return failed('invalid');
      }
      try {
        await this.runCommand([
          'config',
          'model',
          'credential',
          'delete',
          reference,
          '--json',
        ]);
      } catch {
        return failed();
      }
      const inspection = await this.inspect().catch(() => current);
      if (
        await this.options.supervisor.activateSavedModelConfiguration()
      ) {
        return { accepted: true, state: 'active', inspection };
      }
      return {
        accepted: false,
        state: 'savedNotActive',
        reason: 'unavailable',
        inspection,
      };
    } finally {
      lease.release();
    }
  };

  retryConnection = async (): Promise<ModelConfigActionResult> => {
    const lease = this.options.supervisor.beginModelConfigTransaction();
    if (typeof lease === 'string') {
      return blocked(lease);
    }
    try {
      const inspection = await this.inspect().catch(
        (): undefined => undefined,
      );
      if (!inspection) {
        return failed();
      }
      if (
        await this.options.supervisor.activateSavedModelConfiguration()
      ) {
        return { accepted: true, state: 'active', inspection };
      }
      return {
        accepted: false,
        state: 'savedNotActive',
        reason: 'unavailable',
        inspection,
      };
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
