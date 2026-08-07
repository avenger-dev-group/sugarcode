import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason } from '@google/genai';

import { RuntimeHost } from '../../src/runtime/host.ts';
import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';
import { modelItemMetadata } from '../../src/runtime/models/step-outcome.ts';
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
    agentTasks: [],
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

class CommentaryOnlyLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const commentary = 'I should inspect the workspace before answering.';
    yield {
      content: {
        role: 'model',
        parts: [{ text: commentary, thought: true }],
      },
      partial: true,
    };
    yield {
      content: {
        role: 'model',
        parts: [{ text: commentary, thought: true }],
      },
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

class ProviderTimeoutLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { customMetadata: { fixture: 'before-provider-timeout' } };
    throw new ProviderAdapterError({
      kind: 'timeout',
      retryable: true,
      message: 'The model stream exceeded the request deadline.',
    });
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

class ReasoningBoundaryLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const internal = {
      text: 'Private chain of thought.',
      thought: true,
      partMetadata: modelItemMetadata('reasoning-internal', {
        phase: 'commentary',
        reasoningVisibility: 'internal',
      }),
    };
    const summary = {
      text: 'I checked the relevant project files.',
      thought: true,
      partMetadata: modelItemMetadata('reasoning-summary', {
        phase: 'commentary',
        reasoningVisibility: 'summary',
      }),
    };
    yield { content: { role: 'model', parts: [internal] }, partial: true };
    yield { content: { role: 'model', parts: [summary] }, partial: true };
    yield {
      content: {
        role: 'model',
        parts: [
          internal,
          summary,
          {
            text: 'Review complete.',
            partMetadata: modelItemMetadata('final-answer', {
              phase: 'final',
              outcome: { kind: 'final' },
            }),
          },
        ],
      },
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

class OutputTruncatedLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  private requestCount = 0;

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    this.requestCount += 1;
    yield {
      content: {
        role: 'model',
        parts: [{
          text: `Long partial ${this.requestCount}`,
          partMetadata: modelItemMetadata(`truncated-${this.requestCount}`, {
            phase: 'commentary',
            outcome: { kind: 'continue', reason: 'maxOutputTokens' },
          }),
        }],
      },
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
              text: 'I should read the requested file before answering.',
              thought: true,
            },
            { text: '\n\n' },
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
      content: {
        role: 'model',
        parts: [{ text: 'Tool loop complete' }],
      },
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

class RepeatingToolErrorLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const failures = request.contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionResponse?.name === 'workspace_read')
      .length;
    if (failures < 2) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: `call-repeat-${failures}`,
              name: 'workspace_read',
              args: { path: 'missing.txt' },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'Should not be reached' }] },
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

class PersistentToolErrorLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const failures = request.contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionResponse?.name === 'workspace_read')
      .length;
    yield {
      content: {
        role: 'model',
        parts: failures < 3
          ? [{
            functionCall: {
              id: `call-persistent-${failures}`,
              name: 'workspace_read',
              args: { path: 'missing.txt' },
            },
          }]
          : [{ text: 'The no-progress guard should stop before this response.' }],
      },
      partial: false,
      turnComplete: failures >= 3,
      finishReason: failures >= 3 ? FinishReason.STOP : undefined,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

class RecoverAfterPrematureFinalLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const parts = request.contents.flatMap((content) => content.parts ?? []);
    const toolResults = parts.filter(
      (part) => part.functionResponse?.name === 'workspace_read',
    );
    const recoveryRequested = parts.some(
      (part) => part.text?.includes('Internal continuation after tool failure'),
    );
    if (toolResults.length === 0) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-failing-read',
              name: 'workspace_read',
              args: { path: 'missing.txt' },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    if (!recoveryRequested) {
      yield {
        content: {
          role: 'model',
          parts: [{
            text: '好的，让我继续读取项目文件。',
            partMetadata: modelItemMetadata('premature-final', {
              phase: 'final',
              outcome: { kind: 'final' },
            }),
          }],
        },
        partial: false,
        turnComplete: true,
        finishReason: FinishReason.STOP,
      };
      return;
    }
    if (toolResults.length === 1) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-recovered-read',
              name: 'workspace_read',
              args: { path: 'fixture.txt' },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{
          text: '项目文件读取完成。',
          partMetadata: modelItemMetadata('recovered-final', {
            phase: 'final',
            outcome: { kind: 'final' },
          }),
        }],
      },
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

class FinalAfterInformativeMissingReadLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  requestCount = 0;

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requestCount += 1;
    const hasReadResult = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'workspace_read',
      )
    );
    if (!hasReadResult) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-read-optional-files',
              name: 'workspace_read',
              args: {
                paths: ['README.md', '.dockerignore', '.gitignore'],
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{
          text: '分析完成：项目缺少 `.dockerignore`。',
          partMetadata: modelItemMetadata('informative-miss-final', {
            phase: 'final',
            outcome: { kind: 'final' },
          }),
        }],
      },
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

class CollaborationLoopLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const parent = Object.hasOwn(request.toolsDict, 'collaboration_dispatch');
    if (!parent) {
      const taskText = request.contents
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join('\n');
      const summary = taskText.includes('Audit')
        ? 'Audit passed.'
        : 'Implementation completed.';
      yield {
        content: { role: 'model', parts: [{ text: summary }] },
        partial: false,
        turnComplete: true,
        finishReason: FinishReason.STOP,
      };
      return;
    }
    const responses = request.contents
      .flatMap((content) => content.parts ?? [])
      .flatMap((part) => part.functionResponse?.name
        ? [part.functionResponse.name]
        : []);
    if (!responses.includes('collaboration_dispatch')) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-dispatch',
              name: 'collaboration_dispatch',
              args: {
                tasks: [
                  {
                    clientTaskKey: 'implementation',
                    title: 'Implement fixture',
                    role: 'worker',
                    access: 'workspaceWrite',
                    dependsOn: [],
                    taskMarkdown: 'Implement the fixture.',
                  },
                  {
                    clientTaskKey: 'audit',
                    title: 'Audit fixture',
                    role: 'auditor',
                    access: 'readOnly',
                    dependsOn: ['implementation'],
                    taskMarkdown: 'Audit the fixture.',
                  },
                ],
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    if (!responses.includes('collaboration_wait')) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-wait',
              name: 'collaboration_wait',
              args: { clientTaskKeys: [] },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'Collaboration complete' }] },
      partial: true,
    };
    yield {
      content: {
        role: 'model',
        parts: [{ text: 'Collaboration complete' }],
      },
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
      content: {
        role: 'model',
        parts: [{ text: 'Patch complete' }],
      },
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
      content: {
        role: 'model',
        parts: [{ text: 'Command complete' }],
      },
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
      content: {
        role: 'model',
        parts: [{ text: 'Current answer' }],
      },
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
    protocolVersion: 2,
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
      'turn.textStarted',
      'turn.textDelta',
      'turn.textCompleted',
      'turn.usage',
      'turn.completed',
    ],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const text = events.find((event) => event.type === 'turn.textDelta');
  assert.equal(text?.delta, 'Fixture response');
  const usage = events.find((event) => event.type === 'turn.usage');
  assert.equal(usage?.usage.totalTokens, 5);
  const terminal = events.find((event) => event.type === 'turn.completed');
  assert.equal(terminal?.status, 'completed');
});

test('RuntimeHost never completes a commentary-only model response', async () => {
  const events: RuntimeEvent[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => new CommentaryOnlyLlm({ model: 'fixture-model' }),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-commentary',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-commentary-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-commentary',
    workspaceId: 'workspace-commentary',
    threadId: 'thread-commentary',
    turnId: 'turn-commentary',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Inspect the project.' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(completed?.status, 'failed');
  assert.equal(completed?.error?.kind, 'protocol');
  assert.match(completed?.error?.message ?? '', /three times/u);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textDelta' ||
        event.type === 'turn.textCompleted',
    ),
    false,
  );
});

test('RuntimeHost preserves typed provider failures caught by ADK', async () => {
  const events: RuntimeEvent[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => new ProviderTimeoutLlm({ model: 'fixture-model' }),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-provider-timeout',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-provider-timeout-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-provider-timeout',
    workspaceId: 'workspace-provider-timeout',
    threadId: 'thread-provider-timeout',
    turnId: 'turn-provider-timeout',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Review the project.' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(completed?.status, 'failed');
  assert.deepEqual(completed?.error, {
    kind: 'timeout',
    retryable: true,
    message: 'The model stream exceeded the request deadline.',
  });
});

test('RuntimeHost publishes provider summaries but keeps internal reasoning private', async () => {
  const events: RuntimeEvent[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => new ReasoningBoundaryLlm({ model: 'fixture-model' }),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-reasoning-boundary',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-reasoning-boundary-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-reasoning-boundary',
    workspaceId: 'workspace-reasoning-boundary',
    threadId: 'thread-reasoning-boundary',
    turnId: 'turn-reasoning-boundary',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Review the project.' }],
  });

  await terminal;

  const visibleText = events.flatMap((event) =>
    event.type === 'turn.textDelta'
      ? [event.delta]
      : event.type === 'turn.textCompleted'
        ? [event.text]
        : [],
  );
  assert.equal(visibleText.some((text) => text.includes('Private chain')), false);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'commentary' &&
        event.text === 'I checked the relevant project files.',
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === 'Review complete.',
    ),
    true,
  );
});

