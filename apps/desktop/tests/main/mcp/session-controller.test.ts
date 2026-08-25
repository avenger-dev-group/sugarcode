import assert from 'node:assert/strict';
import test from 'node:test';

import { McpSessionController } from '../../../src/main/mcp/session-controller.ts';

test('a failed local MCP connection keeps the attempted server selected for retry', async () => {
  const restartRequests: string[][] = [];
  const controller = new McpSessionController({
    getRestartBlock: () => null,
    restart: async (serverIds) => {
      restartRequests.push([...serverIds]);
      return serverIds.length > 0
        ? { accepted: false, reason: 'connectionFailed' }
        : { accepted: true, reason: 'accepted' };
    },
  });

  controller.initialize([{
    id: 'figma-desktop',
    transport: 'loopbackStreamableHttp',
  }]);
  assert.deepEqual(controller.toggle('figma-desktop'), {
    accepted: true,
    reason: 'accepted',
  });

  assert.deepEqual(await controller.enable(), {
    accepted: false,
    reason: 'connectionFailed',
  });
  assert.deepEqual(restartRequests, [['figma-desktop'], []]);
  assert.deepEqual(controller.getSnapshot(), {
    revision: 5,
    status: 'disabled',
    servers: [{
      id: 'figma-desktop',
      transport: 'loopbackStreamableHttp',
    }],
    selectedServerIds: ['figma-desktop'],
    activeServerIds: [],
    actionNotice: '无法连接所选的本地 MCP 服务，请确认服务已启动后重试。',
  });
});

test('runtime auto-activation synchronizes the visible MCP session state', () => {
  const controller = new McpSessionController({
    getRestartBlock: () => null,
    restart: async () => ({ accepted: true, reason: 'accepted' }),
  });
  controller.initialize([
    { id: 'figma-desktop', transport: 'loopbackStreamableHttp' },
  ]);

  controller.synchronizeActive(['figma-desktop']);
  assert.deepEqual(controller.getSnapshot(), {
    revision: 2,
    status: 'enabled',
    servers: [
      { id: 'figma-desktop', transport: 'loopbackStreamableHttp' },
    ],
    selectedServerIds: ['figma-desktop'],
    activeServerIds: ['figma-desktop'],
  });
});
