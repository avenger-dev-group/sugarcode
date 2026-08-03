import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import type { RecoveredConversation } from '../../../../src/main/app-server/conversation/recovery.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return {
        shortCircuit: true,
        url: new URL(
          `../../../../src/${specifier.slice(2)}.ts`,
          import.meta.url,
        ).href,
      };
    }
    if (
      specifier.startsWith('.') &&
      !specifier.split('/').at(-1)?.includes('.') &&
      context.parentURL
    ) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier}.ts`, context.parentURL).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createConversationSnapshot, createMutableTurns } = await import(
  '../../../../src/main/app-server/conversation/controller/projection.ts'
);

const MODEL = {
  profileId: 'openai_a',
  providerFamily: 'openai' as const,
  wireApi: 'openaiResponses' as const,
  modelId: 'openai-a',
  displayName: 'OpenAI A',
  contextWindowTokens: 131_072,
  effectiveCapabilities: {
    toolCalls: true,
    strictTools: false,
    parallelTools: false,
    imageInput: false,
    pdfInput: false,
  },
};

test('a restored Thread keeps its durable model through the Desktop projection', () => {
  const recovered: RecoveredConversation = {
    threadId: '00000000-0000-7000-8000-000000000001',
    turns: [
      {
        id: '00000000-0001-7000-8000-000000000001',
        status: 'completed',
        model: MODEL,
        messages: [],
      },
    ],
  };

  const turns = createMutableTurns(recovered);
  const snapshot = createConversationSnapshot({
    revision: 1,
    phase: 'ready',
    threadId: recovered.threadId,
    activeTurnId: null,
    turns,
    navigator: {
      status: 'ready',
      activeThreadIds: [recovered.threadId],
      activeThreadTitles: {},
      activeTruncated: false,
      search: {
        query: '',
        status: 'idle',
        threadIds: [],
        threadTitles: {},
        truncated: false,
      },
    },
    notice: undefined,
  });

  assert.deepEqual(turns[0]?.model, MODEL);
  assert.deepEqual(snapshot.turns[0]?.model, MODEL);
});