test('RuntimeHost fails after two output truncations without publishing success', async () => {
  const events: RuntimeEvent[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => new OutputTruncatedLlm({ model: 'fixture-model' }),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-truncated',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-truncated-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-truncated',
    workspaceId: 'workspace-truncated',
    threadId: 'thread-truncated',
    turnId: 'turn-truncated',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Produce a long answer.' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(completed?.status, 'failed');
  assert.equal(completed?.error?.kind, 'outputTooLarge');
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' && event.phase === 'final',
    ),
    false,
  );
});

test('RuntimeHost gives repeated execution failures one guided recovery attempt', async () => {
  const events: RuntimeEvent[] = [];
  let readCount = 0;
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    loadThreadJson: () => emptyThreadSnapshot('thread-tool-error'),
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    workspaceRead: async () => {
      readCount += 1;
      return JSON.stringify({ ok: false, error: 'notFound' });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new RepeatingToolErrorLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-tool-error',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-tool-error-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-tool-error',
    workspaceId: 'workspace-tool-error',
    threadId: 'thread-tool-error',
    turnId: 'turn-tool-error',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Read the missing file.' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(readCount, 2);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.error, undefined);
  assert.equal(
    events.some((event) => event.type === 'approval.requested'),
    false,
  );
});

test('RuntimeHost stops a third identical execution failure without progress', async () => {
  const events: RuntimeEvent[] = [];
  let readCount = 0;
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    loadThreadJson: () => emptyThreadSnapshot('thread-persistent-tool-error'),
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    workspaceRead: async () => {
      readCount += 1;
      return JSON.stringify({ ok: false, error: 'notFound' });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new PersistentToolErrorLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-persistent-tool-error',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-persistent-tool-error-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-persistent-tool-error',
    workspaceId: 'workspace-persistent-tool-error',
    threadId: 'thread-persistent-tool-error',
    turnId: 'turn-persistent-tool-error',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Keep retrying the missing file.' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(readCount, 3);
  assert.equal(completed?.status, 'failed');
  assert.equal(completed?.error?.kind, 'protocol');
  assert.match(completed?.error?.message ?? '', /three times/u);
});

test('RuntimeHost retries one premature final after a failed tool result', async () => {
  const events: RuntimeEvent[] = [];
  let readCount = 0;
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    loadThreadJson: () => emptyThreadSnapshot('thread-final-recovery'),
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    workspaceRead: async () => {
      readCount += 1;
      return readCount === 1
        ? JSON.stringify({
          status: 'completed',
          output: { outcome: { type: 'exitCode', code: 1 } },
        })
        : JSON.stringify({ ok: true, content: 'fixture' });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new RecoverAfterPrematureFinalLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-final-recovery',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-final-recovery-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-final-recovery',
    workspaceId: 'workspace-final-recovery',
    threadId: 'thread-final-recovery',
    turnId: 'turn-final-recovery',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '读取并检查项目。' }],
  });

  await terminal;

  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(readCount, 2);
  assert.equal(completed?.status, 'completed');
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === '好的，让我继续读取项目文件。',
    ),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === '项目文件读取完成。',
    ),
    true,
    JSON.stringify(
      events.filter(
        (event) =>
          event.type === 'turn.textCompleted' || event.type === 'turn.completed',
      ),
    ),
  );
});

test('RuntimeHost keeps a summary final after workspace_read confirms a missing file', async () => {
  const events: RuntimeEvent[] = [];
  const requestedPaths: string[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const model = new FinalAfterInformativeMissingReadLlm({
    model: 'fixture-model',
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    loadThreadJson: () => emptyThreadSnapshot('thread-informative-read-miss'),
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    workspaceRead: async (_workspaceId: string, path: string) => {
      requestedPaths.push(path);
      return path === '.dockerignore'
        ? JSON.stringify({ ok: false, error: 'notFound' })
        : JSON.stringify({ ok: true, content: `content:${path}` });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => model,
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveTerminal?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-informative-read-miss',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-informative-read-miss-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-informative-read-miss',
    workspaceId: 'workspace-informative-read-miss',
    threadId: 'thread-informative-read-miss',
    turnId: 'turn-informative-read-miss',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '分析项目可以优化的地方。' }],
  });

  await terminal;

  assert.deepEqual(requestedPaths, [
    'README.md',
    '.dockerignore',
    '.gitignore',
  ]);
  assert.equal(model.requestCount, 2);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === '分析完成：项目缺少 `.dockerignore`。',
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'commentary' &&
        event.text === '分析完成：项目缺少 `.dockerignore`。',
    ),
    false,
  );
});

