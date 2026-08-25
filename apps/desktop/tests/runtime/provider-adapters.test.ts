import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { LlmRequest, LlmResponse } from '@google/adk';
import type { ResponseOutputMessage } from 'openai/resources/responses/responses';

import { AnthropicLlm } from '../../src/runtime/models/anthropic-llm.ts';
import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';
import { OpenAiLlm } from '../../src/runtime/models/openai-llm.ts';
import { readOpenAiResponsesPartReplay } from '../../src/runtime/models/openai-responses-replay.ts';
import {
  contentFromStoredModelHistory,
  encodeModelHistory,
  parseStoredModelHistory,
} from '../../src/runtime/model-history-codec.ts';
import {
  modelItemMetadata,
  readModelItemMetadata,
  readModelStepOutcome,
} from '../../src/runtime/models/step-outcome.ts';
import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from '../../src/runtime/models/types.ts';

const llmRequest = (): LlmRequest => ({
  model: 'fixture-model',
  contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  config: {
    systemInstruction: {
      role: 'user',
      parts: [{ text: 'You are SugarCode.' }],
    },
  },
  liveConnectConfig: {},
  toolsDict: {},
});

const videoRequest = (): LlmRequest => ({
  model: 'fixture-model',
  contents: [{
    role: 'user',
    parts: [
      { text: 'What happens in this video?' },
      {
        inlineData: {
          mimeType: 'video/mp4',
          data: 'bXA0',
          displayName: 'clip.mp4',
        },
        partMetadata: { sugarcodeVideoFps: 1.5 },
      },
    ],
  }],
  config: {},
  liveConnectConfig: {},
  toolsDict: {},
});

const audioRequest = (): LlmRequest => ({
  model: 'fixture-model',
  contents: [{
    role: 'user',
    parts: [
      { text: 'Transcribe this meeting.' },
      {
        inlineData: {
          mimeType: 'audio/mpeg',
          data: 'bXAz',
          displayName: 'meeting.mp3',
        },
      },
    ],
  }],
  config: {},
  liveConnectConfig: {},
  toolsDict: {},
});

const collect = async (
  stream: AsyncIterable<LlmResponse>,
): Promise<readonly LlmResponse[]> => {
  const events: LlmResponse[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const pauseAfterTerminalResponse = async (
  stream: AsyncIterable<LlmResponse>,
  pauseMs: number,
): Promise<LlmResponse> => {
  const iterator = stream[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.turnComplete !== true) {
    next = await iterator.next();
  }
  assert.equal(next.done, false);
  const terminal = next.value;
  await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  assert.equal((await iterator.next()).done, true);
  return terminal;
};

const TERMINAL_FIXTURE_REQUEST_TIMEOUT_MS = 250;
const POST_TERMINAL_DEADLINE_PAUSE_MS = 500;
const CONTINUOUS_STREAM_REQUEST_TIMEOUT_MS = 25;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const serve = async (
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): Promise<Readonly<{ baseUrl: string; close: () => Promise<void> }>> => {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'fixture error');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

const writeSse = (
  response: ServerResponse,
  events: readonly Readonly<{ event?: string; data: unknown }>[],
): void => {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'x-request-id': 'request_fixture',
  });
  for (const item of events) {
    if (item.event) {
      response.write(`event: ${item.event}\n`);
    }
    response.write(
      `data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`,
    );
  }
  response.end();
};

test('OpenAI Chat Completions SDK streams text and usage into ADK responses', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [
      {
        data: {
          id: 'chatcmpl_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [
            { index: 0, delta: { content: 'Hello' }, finish_reason: null },
          ],
        },
      },
      {
        data: {
          id: 'chatcmpl_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        },
      },
      { data: '[DONE]' },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    reasoningEffort: 'xhigh',
    serviceTier: 'fast',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));

  assert.equal(receivedBody?.model, 'fixture-model');
  assert.equal(receivedBody?.stream, true);
  assert.equal(receivedBody?.max_completion_tokens, 32_768);
  assert.equal(receivedBody?.reasoning_effort, 'xhigh');
  assert.equal(receivedBody?.service_tier, 'priority');
  assert.equal(events[0]?.content?.parts?.[0]?.text, 'Hello');
  assert.equal(events.at(-1)?.turnComplete, true);
  assert.equal(events.at(-1)?.usageMetadata?.totalTokenCount, 6);
});

