import { describe, expect, it, vi } from 'vitest';

import type { ModelConfigInspection } from '@/shared/model-config';

import { ModelConfigController } from '../controller';
import type { ConnectionSupervisor } from '../../connection/supervisor';

const INSPECTION: ModelConfigInspection = {
  contractVersion: 1,
  revision: 'a'.repeat(64),
  config: {
    apiFormat: 'openai-chat-completions',
    endpoint: 'http://127.0.0.1:18080/v1/chat/completions',
    model: 'fixture-model',
    credentialReference: 'model-api-token',
  },
  credentialStatus: 'present',
};

const createSupervisor = () => {
  const release = vi.fn();
  const supervisor = {
    beginModelConfigTransaction: vi.fn(() => ({ release })),
    activateSavedModelConfiguration: vi.fn(async () => true),
    getResolvedCli: vi.fn(() => ({
      executablePath: '/cli',
      workingDirectory: '/work',
    })),
    getCliEnvironment: vi.fn(() => ({})),
  } as unknown as ConnectionSupervisor;
  return { release, supervisor };
};

describe('ModelConfigController', () => {
  it('validates, writes the credential, saves non-secret config, then reconnects', async () => {
    const { release, supervisor } = createSupervisor();
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const run = vi.fn(async (options) => {
      calls.push({
        args: options.args,
        ...(options.input
          ? { input: Buffer.from(options.input).toString('utf8') }
          : {}),
      });
      if (options.args.includes('set') && options.args.includes('credential')) {
        return {
          contractVersion: 1,
          reference: 'model-api-token',
          status: 'present',
        };
      }
      if (options.args.includes('validate')) {
        return { contractVersion: 1, valid: true, config: INSPECTION.config };
      }
      return INSPECTION;
    });
    const controller = new ModelConfigController({
      supervisor,
      runCliJson: run,
    });

    await expect(
      controller.save({
        expectedRevision: INSPECTION.revision,
        config: INSPECTION.config,
        credential: 'secret-sentinel',
      }),
    ).resolves.toEqual({
      accepted: true,
      state: 'active',
      inspection: INSPECTION,
    });

    expect(calls.map((call) => call.args.slice(2, 4))).toEqual([
      ['validate', '--stdin'],
      ['credential', 'set'],
      ['set', '--stdin'],
    ]);
    expect(calls[1]?.input).toBe('secret-sentinel');
    expect(calls[2]?.input).not.toContain('secret-sentinel');
    expect(
      supervisor.activateSavedModelConfiguration,
    ).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports an honest partial commit when config save fails after credential write', async () => {
    const { supervisor } = createSupervisor();
    const run = vi.fn(async (options) => {
      if (options.args.includes('validate')) {
        return { contractVersion: 1, valid: true, config: INSPECTION.config };
      }
      if (options.args.includes('credential')) {
        return {
          contractVersion: 1,
          reference: 'model-api-token',
          status: 'present',
        };
      }
      if (options.args.includes('inspect')) {
        return { ...INSPECTION, credentialStatus: 'present' };
      }
      throw new Error('save failed');
    });
    const controller = new ModelConfigController({
      supervisor,
      runCliJson: run,
    });
    const result = await controller.save({
      expectedRevision: INSPECTION.revision,
      config: INSPECTION.config,
      credential: 'secret-sentinel',
    });

    expect(result.state).toBe('credentialStoredConfigUnchanged');
    expect(result.accepted).toBe(false);
    expect(
      supervisor.activateSavedModelConfiguration,
    ).not.toHaveBeenCalled();
  });

  it('does no CLI work when a reconnect precondition blocks the lease', async () => {
    const supervisor = {
      beginModelConfigTransaction: vi.fn(() => 'turnActive'),
    } as unknown as ConnectionSupervisor;
    const run = vi.fn();
    const controller = new ModelConfigController({
      supervisor,
      runCliJson: run,
    });
    await expect(
      controller.save({
        expectedRevision: INSPECTION.revision,
        config: INSPECTION.config,
      }),
    ).resolves.toEqual({
      accepted: false,
      state: 'blocked',
      reason: 'turnActive',
    });
    expect(run).not.toHaveBeenCalled();
  });
});
