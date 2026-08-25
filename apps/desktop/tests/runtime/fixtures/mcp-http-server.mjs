import { createServer as createHttpServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const httpServer = createHttpServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/mcp') {
    response.writeHead(405, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Method not allowed.' },
      id: null,
    }));
    return;
  }

  try {
    request.setEncoding('utf8');
    let payload = '';
    for await (const chunk of request) {
      payload += chunk;
    }

    const server = new Server(
      { name: 'sugarcode-http-mcp-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'echo',
        description: 'Echo fixture arguments over Streamable HTTP',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(toolRequest.params.arguments ?? {}),
      }],
    }));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, JSON.parse(payload));
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'application/json' });
    }
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32_603,
        message: error instanceof Error ? error.message : 'Fixture error',
      },
      id: null,
    }));
  }
});

httpServer.listen(0, '127.0.0.1', () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP MCP fixture did not receive a TCP address.');
  }
  console.log(`http://127.0.0.1:${address.port}/mcp`);
});

const close = () => httpServer.close();
process.once('SIGINT', close);
process.once('SIGTERM', close);
