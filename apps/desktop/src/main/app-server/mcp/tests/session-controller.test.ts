import { describe, expect, it, vi } from 'vitest';

import { McpSessionController } from '../session-controller';

describe('McpSessionController', () => {
  it('enforces transport combinations and rolls back one failed restart', async () => {
    const restart = vi
      .fn<(ids: readonly string[]) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const controller = new McpSessionController({
      getRestartBlock: () => null,
      restart,
    });
    controller.initialize([
      { id: 'alpha', transport: 'stdio' },
      { id: 'beta', transport: 'stdio' },
    ]);
    expect(controller.toggle('alpha')).toEqual({
      accepted: true,
      reason: 'accepted',
    });
    await expect(controller.enable()).resolves.toEqual({
      accepted: true,
      reason: 'accepted',
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'enabled',
      activeServerIds: ['alpha'],
    });

    expect(controller.toggle('beta').accepted).toBe(true);
    await expect(controller.enable()).resolves.toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(restart).toHaveBeenNthCalledWith(2, ['alpha', 'beta']);
    expect(restart).toHaveBeenNthCalledWith(3, ['alpha']);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'enabled',
      activeServerIds: ['alpha'],
      selectedServerIds: ['alpha'],
    });
  });

  it('rejects mixed stdio and loopback HTTP selection', () => {
    const controller = new McpSessionController({
      getRestartBlock: () => null,
      restart: async () => true,
    });
    controller.initialize([
      { id: 'alpha', transport: 'stdio' },
      { id: 'local-http', transport: 'loopbackStreamableHttp' },
    ]);
    expect(controller.toggle('alpha').accepted).toBe(true);
    expect(controller.toggle('local-http')).toEqual({
      accepted: false,
      reason: 'incompatibleSelection',
    });
  });
});
