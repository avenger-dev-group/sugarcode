import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Response,
  ResponseOutputItem,
} from 'openai/resources/responses/responses';

import { RuntimeProtocolError } from '../../src/runtime/protocol-error.ts';
import { OpenAiResponsesReconciler } from '../../src/runtime/models/openai-responses-reconciler.ts';

const response = (
  id: string,
  output: readonly ResponseOutputItem[],
): Response => ({
  id,
  status: 'completed',
  output: [...output],
  usage: null,
} as unknown as Response);

const toolItem = (
  index: number,
): Extract<ResponseOutputItem, { type: 'function_call' }> => ({
  id: `item_${index}`,
  type: 'function_call',
  call_id: `call_${index}`,
  name: 'workspace_read',
  arguments: `{"path":"file-${index}.txt"}`,
  status: 'completed',
});

test('Responses reconciler preserves parallel tool order and independent IDs', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(1, toolItem(1));
  reconciler.onOutputItemDone(0, toolItem(0));

  const terminal = reconciler.finish(response('resp_parallel', []),
    'response.completed');

  assert.deepEqual(
    terminal.blocks.map((block) =>
      block.type === 'toolCall'
        ? [block.outputIndex, block.itemId, block.callId]
        : []),
    [
      [0, 'item_0', 'call_0'],
      [1, 'item_1', 'call_1'],
    ],
  );
});

test('Responses reconciler blocks malformed tool calls before execution', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    ...toolItem(0),
    arguments: '{',
  });

  assert.throws(
    () => reconciler.finish(response('resp_malformed', []),
      'response.completed'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'malformedToolCall' &&
      error.details.protocol.eventType === 'response.completed',
  );
});

test('Responses reconciler rejects conflicts between done and completed', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'message_conflict',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'First', annotations: [] }],
  });

  assert.throws(
    () => reconciler.finish(response('resp_conflict', [{
      id: 'message_conflict',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Second', annotations: [] }],
    }]), 'response.completed'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'ambiguousOutputReconciliation',
  );
});

test('Responses reconciler ignores empty reasoning and rejects content-bearing unknown items', () => {
  const reconciler = new OpenAiResponsesReconciler();
  assert.equal(
    reconciler.onReasoningDelta('summary', 0, 'reasoning_empty', ''),
    undefined,
  );
  assert.deepEqual(
    reconciler.finish(response('resp_empty', []), 'response.completed').blocks,
    [],
  );

  const unknown = new OpenAiResponsesReconciler();
  assert.throws(
    () => unknown.onOutputItemAdded(0, {
      id: 'unknown_item',
      type: 'future_content',
      payload: { text: 'must not be dropped' },
      status: 'completed',
    } as unknown as ResponseOutputItem),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'invalidEventShape',
  );
});

test('Responses reconciler accepts compatible gateways that omit early reasoning arrays', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemAdded(0, {
    id: 'reasoning_ark_fixture',
    type: 'reasoning',
    status: 'in_progress',
  } as unknown as ResponseOutputItem);
  reconciler.onReasoningDelta(
    'summary',
    0,
    'reasoning_ark_fixture',
    'Working',
  );

  const terminal = reconciler.finish(response('resp_ark_fixture', []),
    'response.completed');
  assert.equal(terminal.blocks[0]?.type, 'reasoning');
});

test('Responses reconciler rejects events after a terminal response', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.finish(response('resp_terminal', []), 'response.completed');

  assert.throws(
    () => reconciler.onTextDelta(0, 'message_late', 'late'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'terminalLifecycleViolation',
  );
});