test('RuntimeHost streams and controls native PTY sessions without a CLI bridge', async () => {
  const events: RuntimeEvent[] = [];
  const inputs: string[] = [];
  const sizes: Array<readonly [number, number]> = [];
  let drainCount = 0;
  let closeCount = 0;
  let resolveExited: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    createTerminalJson: () => JSON.stringify({ shell: '/bin/zsh' }),
    terminalInput: (_sessionId: string, data: string): void => {
      inputs.push(data);
    },
    terminalResize: (_sessionId: string, columns: number, rows: number) => {
      sizes.push([columns, rows]);
    },
    terminalTerminate: (): void => undefined,
    drainTerminalEventsJson: () => {
      drainCount += 1;
      return drainCount === 1
        ? JSON.stringify([{ type: 'output', sequence: 1, data: 'fixture\r\n' }])
        : JSON.stringify([{
            type: 'exit',
            exitCode: 0,
            reason: 'natural',
          }]);
    },
    closeTerminal: () => {
      closeCount += 1;
      return true;
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'terminal.exited') {
        resolveExited?.();
      }
    },
  });
  const sessionId = '22222222-2222-4222-8222-222222222222';

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'terminal.create',
    requestId: 'request-terminal',
    workspaceId: 'workspace-fixture',
    generation: 3,
    sessionId,
    columns: 80,
    rows: 24,
  });
  host.handle({
    type: 'terminal.input',
    requestId: 'request-input',
    workspaceId: 'workspace-fixture',
    generation: 3,
    sessionId,
    data: 'pwd\n',
  });
  host.handle({
    type: 'terminal.resize',
    requestId: 'request-resize',
    workspaceId: 'workspace-fixture',
    generation: 3,
    sessionId,
    columns: 120,
    rows: 40,
  });

  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for terminal exit.')), 1_000),
    ),
  ]);

  assert.deepEqual(inputs, ['pwd\n']);
  assert.deepEqual(sizes, [[120, 40]]);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith('terminal.'))
      .map((event) => event.type),
    [
      'terminal.started',
      'terminal.inputAccepted',
      'terminal.output',
      'terminal.exited',
    ],
  );
  assert.equal(closeCount, 1);
});