test('OpenAI Chat serializes video with the configured protocol video_url extension', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (_request, response) => {
    receivedBody = JSON.parse(await readBody(_request)) as Record<string, unknown>;
    writeSse(response, [
      {
        data: {
          id: 'chatcmpl_video',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: { content: 'A demo.' }, finish_reason: null }],
        },
      },
      {
        data: {
          id: 'chatcmpl_video',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      },
      { data: '[DONE]' },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  await collect(model.generateContentAsync(videoRequest(), true));

  const messages = receivedBody?.messages as Array<Record<string, unknown>>;
  const content = messages[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content[1], {
    type: 'video_url',
    video_url: {
      url: 'data:video/mp4;base64,bXA0',
      fps: 1.5,
    },
  });
});

test('OpenAI Chat serializes extracted audio as input_audio', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [
      {
        data: {
          id: 'chatcmpl_audio',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      },
      { data: '[DONE]' },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  await collect(model.generateContentAsync(audioRequest(), true));

  const messages = receivedBody?.messages as Array<Record<string, unknown>>;
  const content = messages[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content[1], {
    type: 'input_audio',
    input_audio: { data: 'bXAz', format: 'mp3' },
  });
});

test('OpenAI Responses SDK maps function calls back to the ADK tool name', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/responses');
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'item_fixture',
            type: 'function_call',
            call_id: 'call_fixture',
            name: 'workspace_read',
            arguments: '',
            status: 'in_progress',
          },
        },
      },
      {
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          sequence_number: 2,
          output_index: 0,
          item_id: 'item_fixture',
          name: 'workspace_read',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_fixture',
            object: 'response',
            created_at: 1,
            status: 'completed',
            error: null,
            incomplete_details: null,
            instructions: null,
            max_output_tokens: null,
            model: 'fixture-model',
            output: [],
            parallel_tool_calls: false,
            previous_response_id: null,
            reasoning: null,
            store: false,
            temperature: 1,
            text: { format: { type: 'text' } },
            tool_choice: 'auto',
            tools: [],
            top_p: 1,
            truncation: 'disabled',
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [
      {
        functionDeclarations: [
          {
            name: 'workspace/read',
            description: 'Read a workspace file.',
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    reasoningEffort: 'max',
    serviceTier: 'fast',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const functionCall = events
    .flatMap((event) => event.content?.parts ?? [])
    .find((part) => part.functionCall)?.functionCall;

  assert.equal(functionCall?.id, 'call_fixture');
  assert.equal(functionCall?.name, 'workspace/read');
  assert.deepEqual(functionCall?.args, { path: 'README.md' });
  assert.equal(receivedBody?.max_output_tokens, 32_768);
  assert.deepEqual(receivedBody?.reasoning, { effort: 'max' });
  assert.equal(receivedBody?.service_tier, 'priority');
  assert.equal(events.at(-1)?.turnComplete, true);
});

test('OpenAI Responses serializes video as an input file without changing protocols', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [{
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_video_fixture',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  await collect(model.generateContentAsync(videoRequest(), true));

  const input = receivedBody?.input as Array<Record<string, unknown>>;
  const content = input[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content[1], {
    type: 'input_file',
    file_data: 'data:video/mp4;base64,bXA0',
    filename: 'clip.mp4',
  });
});

test('OpenAI Responses preserves extracted audio as a dedicated input item', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [{
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_audio_fixture',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  await collect(model.generateContentAsync(audioRequest(), true));

  const input = receivedBody?.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[1], {
    type: 'input_audio',
    input_audio: { data: 'bXAz', format: 'mp3' },
  });
});

test('OpenAI Responses retries a terminated stream after lifecycle-only events', async (context) => {
  let requestCount = 0;
  const fixture = await serve(async (_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          sequence_number: 0,
          response: {
            id: 'resp_terminated_fixture',
            status: 'in_progress',
            output: [],
          },
        })}\n\n`,
      );
      response.destroy();
      return;
    }
    writeSse(response, [{
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_retried_fixture',
          status: 'completed',
          output: [{
            id: 'message_retried_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: 'Recovered after reconnect.',
              annotations: [],
            }],
          }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    maxRetries: 1,
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));

  assert.equal(requestCount, 2);
  assert.equal(
    events.at(-1)?.content?.parts?.find((part) => part.text)?.text,
    'Recovered after reconnect.',
  );
});

test('OpenAI Responses does not retry a terminated stream after visible output', async (context) => {
  let requestCount = 0;
  const fixture = await serve(async (_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        sequence_number: 1,
        output_index: 0,
        item_id: 'message_visible_fixture',
        content_index: 0,
        delta: 'Visible output',
        logprobs: [],
      })}\n\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    response.destroy();
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    maxRetries: 1,
  });

  await assert.rejects(
    collect(model.generateContentAsync(llmRequest(), true)),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAdapterError);
      assert.equal(error.details.kind, 'connection');
      assert.equal(error.details.retryable, true);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test('Anthropic Messages rejects direct video without silently dropping it', async () => {
  const model = new AnthropicLlm({
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-key',
  });
  await assert.rejects(
    collect(model.generateContentAsync(videoRequest(), true)),
    /does not support direct video input/u,
  );
});

test('OpenAI Responses releases its request deadline before a terminal tool call is consumed', async (context) => {
  const fixture = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/responses');
    await readBody(request);
    writeSse(response, [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'item_deadline_fixture',
            type: 'function_call',
            call_id: 'call_deadline_fixture',
            name: 'workspace_read',
            arguments: '',
            status: 'in_progress',
          },
        },
      },
      {
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          sequence_number: 2,
          output_index: 0,
          item_id: 'item_deadline_fixture',
          name: 'workspace_read',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_deadline_fixture',
            status: 'completed',
            output: [],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    timeoutMs: TERMINAL_FIXTURE_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });

  const terminal = await pauseAfterTerminalResponse(
    model.generateContentAsync(llmRequest(), true),
    POST_TERMINAL_DEADLINE_PAUSE_MS,
  );

  assert.equal(terminal.turnComplete, true);
  assert.equal(
    readModelStepOutcome(terminal.content?.parts ?? [])?.kind,
    'toolCalls',
  );
});

test('OpenAI Responses preserves commentary phase, Item ID, and phased history', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    writeSse(response, [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'message_commentary_fixture',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            phase: 'commentary',
            content: [],
          },
        },
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 2,
          item_id: 'message_commentary_fixture',
          output_index: 0,
          content_index: 0,
          delta: 'Still working',
          logprobs: [],
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_commentary_fixture',
            status: 'completed',
            output: [{
              id: 'message_commentary_fixture',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'commentary',
              content: [{
                type: 'output_text',
                text: 'Still working',
                annotations: [],
                logprobs: [],
              }],
            }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.contents.push({
    role: 'model',
    parts: [{
      text: 'Earlier commentary',
      partMetadata: modelItemMetadata('message_history_fixture', {
        phase: 'commentary',
      }),
    }],
  });
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const finalParts = events.at(-1)?.content?.parts ?? [];
  const metadata = readModelItemMetadata(finalParts[0] ?? {});
  const input = receivedBody?.input as Array<Record<string, unknown>>;

  assert.equal(metadata?.itemId, 'message_commentary_fixture');
  assert.equal(metadata?.phase, 'commentary');
  assert.deepEqual(readModelStepOutcome(finalParts), {
    kind: 'continue',
    reason: 'commentaryOnly',
  });
  assert.equal(input.at(-1)?.phase, 'commentary');
});

test('OpenAI Responses reconciles compatible gateway text IDs by output index', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'message_authoritative_fixture',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            phase: 'final_answer',
            content: [],
          },
        },
      },
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 2,
          item_id: 'message_temporary_fixture',
          output_index: 0,
          content_index: 0,
          delta: 'One answer',
          logprobs: [],
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_mismatched_item_fixture',
            status: 'completed',
            output: [{
              id: 'message_authoritative_fixture',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{
                type: 'output_text',
                text: 'One answer',
                annotations: [],
                logprobs: [],
              }],
            }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));
  const streamedPart = events.find((event) => event.partial)?.content?.parts?.[0];
  const finalParts = events.at(-1)?.content?.parts ?? [];

  assert.equal(readModelItemMetadata(streamedPart ?? {})?.itemId,
    'message_authoritative_fixture');
  assert.deepEqual(finalParts.map((part) => part.text), ['One answer']);
  assert.equal(readModelItemMetadata(finalParts[0] ?? {})?.itemId,
    'message_authoritative_fixture');
  assert.deepEqual(readModelStepOutcome(finalParts), { kind: 'final' });
});

test('OpenAI Responses reconciles a streamed alias when gateway output indexes drift', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          sequence_number: 1,
          item_id: 'message_streamed_fixture',
          output_index: 1,
          content_index: 0,
          delta: 'One answer',
          logprobs: [],
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 2,
          response: {
            id: 'resp_drifted_index_fixture',
            status: 'completed',
            output: [{
              id: 'message_terminal_fixture',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{
                type: 'output_text',
                text: 'One answer',
                annotations: [],
                logprobs: [],
              }],
            }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));
  const finalParts = events.at(-1)?.content?.parts ?? [];

  assert.deepEqual(finalParts.map((part) => part.text), ['One answer']);
  assert.equal(readModelItemMetadata(finalParts[0] ?? {})?.itemId,
    'message_streamed_fixture');
  assert.deepEqual(readModelStepOutcome(finalParts), { kind: 'final' });
});

test('OpenAI Chat maps malformed tool JSON to a bounded internal error tool', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        data: {
          id: 'chatcmpl_bad_tool',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_bad_tool',
                type: 'function',
                function: { name: 'workspace_read', arguments: '{' },
              }],
            },
            finish_reason: null,
          }],
        },
      },
      {
        data: {
          id: 'chatcmpl_bad_tool',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
      },
      { data: '[DONE]' },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [{
      functionDeclarations: [{
        name: 'workspace_read',
        parametersJsonSchema: { type: 'object' },
      }],
    }],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const call = events.at(-1)?.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;

  assert.equal(call?.name, INVALID_TOOL_ARGUMENTS_TOOL_NAME);
  assert.deepEqual(call?.args, {
    toolName: 'workspace_read',
    argumentsText: '{',
  });
});

test('OpenAI repairs an unambiguous concatenated workspace_read batch', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        data: {
          id: 'chatcmpl_batch_read',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_batch_read',
                type: 'function',
                function: {
                  name: 'workspace_read',
                  arguments:
                    '{"path":"README.md"}{"path":"package.json"}',
                },
              }],
            },
            finish_reason: null,
          }],
        },
      },
      {
        data: {
          id: 'chatcmpl_batch_read',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
      },
      { data: '[DONE]' },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [{
      functionDeclarations: [{
        name: 'workspace_read',
        parametersJsonSchema: { type: 'object' },
      }],
    }],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const call = events.at(-1)?.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;

  assert.equal(call?.name, 'workspace_read');
  assert.deepEqual(call?.args, {
    paths: ['README.md', 'package.json'],
  });
});

test('OpenAI Responses adapter never infers a tool call from reasoning text', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.reasoning_summary_text.delta',
        data: {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: 1,
          item_id: 'reasoning_summary_fixture',
          output_index: 0,
          summary_index: 0,
          delta: 'I will inspect the workspace safely.',
        },
      },
      {
        event: 'response.reasoning_text.delta',
        data: {
          type: 'response.reasoning_text.delta',
          sequence_number: 2,
          item_id: 'reasoning_fixture',
          output_index: 0,
          content_index: 0,
          delta: '<tool_call>\n<function=workspace_list>',
        },
      },
      {
        event: 'response.reasoning_text.delta',
        data: {
          type: 'response.reasoning_text.delta',
          sequence_number: 3,
          item_id: 'reasoning_fixture',
          output_index: 0,
          content_index: 0,
          delta:
            '\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>',
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 4,
          response: {
            id: 'resp_text_tool_fixture',
            status: 'completed',
            usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [
      {
        functionDeclarations: [
          {
            name: 'workspace_list',
            description: 'List a workspace directory.',
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const parts = events.flatMap((event) => event.content?.parts ?? []);
  assert.equal(parts.some((part) => part.functionCall), false);
  assert.equal(parts.some((part) => part.thought), true);
  assert.equal(parts.some((part) => part.text?.includes('<tool_call>')), true);
  const summary = parts.find(
    (part) => part.text?.includes('inspect the workspace safely'),
  );
  const internal = parts.find((part) => part.text?.includes('<tool_call>'));
  assert.equal(
    readModelItemMetadata(summary ?? {})?.reasoningVisibility,
    'summary',
  );
  assert.equal(
    readModelItemMetadata(internal ?? {})?.reasoningVisibility,
    'internal',
  );
});

test('OpenAI SDK stops a continuously streaming response at the request deadline', async (context) => {
  const fixture = await serve(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl_streaming',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [
          { index: 0, delta: { content: 'Still working' }, finish_reason: null },
        ],
      })}\n\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    response.end();
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiChatCompletions',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    timeoutMs: CONTINUOUS_STREAM_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });

  await assert.rejects(
    collect(model.generateContentAsync(llmRequest(), true)),
    (error: unknown) =>
      error instanceof Error &&
      'details' in error &&
      typeof error.details === 'object' &&
      error.details !== null &&
      'kind' in error.details &&
      error.details.kind === 'timeout',
  );
});

test('Anthropic SDK streams thinking, text, tool calls, and usage into ADK responses', async (context) => {
  let receivedBody: Record<string, unknown> | undefined;
  let receivedBeta = '';
  const fixture = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/messages?beta=true');
    receivedBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
    receivedBeta = String(request.headers['anthropic-beta'] ?? '');
    writeSse(response, [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 5,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Check.' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'signature' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'tool_fixture',
            name: 'workspace_read',
            input: {},
            caller: { type: 'direct' },
          },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: 'tool_use',
            stop_sequence: null,
            stop_details: null,
            container: null,
          },
          usage: { output_tokens: 3 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [
      {
        functionDeclarations: [
          {
            name: 'workspace/read',
            description: 'Read a workspace file.',
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ],
  };
  const model = new AnthropicLlm({
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    reasoningEffort: 'high',
    serviceTier: 'fast',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const parts = events.flatMap((event) => event.content?.parts ?? []);
  const functionCall = parts.find((part) => part.functionCall)?.functionCall;

  const thinking = parts.find((part) => part.thought && part.text === 'Check.');
  assert.equal(thinking?.text, 'Check.');
  assert.equal(
    readModelItemMetadata(thinking ?? {})?.reasoningVisibility,
    'internal',
  );
  assert.equal(functionCall?.name, 'workspace/read');
  assert.deepEqual(receivedBody?.output_config, { effort: 'high' });
  assert.equal(receivedBody?.speed, 'fast');
  assert.match(receivedBeta, /fast-mode-2026-02-01/u);
  assert.deepEqual(functionCall?.args, { path: 'README.md' });
  assert.equal(events.at(-1)?.usageMetadata?.totalTokenCount, 8);
  assert.equal(events.at(-1)?.turnComplete, true);
});

test('Anthropic releases its request deadline before a terminal tool call is consumed', async (context) => {
  const fixture = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/messages');
    await readBody(request);
    writeSse(response, [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_deadline_fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool_deadline_fixture',
            name: 'workspace_read',
            input: {},
          },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"path":"README.md"}',
          },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: 0 },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
  });
  context.after(fixture.close);
  const model = new AnthropicLlm({
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    timeoutMs: TERMINAL_FIXTURE_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });

  const terminal = await pauseAfterTerminalResponse(
    model.generateContentAsync(llmRequest(), true),
    POST_TERMINAL_DEADLINE_PAUSE_MS,
  );

  assert.equal(terminal.turnComplete, true);
  assert.equal(
    readModelStepOutcome(terminal.content?.parts ?? [])?.kind,
    'toolCalls',
  );
});

test('OpenAI Responses completes a function call from output_item.done without arguments.done', async (context) => {
  const toolItem = {
    id: 'item_done_fixture',
    type: 'function_call' as const,
    call_id: 'call_done_fixture',
    name: 'workspace_read',
    arguments: '{"path":"README.md"}',
    status: 'completed' as const,
  };
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: { ...toolItem, arguments: '', status: 'in_progress' },
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 2,
          output_index: 0,
          item: toolItem,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_done_fixture',
            status: 'completed',
            output: [toolItem],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [{
      functionDeclarations: [{
        name: 'workspace_read',
        parametersJsonSchema: { type: 'object' },
      }],
    }],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const calls = events.at(-1)?.content?.parts?.filter(
    (part) => part.functionCall,
  ) ?? [];

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.functionCall?.id, 'call_done_fixture');
  assert.equal(calls[0]?.functionCall?.name, 'workspace_read');
  assert.deepEqual(calls[0]?.functionCall?.args, { path: 'README.md' });
  assert.deepEqual(
    readOpenAiResponsesPartReplay(calls[0]?.partMetadata)?.block,
    {
      type: 'toolCall',
      itemId: 'item_done_fixture',
      callId: 'call_done_fixture',
    },
  );
});

test('OpenAI Responses keeps streamed tool order when terminal output is reordered', async (context) => {
  const firstCall = {
    id: 'item_reordered_first',
    type: 'function_call' as const,
    call_id: 'call_reordered_first',
    name: 'workspace_read',
    arguments: '{"path":"first.txt","options":{"b":2,"a":1}}',
    status: 'completed' as const,
  };
  const secondCall = {
    id: 'item_reordered_second',
    type: 'function_call' as const,
    call_id: 'call_reordered_second',
    name: 'workspace_read',
    arguments: '{"path":"second.txt"}',
    status: 'completed' as const,
  };
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 1,
          output_index: 0,
          item: firstCall,
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 2,
          output_index: 1,
          item: secondCall,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_reordered_tools_fixture',
            status: 'completed',
            output: [
              {
                ...secondCall,
                id: 'terminal_item_reordered_second',
                call_id: 'terminal_call_reordered_second',
              },
              {
                ...firstCall,
                id: 'terminal_item_reordered_first',
                call_id: 'terminal_call_reordered_first',
                arguments:
                  '{ "options": { "a": 1, "b": 2 }, "path": "first.txt" }',
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [{
      functionDeclarations: [{
        name: 'workspace_read',
        parametersJsonSchema: { type: 'object' },
      }],
    }],
  };
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(request, true));
  const calls = events.at(-1)?.content?.parts?.flatMap((part) =>
    part.functionCall ? [part.functionCall] : []) ?? [];

  assert.deepEqual(
    calls.map((call) => [call.id, call.args]),
    [
      [
        'call_reordered_first',
        { path: 'first.txt', options: { b: 2, a: 1 } },
      ],
      ['call_reordered_second', { path: 'second.txt' }],
    ],
  );
});

test('OpenAI Responses restart replay keeps provider item ID separate from call_id', async (context) => {
  let requestIndex = 0;
  let replayBody: Record<string, unknown> | undefined;
  const fixture = await serve(async (request, response) => {
    requestIndex += 1;
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    if (requestIndex === 1) {
      const call = {
        id: 'item_replay_fixture',
        type: 'function_call',
        call_id: 'call_replay_fixture',
        name: 'workspace_read',
        arguments: '{"path":"README.md"}',
        status: 'completed',
      };
      writeSse(response, [
        {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            sequence_number: 1,
            output_index: 0,
            item: call,
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            sequence_number: 2,
            response: {
              id: 'resp_replay_call_fixture',
              status: 'completed',
              output: [call],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          },
        },
      ]);
      return;
    }
    replayBody = body;
    writeSse(response, [{
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_replay_final_fixture',
          status: 'completed',
          output: [{
            id: 'message_replay_final_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: 'Done',
              annotations: [],
            }],
          }],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });
  const request = llmRequest();
  request.config = {
    ...request.config,
    tools: [{
      functionDeclarations: [{
        name: 'workspace_read',
        parametersJsonSchema: { type: 'object' },
      }],
    }],
  };
  const first = await collect(model.generateContentAsync(request, true));
  const assistant = first.at(-1)?.content;
  assert.ok(assistant);
  const restoredAssistant = contentFromStoredModelHistory(
    parseStoredModelHistory(JSON.parse(JSON.stringify(
      encodeModelHistory(assistant),
    ))),
  );
  const toolResult = contentFromStoredModelHistory(
    parseStoredModelHistory(JSON.parse(JSON.stringify(encodeModelHistory({
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'call_replay_fixture',
          name: 'workspace_read',
          response: { content: 'fixture' },
        },
      }],
    })))),
  );
  const initial = request.contents[0];
  assert.ok(initial);
  await collect(model.generateContentAsync({
    ...request,
    contents: [
      initial,
      restoredAssistant,
      toolResult,
    ],
  }, true));

  const input = replayBody?.input as Array<Record<string, unknown>>;
  const replayedCall = input.find((item) => item.type === 'function_call');
  const replayedResult = input.find(
    (item) => item.type === 'function_call_output',
  );
  assert.equal(replayedCall?.id, 'item_replay_fixture');
  assert.equal(replayedCall?.call_id, 'call_replay_fixture');
  assert.equal(replayedResult?.call_id, 'call_replay_fixture');
});

test('OpenAI Responses deterministically backfills a completed-only tool call', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [{
      event: 'response.completed',
      data: {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_completed_only_fixture',
          status: 'completed',
          output: [{
            id: 'item_completed_only_fixture',
            type: 'function_call',
            call_id: 'call_completed_only_fixture',
            name: 'workspace_read',
            arguments: '{"path":"package.json"}',
            status: 'completed',
          }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));
  const call = events.at(-1)?.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;

  assert.equal(call?.id, 'call_completed_only_fixture');
  assert.deepEqual(call?.args, { path: 'package.json' });
});

test('OpenAI Responses backfills reasoning encrypted content from response.completed', async (context) => {
  const doneReasoning = {
    id: 'reasoning_backfill_fixture',
    type: 'reasoning' as const,
    summary: [{ type: 'summary_text' as const, text: 'Checked the workspace' }],
    status: 'completed' as const,
  };
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 1,
          output_index: 0,
          item: doneReasoning,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 2,
          response: {
            id: 'resp_reasoning_backfill_fixture',
            status: 'completed',
            output: [{
              ...doneReasoning,
              encrypted_content: 'encrypted-reasoning-fixture',
            }],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));
  const replay = readOpenAiResponsesPartReplay(
    events.at(-1)?.content?.parts?.[0]?.partMetadata,
  );

  assert.equal(replay?.block.type, 'reasoning');
  assert.equal(
    replay?.block.type === 'reasoning'
      ? replay.block.item.encrypted_content
      : undefined,
    'encrypted-reasoning-fixture',
  );
});

test('OpenAI Responses tolerates gateway reasoning drift between done and completed', async (context) => {
  const streamedReasoning = {
    id: 'reasoning_drift_fixture',
    type: 'reasoning' as const,
    summary: [{ type: 'summary_text' as const, text: 'Stream summary' }],
    encrypted_content: 'stream-encrypted-reasoning',
    status: 'completed' as const,
  };
  const completedMessage: ResponseOutputMessage = {
    id: 'message_drift_fixture',
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    phase: 'final_answer' as const,
    content: [{
      type: 'output_text' as const,
      text: 'Hello from the compatible gateway',
      annotations: [],
      logprobs: [],
    }],
  };
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 1,
          output_index: 0,
          item: streamedReasoning,
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          sequence_number: 2,
          output_index: 1,
          item: completedMessage,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_reasoning_drift_fixture',
            status: 'completed',
            output: [{
              ...streamedReasoning,
              summary: [{
                type: 'summary_text',
                text: 'Different terminal summary',
              }],
              encrypted_content: 'different-terminal-encrypted-reasoning',
            }, completedMessage],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        },
      },
    ]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
  });

  const events = await collect(model.generateContentAsync(llmRequest(), true));
  const finalParts = events.at(-1)?.content?.parts ?? [];
  const reasoningReplay = readOpenAiResponsesPartReplay(
    finalParts[0]?.partMetadata,
  );

  assert.equal(finalParts.at(-1)?.text, 'Hello from the compatible gateway');
  assert.equal(reasoningReplay?.block.type, 'reasoning');
  assert.equal(
    reasoningReplay?.block.type === 'reasoning'
      ? reasoningReplay.block.item.summary[0]?.text
      : undefined,
    'Stream summary',
  );
  assert.deepEqual(readModelStepOutcome(finalParts), { kind: 'final' });
});

test('OpenAI Responses reports a specific protocol error when the terminal event is missing', async (context) => {
  const fixture = await serve(async (_request, response) => {
    writeSse(response, [{
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        sequence_number: 1,
        output_index: 0,
        item_id: 'message_unterminated_fixture',
        content_index: 0,
        delta: 'partial',
        logprobs: [],
      },
    }]);
  });
  context.after(fixture.close);
  const model = new OpenAiLlm({
    wireApi: 'openaiResponses',
    model: 'fixture-model',
    baseUrl: fixture.baseUrl,
    apiKey: 'test-key',
    maxRetries: 0,
  });

  await assert.rejects(
    collect(model.generateContentAsync(llmRequest(), true)),
    (error: unknown) =>
      error instanceof ProviderAdapterError &&
      error.details.kind === 'protocol' &&
      error.details.protocol?.code === 'terminalLifecycleViolation' &&
      error.details.protocol.eventType === 'stream.end' &&
      /^[0-9a-f]{64}$/u.test(error.details.protocol.shapeSha256),
  );
});
