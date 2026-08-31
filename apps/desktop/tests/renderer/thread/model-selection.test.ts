import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestDurableModelProfileId,
  modelRequestOptionsEqual,
  resolveModelProfileId,
  resolveModelRequestOptions,
} from '../../../src/renderer/components/thread/model-selection.ts';

test('the latest durable Turn model wins over the catalog default', () => {
  assert.equal(
    latestDurableModelProfileId([
      {
        id: 'turn-1',
        status: 'completed',
        model: {
          profileId: 'openai_a',
          providerFamily: 'openai',
          wireApi: 'openaiResponses',
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
        },
        messages: [],
      },
      {
        id: 'turn-2',
        status: 'interrupted',
        messages: [],
      },
    ]),
    'openai_a',
  );
  assert.equal(
    resolveModelProfileId(undefined, 'openai_a', 'default_model'),
    'openai_a',
  );
});

test('an explicit next-Turn selection wins over durable and default models', () => {
  assert.equal(
    resolveModelProfileId('anthropic_b', 'openai_a', 'default_model'),
    'anthropic_b',
  );
});

test('request options inherit only missing values from the selected profile', () => {
  assert.deepEqual(
    resolveModelRequestOptions(
      undefined,
      { reasoningEffort: 'high' },
      { reasoningEffort: 'low', serviceTier: 'fast' },
    ),
    { reasoningEffort: 'high', serviceTier: 'fast' },
  );

  const explicit = {
    reasoningEffort: 'medium' as const,
    serviceTier: 'standard' as const,
  };
  assert.equal(
    resolveModelRequestOptions(
      explicit,
      { reasoningEffort: 'high', serviceTier: 'fast' },
      { reasoningEffort: 'low', serviceTier: 'fast' },
    ),
    explicit,
  );
});

test('request option equality is based on rendered control values', () => {
  assert.equal(
    modelRequestOptionsEqual(
      { reasoningEffort: 'high', serviceTier: 'fast' },
      { reasoningEffort: 'high', serviceTier: 'fast' },
    ),
    true,
  );
  assert.equal(
    modelRequestOptionsEqual(
      { reasoningEffort: 'high', serviceTier: 'fast' },
      { reasoningEffort: 'medium', serviceTier: 'fast' },
    ),
    false,
  );
});
