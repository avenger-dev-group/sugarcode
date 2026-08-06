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

const emptyThreadSnapshot = (threadId = 'thread-fixture'): string =>
  JSON.stringify({
    thread: {
      id: threadId,
      workspaceId: 'workspace-fixture',
      title: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [],
    items: [],
  });

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

class CommandLoopLlm extends BaseLlm {
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
              id: 'call-command',
              name: 'shell_exec',
              args: {
                mode: 'sandboxed',
                command: '/bin/pwd',
                arguments: [],
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'Command complete' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'Command complete' }] },
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

class CaptureLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    yield {
      content: { role: 'model', parts: [{ text: 'Current answer' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'Current answer' }] },
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
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async () => '{}',
    cancelOperation: () => false,
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
    beginOperation: () => true,
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
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
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async () => '{}',
    cancelOperation: () => false,
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
    beginOperation: () => true,
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
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

test('RuntimeHost approves and persists command execution before native dispatch', async () => {
  const events: RuntimeEvent[] = [];
  let beginCount = 0;
  let executeCount = 0;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async (_operationId, _workspaceId, mode, command) => {
      executeCount += 1;
      assert.equal(mode, 'sandboxed');
      assert.equal(command, '/bin/pwd');
      return JSON.stringify({ status: 'completed', mode, output: { stdout: '/fixture' } });
    },
    cancelOperation: () => false,
    ensureWorkspace: () => undefined,
    ensureThread: () => undefined,
    createThreadJson: () => emptyThreadSnapshot(),
    listThreadsJson: () => '[]',
    setThreadArchivedJson: () => emptyThreadSnapshot(),
    deleteThread: () => true,
    forkThreadJson: () => emptyThreadSnapshot(),
    startTurn: () => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    proposeOperation: () => true,
    resolveApproval: () => true,
    beginOperation: () => {
      beginCount += 1;
      return true;
    },
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceSearch: async () => '{}',
    workspaceApplyPatch: async () => '{}',
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
    createModel: () => new CommandLoopLlm({ model: 'fixture-model' }),
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
    content: [{ type: 'text', text: 'Show the workspace path' }],
  });
  let approval: Extract<RuntimeEvent, { type: 'approval.requested' }> | undefined;
  for (let attempt = 0; attempt < 20 && !approval; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    approval = events.find((event) => event.type === 'approval.requested');
  }
  assert.ok(approval);
  assert.equal(approval.toolName, 'shell_exec');
  assert.equal(approval.argumentsSummary, 'Sandboxed: /bin/pwd');
  assert.equal(approval.fullAccess, false);
  assert.equal(beginCount, 0);
  assert.equal(executeCount, 0);
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
  assert.equal(beginCount, 1);
  assert.equal(executeCount, 1);
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
});

test('RuntimeHost rebuilds completed neutral history into ADK and loads verified attachments', async () => {
  const events: RuntimeEvent[] = [];
  const model = new CaptureLlm({ model: 'fixture-model' });
  const sha256 = 'a'.repeat(64);
  const asset = {
    assetId: `ast_${sha256}`,
    sha256,
    mediaType: 'text/plain',
    originalName: 'fixture.txt',
    sizeBytes: 7,
    kind: 'text' as const,
  };
  const snapshot = JSON.stringify({
    thread: {
      id: 'thread-fixture',
      workspaceId: 'workspace-fixture',
      title: null,
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      parentThreadId: null,
    },
    turns: [{
      id: 'turn-earlier',
      requestId: 'request-earlier',
      status: 'completed',
      providerWireApi: 'openaiResponses',
      model: 'fixture-model',
      errorJson: null,
      startedAt: 1,
      completedAt: 2,
    }],
    items: [
      {
        id: 'earlier-user',
        turnId: 'turn-earlier',
        sequence: 1,
        kind: 'turn.userMessage',
        payload: { content: [{ type: 'text', text: 'Earlier request' }] },
      },
      {
        id: 'earlier-tool-call',
        turnId: 'turn-earlier',
        sequence: 2,
        kind: 'turn.modelHistory',
        payload: {
          history: {
            role: 'assistant',
            parts: [{
              type: 'toolCall',
              id: 'call-earlier',
              name: 'workspace_read',
              arguments: { path: 'fixture.txt' },
            }],
          },
        },
      },
      {
        id: 'earlier-tool-result',
        turnId: 'turn-earlier',
        sequence: 3,
        kind: 'turn.modelHistory',
        payload: {
          history: {
            role: 'user',
            parts: [{
              type: 'toolResult',
              id: 'call-earlier',
              name: 'workspace_read',
              result: { content: 'fixture' },
            }],
          },
        },
      },
      {
        id: 'earlier-model',
        turnId: 'turn-earlier',
        sequence: 4,
        kind: 'turn.modelHistory',
        payload: {
          history: {
            role: 'assistant',
            parts: [{
              type: 'text',
              text: 'Earlier answer',
              reasoning: false,
            }],
          },
        },
      },
    ],
  });
  const native: NativeRuntimeBinding = {
    importAssetJson: () => JSON.stringify(asset),
    readAssetJson: () => JSON.stringify({ asset, data: 'Zml4dHVyZQ==' }),
    executeCommandJson: async () => '{}',
    cancelOperation: () => false,
    ensureWorkspace: () => undefined,
    ensureThread: () => undefined,
    createThreadJson: () => emptyThreadSnapshot(),
    listThreadsJson: () => '[]',
    setThreadArchivedJson: () => emptyThreadSnapshot(),
    deleteThread: () => true,
    forkThreadJson: () => emptyThreadSnapshot(),
    startTurn: () => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    proposeOperation: () => true,
    resolveApproval: () => true,
    beginOperation: () => true,
    completeOperation: () => true,
    loadThreadJson: () => snapshot,
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceSearch: async () => '{}',
    workspaceApplyPatch: async () => '{}',
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
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
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
    requestId: 'request-current',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-current',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [
      { type: 'text', text: 'Current request' },
      { type: 'asset', asset },
    ],
  });
  await completed;

  const contents = model.requests[0]?.contents ?? [];
  assert.deepEqual(contents.map((content) => content.role), [
    'user',
    'model',
    'user',
    'model',
    'user',
  ]);
  assert.equal(contents[0]?.parts?.[0]?.text, 'Earlier request');
  assert.deepEqual(contents[1]?.parts?.[0]?.functionCall, {
    id: 'call-earlier',
    name: 'workspace_read',
    args: { path: 'fixture.txt' },
  });
  assert.deepEqual(contents[2]?.parts?.[0]?.functionResponse, {
    id: 'call-earlier',
    name: 'workspace_read',
    response: { content: 'fixture' },
  });
  assert.equal(contents[3]?.parts?.[0]?.text, 'Earlier answer');
  assert.equal(
    contents[4]?.parts?.map((part) => part.text).filter(Boolean).join('\n'),
    'Current request\nAttachment fixture.txt:\nfixture',
  );
  assert.ok(events.some((event) => event.type === 'turn.completed'));
});
