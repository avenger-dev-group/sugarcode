import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isModelConfigSaveRequest,
  isModelConfigValue,
} from '../../src/shared/model-config.ts';

const catalog = (contextWindowTokens?: number) => ({
  defaultProfileId: 'model_primary',
  connections: [
    {
      id: 'conn_primary',
      kind: 'openaiCompatible',
      displayName: 'Custom provider',
      baseUrl: 'http://127.0.0.1:18080/v1',
      enabled: true,
      wireApi: 'openaiChatCompletions',
    },
  ],
  profiles: [
    {
      id: 'model_primary',
      connectionId: 'conn_primary',
      displayName: 'Primary model',
      modelId: 'fixture-model',
      strictTools: 'auto',
      parallelTools: 'auto',
      ...(contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens }),
    },
  ],
});

test('context window may be omitted and accepts the documented boundaries', () => {
  assert.equal(isModelConfigValue(catalog()), true);
  assert.equal(isModelConfigValue(catalog(4_096)), true);
  assert.equal(isModelConfigValue(catalog(2_097_152)), true);
});

test('context window rejects out-of-range and fractional values', () => {
  assert.equal(isModelConfigValue(catalog(4_095)), false);
  assert.equal(isModelConfigValue(catalog(2_097_153)), false);
  assert.equal(isModelConfigValue(catalog(131_072.5)), false);
});

test('save request carries one credential action per connection without a key echo', () => {
  assert.equal(
    isModelConfigSaveRequest({
      expectedRevision: 'a'.repeat(64),
      config: catalog(),
      credentialUpdates: [
        { action: 'preserve', connectionId: 'conn_primary' },
      ],
    }),
    true,
  );
});
