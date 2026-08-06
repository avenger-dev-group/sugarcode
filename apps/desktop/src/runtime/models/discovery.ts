import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import type {
  ModelConnectionValue,
  ModelDiscoveryResult,
} from '../../shared/model-config.ts';

type ResolvedConnection = Readonly<{
  connection: ModelConnectionValue;
  apiKey?: string;
}>;

const parseResolvedConnection = (value: string): ResolvedConnection => {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('connection' in parsed) ||
    typeof parsed.connection !== 'object' ||
    parsed.connection === null ||
    !('id' in parsed.connection) ||
    typeof parsed.connection.id !== 'string' ||
    !('providerFamily' in parsed.connection) ||
    !['openai', 'anthropic'].includes(String(parsed.connection.providerFamily)) ||
    !('baseUrl' in parsed.connection) ||
    typeof parsed.connection.baseUrl !== 'string' ||
    ('apiKey' in parsed &&
      parsed.apiKey !== null &&
      typeof parsed.apiKey !== 'string')
  ) {
    throw new Error('The native model connection was invalid.');
  }
  return parsed as ResolvedConnection;
};

const anthropicBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/\/v1\/?$/u, '');

export const discoverModels = async (
  connectionJson: string,
  abortSignal?: AbortSignal,
): Promise<ModelDiscoveryResult> => {
  const { connection, apiKey } = parseResolvedConnection(connectionJson);
  if (!apiKey) {
    throw new Error('The model connection has no API key.');
  }
  const models: Array<{ modelId: string; displayName: string }> = [];
  if (connection.providerFamily === 'openai') {
    const client = new OpenAI({
      apiKey,
      baseURL: connection.baseUrl,
      maxRetries: 0,
    });
    for await (const model of client.models.list({ signal: abortSignal })) {
      models.push({ modelId: model.id, displayName: model.id });
      if (models.length >= 500) {
        break;
      }
    }
  } else {
    const client = new Anthropic({
      apiKey,
      baseURL: anthropicBaseUrl(connection.baseUrl),
      maxRetries: 0,
    });
    for await (const model of client.models.list({}, { signal: abortSignal })) {
      models.push({
        modelId: model.id,
        displayName: model.display_name || model.id,
      });
      if (models.length >= 500) {
        break;
      }
    }
  }
  models.sort((left, right) => left.modelId.localeCompare(right.modelId));
  return { connectionId: connection.id, models };
};
