import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuntimeMcpManager } from '../../src/runtime/mcp.ts';

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const fixture = path.join(fixtureDirectory, 'mcp-server.mjs');
const httpFixture = path.join(fixtureDirectory, 'mcp-http-server.mjs');

const createLoopbackFixture = async () => {
  const fixtureProcess = spawn(process.execPath, [httpFixture], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: fixtureProcess.stdout });
  const endpoint = await Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    once(fixtureProcess, 'exit').then(([code]) => {
      throw new Error(`HTTP MCP fixture exited before listening (${code}).`);
    }),
  ]);

  return {
    endpoint,
    close: async () => {
      lines.close();
      if (fixtureProcess.exitCode === null) {
        fixtureProcess.kill();
        await once(fixtureProcess, 'exit');
      }
    },
  };
};

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
    | Readonly<{
        serverId: string;
        name: string;
        purpose: string;
        argumentsValue: Readonly<Record<string, unknown>>;
        inventorySha256: string;
      }>
    | undefined;
  const tools = manager.toolsForTurn(async (request) => {
    approval = request;
    return request.execute();
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mcp__fixture__echo');
  const declaration = tools[0]._getDeclaration();
  assert.equal(
    declaration.parameters?.properties?.sugarcodeApprovalPurpose?.type,
    'STRING',
  );
  assert.equal(
    declaration.parameters?.required?.includes('sugarcodeApprovalPurpose'),
    true,
  );
  const response = await tools[0].runAsync({
    args: {
      value: 'hello',
      sugarcodeApprovalPurpose: '读取当前设计节点，为实现页面提供布局信息。',
    },
    toolContext: {
      abortSignal: new AbortController().signal,
    },
  } as unknown as Parameters<(typeof tools)[number]['runAsync']>[0]);
  assert.equal(approval?.serverId, 'fixture');
  assert.equal(approval?.name, 'mcp__fixture__echo');
  assert.equal(approval?.purpose, '读取当前设计节点，为实现页面提供布局信息。');
  assert.deepEqual(approval?.argumentsValue, { value: 'hello' });
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

test('RuntimeMcpManager discovers and invokes a loopback Streamable HTTP MCP server', async () => {
  const fixtureServer = await createLoopbackFixture();
  const manager = new RuntimeMcpManager();

  try {
    manager.configure({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [{
        id: 'figma-desktop',
        transport: 'loopbackStreamableHttp',
        endpoint: fixtureServer.endpoint,
      }],
    });

    assert.deepEqual(await manager.ensureApplicationActive('figma'), {
      accepted: true,
      reason: 'accepted',
    });
    const tools = manager.toolsForTurn((request) => request.execute());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'mcp__figma-desktop__echo');
    assert.deepEqual(
      await tools[0].runAsync({
        args: {
          value: 'local-figma',
          sugarcodeApprovalPurpose: '读取 Figma 当前选区，获取界面设计上下文。',
        },
        toolContext: {
          abortSignal: new AbortController().signal,
        },
      } as unknown as Parameters<(typeof tools)[number]['runAsync']>[0]),
      {
        content: [{
          type: 'text',
          text: '{"value":"local-figma"}',
        }],
      },
    );
  } finally {
    await manager.close();
    await fixtureServer.close();
  }
});
