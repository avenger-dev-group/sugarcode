import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { AnthropicLlm } from '../../src/runtime/models/anthropic-llm.ts';
import { OpenAiLlm } from '../../src/runtime/models/openai-llm.ts';
import { readModelItemMetadata } from '../../src/runtime/models/step-outcome.ts';
import { encodeModelHistory, contentFromStoredModelHistory } from '../../src/runtime/persistence/model-history-codec.ts';
import type { ModelReasoningEffort, ModelWireApi } from '../../src/shared/model-config.ts';

const reasoning = 'Check values.';
const answer = '391';
const protocols: readonly ModelWireApi[] = ['openaiChatCompletions', 'openaiResponses', 'anthropicMessages'];

const wireEvents = (wireApi: ModelWireApi): readonly unknown[] => {
  if (wireApi === 'openaiChatCompletions') {
    return [
      ...[{ reasoning_content: 'Check ' }, { reasoning_content: 'values.' }, { content: answer }].map((delta) => ({
        id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'metis-coder-max',
        choices: [{ index: 0, delta, finish_reason: null as string | null }],
      })),
      { id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ];
  }
  if (wireApi === 'openaiResponses') {
    return [
      { type: 'response.created', response: { id: 'resp-1', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'reasoning-1', type: 'reasoning', summary: [] } },
      ...['Check ', 'values.'].map((delta) => ({
        type: 'response.reasoning_text.delta', output_index: 0, item_id: 'reasoning-1', content_index: 0, delta,
      })),
      { type: 'response.output_item.added', output_index: 1, item: { id: 'message-1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'message-1', content_index: 0, delta: answer },
      { type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [
        { id: 'reasoning-1', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: reasoning }], encrypted_content: 'opaque-checkpoint' },
        { id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] },
      ] } },
    ];
  }
  return [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [], model: 'metis-coder-max', usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...['Check ', 'values.'].map((thinking) => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thinking' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
};

const serve = async (wireApi: ModelWireApi) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of wireEvents(wireApi)) {
        if (typeof event === 'object' && event && 'type' in event) response.write(`event: ${event.type}\n`);
        response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
      }
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const request = (model: string): LlmRequest => ({
  model,
  contents: [{ role: 'user', parts: [{ text: '17 × 23?' }] }],
  config: { maxOutputTokens: 2048 },
  liveConnectConfig: {},
  toolsDict: {},
});

const collect = async (events: AsyncIterable<LlmResponse>): Promise<LlmResponse[]> => {
  const result: LlmResponse[] = [];
  for await (const event of events) result.push(event);
  return result;
};

for (const wireApi of protocols) {
  for (const effort of ['auto', 'low', 'none'] as const) {
    test(`${wireApi}: metis ${effort} requests the protocol-specific thinking mode`, async (context) => {
      const fixture = await serve(wireApi);
      context.after(fixture.close);
      const options = { model: 'metis-coder-max', baseUrl: fixture.baseUrl, apiKey: 'fixture-key', reasoningEffort: effort };
      const model = wireApi === 'anthropicMessages' ? new AnthropicLlm(options) : new OpenAiLlm({ ...options, wireApi });
      const events = await collect(model.generateContentAsync(request(options.model), true));
      const body = fixture.requests[0];
      const expectedEffort = effort === 'auto' ? 'high' : effort;
      if (wireApi === 'openaiChatCompletions') {
        assert.deepEqual(body.thinking, { type: effort === 'none' ? 'disabled' : 'enabled' });
        assert.equal(body.reasoning_effort, expectedEffort);
        assert.equal(body.tools, undefined, 'empty tool arrays are rejected by the gateway');
        assert.equal(body.parallel_tool_calls, undefined);
      } else if (wireApi === 'openaiResponses') {
        assert.deepEqual(body.reasoning, { effort: expectedEffort, summary: 'auto' });
        assert.equal(body.thinking, undefined);
      } else {
        assert.deepEqual(body.thinking, { type: effort === 'none' ? 'disabled' : 'adaptive' });
        assert.deepEqual(body.output_config, effort === 'none' ? undefined : { effort: expectedEffort });
      }
      const streamed = events.filter((event) => event.partial).flatMap((event) => event.content?.parts ?? []);
      assert.equal(streamed.filter((part) => readModelItemMetadata(part)?.reasoningVisibility === 'provider').map((part) => part.text).join(''), reasoning);
      assert.equal(streamed.filter((part) => !part.thought).map((part) => part.text).join(''), answer);
      const terminal = events.findLast((event) => event.partial === false);
      const finalParts = terminal?.content?.parts ?? [];
      assert.equal(finalParts.filter((part) => !part.thought).map((part) => part.text).join(''), answer);
      assert.equal(finalParts.filter((part) => readModelItemMetadata(part)?.reasoningVisibility === 'provider').map((part) => part.text).join(''), reasoning);
    });
  }

  test(`${wireApi}: ordinary models do not inherit metis thinking defaults`, async (context) => {
    const fixture = await serve(wireApi);
    context.after(fixture.close);
    const options = { model: 'ordinary-model', baseUrl: fixture.baseUrl, apiKey: 'fixture-key', reasoningEffort: 'auto' as ModelReasoningEffort };
    const model = wireApi === 'anthropicMessages' ? new AnthropicLlm(options) : new OpenAiLlm({ ...options, wireApi });
    await collect(model.generateContentAsync(request(options.model), true));
    const body = fixture.requests[0];
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.output_config, undefined);
    if (wireApi === 'openaiResponses') assert.deepEqual(body.reasoning, { summary: 'auto' });
  });

  test(`${wireApi}: new reasoning survives history round-trip without becoming answer text`, async (context) => {
    const fixture = await serve(wireApi);
    context.after(fixture.close);
    const options = { model: 'metis-coder-max', baseUrl: fixture.baseUrl, apiKey: 'fixture-key' };
    const model = wireApi === 'anthropicMessages' ? new AnthropicLlm(options) : new OpenAiLlm({ ...options, wireApi });
    const first = request(options.model);
    const events = await collect(model.generateContentAsync(first, true));
    const terminal = events.findLast((event) => event.partial === false);
    assert.ok(terminal?.content);
    const stored = encodeModelHistory(terminal.content);
    assert.ok(stored);
    const restored = contentFromStoredModelHistory(stored);
    await collect(model.generateContentAsync({ ...first, contents: [...first.contents, restored, { role: 'user', parts: [{ text: 'Confirm.' }] }] }, true));
    const body = fixture.requests[1];
    if (wireApi === 'openaiChatCompletions') {
      const history = body.messages as { role: string; content: string; reasoning_content?: string }[];
      assert.equal(history.find((message) => message.role === 'assistant')?.content, answer);
      assert.equal(history.find((message) => message.role === 'assistant')?.reasoning_content, reasoning);
    } else if (wireApi === 'openaiResponses') {
      const history = body.input as { type: string; encrypted_content?: string }[];
      assert.equal(history.find((item) => item.type === 'reasoning')?.encrypted_content, 'opaque-checkpoint');
    } else {
      const history = body.messages as { role: string; content: { type: string; thinking?: string; signature?: string }[] }[];
      const thinking = history.find((message) => message.role === 'assistant')?.content.find((part) => part.type === 'thinking');
      assert.equal(thinking?.thinking, reasoning);
      assert.equal(thinking?.signature, 'signed-thinking');
    }
  });
}
