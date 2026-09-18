import assert from 'node:assert/strict';
import test from 'node:test';

import { consolidateProviderConnections } from '../../../src/renderer/components/model-config/catalog.ts';
import type { ModelConfigValue } from '../../../src/shared/model-config.ts';

const profile = (id: string, connectionId: string) => ({
  id,
  connectionId,
  displayName: id,
  modelId: id,
  toolCalls: 'auto' as const,
  strictTools: 'auto' as const,
  parallelTools: 'auto' as const,
  imageInput: 'auto' as const,
  pdfInput: 'auto' as const,
});

test('legacy connections with the same normalized URL and protocol become one provider', () => {
  const config: ModelConfigValue = {
    defaultProfileId: 'model_a',
    connections: [
      {
        id: 'connection_a',
        providerFamily: 'openai',
        displayName: 'First model',
        baseUrl: 'HTTPS://Gateway.Example/v1/',
        enabled: true,
        wireApi: 'openaiChatCompletions',
        continuationMode: 'localReplay',
      },
      {
        id: 'connection_b',
        providerFamily: 'openai',
        displayName: 'Metis',
        baseUrl: 'https://gateway.example/v1',
        enabled: true,
        wireApi: 'openaiChatCompletions',
        continuationMode: 'localReplay',
      },
    ],
    profiles: [
      profile('model_a', 'connection_a'),
      profile('model_b', 'connection_b'),
    ],
  };
  const consolidated = consolidateProviderConnections(config, [
    { connectionId: 'connection_a', status: 'notConfigured' },
    { connectionId: 'connection_b', status: 'present' },
  ]);
  assert.deepEqual(consolidated.connections.map(({ id }) => id), [
    'connection_b',
  ]);
  assert.deepEqual(
    consolidated.profiles.map(({ connectionId }) => connectionId),
    ['connection_b', 'connection_b'],
  );
});

test('the same URL remains separate when the wire protocol differs', () => {
  const base = {
    providerFamily: 'openai' as const,
    displayName: 'Gateway',
    baseUrl: 'https://gateway.example/v1',
    enabled: true,
    continuationMode: 'localReplay' as const,
  };
  const config: ModelConfigValue = {
    defaultProfileId: 'model_a',
    connections: [
      { ...base, id: 'connection_a', wireApi: 'openaiChatCompletions' },
      { ...base, id: 'connection_b', wireApi: 'openaiResponses' },
    ],
    profiles: [
      profile('model_a', 'connection_a'),
      profile('model_b', 'connection_b'),
    ],
  };
  assert.equal(consolidateProviderConnections(config).connections.length, 2);
});
