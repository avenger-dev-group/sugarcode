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

test('Responses reconciler matches reordered terminal tools by stable identity', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, toolItem(0));
  reconciler.onOutputItemDone(1, toolItem(1));

  const terminal = reconciler.finish(response('resp_reordered', [
    toolItem(1),
    toolItem(0),
  ]), 'response.completed');

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

test('Responses reconciler uses call ID when terminal item ID drifts', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, toolItem(0));

  const terminal = reconciler.finish(response('resp_item_id_drift', [{
    ...toolItem(0),
    id: 'gateway_terminal_item_0',
  }]), 'response.completed');

  assert.deepEqual(terminal.blocks.map((block) =>
    block.type === 'toolCall'
      ? [block.itemId, block.callId]
      : []), [['item_0', 'call_0']]);
});

test('Responses reconciler compares tool arguments by JSON semantics', () => {
  const reconciler = new OpenAiResponsesReconciler();
  const streamed = {
    ...toolItem(0),
    arguments: '{"path":"file.txt","options":{"b":2,"a":1}}',
  };
  reconciler.onOutputItemDone(0, streamed);

  const terminal = reconciler.finish(response('resp_argument_format', [{
    ...streamed,
    arguments: '{ "options": { "a": 1, "b": 2 }, "path": "file.txt" }',
  }]), 'response.completed');

  assert.equal(terminal.blocks[0]?.type, 'toolCall');
  if (terminal.blocks[0]?.type === 'toolCall') {
    assert.equal(terminal.blocks[0].arguments, streamed.arguments);
  }
});

test('Responses reconciler rejects real tool argument conflicts safely', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, toolItem(0));

  assert.throws(
    () => reconciler.finish(response('resp_argument_conflict', [{
      ...toolItem(0),
      arguments: '{"path":"different-private-path.txt"}',
    }]), 'response.completed'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'ambiguousOutputReconciliation' &&
      error.message.includes('arguments') &&
      !error.message.includes('different-private-path.txt'),
  );
});

test('Responses reconciler keeps the done call ID when the terminal call ID drifts', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, toolItem(0));

  const terminal = reconciler.finish(response('resp_call_id_drift', [{
    ...toolItem(0),
    id: 'item_changed',
    call_id: 'call_changed',
  }]), 'response.completed');

  assert.deepEqual(terminal.blocks.map((block) =>
    block.type === 'toolCall'
      ? [block.itemId, block.callId]
      : []), [['item_0', 'call_0']]);
});

test('Responses reconciler diagnoses call ID and argument conflicts safely', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, toolItem(0));

  assert.throws(
    () => reconciler.finish(response('resp_call_argument_conflict', [{
      ...toolItem(0),
      id: 'item_changed',
      call_id: 'call_changed',
      arguments: '{"path":"different-private-path.txt"}',
    }]), 'response.completed'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'ambiguousOutputReconciliation' &&
      error.message.includes('callId') &&
      error.message.includes('arguments') &&
      !error.message.includes('different-private-path.txt'),
  );
});

test('Responses reconciler blocks ambiguous content-only tool matches', () => {
  const reconciler = new OpenAiResponsesReconciler();
  const first = {
    ...toolItem(0),
    arguments: '{"path":"same.txt"}',
  };
  const second = {
    ...toolItem(1),
    arguments: '{"path":"same.txt"}',
  };
  reconciler.onOutputItemDone(0, first);
  reconciler.onOutputItemDone(1, second);

  assert.throws(
    () => reconciler.finish(response('resp_ambiguous_content', [{
      ...first,
      id: 'item_changed',
      call_id: 'call_changed',
    }]), 'response.completed'),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'ambiguousOutputReconciliation',
  );
});

test('Responses reconciler tolerates terminal index shifts when reasoning is omitted', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'reasoning_0',
    type: 'reasoning',
    status: 'completed',
    summary: [{ type: 'summary_text', text: 'Checked the workspace.' }],
  } as unknown as ResponseOutputItem);
  reconciler.onOutputItemDone(1, toolItem(0));

  const terminal = reconciler.finish(response('resp_omitted_reasoning', [
    toolItem(0),
  ]), 'response.completed');

  assert.deepEqual(
    terminal.blocks.map((block) => [block.type, block.outputIndex]),
    [
      ['reasoning', 0],
      ['toolCall', 1],
    ],
  );
});