test('RuntimeHost runs persisted child LlmAgent invocations through the collaboration DAG', async () => {
  const events: RuntimeEvent[] = [];
  const createdTasks: Array<Record<string, unknown>> = [];
  const updatedStatuses: string[] = [];
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    createAgentTasksJson: (_turnId: string, tasksJson: string) => {
      createdTasks.push(...JSON.parse(tasksJson) as Array<Record<string, unknown>>);
      return JSON.stringify({ inserted: createdTasks.length });
    },
    updateAgentTask: (_taskId: string, status: string) => {
      updatedStatuses.push(status);
      return true;
    },
    loadThreadJson: () => emptyThreadSnapshot(),
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceInspectJson: () => '{}',
    workspaceSearch: async () => '{}',
    workspaceApplyPatch: async () => '{}',
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new CollaborationLoopLlm({ model: 'fixture-model' }),
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
    requestId: 'request-initialize-collaboration',
    protocolVersion: 2,
    dataDirectory: '/tmp/sugarcode-v3-collaboration',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-collaboration',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-collaboration',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: true,
    },
    content: [{ type: 'text', text: 'Use collaboration.' }],
  });
  await completed;

  assert.equal(createdTasks.length, 2);
  assert.ok(updatedStatuses.includes('running'));
  assert.equal(updatedStatuses.filter((status) => status === 'completed').length, 2);
  const tasks = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'agent.task' }> =>
      event.type === 'agent.task',
  );
  assert.ok(
    tasks.some(
      (event) =>
        event.task.clientTaskKey === 'implementation' &&
        event.task.progress?.stage === 'waitingForModel',
    ),
  );
  const implementationCompleted = tasks.findIndex(
    (event) =>
      event.task.clientTaskKey === 'implementation' &&
      event.task.status === 'completed',
  );
  const auditRunning = tasks.findIndex(
    (event) => event.task.clientTaskKey === 'audit' && event.task.status === 'running',
  );
  assert.ok(implementationCompleted >= 0);
  assert.ok(auditRunning > implementationCompleted);
  assert.equal(events.at(-1)?.type, 'turn.completed');
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
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async () => '{}',
    drainCommandOutputJson: () => '[]',
    finishCommandOutput: () => undefined,
    createTerminalJson: () => '{}',
    terminalInput: () => undefined,
    terminalResize: () => undefined,
    terminalTerminate: () => undefined,
    drainTerminalEventsJson: () => '[]',
    closeTerminal: () => false,
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
    createAgentTasksJson: () => '{"inserted":0}',
    updateAgentTask: () => true,
    proposeOperation: () => true,
    resolveApproval: () => true,
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
    workspaceRead: async (_workspaceId, path) => {
      readPath = path;
      return JSON.stringify({ ok: true, content: 'fixture', bytes: 7 });
    },
    workspaceList: async () => JSON.stringify({
      ok: true,
      entries: [{ name: 'src', kind: 'directory' }],
    }),
    workspaceInspectJson: () => JSON.stringify({
      status: 'complete',
      path: 'fixture.txt',
      content: 'fixture',
      bytes: 7,
      lines: 1,
      hasUtf8Bom: false,
    }),
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
    protocolVersion: 2,
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
    type: 'workspace.list',
    requestId: 'request-workspace-list',
    workspaceId: 'workspace-fixture',
    path: '',
  });
  host.handle({
    type: 'workspace.inspect',
    requestId: 'request-workspace-inspect',
    workspaceId: 'workspace-fixture',
    path: 'fixture.txt',
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
    content: [{ type: 'text', text: '请读取 fixture.txt' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for tool Turn.')), 2_000),
    ),
  ]);

  assert.equal(readPath, 'fixture.txt');
  assert.ok(events.some((event) => event.type === 'workspace.opened'));
  assert.deepEqual(
    events.find((event) => event.type === 'workspace.listResult')?.entries,
    [{ name: 'src', path: 'src', kind: 'directory' }],
  );
  assert.equal(
    events.find((event) => event.type === 'workspace.inspected')?.document.status,
    'complete',
  );
  assert.ok(events.some((event) => event.type === 'turn.toolCall'));
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
  assert.ok(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'commentary' &&
        event.text === '正在读取 fixture.txt。',
    ),
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' && event.text.trim().length === 0,
    ),
    false,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'turn.textDelta' && event.delta === 'Tool loop complete',
    ),
  );
  assert.ok(persistedKinds.includes('turn.toolCall'));
  assert.ok(persistedKinds.includes('turn.toolResult'));
  assert.equal(persistedKinds.includes('turn.textStarted'), false);
  assert.equal(persistedKinds.includes('turn.textDelta'), false);
  assert.equal(
    persistedKinds.filter((kind) => kind === 'turn.textCompleted').length,
    2,
  );
});

