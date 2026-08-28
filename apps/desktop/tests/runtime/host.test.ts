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

import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../../src/shared/model-metadata.ts';
import {
  isFutureActionOnlyFinal,
  planSubmissionIssue,
  RuntimeHost,
} from '../../src/runtime/host.ts';
import { userInputBoundaryCommentary } from '../../src/shared/conversation/user-input-boundary.ts';
import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';
import { modelItemMetadata } from '../../src/runtime/models/step-outcome.ts';
import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from '../../src/runtime/models/types.ts';
import { VideoAnalyzer } from '../../src/runtime/video-analysis.ts';
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

const turnNativeFixture = (options: Readonly<{
  appendItem?: NativeRuntimeBinding['appendItem'];
  finishTurn?: NativeRuntimeBinding['finishTurn'];
  replaceLatestTurnWithUserMessage?: NonNullable<
    NativeRuntimeBinding['replaceLatestTurnWithUserMessage']
  >;
  updateThreadTitleJson?: NativeRuntimeBinding['updateThreadTitleJson'];
}> = {}): NativeRuntimeBinding => ({
  inspectMcpConfigJson: () => JSON.stringify({
    contractVersion: 1,
    revision: '0'.repeat(64),
    servers: [],
  }),
  skillsContextJson: () => '{"skills":[]}',
  listPendingApprovalsJson: () => '[]',
  ensureThread: (): void => undefined,
  loadThreadJson: (threadId: string): string => emptyThreadSnapshot(threadId),
  updateThreadTitleJson:
    options.updateThreadTitleJson ??
    ((threadId: string) => emptyThreadSnapshot(threadId)),
  startTurn: (): void => undefined,
  replaceLatestTurnWithUserMessage:
    options.replaceLatestTurnWithUserMessage ?? (() => undefined),
  appendItem: options.appendItem ?? (() => true),
  finishTurn: options.finishTurn ?? (() => true),
} as unknown as NativeRuntimeBinding);

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

class ImageRoutingFixtureLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    if (this.model === 'vision-model') {
      yield {
        content: {
          role: 'model',
          parts: [{ text: 'The image shows a login form.' }],
        },
        partial: false,
        turnComplete: true,
        finishReason: FinishReason.STOP,
      };
      return;
    }
    const hasAnalysis = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'analyze_image',
      ),
    );
    if (!hasAnalysis) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-analyze-image',
              name: 'analyze_image',
              args: {
                assetId: `ast_${'a'.repeat(64)}`,
                question: 'What interface is visible?',
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: 'The screenshot is a login form.' }] },
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

class VideoRoutingFixtureLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    if (this.model === 'video-model') {
      yield {
        content: {
          role: 'model',
          parts: [{ text: 'The video demonstrates a login workflow.' }],
        },
        partial: false,
        turnComplete: true,
        finishReason: FinishReason.STOP,
      };
      return;
    }
    const hasAnalysis = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'analyze_video',
      ),
    );
    if (!hasAnalysis) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-analyze-video',
              name: 'analyze_video',
              args: {
                assetId: `ast_${'c'.repeat(64)}`,
                question: 'What workflow is shown?',
                fps: 1,
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
        parts: [{ text: 'The clip shows a login workflow.' }],
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

class UserInputLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const hasUserInputResult = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'request_user_input',
      ),
    );
    if (!hasUserInputResult) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-user-input',
              name: 'request_user_input',
              args: {
                questions: [{
                  id: 'scope',
                  header: '实现范围',
                  question: '本次需要覆盖到哪一层？',
                  options: [
                    {
                      label: '完整链路（推荐）',
                      description: '包含 Agent、协议和界面。',
                    },
                    {
                      label: '仅界面',
                      description: '只处理显示和交互。',
                    },
                  ],
                }],
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: { role: 'model', parts: [{ text: '已按完整链路继续。' }] },
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

class SplitPlanAfterUserInputLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const hasUserInputResult = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'request_user_input',
      ),
    );
    if (!hasUserInputResult) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              text:
                '## 一、现状\n\n已完成分析。\n\n' +
                '## 八、待确认事项\n\n以下决策会影响计划。',
              partMetadata: modelItemMetadata('pre-question-plan', {
                phase: 'provisional',
                outcome: { kind: 'toolCalls' },
              }),
            },
            {
              functionCall: {
                id: 'call-split-plan-input',
                name: 'request_user_input',
                args: {
                  questions: [{
                    id: 'cache_strategy',
                    header: '缓存策略',
                    question: '号码识别结果缓存多久？',
                    options: [
                      { label: '30 天（推荐）', description: '平衡成本和时效。' },
                      { label: '7 天', description: '提高数据时效。' },
                    ],
                  }],
                },
              },
            },
          ],
        },
        partial: false,
      };
      return;
    }
    if (this.requests.length === 3) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-submit-complete-plan',
              name: 'submit_plan',
              args: {
                content:
                  '# 完整计划\n\n## 一、现状\n\n已完成分析。\n\n## 二、实施\n\n缓存时间为 30 天。',
              },
            },
          }],
        },
        partial: false,
      };
      return;
    }
    const ignoredRecovery = this.requests.length === 2;
    const text = ignoredRecovery
      ? '感谢确认。\n\n## 九、最终确认\n\n缓存时间为 30 天。'
      : '正式计划已提交。';
    yield {
      content: {
        role: 'model',
        parts: [{
          text,
          partMetadata: modelItemMetadata(
            ignoredRecovery ? 'continued-plan' : 'plan-submitted',
            { phase: 'final', outcome: { kind: 'final' } },
          ),
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

class MultiRoundUserInputLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const results = request.contents.flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionResponse?.name === 'request_user_input');
    if (results.length < 2) {
      const second = results.length === 1;
      yield {
        content: {
          role: 'model',
          parts: [
            {
              text: second
                ? '# 发布计划\n\n## 一、发布策略\n\n先完成全部实现。'
                : '第一阶段分析完成，需要先确认实现范围。',
              partMetadata: modelItemMetadata(
                second ? 'pre-rollout-draft' : 'pre-scope-summary',
                { phase: 'provisional', outcome: { kind: 'toolCalls' } },
              ),
            },
            {
              functionCall: {
                id: second ? 'call-user-input-rollout' : 'call-user-input-scope',
                name: 'request_user_input',
                args: {
                  questions: [{
                    id: second ? 'rollout' : 'scope',
                    header: second ? '发布方式' : '实现范围',
                    question: second
                      ? '需要如何发布？'
                      : '本次需要覆盖到哪一层？',
                    options: [
                      {
                        label: second ? '分阶段（推荐）' : '完整链路（推荐）',
                        description: '采用推荐方案。',
                      },
                      {
                        label: second ? '一次发布' : '仅界面',
                        description: '采用备选方案。',
                      },
                    ],
                  }],
                },
              },
            },
          ],
        },
        partial: false,
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{
          text: '两轮决策均已处理。',
          partMetadata: modelItemMetadata('multi-round-final', {
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

class PartialCancellationUserInputLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const hasResult = request.contents.some((content) =>
      (content.parts ?? []).some(
        (part) => part.functionResponse?.name === 'request_user_input',
      ),
    );
    if (!hasResult) {
      yield {
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call-user-input-cancel',
              name: 'request_user_input',
              args: {
                questions: [
                  {
                    id: 'scope',
                    header: '实现范围',
                    question: '本次需要覆盖到哪一层？',
                    options: [
                      { label: '完整链路（推荐）', description: '覆盖全部层。' },
                      { label: '仅界面', description: '只处理界面。' },
                    ],
                  },
                  {
                    id: 'rollout',
                    header: '发布方式',
                    question: '需要如何发布？',
                    options: [
                      { label: '分阶段（推荐）', description: '逐步发布。' },
                      { label: '一次发布', description: '立即发布。' },
                    ],
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
    yield {
      content: { role: 'model', parts: [{ text: '已使用部分回答继续。' }] },
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

class PersistentUnavailableInstructionsLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const failures = request.contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionResponse?.name === 'workspace_apply_patch')
      .length;
    yield {
      content: {
        role: 'model',
        parts: [{
          functionCall: {
            id: `call-unavailable-instructions-${failures}`,
            name: 'workspace_apply_patch',
            args: {
              patch:
                '*** Begin Patch\n*** Update File: src/value.ts\n@@\n-old\n+new\n*** End Patch',
            },
          },
        }],
      },
      partial: false,
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
  private readonly childTools?: Map<string, readonly string[]>;

  constructor(
    options: ConstructorParameters<typeof BaseLlm>[0],
    childTools?: Map<string, readonly string[]>,
  ) {
    super(options);
    this.childTools = childTools;
  }

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
      this.childTools?.set(
        taskText.includes('Audit') ? 'auditor' : 'worker',
        Object.keys(request.toolsDict),
      );
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
                    dependsOn: [],
                    taskMarkdown: 'Implement the fixture.',
                  },
                  {
                    clientTaskKey: 'audit',
                    title: 'Audit fixture',
                    role: 'auditor',
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

class FutureActionFinalLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const text = this.requests.length === 1
      ? '好的，现在我开始生成完整的演示文稿。'
      : '处理完成：没有需要修改的文件。';
    yield {
      content: {
        role: 'model',
        parts: [{
          text,
          partMetadata: modelItemMetadata(
            `future-final-${this.requests.length}`,
            { phase: 'final', outcome: { kind: 'final' } },
          ),
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

class StickyWriteFailureLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  requestCount = 0;

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    void _request;
    this.requestCount += 1;
    const parts = this.requestCount === 1
      ? [{
        functionCall: {
          id: 'call-malformed-write',
          name: INVALID_TOOL_ARGUMENTS_TOOL_NAME,
          args: {
            toolName: 'workspace_apply_patch',
            argumentsText: '{"patch":"*** Begin Patch',
          },
        },
      }]
      : this.requestCount === 2
        ? [{
          functionCall: {
            id: 'call-read-after-failed-write',
            name: 'workspace_read',
            args: { path: 'fixture.txt' },
          },
        }]
        : this.requestCount === 3
          ? [{ text: '项目检查结束。' }]
          : [{ text: '无法继续：写入参数无效，文件仍未修改。' }];
    yield {
      content: { role: 'model', parts },
      partial: false,
      turnComplete: this.requestCount >= 3,
      finishReason: this.requestCount >= 3 ? FinishReason.STOP : undefined,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

class InspectionFallbackLlm extends BaseLlm {
  static readonly supportedModels = [/^fixture/u];
  readonly requests: LlmRequest[] = [];

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const parts = this.requests.length === 1
      ? [{
        functionCall: {
          id: 'call-find-without-root',
          name: 'shell_exec',
          args: {
            mode: 'sandboxed',
            command: '/usr/bin/find',
            arguments: ['-name', 'AGENTS.md'],
          },
        },
      }]
      : this.requests.length === 2
        ? [{
          functionCall: {
            id: 'call-workspace-list-fallback',
            name: 'workspace_list',
            args: { path: '.' },
          },
        }]
        : this.requests.length === 3
          ? [{
            functionCall: {
              id: 'call-submit-plan-after-fallback',
              name: 'submit_plan',
              args: {
                content: '# 完整计划\n\n## 一、实施范围\n\n按已确认需求执行。',
              },
            },
          }]
          : [{
            text: '正式计划已提交。',
            partMetadata: modelItemMetadata('plan-submitted-after-fallback', {
              phase: 'final',
              outcome: { kind: 'final' },
            }),
          }];
    yield {
      content: { role: 'model', parts },
      partial: false,
      turnComplete: this.requests.length >= 4,
      finishReason: this.requests.length >= 4 ? FinishReason.STOP : undefined,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

test('future-action-only final detection distinguishes promises from outcomes', () => {
  assert.equal(DEFAULT_MODEL_REQUEST_TIMEOUT_MS, 600_000);
  assert.equal(
    isFutureActionOnlyFinal('好的，现在我开始生成完整的演示文稿。'),
    true,
  );
  assert.equal(isFutureActionOnlyFinal('Let me now update the file.'), true);
  assert.equal(isFutureActionOnlyFinal('文件已经更新并验证完成。'), false);
  assert.equal(isFutureActionOnlyFinal('无法继续：缺少写入权限。'), false);
});

test('user-input boundary keeps brief progress and collapses pre-question deliverables', () => {
  assert.equal(
    userInputBoundaryCommentary(
      '现状已经厘清，还有一个架构决策需要确认。',
      '/plan 设计号码识别 API',
      ['缓存命中时是否收费？'],
    ),
    '现状已经厘清，还有一个架构决策需要确认。',
  );
  assert.equal(
    userInputBoundaryCommentary(
      '# 完整计划\n\n## 一、现状\n\n已经分析完成。\n\n## 二、实施方案',
      '/plan 设计号码识别 API',
      ['缓存命中时是否收费？'],
    ),
    '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
  );
  assert.equal(
    userInputBoundaryCommentary(
      '# 计划\n\n1. 确认：缓存命中时是否收费？',
      '/plan 设计号码识别 API',
      ['缓存命中时是否收费？'],
    ),
    '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
  );
  assert.equal(
    userInputBoundaryCommentary(
      '缓存命中时是否收费？',
      '/plan 设计号码识别 API',
      ['缓存命中时是否收费？'],
    ),
    '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
  );
});

test('formal plan validation rejects approval prompts and accepts plan-only content', () => {
  assert.equal(
    planSubmissionIssue('# 计划\n\n完成实现与验证。'),
    undefined,
  );
  assert.match(
    planSubmissionIssue('# 计划\n\n需要我开始实现吗？') ?? '',
    /question|approval|invitation/u,
  );
  assert.match(
    planSubmissionIssue('# Plan\n\nShould I proceed?') ?? '',
    /question|approval|invitation/u,
  );
});

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
    protocolVersion: 7,
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

test('RuntimeHost delegates image understanding to the configured analysis model', async () => {
  const asset = {
    assetId: `ast_${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    mediaType: 'image/png',
    originalName: 'login.png',
    sizeBytes: 12,
    kind: 'image' as const,
  };
  const models: ImageRoutingFixtureLlm[] = [];
  const native = {
    ...turnNativeFixture(),
    inspectModelConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      credentialStatuses: [{ connectionId: 'vision-connection', status: 'present' }],
      config: {
        defaultProfileId: 'default-model',
        mediaRouting: { imageProfileId: 'vision-profile' },
        connections: [{
          id: 'vision-connection',
          providerFamily: 'openai',
          displayName: 'Vision connection',
          baseUrl: 'http://127.0.0.1:1/v1',
          enabled: true,
          wireApi: 'openaiResponses',
          continuationMode: 'localReplay',
        }],
        profiles: [
          {
            id: 'default-model',
            connectionId: 'vision-connection',
            displayName: 'Default model',
            modelId: 'default-model',
            toolCalls: 'auto',
            strictTools: 'auto',
            parallelTools: 'auto',
            imageInput: 'disabled',
            pdfInput: 'auto',
          },
          {
            id: 'vision-profile',
            connectionId: 'vision-connection',
            displayName: 'Vision model',
            modelId: 'vision-model',
            toolCalls: 'auto',
            strictTools: 'auto',
            parallelTools: 'auto',
            imageInput: 'enabled',
            pdfInput: 'auto',
          },
        ],
      },
    }),
    modelProfileJson: (profileId?: string) => JSON.stringify({
      profile: {
        id: profileId,
        connectionId: 'vision-connection',
        displayName: 'Vision model',
        modelId: 'vision-model',
        toolCalls: 'auto',
        strictTools: 'auto',
        parallelTools: 'auto',
        imageInput: 'enabled',
        pdfInput: 'auto',
      },
      connection: {
        id: 'vision-connection',
        providerFamily: 'openai',
        displayName: 'Vision connection',
        baseUrl: 'http://127.0.0.1:1/v1',
        enabled: true,
        wireApi: 'openaiResponses',
        continuationMode: 'localReplay',
      },
      apiKey: 'fixture-key',
    }),
    readAssetJson: () => JSON.stringify({ asset, data: 'cG5n' }),
  } as NativeRuntimeBinding;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: (provider) => {
      const model = new ImageRoutingFixtureLlm({ model: provider.model });
      models.push(model);
      return model;
    },
    loadNative: () => native,
    postEvent: (event) => {
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-image-initialize',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-image-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-image-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-image-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'main-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'asset', asset },
    ],
  });
  await completed;

  const mainRequests = models
    .filter((model) => model.model === 'main-model')
    .flatMap((model) => model.requests);
  const visionRequests = models
    .filter((model) => model.model === 'vision-model')
    .flatMap((model) => model.requests);
  assert.ok(Object.hasOwn(mainRequests[0]?.toolsDict ?? {}, 'analyze_image'));
  assert.match(JSON.stringify(mainRequests[0]?.contents), /Image attachment/u);
  assert.doesNotMatch(JSON.stringify(mainRequests[0]?.contents), /inlineData/u);
  assert.equal(visionRequests[0]?.contents[0]?.parts?.[1]?.inlineData?.data, 'cG5n');
  assert.match(JSON.stringify(mainRequests.at(-1)?.contents), /login form/u);
});

test('RuntimeHost delegates video understanding without changing the configured provider protocol', async () => {
  const asset = {
    assetId: `ast_${'c'.repeat(64)}`,
    sha256: 'c'.repeat(64),
    mediaType: 'video/mp4',
    originalName: 'login-flow.mp4',
    sizeBytes: 1_024,
    kind: 'video' as const,
  };
  const models: VideoRoutingFixtureLlm[] = [];
  const createdProviders: Array<{ model: string; wireApi: string }> = [];
  const videoEvents: RuntimeEvent[] = [];
  const native = {
    ...turnNativeFixture(),
    inspectModelConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      credentialStatuses: [{ connectionId: 'video-connection', status: 'present' }],
      config: {
        defaultProfileId: 'default-model',
        mediaRouting: { videoProfileId: 'video-profile' },
        connections: [{
          id: 'video-connection',
          providerFamily: 'anthropic',
          displayName: 'Video connection',
          baseUrl: 'http://127.0.0.1:1',
          enabled: true,
          wireApi: 'anthropicMessages',
          continuationMode: 'localReplay',
        }],
        profiles: [
          {
            id: 'default-model',
            connectionId: 'video-connection',
            displayName: 'Default model',
            modelId: 'default-model',
            toolCalls: 'auto',
            strictTools: 'auto',
            parallelTools: 'auto',
            imageInput: 'auto',
            pdfInput: 'auto',
          },
          {
            id: 'video-profile',
            connectionId: 'video-connection',
            displayName: 'Video model',
            modelId: 'video-model',
            toolCalls: 'auto',
            strictTools: 'auto',
            parallelTools: 'auto',
            imageInput: 'auto',
            pdfInput: 'auto',
          },
        ],
      },
    }),
    modelProfileJson: (profileId?: string) => JSON.stringify({
      profile: {
        id: profileId,
        connectionId: 'video-connection',
        displayName: 'Video model',
        modelId: 'video-model',
        toolCalls: 'auto',
        strictTools: 'auto',
        parallelTools: 'auto',
        imageInput: 'auto',
        pdfInput: 'auto',
      },
      connection: {
        id: 'video-connection',
        providerFamily: 'anthropic',
        displayName: 'Video connection',
        baseUrl: 'http://127.0.0.1:1',
        enabled: true,
        wireApi: 'anthropicMessages',
        continuationMode: 'localReplay',
      },
      apiKey: 'fixture-key',
    }),
    readVideoAssetPathJson: () => JSON.stringify({
      asset,
      path: '/fixture/login-flow.mp4',
    }),
  } as NativeRuntimeBinding;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: (provider) => {
      createdProviders.push({ model: provider.model, wireApi: provider.wireApi });
      const model = new VideoRoutingFixtureLlm({ model: provider.model });
      models.push(model);
      return model;
    },
    videoAnalyzer: new VideoAnalyzer({
      extractFrames: async () => ({
        durationSeconds: 2,
        effectiveFps: 1,
        frames: [{ data: 'anBlZw==', timestampSeconds: 0 }],
      }),
      extractAudio: async () => ({
        durationSeconds: 2,
        chunks: [],
      }),
    }),
    loadNative: () => native,
    postEvent: (event) => {
      videoEvents.push(event);
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-video-initialize',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-video-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-video-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-video-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'main-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [
      { type: 'text', text: 'Describe this video.' },
      { type: 'asset', asset },
    ],
  });
  await completed;

  const mainRequests = models
    .filter((model) => model.model === 'main-model')
    .flatMap((model) => model.requests);
  const videoRequests = models
    .filter((model) => model.model === 'video-model')
    .flatMap((model) => model.requests);
  const videoToolRequest = mainRequests.find((request) =>
    Object.hasOwn(request.toolsDict ?? {}, 'analyze_video'),
  );
  assert.ok(videoToolRequest, JSON.stringify(
    {
      providers: createdProviders,
      events: videoEvents,
      requests: mainRequests.map((request) => ({
        tools: Object.keys(request.toolsDict ?? {}),
        contents: request.contents,
      })),
    },
  ));
  assert.match(JSON.stringify(videoToolRequest.contents), /Video attachment/u);
  assert.doesNotMatch(JSON.stringify(videoToolRequest.contents), /inlineData/u);
  assert.equal(videoRequests[0]?.contents[0]?.parts?.[1]?.inlineData?.data, 'anBlZw==');
  assert.equal(videoRequests[0]?.contents[0]?.parts?.[1]?.inlineData?.mimeType, 'image/jpeg');
  assert.ok(createdProviders.some(
    (provider) =>
      provider.model === 'video-model' && provider.wireApi === 'anthropicMessages',
  ));
  assert.ok(videoEvents.some(
    (event) =>
      event.type === 'turn.textCompleted' &&
      event.phase === 'commentary' &&
      event.text.includes('extracted frames because native video was unavailable'),
  ));
  assert.match(JSON.stringify(mainRequests.at(-1)?.contents), /login workflow/u);
});

test('RuntimeHost makes /plan immutable read-only at the tool boundary', async () => {
  const model = new CaptureLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    loadNative: () => turnNativeFixture(),
    postEvent: (event) => {
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-plan-initialize',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-plan-boundary-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-plan-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-plan-fixture',
    turnId: 'turn-plan-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: true,
    },
    content: [{ type: 'text', text: '/plan\n\n设计号码识别 API' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for plan Turn.')), 2_000),
    ),
  ]);

  const toolNames = Object.keys(model.requests[0]?.toolsDict ?? {});
  assert.ok(toolNames.includes('request_user_input'));
  assert.ok(toolNames.includes('submit_plan'));
  assert.ok(toolNames.includes('workspace_read'));
  assert.ok(toolNames.includes('workspace_list'));
  assert.ok(toolNames.includes('workspace_search'));
  assert.equal(toolNames.includes('workspace_apply_patch'), false);
  assert.equal(toolNames.includes('shell_exec'), false);
  assert.equal(toolNames.includes('collaboration_dispatch'), false);
});

test('RuntimeHost durably seeds a revised user message without appending it twice', async () => {
  const events: RuntimeEvent[] = [];
  const appendedKinds: string[] = [];
  let durableUserContent = '';
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = turnNativeFixture({
    replaceLatestTurnWithUserMessage: (
      _replacedTurnId,
      _turnId,
      _threadId,
      _requestId,
      _providerWireApi,
      _model,
      userContentJson,
    ) => {
      durableUserContent = userContentJson;
    },
    appendItem: (_itemId, _turnId, _sequence, kind) => {
      appendedKinds.push(kind);
      return true;
    },
  });
  const host = new RuntimeHost({
    createModel: () => new FixtureLlm({ model: 'fixture-model' }),
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
    requestId: 'request-revise-initialize',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-revise-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.revise',
    requestId: 'request-revise',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-revised',
    replacedTurnId: 'turn-original',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Revised request' }],
  });

  await completed;
  assert.equal(
    durableUserContent,
    JSON.stringify([{ type: 'text', text: 'Revised request' }]),
  );
  assert.ok(events.some((event) => event.type === 'turn.revised'));
  assert.ok(events.some((event) => event.type === 'turn.userMessage'));
  assert.equal(appendedKinds.includes('turn.revised'), false);
  assert.equal(appendedKinds.includes('turn.userMessage'), false);
  assert.equal(appendedKinds.includes('turn.started'), true);
});

test('RuntimeHost retries a future-action-only final and uses the global output budget', async () => {
  const events: RuntimeEvent[] = [];
  const model = new FutureActionFinalLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    loadNative: () => turnNativeFixture(),
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-future-final',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-future-final-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-future-final',
    workspaceId: 'workspace-future-final',
    threadId: 'thread-future-final',
    turnId: 'turn-future-final',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '完成任务。' }],
  });

  await completed;

  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0]?.config?.maxOutputTokens, 32_768);
  assert.equal(
    model.requests[1]?.contents.some((content) =>
      content.parts?.some((part) =>
        part.text?.includes('Internal continuation after premature final')
      )
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === '好的，现在我开始生成完整的演示文稿。',
    ),
    false,
  );
  assert.equal(
    events.find((event) => event.type === 'turn.completed')?.status,
    'completed',
  );
});

test('RuntimeHost keeps a failed write unresolved across a successful read', async () => {
  const events: RuntimeEvent[] = [];
  const model = new StickyWriteFailureLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = {
    ...turnNativeFixture(),
    workspaceRead: async () => JSON.stringify({ ok: true, content: 'fixture' }),
  } as unknown as NativeRuntimeBinding;
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
    requestId: 'request-initialize-sticky-write',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-sticky-write-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-sticky-write',
    workspaceId: 'workspace-sticky-write',
    threadId: 'thread-sticky-write',
    turnId: 'turn-sticky-write',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '更新文件。' }],
  });

  await completed;

  assert.equal(model.requestCount, 4);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.phase === 'final' &&
        event.text === '项目检查结束。',
    ),
    false,
  );
  assert.equal(
    events.find((event) => event.type === 'turn.completed')?.status,
    'completed',
  );
});

test('RuntimeHost accepts a complete plan after workspace tools recover a failed read-only shell inspection', async () => {
  const events: RuntimeEvent[] = [];
  const model = new InspectionFallbackLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = {
    ...turnNativeFixture(),
    workspaceList: async () => JSON.stringify({
      ok: true,
      entries: [{ kind: 'file', name: 'README.md' }],
    }),
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => model,
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') resolveCompleted?.();
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-inspection-fallback',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v4-inspection-fallback-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-inspection-fallback',
    workspaceId: 'workspace-inspection-fallback',
    threadId: 'thread-inspection-fallback',
    turnId: 'turn-inspection-fallback',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '/plan 制定实施计划' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  assert.equal(model.requests.length, 3);
  assert.equal(
    model.requests.some((request) =>
      request.contents.some((content) =>
        content.parts?.some((part) =>
          part.text?.includes('Internal continuation after tool failure')
        )
      )
    ),
    false,
  );
  assert.ok(events.some(
    (event) =>
      event.type === 'turn.planProposed' &&
      event.content.startsWith('# 完整计划'),
  ));
});

test('RuntimeHost pauses for structured user input and resumes the same Turn', async () => {
  const events: RuntimeEvent[] = [];
  const model = new UserInputLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.userInputRequested') {
        host.handle({
          type: 'turn.userInputResponse',
          requestId: 'request-answer',
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          turnId: event.turnId,
          inputRequestId: event.inputRequestId,
          submission: {
            kind: 'submitted',
            decisions: [{
              questionId: 'scope',
              kind: 'answered',
              source: 'option',
              answer: '完整链路（推荐）',
            }],
          },
        });
      }
      if (event.type === 'turn.completed') {
        resolveCompleted?.();
      }
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-input',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-user-input-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-input',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-user-input-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '实现这个需求' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  assert.ok(events.some((event) => event.type === 'turn.userInputRequested'));
  assert.ok(events.some((event) => event.type === 'turn.userInputResolved'));
  assert.equal(
    JSON.stringify(model.requests[1]?.contents).includes('完整链路（推荐）'),
    true,
  );
  assert.equal(
    events.findLast((event) => event.type === 'turn.completed')?.status,
    'completed',
  );
});

test('RuntimeHost replaces a post-question plan continuation with a complete final answer', async () => {
  const events: RuntimeEvent[] = [];
  const model = new SplitPlanAfterUserInputLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.userInputRequested') {
        host.handle({
          type: 'turn.userInputResponse',
          requestId: 'request-answer-split-plan',
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          turnId: event.turnId,
          inputRequestId: event.inputRequestId,
          submission: {
            kind: 'submitted',
            decisions: [{
              questionId: 'cache_strategy',
              kind: 'answered',
              source: 'option',
              answer: '30 天（推荐）',
            }],
          },
        });
      }
      if (event.type === 'turn.completed') resolveCompleted?.();
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-split-plan',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v4-split-plan-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-split-plan',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-split-plan-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '/plan 设计号码识别 API' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  assert.equal(model.requests.length, 3);
  for (const request of model.requests) {
    const toolNames = Object.keys(request.toolsDict);
    assert.equal(toolNames.includes('workspace_apply_patch'), false);
    assert.equal(toolNames.includes('shell_exec'), false);
    assert.equal(toolNames.includes('collaboration_dispatch'), false);
  }
  assert.match(
    JSON.stringify(model.requests[1]?.contents),
    /Internal post-question response boundary/u,
  );
  assert.match(
    JSON.stringify(model.requests[2]?.contents),
    /Internal continuation after incomplete post-question final/u,
  );
  const preQuestionCommentary = events.find(
    (event) =>
      event.type === 'turn.textCompleted' &&
      event.phase === 'commentary' &&
      event.itemId === 'pre-question-plan',
  );
  assert.equal(preQuestionCommentary?.type, 'turn.textCompleted');
  assert.equal(
    preQuestionCommentary?.type === 'turn.textCompleted'
      ? preQuestionCommentary.text
      : undefined,
    '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' &&
        event.text.includes('## 八、待确认事项'),
    ),
    false,
  );
  assert.equal(events.some(
    (event) =>
      event.type === 'turn.textCompleted' &&
      event.phase === 'final' &&
      event.itemId === 'continued-plan',
  ), false);
  assert.ok(events.some(
    (event) =>
      event.type === 'turn.planProposed' &&
      event.content.startsWith('# 完整计划'),
  ));
  assert.equal(
    events.some(
      (event) =>
        event.type === 'turn.textCompleted' && event.phase === 'final',
    ),
    false,
  );
});

test('RuntimeHost supports two sequential user-input requests in one Turn', async () => {
  const events: RuntimeEvent[] = [];
  const model = new MultiRoundUserInputLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.userInputRequested') {
        const questionId = event.questions[0]?.id;
        if (!questionId) return;
        host.handle({
          type: 'turn.userInputResponse',
          requestId: `request-answer-${questionId}`,
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          turnId: event.turnId,
          inputRequestId: event.inputRequestId,
          submission: {
            kind: 'submitted',
            decisions: questionId === 'scope'
              ? [{
                  questionId,
                  kind: 'answered',
                  source: 'option',
                  answer: '完整链路（推荐）',
                }]
              : [{ questionId, kind: 'skipped' }],
          },
        });
      }
      if (event.type === 'turn.completed') resolveCompleted?.();
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-multi-input',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v4-multi-input-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-multi-input',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-multi-input-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '实现并确认发布方式' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  const requested = events.filter(
    (event) => event.type === 'turn.userInputRequested',
  );
  const resolved = events.filter(
    (event) => event.type === 'turn.userInputResolved',
  );
  assert.equal(requested.length, 2);
  assert.equal(new Set(requested.map((event) => event.inputRequestId)).size, 2);
  assert.deepEqual(
    resolved.map((event) => event.submission),
    [
      {
        kind: 'submitted',
        decisions: [{
          questionId: 'scope',
          kind: 'answered',
          source: 'option',
          answer: '完整链路（推荐）',
        }],
      },
      {
        kind: 'submitted',
        decisions: [{ questionId: 'rollout', kind: 'skipped' }],
      },
    ],
  );
  assert.equal(model.requests.length, 3);
  assert.ok(events.some(
    (event) =>
      event.type === 'turn.textCompleted' &&
      event.itemId === 'pre-scope-summary' &&
      event.text === '第一阶段分析完成，需要先确认实现范围。',
  ));
  assert.ok(events.some(
    (event) =>
      event.type === 'turn.textCompleted' &&
      event.itemId === 'pre-rollout-draft' &&
      event.text === '已完成当前阶段的分析，发现 1 个需要确认的决策点。',
  ));
  assert.equal(
    events.filter(
      (event) =>
        event.type === 'turn.textCompleted' && event.phase === 'final',
    ).length,
    1,
  );
});

test('RuntimeHost returns partial decisions when the user cancels a request', async () => {
  const events: RuntimeEvent[] = [];
  const model = new PartialCancellationUserInputLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.userInputRequested') {
        host.handle({
          type: 'turn.userInputResponse',
          requestId: 'request-cancel-input',
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          turnId: event.turnId,
          inputRequestId: event.inputRequestId,
          submission: {
            kind: 'cancelled',
            decisions: [{
              questionId: 'scope',
              kind: 'answered',
              source: 'option',
              answer: '完整链路（推荐）',
            }],
          },
        });
      }
      if (event.type === 'turn.completed') resolveCompleted?.();
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-cancel-input',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v4-cancel-input-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-cancel-input',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-cancel-input-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '实现需求' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Turn.')), 2_000),
    ),
  ]);

  const resolved = events.find(
    (event) => event.type === 'turn.userInputResolved',
  );
  assert.equal(resolved?.type, 'turn.userInputResolved');
  assert.equal(resolved?.submission.kind, 'cancelled');
  assert.equal(resolved?.submission.decisions.length, 1);
  assert.match(
    JSON.stringify(model.requests[1]?.contents),
    /"kind":"cancelled"/u,
  );
  assert.match(
    JSON.stringify(model.requests[1]?.contents),
    /完整链路（推荐）/u,
  );
});

test('RuntimeHost resolves a pending user-input request when the Turn stops', async () => {
  const events: RuntimeEvent[] = [];
  const model = new UserInputLlm({ model: 'fixture-model' });
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const host = new RuntimeHost({
    createModel: () => model,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.userInputRequested') {
        host.handle({
          type: 'turn.cancel',
          requestId: 'request-stop-input',
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          turnId: event.turnId,
          source: 'stopButton',
        });
      }
      if (event.type === 'turn.completed') resolveCompleted?.();
    },
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize-stop-input',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v4-stop-input-fixture',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-stop-input',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-stop-input-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '实现需求' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for stop.')), 2_000),
    ),
  ]);

  const resolved = events.find(
    (event) => event.type === 'turn.userInputResolved',
  );
  assert.equal(resolved?.type, 'turn.userInputResolved');
  assert.deepEqual(resolved?.submission, {
    kind: 'cancelled',
    decisions: [],
  });
  assert.equal(
    events.findLast((event) => event.type === 'turn.completed')?.status,
    'interrupted',
  );
});

test('RuntimeHost generates and conditionally persists an untitled Thread title', async () => {
  const events: RuntimeEvent[] = [];
  let generatedTitle = '';
  let conditional = false;
  let turnCompleted = false;
  let titleCompleted = false;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const finishIfReady = (): void => {
    if (turnCompleted && titleCompleted) {
      resolveCompleted?.();
    }
  };
  const native = turnNativeFixture({
    updateThreadTitleJson: (threadId, workspaceId, title, onlyIfUnset) => {
      generatedTitle = title;
      conditional = onlyIfUnset;
      const snapshot = JSON.parse(emptyThreadSnapshot(threadId)) as Record<
        string,
        unknown
      >;
      (snapshot.thread as Record<string, unknown>).workspaceId = workspaceId;
      (snapshot.thread as Record<string, unknown>).title = title;
      return JSON.stringify(snapshot);
    },
  });
  const host = new RuntimeHost({
    createModel: () => new FixtureLlm({ model: 'fixture-model' }),
    loadNative: () => native,
    postEvent: (event) => {
      events.push(event);
      if (event.type === 'turn.completed') {
        turnCompleted = true;
      }
      if (
        event.type === 'thread.mutated' &&
        event.operation === 'generateTitle'
      ) {
        titleCompleted = true;
      }
      finishIfReady();
    },
  });
  host.handle({
    type: 'initialize',
    requestId: 'request-title-initialize',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-title-fixture',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-title-turn',
    workspaceId: 'workspace-fixture',
    threadId: 'thread-fixture',
    turnId: 'turn-title-fixture',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    generateTitle: true,
    content: [{ type: 'text', text: '修复会话标题' }],
  });

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('Timed out waiting for generated title.')),
        2_000,
      ),
    ),
  ]);

  assert.equal(generatedTitle, 'Fixture response');
  assert.equal(conditional, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'thread.mutated' &&
        event.operation === 'generateTitle' &&
        event.snapshot?.thread.title === 'Fixture response',
    ),
  );
});

test('RuntimeHost scopes durable Item IDs to each Turn across worker restarts', async () => {
  const persisted = new Map<string, string>();
  const native = turnNativeFixture({
    appendItem: (itemId, turnId) => {
      if (persisted.has(itemId)) {
        throw new Error(`duplicate durable Item ID: ${itemId}`);
      }
      persisted.set(itemId, turnId);
      return true;
    },
  });
  const runTurn = async (suffix: string): Promise<RuntimeEvent[]> => {
    const events: RuntimeEvent[] = [];
    let resolveCompleted: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const host = new RuntimeHost({
      createModel: () => new FixtureLlm({ model: 'fixture-model' }),
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
      requestId: `request-initialize-${suffix}`,
    protocolVersion: 7,
      dataDirectory: `/tmp/sugarcode-v3-restart-${suffix}`,
      nativeModulePath: '/fixture/sugarcode-desktop-native.node',
    });
    host.handle({
      type: 'turn.start',
      requestId: `request-turn-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      threadId: `thread-${suffix}`,
      turnId: `turn-${suffix}`,
      provider: {
        wireApi: 'openaiResponses',
        model: 'fixture-model',
        baseUrl: 'http://127.0.0.1:1/v1',
        timeoutMs: 5_000,
        parallelTools: false,
      },
      content: [{ type: 'text', text: 'Hello' }],
    });
    await completed;
    return events;
  };

  const first = await runTurn('first');
  const second = await runTurn('second');
  const firstTerminal = first.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  const secondTerminal = second.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );

  assert.equal(firstTerminal?.status, 'completed');
  assert.equal(secondTerminal?.status, 'completed');
  assert.equal(
    [...persisted].every(([itemId, turnId]) => itemId.includes(`:${turnId}:`)),
    true,
  );
  assert.equal(
    [...persisted.keys()].filter((itemId) => itemId.startsWith('turn.usage:')).length,
    2,
  );
});

test('RuntimeHost classifies durable Item write failures as local state failures', async () => {
  const events: RuntimeEvent[] = [];
  let terminalErrorJson: string | undefined;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native = turnNativeFixture({
    appendItem: (_itemId, _turnId, _sequence, kind) => {
      if (kind === 'turn.usage') {
        throw new Error('fixture durable Item conflict');
      }
      return true;
    },
    finishTurn: (_turnId, _status, errorJson) => {
      terminalErrorJson = errorJson;
      return true;
    },
  });
  const host = new RuntimeHost({
    createModel: () => new FixtureLlm({ model: 'fixture-model' }),
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
    requestId: 'request-initialize-state-failure',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-state-failure',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-state-failure',
    workspaceId: 'workspace-state-failure',
    threadId: 'thread-state-failure',
    turnId: 'turn-state-failure',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: 'Hello' }],
  });

  await completed;

  const terminal = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'turn.completed' }> =>
      event.type === 'turn.completed',
  );
  assert.equal(terminal?.status, 'failed');
  assert.equal(terminal?.error?.kind, 'stateUnavailable');
  assert.equal(terminal?.error?.retryable, true);
  assert.deepEqual(JSON.parse(terminalErrorJson ?? '{}'), terminal?.error);
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
    protocolVersion: 7,
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
    protocolVersion: 7,
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
    protocolVersion: 7,
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
    protocolVersion: 7,
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
    skillsContextJson: () => '{"skills":[]}',
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
    protocolVersion: 7,
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
    skillsContextJson: () => '{"skills":[]}',
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
    protocolVersion: 7,
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

test('RuntimeHost stops repeated writes when project instructions are unavailable', async () => {
  const events: RuntimeEvent[] = [];
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
    skillsContextJson: () => '{"skills":[]}',
    listPendingApprovalsJson: () => '[]',
    ensureThread: (): void => undefined,
    loadThreadJson: () => emptyThreadSnapshot('thread-unavailable-instructions'),
    startTurn: (): void => undefined,
    appendItem: () => true,
    finishTurn: () => true,
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      return JSON.stringify({
        contractVersion: 1,
        documents: [],
        chains: [],
        errors: scopes.map((scope) => ({ scope, kind: 'invalidEncoding' })),
      });
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new PersistentUnavailableInstructionsLlm({
      model: 'fixture-model',
    }),
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
    requestId: 'request-initialize-unavailable-instructions',
    protocolVersion: 7,
    dataDirectory: '/tmp/sugarcode-v3-unavailable-instructions-fixture',
    nativeModulePath: '/fixture/native.node',
  });
  host.handle({
    type: 'turn.start',
    requestId: 'request-turn-unavailable-instructions',
    workspaceId: 'workspace-unavailable-instructions',
    threadId: 'thread-unavailable-instructions',
    turnId: 'turn-unavailable-instructions',
    provider: {
      wireApi: 'openaiResponses',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 5_000,
      parallelTools: false,
    },
    content: [{ type: 'text', text: '/fix Change src/value.ts.' }],
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
    events.filter((event) => event.type === 'approval.requested').length,
    0,
  );
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
    skillsContextJson: () => '{"skills":[]}',
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
    protocolVersion: 7,
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
    skillsContextJson: () => '{"skills":[]}',
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
    protocolVersion: 7,
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
    protocolVersion: 7,
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
  const childTools = new Map<string, readonly string[]>();
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const skillContent = '# Fixture Skill\n\nFollow the fixture review method.';
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    skillsContextJson: () => JSON.stringify({
      skills: [{
        name: 'fixture-skill',
        description: 'Fixture methodology.',
        content: skillContent,
        bytes: Buffer.byteLength(skillContent),
        sha256: createHash('sha256').update(skillContent).digest('hex'),
      }],
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
    workspacePathSearchJson: async () => '{}',
    workspaceApplyPatch: async () => '{}',
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    createModel: () => new CollaborationLoopLlm(
      { model: 'fixture-model' },
      childTools,
    ),
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
    protocolVersion: 7,
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
  assert.ok(childTools.get('worker')?.includes('workspace_apply_patch'));
  assert.ok(childTools.get('worker')?.includes('shell_exec'));
  assert.ok(childTools.get('worker')?.includes('load_skill'));
  assert.ok(childTools.get('auditor')?.includes('load_skill'));
  assert.deepEqual(
    childTools.get('auditor')?.filter((name) => name.startsWith('workspace_')),
    ['workspace_read', 'workspace_list', 'workspace_search'],
  );
  assert.equal(events.at(-1)?.type, 'turn.completed');
});

test('RuntimeHost executes ADK workspace tools through the native boundary', async () => {
  const events: RuntimeEvent[] = [];
  const persistedKinds: string[] = [];
  let listPath = '';
  let readPath = '';
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    inspectSkillsJson: () => '{"skills":[],"workspaceAvailable":true}',
    skillsContextJson: () => '{"skills":[]}',
    readSkillContentJson: () => '{}',
    setSkillEnabledJson: () => '{"skills":[],"workspaceAvailable":true}',
    importSkillJson: () => '{"skills":[],"workspaceAvailable":true}',
    exportSkillJson: () => '{"path":"/fixture/export"}',
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
    inspectCommandEnvironmentJson: () => '{"state":"notCaptured"}',
    refreshCommandEnvironmentJson: async () => '{"state":"ready"}',
    setCommandProfileLoadingEnabledJson: () => '{"accepted":true}',
    inspectProjectEnvironmentJson: async () => '{"state":"absent"}',
    trustProjectEnvironmentJson: async () => '{"accepted":true}',
    runProjectEnvironmentActionJson: async () => '{"accepted":true,"status":"completed"}',
    inspectTaskWorkspaceJson: () => '{"mode":"local"}',
    taskWorkspaceBindingId: (workspaceId) => workspaceId,
    setTaskWorkspaceModeJson: () => '{"accepted":true}',
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
    workspaceInstructionsJson: () =>
      '{"contractVersion":1,"documents":[],"chains":[{"scope":".","paths":[]}],"errors":[]}',
    ensureThread: () => undefined,
    createThreadJson: () => '{}',
    updateThreadTitleJson: () => '{}',
    listThreadsJson: () => '[]',
    deleteThread: () => true,
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
    workspaceList: async (_workspaceId, path) => {
      listPath = path;
      return JSON.stringify({
        ok: true,
        entries: [{ name: 'src', kind: 'directory' }],
      });
    },
    workspaceInspectJson: () => JSON.stringify({
      status: 'complete',
      path: 'fixture.txt',
      content: 'fixture',
      bytes: 7,
      lines: 1,
      hasUtf8Bom: false,
    }),
    workspaceResolveJson: async (_workspaceId, name) => JSON.stringify({
      status: 'resolved',
      path: `src/${name}`,
    }),
    workspaceSearch: async () => JSON.stringify({ ok: true, matches: [] }),
    workspacePathSearchJson: async () => JSON.stringify({ ok: true, paths: [] }),
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
    protocolVersion: 7,
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
    type: 'workspace.resolve',
    requestId: 'request-workspace-resolve',
    workspaceId: 'workspace-fixture',
    name: 'extension.tsx',
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
  assert.equal(listPath, '.');
  assert.ok(events.some((event) => event.type === 'workspace.opened'));
  assert.deepEqual(
    events.find((event) => event.type === 'workspace.listResult')?.entries,
    [{ name: 'src', path: 'src', kind: 'directory' }],
  );
  assert.equal(
    events.find((event) => event.type === 'workspace.inspected')?.document.status,
    'complete',
  );
  assert.deepEqual(
    events.find((event) => event.type === 'workspace.resolved'),
    {
      type: 'workspace.resolved',
      sequence: events.find((event) => event.type === 'workspace.resolved')?.sequence,
      requestId: 'request-workspace-resolve',
      workspaceId: 'workspace-fixture',
      name: 'extension.tsx',
      status: 'resolved',
      path: 'src/extension.tsx',
    },
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

test('RuntimeHost automatically resumes a recovered workspace patch', async () => {
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
    protocolVersion: 7,
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });
  await completed;
  assert.equal(
    events.some((event) => event.type === 'approval.requested'),
    false,
  );
  assert.equal(approvalStatus, 'approved');
  assert.equal(operationStatus, 'completed');
  assert.equal(applyCount, 1);
  assert.ok(persistedKinds.includes('approval.resolved'));
  assert.ok(persistedKinds.includes('operation.completed'));
});

test('RuntimeHost publishes concurrent approvals and resolves either one independently', () => {
  const commandArguments = [
    {
      mode: 'fullAccess',
      command: 'git status',
      arguments: [] as string[],
      cwd: '.',
      timeoutMs: 300_000,
    },
    {
      mode: 'fullAccess',
      command: 'npm test',
      arguments: [] as string[],
      cwd: '.',
      timeoutMs: 300_000,
    },
  ];
  const records = commandArguments.map((argumentsValue, index) => {
    const argumentsJson = JSON.stringify(argumentsValue);
    return {
      approvalId: `approval-${index + 1}`,
      operationId: `operation-${index + 1}`,
      turnId: `turn-${index + 1}`,
      requestId: `request-${index + 1}`,
      threadId: `thread-${index + 1}`,
      workspaceId: `workspace-${index + 1}`,
      toolName: 'shell_exec',
      requestHash: createHash('sha256').update(argumentsJson).digest('hex'),
      argumentsJson,
    };
  });
  const events: RuntimeEvent[] = [];
  const decisions: Array<readonly [string, string]> = [];
  const native = {
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => JSON.stringify(records),
    appendItem: () => true,
    resolveApproval: (approvalId: string, decision: string) => {
      decisions.push([approvalId, decision]);
      return true;
    },
  } as unknown as NativeRuntimeBinding;
  const host = new RuntimeHost({
    loadNative: () => native,
    postEvent: (event) => events.push(event),
  });

  host.handle({
    type: 'initialize',
    requestId: 'request-initialize',
    protocolVersion: 7,
    dataDirectory: '/fixture/.sugarcode/v3',
    nativeModulePath: '/fixture/sugarcode-desktop-native.node',
  });

  const approvals = events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'approval.requested' }> =>
      event.type === 'approval.requested',
  );
  assert.deepEqual(
    approvals.map((approval) => approval.approvalId),
    ['approval-1', 'approval-2'],
  );

  host.handle({
    type: 'approval.resolve',
    requestId: 'request-decision-2',
    workspaceId: 'workspace-2',
    threadId: 'thread-2',
    turnId: 'turn-2',
    approvalId: 'approval-2',
    decision: 'denied',
    source: 'user',
  });

  assert.deepEqual(decisions, [['approval-2', 'denied']]);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'approval.resolved' &&
        event.approvalId === 'approval-2',
    ),
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'approval.resolved' &&
        event.approvalId === 'approval-1',
    ),
    false,
  );
});

test('RuntimeHost automatically authorizes a workspace patch', async () => {
  const events: RuntimeEvent[] = [];
  let applyCount = 0;
  let proposalCount = 0;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    inspectSkillsJson: () => '{"skills":[],"workspaceAvailable":true}',
    skillsContextJson: () => '{"skills":[]}',
    readSkillContentJson: () => '{}',
    setSkillEnabledJson: () => '{"skills":[],"workspaceAvailable":true}',
    importSkillJson: () => '{"skills":[],"workspaceAvailable":true}',
    exportSkillJson: () => '{"path":"/fixture/export"}',
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
    inspectCommandEnvironmentJson: () => '{"state":"notCaptured"}',
    refreshCommandEnvironmentJson: async () => '{"state":"ready"}',
    setCommandProfileLoadingEnabledJson: () => '{"accepted":true}',
    inspectProjectEnvironmentJson: async () => '{"state":"absent"}',
    trustProjectEnvironmentJson: async () => '{"accepted":true}',
    runProjectEnvironmentActionJson: async () => '{"accepted":true,"status":"completed"}',
    inspectTaskWorkspaceJson: () => '{"mode":"local"}',
    taskWorkspaceBindingId: (workspaceId) => workspaceId,
    setTaskWorkspaceModeJson: () => '{"accepted":true}',
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
    workspaceInstructionsJson: () =>
      '{"contractVersion":1,"documents":[],"chains":[{"scope":".","paths":[]}],"errors":[]}',
    ensureThread: () => undefined,
    createThreadJson: () => '{}',
    updateThreadTitleJson: () => '{}',
    listThreadsJson: () => '[]',
    deleteThread: () => true,
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
    workspaceResolveJson: async () => '{"status":"notFound"}',
    workspaceSearch: async () => '{}',
    workspacePathSearchJson: async () => '{}',
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
    protocolVersion: 7,
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
  await completed;
  assert.equal(proposalCount, 1);
  assert.equal(applyCount, 1);
  assert.equal(
    events.some((event) => event.type === 'approval.requested'),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'approval.resolved'),
    false,
  );
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
});

test('RuntimeHost automatically authorizes a sandboxed command', async () => {
  const events: RuntimeEvent[] = [];
  let claimCount = 0;
  let executeCount = 0;
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const native: NativeRuntimeBinding = {
    inspectSkillsJson: () => '{"skills":[],"workspaceAvailable":true}',
    skillsContextJson: () => '{"skills":[]}',
    readSkillContentJson: () => '{}',
    setSkillEnabledJson: () => '{"skills":[],"workspaceAvailable":true}',
    importSkillJson: () => '{"skills":[],"workspaceAvailable":true}',
    exportSkillJson: () => '{"path":"/fixture/export"}',
    inspectMcpConfigJson: () => JSON.stringify({
      contractVersion: 1,
      revision: '0'.repeat(64),
      servers: [],
    }),
    listPendingApprovalsJson: () => '[]',
    saveMcpConfigJson: () => '{}',
    importAssetJson: () => '{}',
    readAssetJson: () => '{}',
    inspectCommandEnvironmentJson: () => '{"state":"notCaptured"}',
    refreshCommandEnvironmentJson: async () => '{"state":"ready"}',
    setCommandProfileLoadingEnabledJson: () => '{"accepted":true}',
    inspectProjectEnvironmentJson: async () => '{"state":"absent"}',
    trustProjectEnvironmentJson: async () => '{"accepted":true}',
    runProjectEnvironmentActionJson: async () => '{"accepted":true,"status":"completed"}',
    inspectTaskWorkspaceJson: () => '{"mode":"local"}',
    taskWorkspaceBindingId: (workspaceId) => workspaceId,
    setTaskWorkspaceModeJson: () => '{"accepted":true}',
    executeCommandJson: async (
      _operationId,
      _workspaceId,
      threadId,
      mode,
      command,
    ) => {
      executeCount += 1;
      assert.equal(threadId, 'thread-fixture');
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
    workspaceInstructionsJson: () =>
      '{"contractVersion":1,"documents":[],"chains":[{"scope":".","paths":[]}],"errors":[]}',
    ensureThread: () => undefined,
    createThreadJson: () => emptyThreadSnapshot(),
    updateThreadTitleJson: () => emptyThreadSnapshot(),
    listThreadsJson: () => '[]',
    deleteThread: () => true,
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
    workspaceResolveJson: async () => '{"status":"notFound"}',
    workspaceSearch: async () => '{}',
    workspacePathSearchJson: async () => '{}',
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
    protocolVersion: 7,
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
  await completed;
  assert.equal(claimCount, 1);
  assert.equal(executeCount, 1);
  assert.equal(
    events.some((event) => event.type === 'approval.requested'),
    false,
  );
  assert.ok(events.some((event) => event.type === 'turn.toolResult'));
});

test('RuntimeHost rebuilds completed history and interrupted task intent into ADK', async () => {
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
    turns: [
      {
        id: 'turn-earlier',
        requestId: 'request-earlier',
        status: 'completed',
        providerWireApi: 'openaiResponses',
        model: 'fixture-model',
        errorJson: null,
        startedAt: 1,
        completedAt: 2,
      },
      {
        id: 'turn-interrupted',
        requestId: 'request-interrupted',
        status: 'interrupted',
        providerWireApi: 'openaiResponses',
        model: 'fixture-model',
        errorJson: '{"kind":"runtimeRestart"}',
        startedAt: 3,
        completedAt: 4,
      },
    ],
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
      {
        id: 'interrupted-user',
        turnId: 'turn-interrupted',
        sequence: 1,
        kind: 'turn.userMessage',
        payload: { content: [{ type: 'text', text: 'Interrupted request' }] },
      },
      {
        id: 'interrupted-orphan-call',
        turnId: 'turn-interrupted',
        sequence: 2,
        kind: 'turn.modelHistory',
        payload: {
          history: {
            role: 'assistant',
            parts: [{
              type: 'toolCall',
              id: 'call-interrupted',
              name: 'workspace_apply_patch',
              arguments: { patch: 'uncommitted' },
            }],
          },
        },
      },
    ],
  });
  const native: NativeRuntimeBinding = {
    inspectSkillsJson: () => '{"skills":[],"workspaceAvailable":true}',
    skillsContextJson: () => '{"skills":[]}',
    readSkillContentJson: () => '{}',
    setSkillEnabledJson: () => '{"skills":[],"workspaceAvailable":true}',
    importSkillJson: () => '{"skills":[],"workspaceAvailable":true}',
    exportSkillJson: () => '{"path":"/fixture/export"}',
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
    inspectCommandEnvironmentJson: () => '{"state":"notCaptured"}',
    refreshCommandEnvironmentJson: async () => '{"state":"ready"}',
    setCommandProfileLoadingEnabledJson: () => '{"accepted":true}',
    inspectProjectEnvironmentJson: async () => '{"state":"absent"}',
    trustProjectEnvironmentJson: async () => '{"accepted":true}',
    runProjectEnvironmentActionJson: async () => '{"accepted":true,"status":"completed"}',
    inspectTaskWorkspaceJson: () => '{"mode":"local"}',
    taskWorkspaceBindingId: (workspaceId) => workspaceId,
    setTaskWorkspaceModeJson: () => '{"accepted":true}',
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
    workspaceInstructionsJson: () =>
      '{"contractVersion":1,"documents":[],"chains":[{"scope":".","paths":[]}],"errors":[]}',
    ensureThread: () => undefined,
    createThreadJson: () => emptyThreadSnapshot(),
    updateThreadTitleJson: () => emptyThreadSnapshot(),
    listThreadsJson: () => '[]',
    deleteThread: () => true,
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
    workspaceResolveJson: async () => '{"status":"notFound"}',
    workspaceSearch: async () => '{}',
    workspacePathSearchJson: async () => '{}',
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
    protocolVersion: 7,
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
  assert.equal(contents[4]?.parts?.[0]?.text, 'Interrupted request');
  assert.equal(
    contents[5]?.parts?.map((part) => part.text).filter(Boolean).join('\n'),
    'Current request\nAttachment fixture.txt:\nfixture',
  );
  assert.ok(!contents.some((content) =>
    content.parts?.some(
      (part) => part.functionCall?.id === 'call-interrupted',
    ),
  ));
  assert.ok(events.some((event) => event.type === 'turn.completed'));
});
