import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baseUrlForProviderWireChange,
  DEFAULT_NEW_MODEL_WIRE_API,
} from '../../../src/renderer/components/model-config/provider-presets.ts';

test('new model configurations default to OpenAI Responses', () => {
  assert.equal(DEFAULT_NEW_MODEL_WIRE_API, 'openaiResponses');
});

test('provider protocol changes preserve a custom Base URL', () => {
  const customBaseUrl = 'http://gateway.example.test:40000/v1';

  assert.equal(
    baseUrlForProviderWireChange(
      'openaiResponses',
      customBaseUrl,
      'openaiChatCompletions',
    ),
    customBaseUrl,
  );
  assert.equal(
    baseUrlForProviderWireChange(
      'openaiChatCompletions',
      customBaseUrl,
      'anthropicMessages',
    ),
    customBaseUrl,
  );
});

test('provider protocol changes update an unchanged preset Base URL', () => {
  assert.equal(
    baseUrlForProviderWireChange(
      'openaiResponses',
      'https://api.openai.com/v1',
      'anthropicMessages',
    ),
    'https://api.anthropic.com/v1',
  );
  assert.equal(
    baseUrlForProviderWireChange(
      'anthropicMessages',
      'https://api.anthropic.com/v1',
      'openaiChatCompletions',
    ),
    'https://api.openai.com/v1',
  );
});
