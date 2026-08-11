import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeMcpManager } from '../../src/runtime/mcp.ts';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mcp-server.mjs',
);

test('RuntimeMcpManager discovers and invokes an ADK MCPToolset behind approval', async () => {
  const manager = new RuntimeMcpManager();
  manager.configure({
    contractVersion: 1,
    revision: '0'.repeat(64),
    servers: [{
      id: 'fixture',
      transport: 'stdio',
      executable: process.execPath,
      argv: [fixture],
      cwd: path.dirname(fixture),
    }],
  });

  const activated = await manager.setActive(['fixture']);
  assert.deepEqual(activated, { accepted: true, reason: 'accepted' });
  assert.deepEqual(manager.getActiveServerIds(), ['fixture']);

  let approval:
    | Readonly<{ serverId: string; name: string; inventorySha256: string }>
    | undefined;
  const tools = manager.toolsForTurn(async (request) => {
    approval = request;
    return request.execute();
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mcp__fixture__echo');
  const response = await tools[0].runAsync({
    args: { value: 'hello' },
    toolContext: {
      abortSignal: new AbortController().signal,
    },
  } as unknown as Parameters<(typeof tools)[number]['runAsync']>[0]);
  assert.equal(approval?.serverId, 'fixture');
  assert.equal(approval?.name, 'mcp__fixture__echo');
  assert.match(approval?.inventorySha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.deepEqual(response, {
    content: [{ type: 'text', text: '{"value":"hello"}' }],
  });
  assert.deepEqual(
    await manager.executeRecovered(
      'fixture',
      'mcp__fixture__echo',
      { value: 'recovered' },
      approval?.inventorySha256 ?? '',
      new AbortController().signal,
    ),
    { content: [{ type: 'text', text: '{"value":"recovered"}' }] },
  );
  await assert.rejects(
    manager.executeRecovered(
      'fixture',
      'mcp__fixture__echo',
      {},
      'f'.repeat(64),
      new AbortController().signal,
    ),
    /inventory is no longer active/u,
  );
  await manager.close();
});

test('RuntimeMcpManager rejects an HTTP server combined with another selection', async () => {
  const manager = new RuntimeMcpManager();
  manager.configure({
    contractVersion: 1,
    revision: '0'.repeat(64),
    servers: [
      {
        id: 'http',
        transport: 'loopbackStreamableHttp',
        endpoint: 'http://127.0.0.1:8788/mcp',
      },
      {
        id: 'stdio',
        transport: 'stdio',
        executable: process.execPath,
        argv: [fixture],
        cwd: path.dirname(fixture),
      },
    ],
  });
  assert.deepEqual(await manager.setActive(['http', 'stdio']), {
    accepted: false,
    reason: 'incompatibleSelection',
  });
});
