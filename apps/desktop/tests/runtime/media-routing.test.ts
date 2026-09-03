import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelConfigValue } from '../../src/shared/model-config.ts';
import {
  audioAnalysisProfileIds,
  availableThreadImages,
  availableThreadVideos,
  imageAnalysisProfileIds,
  videoAnalysisProfileIds,
} from '../../src/runtime/media/routing.ts';
import type {
  RuntimeAssetDescriptor,
  RuntimeThreadSnapshot,
} from '../../src/runtime/contracts/protocol.ts';

const config = (): ModelConfigValue => ({
  defaultProfileId: 'default_model',
  mediaRouting: {
    imageProfileId: 'vision_model',
    videoProfileId: 'vision_model',
    audioProfileId: 'vision_model',
  },
  connections: [{
    id: 'connection',
    providerFamily: 'openai',
    displayName: 'Fixture',
    baseUrl: 'http://127.0.0.1/v1',
    enabled: true,
    wireApi: 'openaiChatCompletions',
    continuationMode: 'localReplay',
  }],
  profiles: ['default_model', 'current_model', 'vision_model'].map((id) => ({
    id,
    connectionId: 'connection',
    displayName: id,
    modelId: id,
    toolCalls: 'auto',
    strictTools: 'auto',
    parallelTools: 'auto',
    imageInput: 'enabled',
    videoInput: 'enabled',
    audioInput: 'enabled',
    pdfInput: 'auto',
  })),
});

const image = (assetId: string): RuntimeAssetDescriptor => ({
  assetId,
  sha256: assetId.slice(4),
  mediaType: 'image/png',
  originalName: `${assetId}.png`,
  sizeBytes: 10,
  kind: 'image',
});

const video = (assetId: string): RuntimeAssetDescriptor => ({
  assetId,
  sha256: assetId.slice(4),
  mediaType: 'video/mp4',
  originalName: `${assetId}.mp4`,
  sizeBytes: 20,
  kind: 'video',
});

test('image model candidates prefer the configured route, then current and default', () => {
  assert.deepEqual(
    imageAnalysisProfileIds(config(), 'current_model'),
    ['vision_model', 'current_model', 'default_model'],
  );
});

test('image model candidates skip disabled configured profiles and duplicates', () => {
  const value = config();
  assert.deepEqual(
    imageAnalysisProfileIds({
      ...value,
      mediaRouting: { imageProfileId: 'default_model' },
      connections: [{ ...value.connections[0], enabled: false }],
    }, 'current_model'),
    ['current_model'],
  );
});

test('video model candidates preserve configured provider protocols', () => {
  const value = config();
  assert.deepEqual(
    videoAnalysisProfileIds({
      ...value,
      connections: [{
        ...value.connections[0],
        wireApi: 'anthropicMessages',
        providerFamily: 'anthropic',
      }],
    }, 'current_model'),
    ['vision_model', 'current_model', 'default_model'],
  );
});

test('audio model candidates prefer the audio route and can reuse the video model', () => {
  assert.deepEqual(
    audioAnalysisProfileIds(config(), 'vision_model', 'current_model'),
    ['vision_model', 'current_model', 'default_model'],
  );
});

test('audio model candidates exclude protocols without an audio transport', () => {
  const value = config();
  assert.deepEqual(
    audioAnalysisProfileIds({
      ...value,
      connections: [{
        ...value.connections[0],
        providerFamily: 'anthropic',
        wireApi: 'anthropicMessages',
      }],
    }, 'vision_model', 'current_model'),
    [],
  );
});

test('available thread images prefer current content and remove duplicates', () => {
  const current = image(`ast_${'a'.repeat(64)}`);
  const previous = image(`ast_${'b'.repeat(64)}`);
  const snapshot: RuntimeThreadSnapshot = {
    thread: {
      id: 'thread',
      workspaceId: 'workspace',
      title: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: 'turn',
      requestId: 'request',
      status: 'completed',
      providerWireApi: 'openaiChatCompletions',
      model: 'fixture',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [{
      id: 'item',
      turnId: 'turn',
      sequence: 0,
      kind: 'turn.userMessage',
      payload: {
        content: [
          { type: 'asset', asset: previous },
          { type: 'asset', asset: current },
        ],
      },
    }],
    agentTasks: [],
    queue: { paused: false, messages: [] },
  };

  assert.deepEqual(
    availableThreadImages(snapshot, [{ type: 'asset', asset: current }]),
    [current, previous],
  );
});

test('available thread videos prefer current content and remove duplicates', () => {
  const current = video(`ast_${'c'.repeat(64)}`);
  const previous = video(`ast_${'d'.repeat(64)}`);
  const snapshot: RuntimeThreadSnapshot = {
    thread: {
      id: 'thread',
      workspaceId: 'workspace',
      title: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: 'turn',
      requestId: 'request',
      status: 'completed',
      providerWireApi: 'openaiChatCompletions',
      model: 'fixture',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [{
      id: 'item',
      turnId: 'turn',
      sequence: 0,
      kind: 'turn.userMessage',
      payload: {
        content: [
          { type: 'asset', asset: previous },
          { type: 'asset', asset: current },
        ],
      },
    }],
    agentTasks: [],
    queue: { paused: false, messages: [] },
  };

  assert.deepEqual(
    availableThreadVideos(snapshot, [{ type: 'asset', asset: current }]),
    [current, previous],
  );
});
