import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason, type Content } from '@google/genai';

import {
  ContextManager,
  estimateRequestTokens,
  type RuntimeContextCheckpoint,
} from '../../src/runtime/context-manager.ts';
import type { RuntimeModelSelection } from '../../src/runtime/protocol.ts';

class SummaryLlm extends BaseLlm {
  requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    yield {
      content: {
        role: 'model',
        parts: [{
          text: '<context_checkpoint>Goal: finish the active task. Keep the confirmed API decision.</context_checkpoint>',
        }],
      },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled.'));
  }
}

const selection: RuntimeModelSelection = {
  profileId: 'fixture',
  providerFamily: 'openai',
  wireApi: 'openaiChatCompletions',
  modelId: 'fixture-model',
  displayName: 'Fixture',
  contextWindowTokens: 100_000,
  autoCompaction: 'enabled',
  compactThresholdTokens: 20_000,
  nativeCompaction: 'disabled',
  effectiveCapabilities: {
    toolCalls: true,
    strictTools: false,
    parallelTools: true,
    imageInput: false,
    pdfInput: false,
  },
};

test('context manager compacts before sampling and keeps the current prompt verbatim', async () => {
  const currentUserContent: Content = {
    role: 'user',
    parts: [{ text: 'CURRENT USER REQUEST — keep this exact text' }],
  };
  const request: LlmRequest = {
    model: selection.modelId,
    contents: [
      { role: 'user', parts: [{ text: `old request ${'x'.repeat(45_000)}` }] },
      { role: 'model', parts: [{ text: `old result ${'y'.repeat(30_000)}` }] },
      { role: 'user', parts: [{ text: 'recent request one' }] },
      { role: 'model', parts: [{ text: 'recent answer one' }] },
      { role: 'user', parts: [{ text: 'recent request two' }] },
      { role: 'model', parts: [{ text: 'recent answer two' }] },
      currentUserContent,
    ],
    config: { maxOutputTokens: 8_192 },
    liveConnectConfig: {},
    toolsDict: {},
  };
  const before = estimateRequestTokens(request);
  const summarizer = new SummaryLlm({ model: selection.modelId });
  const started: unknown[] = [];
  const finished: unknown[] = [];
  const checkpoints: RuntimeContextCheckpoint[] = [];

  const compacted = await new ContextManager().compactRequest({
    threadId: 'thread-1',
    request,
    currentUserContent,
    selection,
    summarizer,
    signal: new AbortController().signal,
    callbacks: {
      onStarted: (event) => started.push(event),
      onFinished: (event) => finished.push(event),
      persist: (checkpoint) => checkpoints.push(checkpoint),
      currentSequence: () => 42,
    },
  });

  assert.equal(compacted, true);
  assert.equal(started.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.coveredThroughSequence, 42);
  assert.ok(estimateRequestTokens(request) < before);
  assert.match(request.contents[0]?.parts?.[0]?.text ?? '', /context checkpoint/iu);
  assert.equal(
    request.contents.at(-1)?.parts?.[0]?.text,
    'CURRENT USER REQUEST — keep this exact text',
  );
  assert.equal(summarizer.requests[0]?.toolsDict &&
    Object.keys(summarizer.requests[0].toolsDict).length, 0);
});

test('context manager leaves the request untouched below the threshold', async () => {
  const currentUserContent: Content = {
    role: 'user',
    parts: [{ text: 'small request' }],
  };
  const request: LlmRequest = {
    model: selection.modelId,
    contents: [currentUserContent],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
  };
  const original = JSON.stringify(request.contents);
  const compacted = await new ContextManager().compactRequest({
    threadId: 'thread-2',
    request,
    currentUserContent,
    selection,
    summarizer: new SummaryLlm({ model: selection.modelId }),
    signal: new AbortController().signal,
    callbacks: {
      onStarted: () => assert.fail('must not start compaction'),
      onFinished: () => assert.fail('must not finish compaction'),
      persist: () => assert.fail('must not persist a checkpoint'),
      currentSequence: () => 0,
    },
  });
  assert.equal(compacted, false);
  assert.equal(JSON.stringify(request.contents), original);
});
