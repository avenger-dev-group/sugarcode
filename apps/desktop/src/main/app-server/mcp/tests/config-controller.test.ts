import { describe, expect, it, vi } from 'vitest';

import type { McpConfigInspection } from '@/shared/mcp';

import { McpConfigController } from '../config-controller';
import type { ConnectionSupervisor } from '../../connection/supervisor';

const INSPECTION: McpConfigInspection = {
  contractVersion: 1,
  revision: 'a'.repeat(64),
  servers: [
    {
      id: 'local-tools',
      transport: 'stdio',
      executable: '/usr/bin/local-tools',
      argv: ['serve'],
      cwd: '/tmp',
    },
  ],
};

const createSupervisor = (status = 'disabled') => {
  const release = vi.fn();
  const initialize = vi.fn();
  const supervisor = {
    beginModelConfigTransaction: vi.fn(() => ({ release })),
    getResolvedCli: vi.fn(() => ({
      executablePath: '/cli',
      workingDirectory: '/work',
    })),
    getCliEnvironment: vi.fn(() => ({})),
    mcpSession: {
      getSnapshot: vi.fn(() => ({
        status,
        activeServerIds: status === 'enabled' ? ['local-tools'] : [],
      })),
      initialize,
    },
  } as unknown as ConnectionSupervisor;
  return { initialize, release, supervisor };
};

describe('McpConfigController', () => {
  it('validates, atomically saves, and refreshes the disabled inventory', async () => {
    const { initialize, release, supervisor } = createSupervisor();
    const run = vi.fn(async (options) =>
      options.args.includes('validate')
        ? { ...INSPECTION, valid: true }
        : INSPECTION,
    );
    const controller = new McpConfigController({
      supervisor,
      runCliJson: run,
    });

    await expect(
      controller.save({
        expectedRevision: INSPECTION.revision,
        servers: INSPECTION.servers,
      }),
    ).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
      inspection: INSPECTION,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledWith([
      { id: 'local-tools', transport: 'stdio' },
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does no CLI work while an MCP session is active', async () => {
    const { supervisor } = createSupervisor('enabled');
    const run = vi.fn();
    const controller = new McpConfigController({
      supervisor,
      runCliJson: run,
    });

    await expect(
      controller.save({
        expectedRevision: INSPECTION.revision,
        servers: INSPECTION.servers,
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'sessionActive',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns the current inspection on revision conflict', async () => {
    const { supervisor } = createSupervisor();
    const current = { ...INSPECTION, revision: 'b'.repeat(64) };
    const run = vi.fn(async (options) => {
      if (options.args.includes('validate')) {
        return { ...INSPECTION, valid: true };
      }
      if (options.args.includes('inspect')) {
        return current;
      }
      throw new Error('revision mismatch');
    });
    const controller = new McpConfigController({
      supervisor,
      runCliJson: run,
    });

    await expect(
      controller.save({
        expectedRevision: INSPECTION.revision,
        servers: INSPECTION.servers,
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'stale',
      inspection: current,
    });
  });
});