test('RuntimeHost restores a pending approval without replay and executes only after approval', async () => {
  const argumentsJson = JSON.stringify({
    patch: '*** Begin Patch\n*** Add File: recovered.txt\n+fixture\n*** End Patch',
  });
  const requestHash = createHash('sha256').update(argumentsJson).digest('hex');
  const events: RuntimeEvent[] = [];
  const persistedKinds: string[] = [];
  let applyCount = 0;
  let approvalStatus = 'pending';
  let operationStatus = 'proposed';
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => JSON.stringify([{
      approvalId: 'approval-recovered',
      operationId: 'operation-recovered',
      turnId: 'turn-recovered',
      requestId: 'request-recovered',
      threadId: 'thread-recovered',
      workspaceId: 'workspace-recovered',
      toolName: 'workspace_apply_patch',
      requestHash,
      argumentsJson,
      approval: {
        kind: 'command',
        argumentsSummary: `workspace_apply_patch (${Buffer.byteLength(argumentsJson, 'utf8')} bytes)`,
        fullAccess: false,
      },
    }]),
    appendItem: (_itemId: string, _turnId: string, _sequence: number, kind: string) => {
      persistedKinds.push(kind);
      return true;
    },
    resolveApproval: (_approvalId: string, decision: string) => {
      approvalStatus = decision;
      operationStatus = decision === 'approved' ? 'executing' : 'denied';
      return true;
    },
    completeOperation: (_operationId: string, _result: string, succeeded: boolean) => {
      assert.equal(operationStatus, 'executing');
      operationStatus = succeeded ? 'completed' : 'failed';
      return true;
    },
    workspaceApplyPatch: async () => {
      applyCount += 1;
      return JSON.stringify({ ok: true, files: [{ path: 'recovered.txt' }] });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'operation.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 2,
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  const approval = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'approval.requested' }> =>
      event.type === 'approval.requested',
  );
  assert.ok(approval);
  assert.equal(approval.recovered, true);
  assert.equal(applyCount, 0);
  assert.equal(approvalStatus, 'pending');
  assert.ok(!persistedKinds.includes('approval.requested'));

  host.handle({
    type: 'approval.resolve',
    requestId: 'request-recovered-decision',
    workspaceId: approval.workspaceId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    approvalId: approval.approvalId,
    decision: 'approved',
    source: 'user',
  });
  await completed;
  assert.equal(approvalStatus, 'approved');
  assert.equal(operationStatus, 'completed');
  assert.equal(applyCount, 1);
  assert.ok(persistedKinds.includes('approval.resolved'));
  assert.ok(persistedKinds.includes('operation.completed'));
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
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async () => '{}',
    drainCommandOutputJson: () => '[]',
    finishCommandOutput: () => undefined,
    createTerminalJson: () => '{}',
    terminalInput: () => undefined,
    terminalResize: () => undefined,
    terminalTerminate: () => undefined,
    drainTerminalEventsJson: () => '[]',
    closeTerminal: () => false,
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
    createAgentTasksJson: () => '{"inserted":0}',
    updateAgentTask: () => true,
    proposeOperation: () => {
      proposalCount += 1;
      return true;
    },
    resolveApproval: () => true,
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceInspectJson: () => '{}',
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
    protocolVersion: 2,
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
    source: 'user',
  });
  await completed;
  assert.equal(applyCount, 1);
  assert.ok(events.some((event) => event.type === 'approval.resolved'));
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
});

test('RuntimeHost approves and persists command execution before native dispatch', async () => {
  const events: RuntimeEvent[] = [];
  let claimCount = 0;
  let executeCount = 0;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    executeCommandJson: async (_operationId, _workspaceId, mode, command) => {
      executeCount += 1;
      assert.equal(mode, 'sandboxed');
      assert.equal(command, '/bin/pwd');
      return JSON.stringify({ status: 'completed', mode, output: { stdout: '/fixture' } });
    },
    drainCommandOutputJson: () => '[]',
    finishCommandOutput: () => undefined,
    createTerminalJson: () => '{}',
    terminalInput: () => undefined,
    terminalResize: () => undefined,
    terminalTerminate: () => undefined,
    drainTerminalEventsJson: () => '[]',
    closeTerminal: () => false,
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
    createAgentTasksJson: () => '{"inserted":0}',
    updateAgentTask: () => true,
    proposeOperation: () => true,
    resolveApproval: (_approvalId, decision) => {
      if (decision === 'approved') {
        claimCount += 1;
      }
      return true;
    },
    completeOperation: () => true,
    loadThreadJson: () => emptyThreadSnapshot(),
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceInspectJson: () => '{}',
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
    protocolVersion: 2,
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
  assert.equal(claimCount, 0);
  assert.equal(executeCount, 0);
  host.handle({
    type: 'approval.resolve',
    requestId: 'request-approval',
    workspaceId: approval.workspaceId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    approvalId: approval.approvalId,
    decision: 'approved',
    source: 'user',
  });
  await completed;
  assert.equal(claimCount, 1);
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
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    importAssetJson: () => JSON.stringify(asset),
    readAssetJson: () => JSON.stringify({ asset, data: 'Zml4dHVyZQ==' }),
    executeCommandJson: async () => '{}',
    drainCommandOutputJson: () => '[]',
    finishCommandOutput: () => undefined,
    createTerminalJson: () => '{}',
    terminalInput: () => undefined,
    terminalResize: () => undefined,
    terminalTerminate: () => undefined,
    drainTerminalEventsJson: () => '[]',
    closeTerminal: () => false,
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
    createAgentTasksJson: () => '{"inserted":0}',
    updateAgentTask: () => true,
    proposeOperation: () => true,
    resolveApproval: () => true,
    completeOperation: () => true,
    loadThreadJson: () => snapshot,
    workspaceRead: async () => '{}',
    workspaceList: async () => '{}',
    workspaceInspectJson: () => '{}',
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
    protocolVersion: 2,
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
