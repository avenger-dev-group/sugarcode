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
      providerFamily: 'openai',
      displayName: 'Custom provider',
      baseUrl: 'http://127.0.0.1:18080/v1',
      enabled: true,
      wireApi: 'openaiChatCompletions',
      continuationMode: 'localReplay',
    },
  ],
  profiles: [
    {
      id: 'model_primary',
      connectionId: 'conn_primary',
      displayName: 'Primary model',
      modelId: 'fixture-model',
      toolCalls: 'auto',
      strictTools: 'auto',
      parallelTools: 'auto',
      imageInput: 'auto',
      pdfInput: 'auto',
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

test('compaction settings remain optional and validate threshold bounds', () => {
  const configured = catalog(128_000);
  const profile = configured.profiles[0];
  assert.equal(isModelConfigValue({
    ...configured,
    profiles: [{
      ...profile,
      autoCompaction: 'enabled',
      nativeCompaction: 'auto',
      compactThresholdTokens: 96_000,
    }],
  }), true);
  assert.equal(isModelConfigValue({
    ...configured,
    profiles: [{ ...profile, compactThresholdTokens: 128_000 }],
  }), false);
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

test('media routing may select existing image, video, and audio profiles', () => {
  assert.equal(isModelConfigValue({
    ...catalog(),
    mediaRouting: {
      imageProfileId: 'model_primary',
      videoProfileId: 'model_primary',
      audioProfileId: 'model_primary',
    },
  }), true);
  assert.equal(isModelConfigValue({
    ...catalog(),
    mediaRouting: { imageProfileId: 'missing_model' },
  }), false);
  assert.equal(isModelConfigValue({
    ...catalog(),
    mediaRouting: { videoProfileId: 'missing_model' },
  }), false);
  assert.equal(isModelConfigValue({
    ...catalog(),
    mediaRouting: { audioProfileId: 'missing_model' },
  }), false);
});

test('media routing rejects unknown fields', () => {
  assert.equal(isModelConfigValue({
    ...catalog(),
    mediaRouting: {
      imageProfileId: 'model_primary',
      unsupportedProfileId: 'model_primary',
    },
  }), false);
});

test('media capabilities and connection transport remain optional and validated', () => {
  const configured = catalog();
  assert.equal(isModelConfigValue({
    ...configured,
    connections: [{
      ...configured.connections[0],
      mediaTransport: 'dashscopeTemporaryUrl',
    }],
    profiles: [{
      ...configured.profiles[0],
      videoInput: 'enabled',
      audioInput: 'enabled',
    }],
  }), true);
  assert.equal(isModelConfigValue({
    ...configured,
    connections: [{
      ...configured.connections[0],
      mediaTransport: 'unknown',
    }],
  }), false);
});
