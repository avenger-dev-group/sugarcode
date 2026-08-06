import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason } from '@google/genai';

import { RuntimeHost } from '../../src/runtime/host.ts';
import type { NativeRuntimeBinding } from '../../src/runtime/native.ts';
import type { RuntimeEvent } from '../../src/runtime/protocol.ts';

class FixtureLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    _request: LlmRequest,
    _stream = false,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    void _request;
    void _stream;
    void _abortSignal;
    yield {
      content: { role: 'model', parts: [{ text: 'Fixture response' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'Fixture response' }] },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

class ToolLoopLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    request: LlmRequest,
    _stream = false,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    void _stream;
    void _abortSignal;
    const hasToolResult = request.contents.some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse),
    );
    if (!hasToolResult) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-read',
                name: 'workspace_read',
                args: { path: 'fixture.txt' },
              },
            },
          ],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'Tool loop complete' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'Tool loop complete' }] },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

class PatchLoopLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const hasToolResult = request.contents.some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse),
    );
    if (!hasToolResult) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-patch',
              name: 'workspace_apply_patch',
              args: {
                patch: '*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch',
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'Patch complete' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'Patch complete' }] },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

test('RuntimeHost runs an ADK Turn and publishes ordered provider-neutral events', async () => {
  const events: RuntimeEvent[] = [];
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => new FixtureLlm({ model: 'fixture-model' }),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 1,
    dataDirectory: '/tmp/sugarcode-v3-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Hello' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'runtime.ready',
      'turn.started',
      'turn.userMessage',
      'turn.textDelta',
      'turn.usage',
      'turn.completed',
    ],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  const text = events.find((event) => event.type === 'turn.textDelta');
  assert.equal(text?.delta, 'Fixture response');
  const usage = events.find((event) => event.type === 'turn.usage');
  assert.equal(usage?.usage.totalTokens, 5);
  const terminal = events.find((event) => event.type === 'turn.completed');
  assert.equal(terminal?.status, 'completed');
});

test('RuntimeHost executes ADK workspace tools through the native boundary', async () => {
  const events: RuntimeEvent[] = [];
  const persistedKinds: string[] = [];
  let readPath = '';
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    ensureWorkspace: () => undefined,
    ensureThread: () => undefined,
    createThreadJson: () => '{}',
    listThreadsJson: () => '[]',
    setThreadArchivedJson: () => '{}',
    deleteThread: () => true,
    forkThreadJson: () => '{}',
    startTurn: () => undefined,
    appendItem: (_itemId, _turnId, _sequence, kind) => {
      persistedKinds.push(kind);
      return true;
    },
    finishTurn: () => true,
    proposeOperation: () => true,
    resolveApproval: () => true,
    completeOperation: () => true,
    loadThreadJson: () => '{}',
    workspaceRead: async (_workspaceId, path) => {
      readPath = path;
      return JSON.stringify({ ok: true, content: 'fixture', bytes: 7 });
    },
    workspaceList: async () => JSON.stringify({ ok: true, entries: [] }),
    workspaceSearch: async () => JSON.stringify({ ok: true, matches: [] }),
    workspaceApplyPatch: async () => JSON.stringify({ ok: true, files: [] }),
    gitStatusJson: () => '{}',
    gitDiffJson: () => '{}',
    gitMutateJson: () => '{}',
    gitCommitJson: () => '{}',
    inspectModelConfigJson: () => '{}',
    saveModelConfigJson: () => '{}',
    deleteModelApiKeyJson: () => '{}',
    modelConnectionJson: () => '{}',
    modelProfileJson: () => '{}',
  };
  const host = new RuntimeHost({
    createModel: () => new ToolLoopLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 1,
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  host.handle({
    type: 'workspace.open',
    requestId: 'request-workspace',
    workspaceId: 'workspace-fixture',
    canonicalRoot: '/fixture/workspace',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Read fixture.txt' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for tool Turn.')), 2_000),
    ),
  ]);

  assert.equal(readPath, 'fixture.txt');
  assert.ok(events.some((event) => event.type === 'turn.toolCall'));
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
  assert.ok(
    events.some(
      (event) =>
        event.type === 'turn.textDelta' && event.delta === 'Tool loop complete',
    ),
  );
  assert.ok(persistedKinds.includes('turn.toolCall'));
  assert.ok(persistedKinds.includes('turn.toolResult'));
});

test('RuntimeHost persists approval before committing a workspace patch', async () => {
  const events: RuntimeEvent[] = [];
  let applyCount = 0;
  let proposalCount = 0;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    ensureWorkspace: () => undefined,
    ensureThread: () => undefined,
    createThreadJson: () => '{}',
    listThreadsJson: () => '[]',
    setThreadArchivedJson: () => '{}',
    deleteThread: () => true,
    forkThreadJson: () => '{}',
    startTurn: () => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    proposeOperation: () => {
      proposalCount += 1;
      return true;
    },
    resolveApproval: () => true,
    completeOperation: () => true,
    loadThreadJson: () => '{}',
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceSearch: async () => '{}',
    workspaceApplyPatch: async () => {
      applyCount += 1;
      return JSON.stringify({ ok: true, files: [{ path: 'fixture.txt' }] });
    },
    gitStatusJson: () => '{}',
    gitDiffJson: () => '{}',
    gitMutateJson: () => '{}',
    gitCommitJson: () => '{}',
    inspectModelConfigJson: () => '{}',
    saveModelConfigJson: () => '{}',
    deleteModelApiKeyJson: () => '{}',
    modelConnectionJson: () => '{}',
    modelProfileJson: () => '{}',
  };
  const host = new RuntimeHost({
    createModel: () => new PatchLoopLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 1,
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Patch fixture.txt' }],
  });
  let approval: Extract<RuntimeEvent, { type: 'approval.requested' }> | undefined;
  for (let attempt = 0; attempt < 20 && !approval; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    approval = events.find((event) => event.type === 'approval.requested');
  }
  assert.ok(approval);
  assert.equal(proposalCount, 1);
  assert.equal(applyCount, 0);
  host.handle({
    type: 'approval.resolve',
    requestId: 'request-approval',
    workspaceId: approval.workspaceId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    approvalId: approval.approvalId,
    decision: 'approved',
  });
  await completed;
  assert.equal(applyCount, 1);
  assert.ok(events.some((event) => event.type === 'approval.resolved'));
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
});