test('Responses reconciler tolerates conflicting duplicate reasoning from compatible gateways', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'reasoning_gateway',
    type: 'reasoning',
    status: 'completed',
    content: [{ type: 'reasoning_text', text: 'Streamed reasoning' }],
    summary: [],
    encrypted_content: 'streamed-encrypted-content',
  } as unknown as ResponseOutputItem);

  const terminal = reconciler.finish(response('resp_reasoning_drift', [{
    id: 'reasoning_gateway',
    type: 'reasoning',
    status: 'completed',
    content: [{ type: 'reasoning_text', text: 'Terminal reasoning' }],
    summary: [{ type: 'summary_text', text: 'Terminal summary' }],
    encrypted_content: 'terminal-encrypted-content',
  } as unknown as ResponseOutputItem]), 'response.completed');

  assert.equal(terminal.blocks[0]?.type, 'reasoning');
  if (terminal.blocks[0]?.type === 'reasoning') {
    assert.deepEqual(terminal.blocks[0].item.content, [
      { type: 'reasoning_text', text: 'Streamed reasoning' },
    ]);
    assert.deepEqual(terminal.blocks[0].item.summary, [
      { type: 'summary_text', text: 'Terminal summary' },
    ]);
    assert.equal(
      terminal.blocks[0].item.encrypted_content,
      'streamed-encrypted-content',
    );
  }
});

test('Responses reconciler appends terminal-only items after streamed slots', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onReasoningDelta(
    'summary',
    0,
    'reasoning_streamed',
    'Working',
  );

  const terminal = reconciler.finish(response('resp_terminal_compensation', [
    toolItem(0),
  ]), 'response.completed');

  assert.deepEqual(
    terminal.blocks.map((block) => [block.type, block.outputIndex]),
    [
      ['reasoning', 0],
      ['toolCall', 1],
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

test('Responses reconciler rejects conflicting duplicate done messages', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'message_conflict',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'First', annotations: [] }],
  });

  assert.throws(
    () => reconciler.onOutputItemDone(0, {
      id: 'message_conflict',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Second', annotations: [] }],
    }),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.protocol?.code === 'ambiguousOutputReconciliation' &&
      error.details.protocol.eventType === 'response.output_item.done',
  );
});

test('Responses reconciler accepts terminal text rewritten by a compatible gateway', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'message_done_rewritten',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    summary: [],
    content: [{
      type: 'output_text',
      text: 'Draft completed text',
      annotations: [],
      logprobs: null,
    }],
  } as unknown as ResponseOutputItem);

  const terminal = reconciler.finish(response('resp_terminal_rewritten', [{
    id: 'message_terminal_rewritten',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{
      type: 'output_text',
      text: 'Authoritative terminal text',
      annotations: [],
    }],
  }]), 'response.completed');

  assert.equal(terminal.blocks[0]?.type, 'text');
  if (terminal.blocks[0]?.type === 'text') {
    assert.equal(terminal.blocks[0].itemId, 'message_done_rewritten');
    assert.equal(terminal.blocks[0].text, 'Authoritative terminal text');
    assert.equal(terminal.blocks[0].phase, 'final');
  }
});

test('Responses reconciler preserves done text when terminal content is omitted', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'message_omitted_terminal_content',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{
      type: 'output_text',
      text: 'BANDWIDTH_WEBHOOK_USERNAME=random-user',
      annotations: [],
    }],
  });

  const terminal = reconciler.finish(response('resp_omitted_terminal_content', [{
    id: 'message_omitted_terminal_content',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [],
  }]), 'response.completed');

  assert.equal(terminal.blocks[0]?.type, 'text');
  if (terminal.blocks[0]?.type === 'text') {
    assert.equal(
      terminal.blocks[0].text,
      'BANDWIDTH_WEBHOOK_USERNAME=random-user',
    );
    assert.equal(terminal.blocks[0].phase, 'final');
  }
});

test('Responses reconciler backfills terminal text when done content is omitted', () => {
  const reconciler = new OpenAiResponsesReconciler();
  reconciler.onOutputItemDone(0, {
    id: 'message_omitted_done_content',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [],
  });

  const terminal = reconciler.finish(response('resp_omitted_done_content', [{
    id: 'message_omitted_done_content',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{
      type: 'output_text',
      text: 'BANDWIDTH_WEBHOOK_PASSWORD=random-password',
      annotations: [],
    }],
  }]), 'response.completed');

  assert.equal(terminal.blocks[0]?.type, 'text');
  if (terminal.blocks[0]?.type === 'text') {
    assert.equal(
      terminal.blocks[0].text,
      'BANDWIDTH_WEBHOOK_PASSWORD=random-password',
    );
    assert.equal(terminal.blocks[0].phase, 'final');
  }
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
