import assert from 'node:assert/strict';
import test from 'node:test';

import type { Content, Part } from '@google/genai';

import {
  contentFromStoredModelHistory,
  encodeModelHistory,
  parseStoredModelHistory,
} from '../../src/runtime/model-history-codec.ts';
import { RuntimeProtocolError } from '../../src/runtime/protocol-error.ts';
import {
  openAiResponsesPartReplay,
  readOpenAiResponsesPartReplay,
} from '../../src/runtime/models/openai-responses-replay.ts';

const compatibilityKey =
  'openaiResponses:https://ark.example.test/api/coding/v3:fixture-model';

test('model history codec preserves durable content and versioned replay metadata', () => {
  const content: Content = {
    role: 'model',
    parts: [
      {
        text: 'Working',
        thought: true,
        partMetadata: openAiResponsesPartReplay(
          compatibilityKey,
          'resp_fixture',
          {
            type: 'reasoning',
            item: {
              id: 'reasoning_fixture',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Working' }],
              encrypted_content: 'encrypted-fixture',
              status: 'completed',
            },
          },
        ),
      },
      {
        functionCall: {
          id: 'call_fixture',
          name: 'workspace_read',
          args: { path: 'README.md' },
        },
        partMetadata: openAiResponsesPartReplay(
          compatibilityKey,
          'resp_fixture',
          {
            type: 'toolCall',
            itemId: 'item_fixture',
            callId: 'call_fixture',
          },
        ),
      },
    ],
  };

  const stored = encodeModelHistory(content);
  assert.equal(stored.version, 2);
  assert.equal(stored.replay?.blocks.length, 2);
  assert.equal(
    stored.parts[0]?.type === 'text'
      ? stored.parts[0].metadata?.sugarcodeOpenAiResponsesReplay
      : undefined,
    undefined,
  );

  const restored = contentFromStoredModelHistory(
    parseStoredModelHistory(JSON.parse(JSON.stringify(stored))),
  );
  const reasoningReplay = readOpenAiResponsesPartReplay(
    restored.parts?.[0]?.partMetadata,
  );
  const toolReplay = readOpenAiResponsesPartReplay(
    restored.parts?.[1]?.partMetadata,
  );
  assert.equal(reasoningReplay?.block.type, 'reasoning');
  assert.deepEqual(toolReplay?.block, {
    type: 'toolCall',
    itemId: 'item_fixture',
    callId: 'call_fixture',
  });
});

test('model history codec reads legacy unversioned history without migration', () => {
  const restored = parseStoredModelHistory({
    role: 'assistant',
    parts: [{
      type: 'text',
      text: 'Legacy answer',
      reasoning: false,
    }],
  });

  assert.equal(restored.version, 2);
  assert.equal(restored.parts[0]?.type, 'text');
  assert.equal(restored.replay, undefined);
});

test('model history codec degrades a damaged replay envelope per message', () => {
  const restored = parseStoredModelHistory({
    version: 2,
    role: 'assistant',
    parts: [{
      type: 'text',
      text: 'Durable answer',
      reasoning: false,
    }],
    replay: {
      kind: 'openaiResponses',
      version: 99,
      compatibilityKey,
      blocks: [],
    },
  });
  const content = contentFromStoredModelHistory(restored);

  assert.equal(content.parts?.[0]?.text, 'Durable answer');
  assert.equal(restored.replay, undefined);
  assert.equal(restored.replayDegrade?.reason, 'invalidEnvelope');
  assert.match(
    String(content.parts?.[0]?.partMetadata?.sugarcodeReplayDegraded),
    /object|\[object Object\]/u,
  );
});

test('model history codec skips empty metadata Parts but blocks unknown content', () => {
  const emptyMetadataPart = {
    thoughtSignature: 'provider-signature',
    partMetadata: {},
  } as unknown as Part;
  const stored = encodeModelHistory({ role: 'model', parts: [emptyMetadataPart] });
  assert.deepEqual(stored.parts, []);

  assert.throws(
    () => encodeModelHistory({
      role: 'model',
      parts: [{
        executableCode: { language: 'PYTHON', code: 'print(1)' },
      } as unknown as Part],
    }),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.kind === 'protocol' &&
      error.details.protocol?.code === 'invalidEventShape' &&
      /^[0-9a-f]{64}$/u.test(error.details.protocol.shapeSha256),
  );
});

test('model history codec classifies invalid durable history as protocol state', () => {
  assert.throws(
    () => parseStoredModelHistory({ version: 2, role: 'assistant', parts: [{}] }),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.details.kind === 'protocol' &&
      error.details.protocol?.eventType === 'history.restore',
  );
});
