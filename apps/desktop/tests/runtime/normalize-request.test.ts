import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmRequest } from '@google/adk';
import { Type } from '@google/genai';

import { normalizeLlmRequest } from '../../src/runtime/models/normalize-request.ts';

test('provider requests convert Google ADK schemas to standard JSON Schema', () => {
  const request: LlmRequest = {
    model: 'fixture-model',
    contents: [],
    config: {
      tools: [{
        functionDeclarations: [{
          name: 'workspace_read',
          parameters: {
            type: Type.OBJECT,
            properties: {
              paths: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                minItems: '1',
                maxItems: '8',
              },
            },
          },
        }],
      }],
    },
    liveConnectConfig: {},
    toolsDict: {},
  };

  const normalized = normalizeLlmRequest(request, 'fallback-model');

  assert.deepEqual(normalized.tools[0]?.parameters, {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 8,
      },
    },
  });
});

test('provider requests preserve an existing standard JSON Schema', () => {
  const request: LlmRequest = {
    model: 'fixture-model',
    contents: [],
    config: {
      tools: [{
        functionDeclarations: [{
          name: 'fixture_tool',
          parametersJsonSchema: {
            type: 'object',
            properties: {
              values: {
                type: 'array',
                items: { type: 'integer' },
                minItems: 1,
                maxItems: 3,
              },
            },
          },
        }],
      }],
    },
    liveConnectConfig: {},
    toolsDict: {},
  };

  const normalized = normalizeLlmRequest(request, 'fallback-model');

  assert.deepEqual(normalized.tools[0]?.parameters, {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        items: { type: 'integer' },
        minItems: 1,
        maxItems: 3,
      },
    },
  });
});
