import {
  createEvent,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
  type BaseLlm,
  type Event,
  type LlmRequest,
} from '@google/adk';
import { Type, type Content, type Part, type Schema } from '@google/genai';
import { createHash, randomUUID } from 'node:crypto';

import { userInputBoundaryCommentary } from '../shared/conversation/user-input-boundary.ts';
import {
  isTrustedCommentaryId,
  toolProgressCommentaryId,
} from '../shared/conversation/trusted-commentary.ts';
import { parseComposerSubmission } from '../shared/composer.ts';
import {
  ContextManager,
  type RuntimeContextCheckpoint,
} from './context-manager.ts';
import {
  contentFromStoredModelHistory,
  encodeModelHistory,
  parseStoredModelHistory,
  type StoredModelHistoryV2,
} from './model-history-codec.ts';
import { RuntimeProtocolError } from './protocol-error.ts';
import { buildAgentInstructions } from './agent-instructions.ts';
import { finalResponseCandidateIssue } from './final-response-quality.ts';
import {
  createSubmitFinalResponseTool,
  extractDelimitedFinalResponse,
  SUBMIT_FINAL_RESPONSE_TOOL_NAME,
  type FinalResponseSubmissionGuard,
} from './final-response-submission.ts';
import {
  composerIntentInstruction,
  composerModelText,
  composerRequiresFigmaMcp,
  composerTurnMode,
} from './composer-intent.ts';
import {
  CollaborationCoordinator,
  type AgentTaskExecutionContext,
} from './collaboration.ts';
import { WorkspaceInstructionContext } from './workspace-instructions.ts';
import {
  ProviderAdapterError,
  ProviderErrorCapturePlugin,
} from './models/errors.ts';
import { AnthropicLlm } from './models/anthropic-llm.ts';
import { discoverModels } from './models/discovery.ts';
import { OpenAiLlm } from './models/openai-llm.ts';
import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  knownContextWindowTokens,
  supportsNativeCompaction,
} from '../shared/model-metadata.ts';
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../shared/model-request-limits.ts';
import {
  readModelItemMetadata,
  readModelStepOutcome,
} from './models/step-outcome.ts';
import type { ModelStepOutcome, ModelTextPhase } from './models/types.ts';
import { INVALID_TOOL_ARGUMENTS_TOOL_NAME } from './models/types.ts';
import {
  createImageAnalysisTool,
  ImageAnalyzer,
  imageAttachmentReference,
  type ImageAnalysisModel,
  type StoredImageContent,
} from './media-analysis.ts';
import {
  audioAnalysisProfileIds,
  availableThreadVideos,
  availableThreadImages,
  imageAnalysisProfileIds,
  videoAnalysisProfileIds,
} from './media-routing.ts';
import type { AudioAnalysisModel } from './audio-transcription.ts';
import {
  createVideoAnalysisTool,
  VideoAnalyzer,
  videoAttachmentReference,
  type StoredVideoContent,
  type VideoAnalysisModel,
} from './video-analysis.ts';
import {
  createDashscopeTemporaryMediaPublisher,
  effectiveMediaTransport,
  type TemporaryMediaPublisher,
} from './temporary-media.ts';
import { loadNativeRuntime, type NativeRuntimeBinding } from './native.ts';
import {
  isRuntimeContentPart,
  MAX_RUNTIME_PLAN_BYTES,
  MAX_RUNTIME_USER_INPUT_OPTIONS,
  MAX_RUNTIME_USER_INPUT_QUESTIONS,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAssetDescriptor,
  type RuntimeCommand,
  type RuntimeContentPart,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeModelSelection,
  type RuntimeProviderConfig,
  type RuntimeProviderError,
  type RuntimeThreadRecord,
  type RuntimeThreadQueue,
  type RuntimeThreadSnapshot,
  type RuntimeUsage,
  type RuntimeUserInputQuestion,
  type RuntimeUserInputSubmission,
  type RuntimeWorkspaceDocument,
  type RuntimeWorkspaceEntry,
} from './protocol.ts';
import {
  createWorkspaceTools,
  executePrivilegedWorkspaceTool,
  workspacePatchApprovalSummary,
} from './tools/workspace.ts';
import { createTurnSkills, type TurnSkills } from './skills.ts';
import {
  createTurnKnowledge,
  resolveKnowledgeReferences,
} from './knowledge.ts';
import {
  toolFailureRecoveryKey,
  toolResultFailed,
  toolResultRequiresFinalRecovery,
} from './tool-result.ts';
import {
  toolProgressSummary,
  toolResultSummary,
} from './tool-progress-summary.ts';
import { generateThreadTitle, titleSourceFromContent } from './thread-title.ts';
import { RuntimeMcpManager, type McpToolApproval } from './mcp.ts';
import type {
  McpConfigActionResult,
  McpConfigInspection,
} from '../shared/mcp.ts';
import type {
  SkillContent,
  SkillsActionResult,
  SkillsInspection,
} from '../shared/skills.ts';
import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeEditableDocument,
  KnowledgeInspection,
  KnowledgeSearchResult,
} from '../shared/knowledge.ts';
import type {
  CommandEnvironmentActionResult,
  CommandEnvironmentStatus,
  TaskWorkspaceActionResult,
  TaskWorkspaceStatus,
} from '../shared/command-environment.ts';
import { isModelConfigInspection } from '../shared/model-config.ts';
import type { GoalSnapshot } from '../shared/goals.ts';
import {
  createUpdateGoalTool,
  GoalTurnSession,
  goalTurnRuntimeContent,
} from './goals.ts';
import {
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH,
} from '../shared/conversation/limits.ts';

const APPLICATION_NAME = 'sugarcode-desktop-v3';
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
const DEFAULT_PROVIDER_TIMEOUT_MS = DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
const AGENT_APPROVAL_STATUS_DELAY_MS = 250;
const MAX_MCP_ARGUMENT_BYTES = 32 * 1024;
const MAX_TRANSIENT_PROVIDER_RECOVERIES = 1;
const AGENT_PROGRESS_PERSIST_INTERVAL_MS = 1_000;

const isTransientProviderFailure = (
  error: RuntimeProviderError,
): boolean =>
  error.retryable &&
  (error.kind === 'connection' || error.kind === 'timeout');

const providerRecoveryMessage = (
  error: RuntimeProviderError,
  partialSummary = '',
): Content => ({
  role: 'user',
  parts: [{
    text:
      '# Internal provider recovery\n\n' +
      `The previous model stream ended with a retryable ${error.kind} error: ${error.message}\n\n` +
      'Continue the same task from the existing session state. Do not repeat completed tool calls or workspace mutations. ' +
      'Use any recovered draft below, finish only the missing work, and submit one concise final answer.\n\n' +
      (partialSummary.trim().length > 0
        ? `# Recovered partial draft\n\n${partialSummary.slice(0, 16 * 1024)}`
        : '# Recovered partial draft\n\nNo visible draft was recovered.'),
  }],
});

const reserveContextTokens = (
  selection: RuntimeModelSelection,
  reservedTokens: number,
): RuntimeModelSelection => {
  if (reservedTokens <= 0) {
    return selection;
  }
  const safety = Math.max(
    4_096,
    Math.ceil(selection.contextWindowTokens * 0.05),
  );
  const available =
    selection.contextWindowTokens - DEFAULT_MAX_OUTPUT_TOKENS - safety;
  const trigger =
    selection.compactThresholdTokens ??
    Math.min(Math.floor(selection.contextWindowTokens * 0.85), available);
  return {
    ...selection,
    compactThresholdTokens: Math.max(0, trigger - reservedTokens),
  };
};

const INVALID_TOOL_ARGUMENTS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    toolName: { type: Type.STRING },
    argumentsText: { type: Type.STRING },
  },
  required: ['toolName', 'argumentsText'],
} satisfies Schema;

const REQUEST_USER_INPUT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      minItems: '1',
      maxItems: String(MAX_RUNTIME_USER_INPUT_QUESTIONS),
      items: {
        type: Type.OBJECT,
        properties: {
          header: { type: Type.STRING },
          id: { type: Type.STRING },
          question: { type: Type.STRING },
          options: {
            type: Type.ARRAY,
            minItems: '2',
            maxItems: String(MAX_RUNTIME_USER_INPUT_OPTIONS),
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                description: { type: Type.STRING },
              },
              required: ['label', 'description'],
            },
          },
        },
        required: ['header', 'id', 'question', 'options'],
      },
    },
  },
  required: ['questions'],
} satisfies Schema;

const SUBMIT_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content: { type: Type.STRING },
  },
  required: ['content'],
} satisfies Schema;

type RuntimeHostOptions = Readonly<{
  postEvent: (event: RuntimeEvent) => void;
  createModel?: (provider: RuntimeProviderConfig) => BaseLlm;
  loadNative?: typeof loadNativeRuntime;
  videoAnalyzer?: VideoAnalyzer;
}>;

type PendingApproval = Readonly<{
  requestId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  operationId: string;
  kind: 'command' | 'mcp';
  recovered: boolean;
  requiresApproval: boolean;
  publish: () => void;
  resolve: (decision: 'approved' | 'denied') => void;
}>;

type PendingUserInput = Readonly<{
  requestId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  questions: readonly RuntimeUserInputQuestion[];
  resolve: (result: RuntimeUserInputSubmission) => void;
}>;

type RecoveredApprovalRecord = Readonly<{
  approvalId: string;
  operationId: string;
  turnId: string;
  requestId: string;
  threadId: string;
  workspaceId: string;
  toolName: string;
  requestHash: string;
  argumentsJson: string;
  approval: unknown;
}>;

type RecoveredApprovalPresentation =
  | Readonly<{
      kind: 'command';
      purpose: string;
      argumentsSummary: string;
      fullAccess: boolean;
      projectEnvironmentTrust?: true;
    }>
  | Readonly<{
      kind: 'mcp';
      serverId: string;
      name: string;
      purpose: string;
      argumentsBytes: number;
      argumentsSha256: string;
      inventorySha256: string;
    }>;

const defaultCreateModel = (provider: RuntimeProviderConfig): BaseLlm => {
  const common = {
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    headers: provider.headers,
    timeoutMs: provider.timeoutMs,
    parallelTools: provider.parallelTools,
    compactThresholdTokens: provider.compactThresholdTokens,
    nativeCompaction: provider.nativeCompaction,
    reasoningEffort: provider.reasoningEffort,
    serviceTier: provider.serviceTier,
  };
  return provider.wireApi === 'anthropicMessages'
    ? new AnthropicLlm(common)
    : new OpenAiLlm({ ...common, wireApi: provider.wireApi });
};

const temporaryMediaPublisher = (
  provider: RuntimeProviderConfig,
): TemporaryMediaPublisher | undefined => {
  if (
    effectiveMediaTransport(provider.baseUrl) !==
      'dashscopeTemporaryUrl' ||
    !provider.apiKey
  ) {
    return undefined;
  }
  return createDashscopeTemporaryMediaPublisher({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  });
};

const providerForPublishedMedia = (
  provider: RuntimeProviderConfig,
  publisher: TemporaryMediaPublisher | undefined,
): RuntimeProviderConfig =>
  publisher
    ? {
        ...provider,
        headers: {
          ...provider.headers,
          'X-DashScope-OssResourceResolve': 'enable',
        },
      }
    : provider;

type ResolvedProfile = Readonly<{
  provider: RuntimeProviderConfig;
  selection: RuntimeModelSelection;
  mediaCapabilities: Readonly<{
    videoInput: 'auto' | 'enabled' | 'disabled';
    audioInput: 'auto' | 'enabled' | 'disabled';
  }>;
}>;

type TurnExecutionCommand =
  | Extract<RuntimeCommand, { type: 'turn.start' }>
  | Extract<RuntimeCommand, { type: 'turn.startGoal' }>
  | Extract<RuntimeCommand, { type: 'turn.startQueued' }>
  | Extract<RuntimeCommand, { type: 'turn.revise' }>;

type TurnContextCommand =
  TurnExecutionCommand | Extract<RuntimeCommand, { type: 'context.compact' }>;

type TextItemState = {
  phase: ModelTextPhase;
  text: string;
  started: boolean;
  completed: boolean;
  pendingFinal: boolean;
};

type TurnDriverOptions = Readonly<{
  runner: Runner;
  userId: string;
  sessionId: string;
  initialMessage: Content;
  signal: AbortSignal;
  onEvent: (event: Event, textItems: Map<string, TextItemState>) => void;
  onCompletedEvent?: (event: Event) => void;
  consumePendingResults?: () => Promise<string | null>;
  consumePendingSteers?: () => readonly Content[];
  completionGate?: () => boolean;
  retryFinalAfterToolFailure?: () => boolean;
  terminalToolResult?: (
    event: Event,
    textItems: Map<string, TextItemState>,
  ) => boolean;
  validateFinalCandidate?: (candidateText: string) => string | undefined;
  recoverFinalCandidate?: (candidateText: string) => string | undefined;
  validateRecoveredFinalCandidate?: (
    candidateText: string,
  ) => string | undefined;
  settleFinalCandidate?: (
    accepted: boolean,
    textItems: Map<string, TextItemState>,
    recoveredText?: string,
  ) => void;
  takeProviderError?: () => RuntimeProviderError | undefined;
  validateInvocation?: () => void;
}>;

type QueueNativeBinding = Required<
  Pick<
    NativeRuntimeBinding,
    | 'createQueuedMessageJson'
    | 'updateQueuedMessageJson'
    | 'deleteQueuedMessageJson'
    | 'setQueuePausedJson'
    | 'promoteQueuedMessageJson'
    | 'steerQueuedMessageJson'
  >
>;

type InvalidArgumentGuard = {
  repeats: Map<string, number>;
  calls: Map<string, string>;
  repeatedToolFailure?: Readonly<{
    key: string;
    count: number;
    recoveryMarkdown: string;
    recoveryDelivered: boolean;
  }>;
  unresolvedToolFailures: Set<string>;
  finalRecoveryUsed: boolean;
};

type UserInputFinalGuard = {
  questions: RuntimeUserInputQuestion[];
  resolvedRequests: number;
  instructionDeliveredFor: number;
};

type PlanSubmissionGuard = {
  proposal?: Readonly<{
    planId: string;
    content: string;
  }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const FUTURE_ACTION_PATTERN =
  /(?:\b(?:let me|i(?:'ll| will| am going to)|next,? i(?:'ll| will))\s+(?:now\s+)?(?:start|begin|continue|create|generate|write|edit|update|inspect|read|run|implement|fix|complete)\b|(?:让我|讓我|现在|現在|接下来|接下來|下面|稍后|稍後)[，,\s]*(?:我)?(?:会|會|将|將|来|來)?(?:开始|開始|继续|繼續|生成|创建|建立|写入|寫入|修改|补充|補充|读取|讀取|运行|運行|实现|實現|完成))/iu;

const COMPLETED_OR_BLOCKED_PATTERN =
  /(?:\b(?:completed|finished|implemented|updated|created|wrote|blocked|cannot|failed)\b|(?:已经|已經|成功|完成了|修改了|生成了|创建了|建立了|写入了|寫入了|无法|無法|失败|失敗|阻塞|未能))/iu;

const PLAN_INTERACTIVE_TAIL_PATTERN =
  /(?:\b(?:should|shall|would|do)\s+i\s+(?:proceed|continue|implement|start|begin)\b|\b(?:let me know|tell me)\s+(?:if|when)\s+(?:you(?:'d| would)?\s+like|i should)\b|(?:是否|要不要|需不需要|需要我|要我|可以开始|可以開始|确认(?:即可)?开始|確認(?:即可)?開始|如需(?:进入|進入|开始|開始|继续|繼續|实施|實施|实现|實現)|请(?:确认|確認|告知|回复|回覆).{0,12}(?:开始|開始|继续|繼續|实施|實施|实现|實現)))[^。.!！\n]{0,48}[?？。.!！]?\s*$/iu;

export const planSubmissionIssue = (value: string): string | undefined => {
  const text = value.trim();
  if (text.length === 0) {
    return 'The submitted plan is empty.';
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RUNTIME_PLAN_BYTES) {
    return `The submitted plan exceeds ${MAX_RUNTIME_PLAN_BYTES} UTF-8 bytes.`;
  }
  if (
    Array.from(text).some(
      (character) =>
        /\p{Cc}/u.test(character) && !['\n', '\r', '\t'].includes(character),
    )
  ) {
    return 'The submitted plan contains unsupported control characters.';
  }
  if (PLAN_INTERACTIVE_TAIL_PATTERN.test(text)) {
    return 'The submitted plan ends with a question, approval request, or invitation to continue.';
  }
  return undefined;
};

const planSubmissionBoundaryCommentary = (languageSource: string): string =>
  /\p{Script=Han}/u.test(languageSource)
    ? '计划已经整理完成，正在提交正式计划。'
    : 'The plan is complete and is being submitted as the formal proposal.';

export const isFutureActionOnlyFinal = (value: string): boolean => {
  const text = value.trim();
  return (
    text.length > 0 &&
    text.length <= 800 &&
    FUTURE_ACTION_PATTERN.test(text) &&
    !COMPLETED_OR_BLOCKED_PATTERN.test(text)
  );
};

const chineseSectionNumber = (value: string): number | undefined => {
  const digits = new Map([
    ['一', 1],
    ['二', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['七', 7],
    ['八', 8],
    ['九', 9],
  ]);
  if (value === '十') return 10;
  const [tens, units] = value.split('十');
  if (units !== undefined) {
    return (
      (tens ? (digits.get(tens) ?? 0) : 1) * 10 +
      (units ? (digits.get(units) ?? 0) : 0)
    );
  }
  return digits.get(value);
};

const firstStructuredSectionNumber = (value: string): number | undefined => {
  for (const line of value.split(/\r?\n/u)) {
    const heading = line.match(
      /^\s*#{1,6}\s*(?:第\s*)?([0-9]{1,3}|[一二三四五六七八九十]{1,3})(?:\s*[、.．:：]|\s+)/u,
    );
    const list = line.match(/^\s*([0-9]{1,3})[.、．)]\s+/u);
    const token = heading?.[1] ?? list?.[1];
    if (!token) continue;
    return /^\d+$/u.test(token)
      ? Number.parseInt(token, 10)
      : chineseSectionNumber(token);
  }
  return undefined;
};

const userInputFinalCandidateIssue = (
  value: string,
  questions: readonly RuntimeUserInputQuestion[],
): string | undefined => {
  if (questions.some((question) => value.includes(question.question))) {
    return 'The candidate repeated a structured user-input question in the final answer.';
  }
  const firstSection = firstStructuredSectionNumber(value);
  if (firstSection !== undefined && firstSection > 1) {
    return `The candidate began at section ${firstSection}, so it continued an earlier draft instead of providing a complete answer.`;
  }
  return undefined;
};

const boundedUserInputText = (
  value: unknown,
  maxBytes: number,
  maxCharacters?: number,
): string | undefined => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    (maxCharacters !== undefined && Array.from(value).length > maxCharacters) ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return undefined;
  }
  return value.trim();
};

const parseUserInputQuestions = (
  input: unknown,
): readonly RuntimeUserInputQuestion[] | undefined => {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return undefined;
  }
  if (
    input.questions.length < 1 ||
    input.questions.length > MAX_RUNTIME_USER_INPUT_QUESTIONS
  ) {
    return undefined;
  }
  const questions: RuntimeUserInputQuestion[] = [];
  for (const candidate of input.questions) {
    if (!isRecord(candidate) || !Array.isArray(candidate.options)) {
      return undefined;
    }
    const id =
      typeof candidate.id === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(candidate.id)
        ? candidate.id
        : undefined;
    const header = boundedUserInputText(candidate.header, 48, 12);
    const question = boundedUserInputText(candidate.question, 512);
    if (
      !id ||
      !header ||
      !question ||
      candidate.options.length < 2 ||
      candidate.options.length > MAX_RUNTIME_USER_INPUT_OPTIONS
    ) {
      return undefined;
    }
    const options = candidate.options.map((option) => {
      if (!isRecord(option)) {
        return undefined;
      }
      const label = boundedUserInputText(option.label, 96);
      const description = boundedUserInputText(option.description, 384);
      return label && description ? { label, description } : undefined;
    });
    if (
      options.some((option) => option === undefined) ||
      new Set(options.map((option) => option?.label)).size !== options.length
    ) {
      return undefined;
    }
    questions.push({
      id,
      header,
      question,
      options: options as RuntimeUserInputQuestion['options'],
    });
  }
  return new Set(questions.map((question) => question.id)).size ===
    questions.length
    ? questions
    : undefined;
};

// Provider reasoning summaries are untrusted and may contain private chain of
// thought. Only ordinary model text crosses the visible Runtime boundary.
const isVisibleModelTextPart = (part: Part): boolean => {
  if (typeof part.text !== 'string' || part.text.trim().length === 0) {
    return false;
  }
  return (
    part.thought !== true &&
    readModelItemMetadata(part)?.reasoningVisibility === undefined
  );
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, stableJsonValue(item)]),
  );
};

const capabilityEnabled = (value: unknown): boolean => value !== 'disabled';
const capabilityMode = (value: unknown): 'auto' | 'enabled' | 'disabled' =>
  value === 'enabled' || value === 'disabled' ? value : 'auto';

class RuntimeStateUnavailableError extends Error {
  constructor(error: unknown) {
    super(
      error instanceof Error
        ? error.message
        : 'SugarCode could not persist local Turn state.',
      { cause: error },
    );
    this.name = 'RuntimeStateUnavailableError';
  }
}

const withDurableStateWrite = <Value>(write: () => Value): Value => {
  try {
    return write();
  } catch (error) {
    throw new RuntimeStateUnavailableError(error);
  }
};

const providerError = (error: unknown): RuntimeProviderError => {
  if (error instanceof RuntimeStateUnavailableError) {
    return {
      kind: 'stateUnavailable',
      retryable: true,
      message: error.message,
    };
  }
  if (error instanceof ProviderAdapterError) {
    return error.details;
  }
  if (error instanceof RuntimeProtocolError) {
    return error.details;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      kind: 'cancelled',
      retryable: false,
      message: 'The Turn was cancelled.',
    };
  }
  return {
    kind: 'unknown',
    retryable: false,
    message: error instanceof Error ? error.message : 'The Turn failed.',
  };
};

const usageFromEvent = (event: Event): RuntimeUsage | undefined => {
  const usage = event.usageMetadata;
  if (!usage) {
    return undefined;
  }
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const contextInputTokens =
    isRecord(event.customMetadata) &&
    typeof event.customMetadata.contextInputTokens === 'number'
      ? event.customMetadata.contextInputTokens
      : inputTokens;
  return {
    inputTokens,
    contextInputTokens,
    outputTokens,
    ...(usage.thoughtsTokenCount === undefined
      ? {}
      : { reasoningTokens: usage.thoughtsTokenCount }),
    ...(usage.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: usage.cachedContentTokenCount }),
    totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
  };
};

type StoredAssetContent = Readonly<{
  asset: RuntimeAssetDescriptor;
  data: string;
}>;

type ActiveTerminal = {
  requestId: string;
  workspaceId: string;
  threadId?: string;
  generation: number;
  sessionId: string;
  nextOutputSequence: number;
  paused: boolean;
  timer?: NodeJS.Timeout;
};

type TerminalExitReason = Extract<
  RuntimeEvent,
  { type: 'terminal.exited' }
>['reason'];

const isTerminalExitReason = (value: unknown): value is TerminalExitReason =>
  ['natural', 'requested', 'ownerLost', 'protocolError', 'ioError'].includes(
    String(value),
  );

export class RuntimeHost {
  private readonly postEvent: RuntimeHostOptions['postEvent'];
  private readonly createModel: NonNullable<RuntimeHostOptions['createModel']>;
  private readonly loadNative: NonNullable<RuntimeHostOptions['loadNative']>;
  private readonly sessions = new InMemorySessionService();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly activeTurnThreads = new Map<string, string>();
  private readonly activeTurnSelections = new Map<
    string,
    RuntimeModelSelection
  >();
  private readonly activeTurnSkills = new Map<string, TurnSkills>();
  private readonly activeGoalSessions = new Map<string, GoalTurnSession>();
  private readonly pendingSteersByTurn = new Map<
    string,
    RuntimeContentPart[][]
  >();
  private readonly cancellationSources = new Map<string, 'stopButton'>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly activeOperations = new Map<string, Set<string>>();
  private readonly terminals = new Map<string, ActiveTerminal>();
  private readonly mcp = new RuntimeMcpManager();
  private readonly collaboration = new CollaborationCoordinator();
  private readonly contextManager = new ContextManager();
  private readonly imageAnalyzer = new ImageAnalyzer();
  private readonly videoAnalyzer: VideoAnalyzer;
  private sequence = 0;
  private initialized = false;
  private shuttingDown = false;
  private nativeRuntime: NativeRuntimeBinding | null = null;
  private revisionNativeAvailable = false;

  constructor(options: RuntimeHostOptions) {
    this.postEvent = options.postEvent;
    this.createModel = options.createModel ?? defaultCreateModel;
    this.loadNative = options.loadNative ?? loadNativeRuntime;
    this.videoAnalyzer = options.videoAnalyzer ?? new VideoAnalyzer();
  }

  handle = (command: RuntimeCommand): void => {
    switch (command.type) {
      case 'initialize':
        this.videoAnalyzer.setFfmpegPath(command.ffmpegPath);
        if (command.nativeModulePath) {
          this.nativeRuntime = this.loadNative(
            command.nativeModulePath,
            command.dataDirectory,
          );
          this.revisionNativeAvailable =
            typeof this.nativeRuntime.replaceLatestTurnWithUserMessage ===
            'function';
          this.mcp.configure(
            this.parseNativeJson<McpConfigInspection>(
              this.nativeRuntime.inspectMcpConfigJson(),
            ),
          );
          this.restorePendingApprovals();
        }
        this.initialized = true;
        this.emit({
          type: 'runtime.ready',
          requestId: command.requestId,
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
        });
        this.publishPendingApprovals();
        break;
      case 'workspace.open':
        this.requireReady(command.requestId);
        this.requireNative().ensureWorkspace(
          command.workspaceId,
          command.canonicalRoot,
        );
        this.emit({
          type: 'workspace.opened',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          canonicalRoot: command.canonicalRoot,
        });
        break;
      case 'workspace.list':
        this.requireReady(command.requestId);
        void this.listWorkspace(command);
        break;
      case 'workspace.pathSearch':
        this.requireReady(command.requestId);
        void this.searchWorkspacePaths(command);
        break;
      case 'workspace.inspect':
        this.requireReady(command.requestId);
        this.emit({
          type: 'workspace.inspected',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          document: this.parseNativeJson<RuntimeWorkspaceDocument>(
            this.requireNative().workspaceInspectJson(
              command.workspaceId,
              command.path,
            ),
          ),
        });
        break;
      case 'workspace.resolve':
        this.requireReady(command.requestId);
        void this.resolveWorkspace(command);
        break;
      case 'environment.inspect':
        this.requireReady(command.requestId);
        this.emit({
          type: 'environment.inspection',
          requestId: command.requestId,
          status: this.parseNativeJson<CommandEnvironmentStatus>(
            this.requireNative().inspectCommandEnvironmentJson(
              command.workspaceId,
              command.threadId,
            ),
          ),
        });
        break;
      case 'environment.refresh':
        this.requireReady(command.requestId);
        void this.requireNative()
          .refreshCommandEnvironmentJson(command.workspaceId, command.threadId)
          .then((value) => {
            this.emit({
              type: 'environment.action',
              requestId: command.requestId,
              action: {
                accepted: true,
                status: this.parseNativeJson<CommandEnvironmentStatus>(value),
              },
            });
          })
          .catch(() => {
            this.emit({
              type: 'environment.action',
              requestId: command.requestId,
              action: { accepted: false },
            });
          });
        break;
      case 'environment.profileLoadingSet':
        this.requireReady(command.requestId);
        this.emit({
          type: 'environment.action',
          requestId: command.requestId,
          action: this.parseNativeJson<CommandEnvironmentActionResult>(
            this.requireNative().setCommandProfileLoadingEnabledJson(
              command.enabled,
            ),
          ),
        });
        break;
      case 'taskWorkspace.inspect':
        this.requireReady(command.requestId);
        this.emit({
          type: 'taskWorkspace.inspection',
          requestId: command.requestId,
          workspace: this.parseNativeJson<TaskWorkspaceStatus>(
            this.requireNative().inspectTaskWorkspaceJson(
              command.workspaceId,
              command.threadId,
            ),
          ),
        });
        break;
      case 'taskWorkspace.set': {
        this.requireReady(command.requestId);
        const taskIsActive = [...this.activeTurnThreads.values()].includes(
          command.threadId,
        );
        const taskHasTerminal = [...this.terminals.values()].some(
          (terminal) =>
            terminal.workspaceId === command.workspaceId &&
            terminal.threadId === command.threadId,
        );
        this.emit({
          type: 'taskWorkspace.action',
          requestId: command.requestId,
          action:
            taskIsActive || taskHasTerminal
              ? { accepted: false }
              : this.parseNativeJson<TaskWorkspaceActionResult>(
                  this.requireNative().setTaskWorkspaceModeJson(
                    command.workspaceId,
                    command.threadId,
                    command.mode,
                  ),
                ),
        });
        break;
      }
      case 'asset.import':
        this.requireReady(command.requestId);
        {
          const native = this.requireNative();
          if (command.localPath && !native.importVideoPathJson) {
            throw new Error(
              'The native runtime does not support path-based video imports.',
            );
          }
          const importedJson = command.localPath
            ? native.importVideoPathJson?.(
                command.fileName,
                command.mediaType,
                command.localPath,
              )
            : native.importAssetJson(
                command.fileName,
                command.mediaType,
                command.data,
              );
          if (!importedJson) {
            throw new Error(
              'The native runtime did not return imported video metadata.',
            );
          }
          this.emit({
            type: 'asset.imported',
            requestId: command.requestId,
            asset: this.parseNativeJson<RuntimeAssetDescriptor>(importedJson),
          });
        }
        break;
      case 'asset.preview': {
        this.requireReady(command.requestId);
        const stored = this.parseNativeJson<StoredImageContent>(
          this.requireNative().readAssetJson(command.assetId),
        );
        if (stored.asset.assetId !== command.assetId) {
          throw new Error(
            'Stored asset metadata does not match the preview request.',
          );
        }
        this.emit({
          type: 'asset.preview',
          requestId: command.requestId,
          preview:
            stored.asset.kind !== 'image'
              ? { available: false, reason: 'unsupported' }
              : stored.data.length + 128 >
                  MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH
                ? { available: false, reason: 'tooLarge' }
                : { available: true, asset: stored.asset, data: stored.data },
        });
        break;
      }
      case 'turn.start':
      case 'turn.startGoal':
      case 'turn.startQueued':
      case 'turn.revise':
        this.requireReady(command.requestId);
        void this.startTurn(command);
        break;
      case 'goal.mutate': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.mutateGoalJson) {
          throw new Error('The native runtime does not support Goals.');
        }
        const goal = this.parseNativeJson<GoalSnapshot | null>(
          native.mutateGoalJson(
            command.threadId,
            JSON.stringify({ ...command.mutation, goalId: command.goalId }),
          ),
        );
        if (goal) {
          for (const session of this.activeGoalSessions.values()) {
            session.refresh(goal);
          }
        }
        this.emit({
          type: 'goal.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          goal,
        });
        break;
      }
      case 'queue.messageCreate': {
        this.requireReady(command.requestId);
        const content = this.nativeRuntime
          ? resolveKnowledgeReferences(
              this.nativeRuntime,
              command.workspaceId,
              command.content,
              command.threadId,
            )
          : command.content;
        const queue = this.parseNativeJson<RuntimeThreadQueue>(
          this.requireQueueNative().createQueuedMessageJson(
            command.threadId,
            command.queueItemId,
            JSON.stringify(content),
            command.modelProfileId,
            command.modelRequest
              ? JSON.stringify(command.modelRequest)
              : undefined,
          ),
        );
        this.emit({
          type: 'queue.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          queue,
        });
        break;
      }
      case 'queue.messageUpdate': {
        this.requireReady(command.requestId);
        const content = this.nativeRuntime
          ? resolveKnowledgeReferences(
              this.nativeRuntime,
              command.workspaceId,
              command.content,
              command.threadId,
            )
          : command.content;
        const queue = this.parseNativeJson<RuntimeThreadQueue>(
          this.requireQueueNative().updateQueuedMessageJson(
            command.threadId,
            command.queueItemId,
            command.expectedRevision,
            JSON.stringify(content),
            command.modelProfileId,
            command.modelRequest
              ? JSON.stringify(command.modelRequest)
              : undefined,
          ),
        );
        this.emit({
          type: 'queue.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          queue,
        });
        break;
      }
      case 'queue.messageDelete': {
        this.requireReady(command.requestId);
        const queue = this.parseNativeJson<RuntimeThreadQueue>(
          this.requireQueueNative().deleteQueuedMessageJson(
            command.threadId,
            command.queueItemId,
            command.expectedRevision,
          ),
        );
        this.emit({
          type: 'queue.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          queue,
        });
        break;
      }
      case 'queue.pause':
      case 'queue.resume': {
        this.requireReady(command.requestId);
        const queue = this.parseNativeJson<RuntimeThreadQueue>(
          this.requireQueueNative().setQueuePausedJson(
            command.threadId,
            command.type === 'queue.pause',
          ),
        );
        this.emit({
          type: 'queue.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          queue,
        });
        break;
      }
      case 'turn.steerQueued': {
        this.requireReady(command.requestId);
        if (
          !this.activeTurns.has(command.expectedTurnId) ||
          this.activeTurnThreads.get(command.expectedTurnId) !==
            command.threadId ||
          this.activeTurns.get(command.expectedTurnId)?.signal.aborted
        ) {
          throw new Error('turnMismatch');
        }
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().loadThreadJson(command.threadId),
        );
        const queued = snapshot.queue.messages.find(
          (message) => message.id === command.queueItemId,
        );
        if (!queued) {
          throw new Error('queueItemNotFound');
        }
        if (queued.revision !== command.expectedRevision) {
          throw new Error('queueRevisionMismatch');
        }
        const activeSelection = this.activeTurnSelections.get(
          command.expectedTurnId,
        );
        if (!activeSelection) {
          throw new Error('notSteerable');
        }
        this.contentFromParts(queued.content, activeSelection);
        const activeSkills = this.activeTurnSkills.get(command.expectedTurnId);
        if (!activeSkills) {
          throw new Error('notSteerable');
        }
        activeSkills.validateSteering(queued.content);
        if (
          queued.content.some(
            (part) =>
              part.type === 'text' &&
              parseComposerSubmission(part.text).references.some(
                (reference) => reference.kind === 'command',
              ),
          )
        ) {
          throw new Error('notSteerable');
        }
        const itemId = `${command.expectedTurnId}:steer:${command.queueItemId}`;
        const taken = this.parseNativeJson<{
          message: { content: RuntimeContentPart[] };
          queue: RuntimeThreadQueue;
        }>(
          this.requireQueueNative().steerQueuedMessageJson(
            command.threadId,
            command.queueItemId,
            command.expectedRevision,
            command.expectedTurnId,
            itemId,
            this.sequence + 1,
          ),
        );
        const pending =
          this.pendingSteersByTurn.get(command.expectedTurnId) ?? [];
        pending.push([...taken.message.content]);
        this.pendingSteersByTurn.set(command.expectedTurnId, pending);
        this.emitTransient({
          type: 'turn.steered',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.expectedTurnId,
          itemId,
          content: taken.message.content,
          queue: taken.queue,
        });
        break;
      }
      case 'context.compact':
        this.requireReady(command.requestId);
        void this.compactContext(command);
        break;
      case 'turn.cancel':
        if (this.activeTurns.has(command.turnId)) {
          this.cancellationSources.set(command.turnId, command.source);
          this.activeTurns.get(command.turnId)?.abort();
        }
        this.collaboration.cancelTurn(command.turnId);
        this.cancelTurnApprovals(command.turnId);
        this.cancelTurnUserInputs(command.turnId);
        this.cancelTurnOperations(command.turnId);
        break;
      case 'turn.userInputResponse': {
        const pending = this.pendingUserInputs.get(command.inputRequestId);
        const expectedQuestionIds = pending?.questions.map(
          (question) => question.id,
        );
        const submittedDecisions = new Map(
          command.submission.decisions.map((decision) => [
            decision.questionId,
            decision,
          ]),
        );
        const questions = new Map(
          pending?.questions.map((question) => [question.id, question]),
        );
        const decisionsValid = command.submission.decisions.every(
          (decision) => {
            const question = questions.get(decision.questionId);
            return Boolean(
              question &&
              (decision.kind !== 'answered' ||
                decision.source !== 'option' ||
                question.options.some(
                  (option) => option.label === decision.answer,
                )),
            );
          },
        );
        if (
          !pending ||
          pending.workspaceId !== command.workspaceId ||
          pending.threadId !== command.threadId ||
          pending.turnId !== command.turnId ||
          !decisionsValid ||
          (command.submission.kind === 'submitted' &&
            (expectedQuestionIds?.length !==
              command.submission.decisions.length ||
              !expectedQuestionIds.every((id) => submittedDecisions.has(id))))
        ) {
          this.emit({
            type: 'runtime.log',
            requestId: command.requestId,
            level: 'warn',
            message: `User input ${command.inputRequestId} has no matching pending runtime tool.`,
          });
          break;
        }
        const decisions = expectedQuestionIds.flatMap((questionId) => {
          const decision = submittedDecisions.get(questionId);
          return decision ? [decision] : [];
        });
        const submission: RuntimeUserInputSubmission = {
          kind: command.submission.kind,
          decisions,
        };
        this.pendingUserInputs.delete(command.inputRequestId);
        this.emit({
          type: 'turn.userInputResolved',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          inputRequestId: command.inputRequestId,
          submission,
        });
        pending.resolve(submission);
        break;
      }
      case 'terminal.create':
        this.requireReady(command.requestId);
        this.createTerminal(command);
        break;
      case 'terminal.input':
        this.requireReady(command.requestId);
        if (
          this.handleTerminalAction(command, () =>
            this.requireNative().terminalInput(command.sessionId, command.data),
          )
        ) {
          this.emit({
            type: 'terminal.inputAccepted',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            generation: command.generation,
            sessionId: command.sessionId,
            inputBytes: Buffer.byteLength(command.data, 'utf8'),
          });
        }
        break;
      case 'terminal.resize':
        this.requireReady(command.requestId);
        this.handleTerminalAction(command, () =>
          this.requireNative().terminalResize(
            command.sessionId,
            command.columns,
            command.rows,
          ),
        );
        break;
      case 'terminal.flow': {
        this.requireReady(command.requestId);
        const terminal = this.terminals.get(command.sessionId);
        if (terminal && this.matchesTerminal(terminal, command)) {
          terminal.paused = command.paused;
          if (!command.paused) {
            this.scheduleTerminalPoll(terminal);
          }
        }
        break;
      }
      case 'terminal.terminate':
        this.requireReady(command.requestId);
        this.handleTerminalAction(command, () =>
          this.requireNative().terminalTerminate(command.sessionId),
        );
        break;
      case 'terminal.close':
        this.closeTerminal(command.sessionId);
        break;
      case 'approval.resolve': {
        const pending = this.pendingApprovals.get(command.approvalId);
        if (
          !pending ||
          pending.workspaceId !== command.workspaceId ||
          pending.threadId !== command.threadId ||
          pending.turnId !== command.turnId
        ) {
          this.emit({
            type: 'runtime.log',
            requestId: command.requestId,
            level: 'warn',
            message: `Approval ${command.approvalId} has no matching pending runtime tool.`,
          });
          break;
        }
        this.finishApproval(
          command.approvalId,
          pending,
          command.decision,
          command.requestId,
          command.source,
        );
        break;
      }
      case 'mcp.configInspect': {
        this.requireReady(command.requestId);
        const inspection = this.parseNativeJson<McpConfigInspection>(
          this.requireNative().inspectMcpConfigJson(),
        );
        this.mcp.configure(inspection);
        this.emit({
          type: 'mcp.configInspection',
          requestId: command.requestId,
          inspection,
        });
        break;
      }
      case 'mcp.configSave': {
        this.requireReady(command.requestId);
        if (
          this.activeTurns.size > 0 ||
          this.pendingApprovals.size > 0 ||
          this.mcp.getActiveServerIds().length > 0
        ) {
          const reason =
            this.activeTurns.size > 0
              ? 'turnActive'
              : this.pendingApprovals.size > 0
                ? 'approvalPending'
                : 'sessionActive';
          this.emit({
            type: 'mcp.configAction',
            requestId: command.requestId,
            action: { accepted: false, reason },
          });
          break;
        }
        try {
          const action = this.parseNativeJson<McpConfigActionResult>(
            this.requireNative().saveMcpConfigJson(
              command.request.expectedRevision,
              JSON.stringify(command.request.servers),
            ),
          );
          if (action.inspection) {
            this.mcp.configure(action.inspection);
          }
          this.emit({
            type: 'mcp.configAction',
            requestId: command.requestId,
            action,
          });
        } catch {
          this.emit({
            type: 'mcp.configAction',
            requestId: command.requestId,
            action: { accepted: false, reason: 'unavailable' },
          });
        }
        break;
      }
      case 'mcp.sessionSet':
        this.requireReady(command.requestId);
        void this.setMcpSession(command);
        break;
      case 'skills.inspect': {
        this.requireReady(command.requestId);
        const inspection = this.parseNativeJson<SkillsInspection>(
          this.requireNative().inspectSkillsJson(command.workspaceId),
        );
        this.emit({
          type: 'skills.inspection',
          requestId: command.requestId,
          inspection,
        });
        break;
      }
      case 'skills.content': {
        this.requireReady(command.requestId);
        const content = this.parseNativeJson<SkillContent>(
          this.requireNative().readSkillContentJson(
            command.workspaceId,
            command.skillId,
            command.expectedSha256,
          ),
        );
        this.emit({
          type: 'skills.content',
          requestId: command.requestId,
          content,
        });
        break;
      }
      case 'skills.setEnabled': {
        this.requireReady(command.requestId);
        const inspection = this.parseNativeJson<SkillsInspection>(
          this.requireNative().setSkillEnabledJson(
            command.workspaceId,
            command.skillId,
            command.enabled,
          ),
        );
        this.emit({
          type: 'skills.action',
          requestId: command.requestId,
          action: { accepted: true, inspection },
        });
        break;
      }
      case 'skills.import': {
        this.requireReady(command.requestId);
        const inspection = this.parseNativeJson<SkillsInspection>(
          this.requireNative().importSkillJson(
            command.workspaceId,
            command.sourcePath,
          ),
        );
        this.emit({
          type: 'skills.action',
          requestId: command.requestId,
          action: { accepted: true, inspection },
        });
        break;
      }
      case 'skills.export': {
        this.requireReady(command.requestId);
        const result = this.parseNativeJson<{ path: string }>(
          this.requireNative().exportSkillJson(
            command.workspaceId,
            command.skillId,
            command.destinationPath,
          ),
        );
        const action: SkillsActionResult = {
          accepted: true,
          path: result.path,
        };
        this.emit({
          type: 'skills.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'skills.importZip': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.importSkillZipJson)
          throw new Error('Skill ZIP import is unavailable.');
        const inspection = this.parseNativeJson<SkillsInspection>(
          native.importSkillZipJson(command.workspaceId, command.archivePath),
        );
        this.emit({
          type: 'skills.action',
          requestId: command.requestId,
          action: { accepted: true, inspection },
        });
        break;
      }
      case 'skills.exportZip': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.exportSkillZipJson)
          throw new Error('Skill ZIP export is unavailable.');
        const result = this.parseNativeJson<{ path: string }>(
          native.exportSkillZipJson(
            command.workspaceId,
            command.skillId,
            command.destinationPath,
          ),
        );
        this.emit({
          type: 'skills.action',
          requestId: command.requestId,
          action: { accepted: true, path: result.path },
        });
        break;
      }
      case 'knowledge.inspect': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.inspectKnowledgeJson)
          throw new Error('Knowledge runtime is unavailable.');
        const inspection = this.parseNativeJson<KnowledgeInspection>(
          native.inspectKnowledgeJson(command.workspaceId),
        );
        this.emit({
          type: 'knowledge.inspection',
          requestId: command.requestId,
          inspection,
        });
        break;
      }
      case 'knowledge.create': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.createKnowledgeBaseJson)
          throw new Error('Knowledge runtime is unavailable.');
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.createKnowledgeBaseJson(
            command.name,
            command.description,
            JSON.stringify(command.workspaceIds),
          ),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.update': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.updateKnowledgeBaseJson) {
          throw new Error('Knowledge settings are unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.updateKnowledgeBaseJson(
            command.knowledgeBaseId,
            command.name,
            command.description,
            JSON.stringify(command.workspaceIds),
            JSON.stringify(command.ignoreRules),
            command.semanticEnabled,
          ),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.delete': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.deleteKnowledgeBaseJson)
          throw new Error('Knowledge runtime is unavailable.');
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.deleteKnowledgeBaseJson(command.knowledgeBaseId),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.addFiles': {
        this.requireReady(command.requestId);
        void this.addKnowledgeFiles(command);
        break;
      }
      case 'knowledge.addFolder': {
        this.requireReady(command.requestId);
        void this.addKnowledgeFolder(command);
        break;
      }
      case 'knowledge.text.create': {
        this.requireReady(command.requestId);
        void this.mutateKnowledgeText(command);
        break;
      }
      case 'knowledge.text.read': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.readKnowledgeTextDocumentJson) {
          throw new Error('Knowledge text editing is unavailable.');
        }
        const document = this.parseNativeJson<KnowledgeEditableDocument>(
          native.readKnowledgeTextDocumentJson(command.sourceId),
        );
        this.emit({
          type: 'knowledge.textDocument',
          requestId: command.requestId,
          document,
        });
        break;
      }
      case 'knowledge.text.update': {
        this.requireReady(command.requestId);
        void this.mutateKnowledgeText(command);
        break;
      }
      case 'knowledge.source.delete': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.deleteKnowledgeSourceJson) {
          throw new Error('Knowledge source deletion is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.deleteKnowledgeSourceJson(command.sourceId),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.source.rescan': {
        this.requireReady(command.requestId);
        void this.rescanKnowledgeSource(command);
        break;
      }
      case 'knowledge.index.cancel': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.cancelKnowledgeIndexJobJson) {
          throw new Error('Knowledge indexing control is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.cancelKnowledgeIndexJobJson(command.jobId),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.detail': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.inspectKnowledgeBaseJson)
          throw new Error('Knowledge runtime is unavailable.');
        const detail = this.parseNativeJson<KnowledgeBaseDetail>(
          native.inspectKnowledgeBaseJson(command.knowledgeBaseId),
        );
        this.emit({
          type: 'knowledge.detail',
          requestId: command.requestId,
          detail,
        });
        break;
      }
      case 'knowledge.search': {
        this.requireReady(command.requestId);
        void this.searchKnowledge(command);
        break;
      }
      case 'knowledge.model.install': {
        this.requireReady(command.requestId);
        void this.installSemanticModel(command);
        break;
      }
      case 'knowledge.model.cancel': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.cancelSemanticModelDownloadJson) {
          throw new Error('Semantic model download control is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.cancelSemanticModelDownloadJson(),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.model.remove': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.removeSemanticModelJson) {
          throw new Error('Semantic model removal is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.removeSemanticModelJson(),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.retrieval.select': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.selectKnowledgeRetrievalPlanJson) {
          throw new Error('Knowledge retrieval selection is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.selectKnowledgeRetrievalPlanJson(command.planId),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'knowledge.semanticIndex.pause': {
        this.requireReady(command.requestId);
        const native = this.requireNative();
        if (!native.setSemanticIndexPausedJson) {
          throw new Error('Semantic index pause control is unavailable.');
        }
        const action = this.parseNativeJson<KnowledgeActionResult>(
          native.setSemanticIndexPausedJson(command.paused),
        );
        this.emit({
          type: 'knowledge.action',
          requestId: command.requestId,
          action,
        });
        break;
      }
      case 'thread.list':
        this.requireReady(command.requestId);
        this.emit({
          type: 'thread.listResult',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          query: command.query ?? '',
          threads: this.parseNativeJson<RuntimeThreadRecord[]>(
            this.requireNative().listThreadsJson(
              command.workspaceId,
              command.query,
            ),
          ),
        });
        break;
      case 'thread.load':
        this.requireReady(command.requestId);
        this.emit({
          type: 'thread.loaded',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          snapshot: this.parseNativeJson<RuntimeThreadSnapshot>(
            this.requireNative().loadThreadJson(command.threadId),
          ),
        });
        break;
      case 'thread.create': {
        this.requireReady(command.requestId);
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().createThreadJson(
            command.workspaceId,
            command.title,
          ),
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'create',
          threadId: snapshot.thread.id,
          snapshot,
        });
        break;
      }
      case 'thread.rename': {
        this.requireReady(command.requestId);
        const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
          this.requireNative().updateThreadTitleJson(
            command.threadId,
            command.workspaceId,
            command.title.trim(),
            false,
          ),
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'rename',
          threadId: command.threadId,
          snapshot,
        });
        break;
      }
      case 'thread.delete': {
        this.requireReady(command.requestId);
        const deleted = this.requireNative().deleteThread(
          command.threadId,
          command.workspaceId,
        );
        this.emit({
          type: 'thread.mutated',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'delete',
          threadId: command.threadId,
          deleted,
        });
        break;
      }
      case 'git.status':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'status',
          result: this.parseNativeJson(
            this.requireNative().gitStatusJson(
              command.threadId
                ? this.taskWorkspaceBindingId(
                    command.workspaceId,
                    command.threadId,
                  )
                : command.workspaceId,
            ),
          ),
        });
        break;
      case 'git.diff':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'diff',
          result: this.parseNativeJson(
            this.requireNative().gitDiffJson(
              command.threadId
                ? this.taskWorkspaceBindingId(
                    command.workspaceId,
                    command.threadId,
                  )
                : command.workspaceId,
              command.expectedRevision,
              command.path,
              command.source,
            ),
          ),
        });
        break;
      case 'git.stage':
      case 'git.unstage': {
        const operation = command.type === 'git.stage' ? 'stage' : 'unstage';
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation,
          result: this.parseNativeJson(
            this.requireNative().gitMutateJson(
              command.threadId
                ? this.taskWorkspaceBindingId(
                    command.workspaceId,
                    command.threadId,
                  )
                : command.workspaceId,
              command.expectedRevision,
              command.paths,
              operation === 'stage',
            ),
          ),
        });
        break;
      }
      case 'git.commit':
        this.emit({
          type: 'git.result',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          operation: 'commit',
          result: this.parseNativeJson(
            this.requireNative().gitCommitJson(
              command.threadId
                ? this.taskWorkspaceBindingId(
                    command.workspaceId,
                    command.threadId,
                  )
                : command.workspaceId,
              command.expectedRevision,
              command.message,
              command.authorName,
              command.authorEmail,
            ),
          ),
        });
        break;
      case 'model.inspect':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configInspection',
          requestId: command.requestId,
          inspection: this.parseNativeJson(
            this.requireNative().inspectModelConfigJson(),
          ),
        });
        break;
      case 'model.save':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configAction',
          requestId: command.requestId,
          action: this.parseNativeJson(
            this.requireNative().saveModelConfigJson(
              command.request.expectedRevision,
              JSON.stringify(command.request.config),
              JSON.stringify(command.request.credentialUpdates),
            ),
          ),
        });
        break;
      case 'model.deleteApiKey':
        this.requireReady(command.requestId);
        this.emit({
          type: 'model.configAction',
          requestId: command.requestId,
          action: this.parseNativeJson(
            this.requireNative().deleteModelApiKeyJson(
              command.connectionId,
              command.expectedRevision,
            ),
          ),
        });
        break;
      case 'model.discover':
        this.requireReady(command.requestId);
        void this.discover(command.requestId, command.connectionId);
        break;
      case 'shutdown':
        this.shuttingDown = true;
        for (const controller of this.activeTurns.values()) {
          controller.abort();
        }
        for (const turnId of this.activeTurns.keys()) {
          this.collaboration.cancelTurn(turnId);
          this.cancelTurnApprovals(turnId);
          this.cancelTurnOperations(turnId);
        }
        this.activeTurns.clear();
        this.activeTurnThreads.clear();
        this.nativeRuntime?.setKnowledgeAgentActive?.(false);
        for (const sessionId of [...this.terminals.keys()]) {
          this.closeTerminal(sessionId);
        }
        void this.mcp.close();
        break;
    }
  };

  private addKnowledgeFiles = async (
    command: Extract<RuntimeCommand, { type: 'knowledge.addFiles' }>,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      if (!native.addKnowledgeFilesJson)
        throw new Error('Knowledge runtime is unavailable.');
      const result = this.parseNativeJson<{
        indexed: number;
        skipped: number;
        errors: number;
      }>(
        await native.addKnowledgeFilesJson(
          command.knowledgeBaseId,
          JSON.stringify(command.paths),
        ),
      );
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: { accepted: true, ...result },
      });
    } catch (error) {
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: {
          accepted: false,
          reason: 'unavailable',
          message:
            error instanceof Error
              ? error.message
              : 'Knowledge indexing failed.',
        },
      });
    }
  };

  private mutateKnowledgeText = async (
    command: Extract<
      RuntimeCommand,
      { type: 'knowledge.text.create' | 'knowledge.text.update' }
    >,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      const result =
        command.type === 'knowledge.text.create'
          ? await (() => {
              if (!native.createKnowledgeTextDocumentJson) {
                throw new Error('Knowledge text creation is unavailable.');
              }
              return native.createKnowledgeTextDocumentJson(
                command.knowledgeBaseId,
                command.fileName,
                command.content,
              );
            })()
          : await (() => {
              if (!native.updateKnowledgeTextDocumentJson) {
                throw new Error('Knowledge text editing is unavailable.');
              }
              return native.updateKnowledgeTextDocumentJson(
                command.sourceId,
                command.expectedSha256,
                command.content,
              );
            })();
      const indexed = this.parseNativeJson<{
        indexed: number;
        skipped: number;
        errors: number;
        deleted?: number;
        jobId?: string;
      }>(result);
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: { accepted: true, ...indexed },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Knowledge document could not be saved.';
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: {
          accepted: false,
          reason: /changed|already exists|UNIQUE|collision/u.test(message)
            ? 'conflict'
            : /invalid|empty|exceeds|\.txt|\.md/u.test(message)
              ? 'invalid'
              : 'unavailable',
          message,
        },
      });
    }
  };

  private installSemanticModel = async (
    command: Extract<RuntimeCommand, { type: 'knowledge.model.install' }>,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      if (!native.installSemanticModelJson) {
        throw new Error('Semantic model installation is unavailable.');
      }
      const action = this.parseNativeJson<KnowledgeActionResult>(
        await native.installSemanticModelJson(),
      );
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action,
      });
    } catch (error) {
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: {
          accepted: false,
          reason: 'unavailable',
          message:
            error instanceof Error
              ? error.message
              : 'Semantic model installation failed.',
        },
      });
    }
  };

  private searchKnowledge = async (
    command: Extract<RuntimeCommand, { type: 'knowledge.search' }>,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      if (!native.searchKnowledgeJson) {
        throw new Error('Knowledge runtime is unavailable.');
      }
      const result = this.parseNativeJson<KnowledgeSearchResult>(
        await native.searchKnowledgeJson(
          command.workspaceId,
          JSON.stringify(command.knowledgeBaseIds),
          command.query,
        ),
      );
      this.emit({
        type: 'knowledge.searchResult',
        requestId: command.requestId,
        result,
      });
    } catch (error) {
      this.emit({
        type: 'runtime.log',
        requestId: command.requestId,
        level: 'error',
        message:
          error instanceof Error ? error.message : 'Knowledge search failed.',
      });
    }
  };

  private addKnowledgeFolder = async (
    command: Extract<RuntimeCommand, { type: 'knowledge.addFolder' }>,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      if (!native.addKnowledgeFolderJson)
        throw new Error('Knowledge runtime is unavailable.');
      const result = this.parseNativeJson<{
        indexed: number;
        skipped: number;
        errors: number;
      }>(
        await native.addKnowledgeFolderJson(
          command.knowledgeBaseId,
          command.path,
        ),
      );
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: { accepted: true, ...result },
      });
    } catch (error) {
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: {
          accepted: false,
          reason: 'unavailable',
          message:
            error instanceof Error
              ? error.message
              : 'Knowledge indexing failed.',
        },
      });
    }
  };

  private rescanKnowledgeSource = async (
    command: Extract<RuntimeCommand, { type: 'knowledge.source.rescan' }>,
  ): Promise<void> => {
    try {
      const native = this.requireNative();
      if (!native.rescanKnowledgeSourceJson) {
        throw new Error('Knowledge source rescanning is unavailable.');
      }
      const result = this.parseNativeJson<{
        indexed: number;
        skipped: number;
        errors: number;
        deleted?: number;
        jobId?: string;
      }>(
        await native.rescanKnowledgeSourceJson(
          command.sourceId,
          command.rebuild,
        ),
      );
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: { accepted: true, ...result },
      });
    } catch (error) {
      this.emit({
        type: 'knowledge.action',
        requestId: command.requestId,
        action: {
          accepted: false,
          reason: 'unavailable',
          message:
            error instanceof Error
              ? error.message
              : 'Knowledge rescanning failed.',
        },
      });
    }
  };

  private listWorkspace = async (
    command: Extract<RuntimeCommand, { type: 'workspace.list' }>,
  ): Promise<void> => {
    try {
      const nativePath = command.path || '.';
      const result = this.parseNativeJson<{
        ok: boolean;
        entries?: readonly Readonly<{
          name: string;
          kind: RuntimeWorkspaceEntry['kind'];
        }>[];
      }>(
        await this.requireNative().workspaceList(
          command.workspaceId,
          nativePath,
        ),
      );
      if (!result.ok || !result.entries) {
        throw new Error('The workspace directory could not be listed.');
      }
      const prefix = command.path.length > 0 ? `${command.path}/` : '';
      this.emit({
        type: 'workspace.listResult',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        path: command.path,
        entries: result.entries.map((entry) => ({
          name: entry.name,
          path: `${prefix}${entry.name}`,
          kind: entry.kind,
        })),
      });
    } catch (error) {
      this.emit({
        type: 'runtime.log',
        requestId: command.requestId,
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'The workspace directory could not be listed.',
      });
    }
  };

  private searchWorkspacePaths = async (
    command: Extract<RuntimeCommand, { type: 'workspace.pathSearch' }>,
  ): Promise<void> => {
    try {
      const result = this.parseNativeJson<{
        ok: boolean;
        paths?: readonly string[];
        truncated?: boolean;
      }>(
        await this.requireNative().workspacePathSearchJson(
          command.workspaceId,
          command.query,
        ),
      );
      if (!result.ok || !result.paths) {
        throw new Error('Workspace files could not be searched.');
      }
      this.emit({
        type: 'workspace.pathSearchResult',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        query: command.query,
        paths: result.paths,
        truncated: result.truncated === true,
      });
    } catch (error) {
      this.emit({
        type: 'runtime.log',
        requestId: command.requestId,
        level: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Workspace files could not be searched.',
      });
    }
  };

  private resolveWorkspace = async (
    command: Extract<RuntimeCommand, { type: 'workspace.resolve' }>,
  ): Promise<void> => {
    try {
      const result = this.parseNativeJson<{
        status: 'resolved' | 'notFound' | 'ambiguous' | 'unavailable';
        path?: string;
      }>(
        await this.requireNative().workspaceResolveJson(
          command.workspaceId,
          command.name,
        ),
      );
      this.emit({
        type: 'workspace.resolved',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        name: command.name,
        status: result.status,
        ...(result.status === 'resolved' && result.path
          ? { path: result.path }
          : {}),
      });
    } catch {
      this.emit({
        type: 'workspace.resolved',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        name: command.name,
        status: 'unavailable',
      });
    }
  };

  private requireReady = (requestId: string): void => {
    if (!this.initialized || this.shuttingDown) {
      throw new Error(`Runtime is not ready for request ${requestId}.`);
    }
  };

  private requireNative = (): NativeRuntimeBinding => {
    if (!this.nativeRuntime) {
      throw new Error('The SugarCode native runtime is unavailable.');
    }
    return this.nativeRuntime;
  };

  private requireQueueNative = (): QueueNativeBinding => {
    const native = this.requireNative();
    if (
      typeof native.createQueuedMessageJson !== 'function' ||
      typeof native.updateQueuedMessageJson !== 'function' ||
      typeof native.deleteQueuedMessageJson !== 'function' ||
      typeof native.setQueuePausedJson !== 'function' ||
      typeof native.promoteQueuedMessageJson !== 'function' ||
      typeof native.steerQueuedMessageJson !== 'function'
    ) {
      throw new Error('The native runtime does not support durable queues.');
    }
    return native as QueueNativeBinding;
  };

  private taskWorkspaceBindingId = (
    workspaceId: string,
    threadId: string,
  ): string => {
    const native = this.requireNative();
    return typeof native.taskWorkspaceBindingId === 'function'
      ? native.taskWorkspaceBindingId(workspaceId, threadId)
      : workspaceId;
  };

  private parseNativeJson = <T>(value: string): T => JSON.parse(value) as T;

  private createTerminal = (
    command: Extract<RuntimeCommand, { type: 'terminal.create' }>,
  ): void => {
    if (this.terminals.has(command.sessionId)) {
      this.emitTerminalError(command, 'protocolInvalid', true);
      return;
    }
    try {
      const info = this.parseNativeJson<unknown>(
        this.requireNative().createTerminalJson(
          command.sessionId,
          command.workspaceId,
          command.threadId,
          command.columns,
          command.rows,
        ),
      );
      if (!isRecord(info) || typeof info.shell !== 'string') {
        throw new Error('Native terminal metadata was invalid.');
      }
      const terminal: ActiveTerminal = {
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        ...(command.threadId ? { threadId: command.threadId } : {}),
        generation: command.generation,
        sessionId: command.sessionId,
        nextOutputSequence: 1,
        paused: false,
      };
      this.terminals.set(command.sessionId, terminal);
      this.emit({
        type: 'terminal.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        generation: command.generation,
        sessionId: command.sessionId,
        shell: info.shell,
      });
      this.scheduleTerminalPoll(terminal);
    } catch {
      this.emitTerminalError(command, 'spawnFailed', true);
    }
  };

  private handleTerminalAction = (
    command:
      | Extract<
          RuntimeCommand,
          {
            type: 'terminal.input' | 'terminal.resize';
          }
        >
      | Extract<
          RuntimeCommand,
          {
            type: 'terminal.terminate' | 'terminal.close';
          }
        >,
    action: () => void,
  ): boolean => {
    const terminal = this.terminals.get(command.sessionId);
    if (!terminal || !this.matchesTerminal(terminal, command)) {
      this.emitTerminalError(command, 'protocolInvalid', true);
      return false;
    }
    try {
      action();
      return true;
    } catch {
      this.emitTerminalError(command, 'terminalCrashed', true);
      this.closeTerminal(command.sessionId);
      return false;
    }
  };

  private matchesTerminal = (
    terminal: ActiveTerminal,
    command: { workspaceId: string; generation: number; sessionId: string },
  ): boolean =>
    terminal.workspaceId === command.workspaceId &&
    terminal.generation === command.generation &&
    terminal.sessionId === command.sessionId;

  private scheduleTerminalPoll = (terminal: ActiveTerminal): void => {
    if (
      terminal.paused ||
      terminal.timer ||
      !this.terminals.has(terminal.sessionId)
    ) {
      return;
    }
    terminal.timer = setTimeout(() => {
      terminal.timer = undefined;
      this.pollTerminal(terminal);
    }, 16);
  };

  private pollTerminal = (terminal: ActiveTerminal): void => {
    if (
      terminal.paused ||
      this.terminals.get(terminal.sessionId) !== terminal
    ) {
      return;
    }
    try {
      const events = this.parseNativeJson<unknown>(
        this.requireNative().drainTerminalEventsJson(terminal.sessionId),
      );
      if (!Array.isArray(events)) {
        throw new Error('Native terminal events were invalid.');
      }
      for (const event of events) {
        if (!isRecord(event) || typeof event.type !== 'string') {
          throw new Error('Native terminal event was invalid.');
        }
        if (
          event.type === 'output' &&
          Number.isSafeInteger(event.sequence) &&
          event.sequence === terminal.nextOutputSequence &&
          typeof event.data === 'string' &&
          Buffer.byteLength(event.data, 'utf8') <= 32_768
        ) {
          terminal.nextOutputSequence += 1;
          this.emit({
            type: 'terminal.output',
            requestId: terminal.requestId,
            workspaceId: terminal.workspaceId,
            generation: terminal.generation,
            sessionId: terminal.sessionId,
            outputSequence: event.sequence,
            data: event.data,
          });
        } else if (event.type === 'error' && typeof event.fatal === 'boolean') {
          this.emitTerminalError(
            terminal,
            event.code === 'outputOverload'
              ? 'outputOverload'
              : 'terminalCrashed',
            event.fatal,
          );
          if (event.fatal) {
            this.closeTerminal(terminal.sessionId);
            return;
          }
        } else if (
          event.type === 'exit' &&
          typeof event.exitCode === 'number' &&
          Number.isSafeInteger(event.exitCode) &&
          isTerminalExitReason(event.reason) &&
          (event.signal === undefined || typeof event.signal === 'string')
        ) {
          this.emit({
            type: 'terminal.exited',
            requestId: terminal.requestId,
            workspaceId: terminal.workspaceId,
            generation: terminal.generation,
            sessionId: terminal.sessionId,
            exitCode: event.exitCode,
            ...(typeof event.signal === 'string'
              ? { signal: event.signal }
              : {}),
            reason: event.reason,
          });
          this.closeTerminal(terminal.sessionId);
          return;
        } else {
          throw new Error('Native terminal event was invalid.');
        }
      }
      this.scheduleTerminalPoll(terminal);
    } catch {
      this.emitTerminalError(terminal, 'protocolInvalid', true);
      this.closeTerminal(terminal.sessionId);
    }
  };

  private emitTerminalError = (
    terminal: {
      requestId: string;
      workspaceId: string;
      generation: number;
      sessionId: string;
    },
    error:
      'spawnFailed' | 'protocolInvalid' | 'terminalCrashed' | 'outputOverload',
    fatal: boolean,
  ): void => {
    this.emit({
      type: 'terminal.error',
      requestId: terminal.requestId,
      workspaceId: terminal.workspaceId,
      generation: terminal.generation,
      sessionId: terminal.sessionId,
      error,
      fatal,
    });
  };

  private closeTerminal = (sessionId: string): void => {
    const terminal = this.terminals.get(sessionId);
    if (terminal?.timer) {
      clearTimeout(terminal.timer);
    }
    this.terminals.delete(sessionId);
    try {
      this.nativeRuntime?.closeTerminal(sessionId);
    } catch {
      // Native terminal containment terminates the process tree on drop.
    }
  };

  private ensureSession = async (
    command: TurnContextCommand,
    selection: RuntimeModelSelection,
  ): Promise<void> => {
    const key = {
      appName: APPLICATION_NAME,
      userId: command.workspaceId,
      sessionId: command.threadId,
    };
    if (await this.sessions.getSession(key)) {
      return;
    }
    const session = await this.sessions.createSession(key);
    try {
      if (!this.nativeRuntime) {
        return;
      }
      const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
        this.nativeRuntime.loadThreadJson(command.threadId),
      );
      for (const turn of snapshot.turns) {
        if (turn.status === 'running') {
          continue;
        }
        const items = snapshot.items
          .filter((item) => item.turnId === turn.id)
          .sort((left, right) => left.sequence - right.sequence);
        const storedHistories = new Map<string, StoredModelHistoryV2>();
        const storedToolResultIds = new Set<string>();
        const toolNamesByCallId = new Map<string, string>();
        if (turn.status === 'completed') {
          for (const item of items) {
            if (item.kind === 'turn.toolCall') {
              const callId = item.payload.callId;
              const name = item.payload.name;
              if (typeof callId === 'string' && typeof name === 'string') {
                toolNamesByCallId.set(callId, name);
              }
              continue;
            }
            if (item.kind !== 'turn.modelHistory') {
              continue;
            }
            const history = this.parseStoredModelHistory(item.payload.history);
            storedHistories.set(item.id, history);
            for (const part of history.parts) {
              if (part.type === 'toolCall') {
                toolNamesByCallId.set(part.id, part.name);
              } else if (part.type === 'toolResult') {
                storedToolResultIds.add(part.id);
              }
            }
          }
        }
        for (const item of items) {
          if (
            item.kind === 'turn.userMessage' ||
            item.kind === 'turn.goalContext'
          ) {
            const content = item.payload.content;
            if (
              !Array.isArray(content) ||
              !content.every(isRuntimeContentPart)
            ) {
              throw new Error('Stored user content is invalid.');
            }
            await this.sessions.appendEvent({
              session,
              event: createEvent({
                id: item.id,
                invocationId: `restore:${turn.id}`,
                author: 'user',
                content: this.contentFromParts(content, selection),
              }),
            });
            continue;
          }
          if (
            turn.status !== 'completed' ||
            (item.kind !== 'turn.modelHistory' &&
              item.kind !== 'turn.contextCheckpoint' &&
              item.kind !== 'turn.toolResult')
          ) {
            continue;
          }
          if (item.kind === 'turn.toolResult') {
            const callId = item.payload.callId;
            const result = item.payload.result;
            if (
              typeof callId !== 'string' ||
              !isRecord(result) ||
              storedToolResultIds.has(callId)
            ) {
              continue;
            }
            const name = toolNamesByCallId.get(callId);
            if (!name) {
              continue;
            }
            await this.sessions.appendEvent({
              session,
              event: createEvent({
                id: `legacy-history:${item.id}`,
                invocationId: `restore:${turn.id}`,
                author: 'sugarcode_agent',
                content: this.contentFromHistory({
                  version: 2,
                  role: 'user',
                  parts: [{
                    type: 'toolResult',
                    id: callId,
                    name,
                    result,
                  }],
                }),
              }),
            });
            continue;
          }
          const restored =
            item.kind === 'turn.contextCheckpoint' &&
            typeof item.payload.summary === 'string'
              ? {
                  version: 2 as const,
                  role: 'user' as const,
                  parts: [
                    {
                      type: 'text' as const,
                      text: `[SugarCode context checkpoint]\n${item.payload.summary}`,
                      reasoning: false,
                    },
                  ],
                }
              : storedHistories.get(item.id) ??
                this.parseStoredModelHistory(item.payload.history);
          await this.sessions.appendEvent({
            session,
            event: createEvent({
              id: item.id,
              invocationId: `restore:${turn.id}`,
              author: 'sugarcode_agent',
              content: this.contentFromHistory(restored),
            }),
          });
        }
      }
    } catch (error) {
      await this.sessions.deleteSession(key);
      throw error;
    }
  };

  private contentFromParts = (
    content: readonly RuntimeContentPart[],
    selection: RuntimeModelSelection,
  ): Content => {
    const attachmentBytes = content.reduce(
      (total, part) =>
        total +
        (part.type === 'asset' &&
        (part.asset.kind === 'pdf' || part.asset.kind === 'text')
          ? part.asset.sizeBytes
          : 0),
      0,
    );
    if (attachmentBytes > MAX_CONVERSATION_ATTACHMENT_BYTES) {
      throw new Error('Inline Turn attachments exceed the 25 MiB limit.');
    }
    const parts: Part[] = content.flatMap((part): readonly Part[] => {
      if (part.type === 'text') {
        return [{ text: composerModelText(part.text) }];
      }
      if (part.type === 'knowledgeReferences') {
        return [];
      }
      if (part.asset.kind === 'image') {
        return [{ text: imageAttachmentReference(part.asset) }];
      }
      if (part.asset.kind === 'video') {
        return [{ text: videoAttachmentReference(part.asset) }];
      }
      const stored = this.parseNativeJson<StoredAssetContent>(
        this.requireNative().readAssetJson(part.asset.assetId),
      );
      if (!this.sameAsset(stored.asset, part.asset)) {
        throw new Error(
          'Stored content asset metadata does not match the Turn.',
        );
      }
      if (
        part.asset.kind === 'pdf' &&
        !selection.effectiveCapabilities.pdfInput
      ) {
        throw new Error(
          `The selected model does not accept ${part.asset.kind} input.`,
        );
      }
      if (part.asset.kind === 'text') {
        return [
          {
            text: `Attachment ${part.asset.originalName}:\n${Buffer.from(stored.data, 'base64').toString('utf8')}`,
          },
        ];
      }
      return [
        {
          inlineData: {
            mimeType: part.asset.mediaType,
            data: stored.data,
            displayName: part.asset.originalName,
          },
        },
      ];
    });
    return { role: 'user', parts };
  };

  private sameAsset = (
    left: RuntimeAssetDescriptor,
    right: RuntimeAssetDescriptor,
  ): boolean =>
    left.assetId === right.assetId &&
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.originalName === right.originalName &&
    left.sizeBytes === right.sizeBytes &&
    left.kind === right.kind &&
    left.pdfPages === right.pdfPages;

  private persistModelHistory = (
    command: TurnExecutionCommand,
    event: Event,
  ): void => {
    if (!this.nativeRuntime || !event.content) {
      return;
    }
    const history = this.storedModelHistory(event.content);
    if (history.parts.length === 0) {
      return;
    }
    this.sequence += 1;
    withDurableStateWrite(() =>
      this.nativeRuntime?.appendItem(
        `history:${command.turnId}:${event.id}`,
        command.turnId,
        this.sequence,
        'turn.modelHistory',
        JSON.stringify({ history }),
      ),
    );
  };

  private persistContextCheckpoint = (
    command: TurnContextCommand,
    checkpoint: RuntimeContextCheckpoint,
  ): void => {
    if (!this.nativeRuntime) {
      return;
    }
    this.sequence += 1;
    withDurableStateWrite(() =>
      this.nativeRuntime?.appendItem(
        `checkpoint:${checkpoint.checkpointId}`,
        command.turnId,
        this.sequence,
        'turn.contextCheckpoint',
        JSON.stringify(checkpoint),
      ),
    );
  };

  private storedModelHistory = (content: Content): StoredModelHistoryV2 =>
    encodeModelHistory(content);

  private parseStoredModelHistory = (value: unknown): StoredModelHistoryV2 =>
    parseStoredModelHistory(value);

  private contentFromHistory = (history: StoredModelHistoryV2): Content =>
    contentFromStoredModelHistory(history);

  private resolveProfile = (command: TurnContextCommand): ResolvedProfile => {
    if ('provider' in command && command.provider) {
      const providerFamily =
        command.provider.wireApi === 'anthropicMessages'
          ? 'anthropic'
          : 'openai';
      return {
        provider: command.provider,
        mediaCapabilities: {
          videoInput: 'auto',
          audioInput: 'auto',
        },
        selection: {
          profileId: 'runtime-direct',
          providerFamily,
          wireApi: command.provider.wireApi,
          modelId: command.provider.model,
          displayName: command.provider.model,
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          autoCompaction: 'disabled',
          nativeCompaction: 'disabled',
          reasoningEffort: command.provider.reasoningEffort ?? 'auto',
          serviceTier: command.provider.serviceTier ?? 'auto',
          effectiveCapabilities: {
            toolCalls: true,
            strictTools: false,
            parallelTools: command.provider.parallelTools,
            imageInput: true,
            pdfInput: providerFamily === 'anthropic',
          },
        },
      };
    }
    return this.resolveConfiguredProfile(
      command.modelProfileId,
      'modelRequest' in command ? command.modelRequest : undefined,
    );
  };

  private resolveConfiguredProfile = (
    profileId?: string,
    modelRequest?: import('../shared/model-config.ts').ModelRequestOptions,
  ): ResolvedProfile => {
    const resolved = this.parseNativeJson<unknown>(
      this.requireNative().modelProfileJson(profileId),
    );
    if (
      !isRecord(resolved) ||
      !isRecord(resolved.profile) ||
      !isRecord(resolved.connection)
    ) {
      throw new Error('The selected model profile is invalid.');
    }
    const profile = resolved.profile;
    const connection = resolved.connection;
    const wireApi = connection.wireApi;
    const providerFamily = connection.providerFamily;
    if (
      typeof profile.id !== 'string' ||
      typeof profile.modelId !== 'string' ||
      typeof profile.displayName !== 'string' ||
      !['openai', 'anthropic'].includes(String(providerFamily)) ||
      ![
        'openaiResponses',
        'openaiChatCompletions',
        'anthropicMessages',
      ].includes(String(wireApi)) ||
      typeof connection.baseUrl !== 'string'
    ) {
      throw new Error('The selected model profile is incomplete.');
    }
    const selection: RuntimeModelSelection = {
      profileId: profile.id,
      providerFamily: providerFamily as RuntimeModelSelection['providerFamily'],
      wireApi: wireApi as RuntimeModelSelection['wireApi'],
      modelId: profile.modelId,
      displayName: profile.displayName,
      contextWindowTokens:
        typeof profile.contextWindowTokens === 'number'
          ? profile.contextWindowTokens
          : (knownContextWindowTokens(
              providerFamily as RuntimeModelSelection['providerFamily'],
              profile.modelId,
            ) ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
      autoCompaction:
        typeof profile.contextWindowTokens === 'number' ||
        knownContextWindowTokens(
          providerFamily as RuntimeModelSelection['providerFamily'],
          profile.modelId,
        ) !== undefined
          ? capabilityMode(profile.autoCompaction)
          : 'disabled',
      ...(typeof profile.compactThresholdTokens === 'number'
        ? { compactThresholdTokens: profile.compactThresholdTokens }
        : {}),
      nativeCompaction: capabilityMode(profile.nativeCompaction),
      reasoningEffort:
        modelRequest?.reasoningEffort ??
        (typeof profile.reasoningEffort === 'string' &&
        ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
          profile.reasoningEffort,
        )
          ? profile.reasoningEffort as RuntimeModelSelection['reasoningEffort']
          : 'auto'),
      serviceTier:
        modelRequest?.serviceTier ??
        (typeof profile.serviceTier === 'string' &&
        ['auto', 'standard', 'fast'].includes(profile.serviceTier)
          ? profile.serviceTier as RuntimeModelSelection['serviceTier']
          : 'auto'),
      effectiveCapabilities: {
        toolCalls: capabilityEnabled(profile.toolCalls),
        strictTools: profile.strictTools === 'enabled',
        parallelTools: capabilityEnabled(profile.parallelTools),
        imageInput: capabilityEnabled(profile.imageInput),
        pdfInput: capabilityEnabled(profile.pdfInput),
      },
    };
    const nativeCompaction =
      selection.nativeCompaction === 'enabled' ||
      (selection.nativeCompaction === 'auto' &&
        supportsNativeCompaction(
          selection.providerFamily,
          selection.wireApi,
          connection.baseUrl,
        ));
    const safety = Math.max(
      4_096,
      Math.ceil(selection.contextWindowTokens * 0.05),
    );
    const effectiveCompactThreshold =
      selection.compactThresholdTokens ??
      Math.min(
        Math.floor(selection.contextWindowTokens * 0.85),
        selection.contextWindowTokens - DEFAULT_MAX_OUTPUT_TOKENS - safety,
      );
    return {
      provider: {
        wireApi: selection.wireApi,
        model: selection.modelId,
        baseUrl: connection.baseUrl,
        ...(typeof resolved.apiKey === 'string'
          ? { apiKey: resolved.apiKey }
          : {}),
        timeoutMs:
          typeof connection.requestTimeoutMs === 'number'
            ? connection.requestTimeoutMs
            : DEFAULT_PROVIDER_TIMEOUT_MS,
        parallelTools: selection.effectiveCapabilities.parallelTools,
        ...(effectiveCompactThreshold >= 4_096
          ? { compactThresholdTokens: effectiveCompactThreshold }
          : {}),
        nativeCompaction,
        reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier,
      },
      mediaCapabilities: {
        videoInput: capabilityMode(profile.videoInput),
        audioInput: capabilityMode(profile.audioInput),
      },
      selection,
    };
  };

  private resolveImageAnalysisModel = (
    current: ResolvedProfile,
  ): ImageAnalysisModel | undefined => {
    const inspection = this.nativeRuntime
      ? this.parseNativeJson<unknown>(
          this.nativeRuntime.inspectModelConfigJson(),
        )
      : undefined;
    const profileIds =
      isModelConfigInspection(inspection) && inspection.config
        ? imageAnalysisProfileIds(
            inspection.config,
            current.selection.profileId,
          )
        : [current.selection.profileId];
    for (const profileId of profileIds) {
      let candidate: ResolvedProfile;
      try {
        candidate =
          profileId === current.selection.profileId
            ? current
            : this.resolveConfiguredProfile(profileId);
      } catch {
        continue;
      }
      if (!candidate.selection.effectiveCapabilities.imageInput) {
        continue;
      }
      return {
        profileId: candidate.selection.profileId,
        modelId: candidate.selection.modelId,
        displayName: candidate.selection.displayName,
        model: this.createModel({
          ...candidate.provider,
          parallelTools: false,
          nativeCompaction: false,
        }),
      };
    }
    return undefined;
  };

  private resolveVideoAnalysisModel = (
    current: ResolvedProfile,
  ): VideoAnalysisModel | undefined => {
    const inspection = this.nativeRuntime
      ? this.parseNativeJson<unknown>(
          this.nativeRuntime.inspectModelConfigJson(),
        )
      : undefined;
    const profileIds =
      isModelConfigInspection(inspection) && inspection.config
        ? videoAnalysisProfileIds(
            inspection.config,
            current.selection.profileId,
          )
        : [current.selection.profileId];
    for (const profileId of profileIds) {
      let candidate: ResolvedProfile;
      try {
        candidate =
          profileId === current.selection.profileId
            ? current
            : this.resolveConfiguredProfile(profileId);
      } catch {
        continue;
      }
      if (candidate.mediaCapabilities.videoInput === 'disabled') {
        continue;
      }
      const publisher = temporaryMediaPublisher(candidate.provider);
      return {
        profileId: candidate.selection.profileId,
        modelId: candidate.selection.modelId,
        displayName: candidate.selection.displayName,
        wireApi: candidate.selection.wireApi,
        imageInput: candidate.selection.effectiveCapabilities.imageInput,
        videoInput: candidate.mediaCapabilities.videoInput,
        model: this.createModel({
          ...providerForPublishedMedia(candidate.provider, publisher),
          parallelTools: false,
          nativeCompaction: false,
        }),
        ...(publisher ? { publisher } : {}),
      };
    }
    return undefined;
  };

  private resolveAudioAnalysisModel = (
    current: ResolvedProfile,
    videoProfileId: string | undefined,
  ): AudioAnalysisModel | undefined => {
    const inspection = this.nativeRuntime
      ? this.parseNativeJson<unknown>(
          this.nativeRuntime.inspectModelConfigJson(),
        )
      : undefined;
    const profileIds =
      isModelConfigInspection(inspection) && inspection.config
        ? audioAnalysisProfileIds(
            inspection.config,
            videoProfileId,
            current.selection.profileId,
          )
        : [videoProfileId, current.selection.profileId].filter(
            (profileId): profileId is string => typeof profileId === 'string',
          );
    for (const profileId of profileIds) {
      let candidate: ResolvedProfile;
      try {
        candidate =
          profileId === current.selection.profileId
            ? current
            : this.resolveConfiguredProfile(profileId);
      } catch {
        continue;
      }
      if (
        candidate.selection.wireApi === 'anthropicMessages' ||
        candidate.mediaCapabilities.audioInput === 'disabled'
      ) {
        continue;
      }
      return {
        profileId: candidate.selection.profileId,
        modelId: candidate.selection.modelId,
        displayName: candidate.selection.displayName,
        model: this.createModel({
          ...candidate.provider,
          parallelTools: false,
          nativeCompaction: false,
        }),
      };
    }
    return undefined;
  };

  private discover = async (
    requestId: string,
    connectionId: string,
  ): Promise<void> => {
    try {
      const discovery = await discoverModels(
        this.requireNative().modelConnectionJson(connectionId),
      );
      this.emit({ type: 'model.discovery', requestId, discovery });
    } catch (error) {
      this.emit({
        type: 'runtime.log',
        requestId,
        level: 'error',
        message:
          error instanceof Error ? error.message : 'Model discovery failed.',
      });
    }
  };

  private invalidArgumentsTool = (
    guard: InvalidArgumentGuard,
    knowledgeSelected: boolean,
  ): FunctionTool<Schema> =>
    new FunctionTool({
      name: INVALID_TOOL_ARGUMENTS_TOOL_NAME,
      description:
        'Internal bounded error tool used only when a provider returns malformed JSON tool arguments.',
      parameters: INVALID_TOOL_ARGUMENTS_SCHEMA,
      execute: async (input) => {
        const argumentsValue = isRecord(input) ? input : {};
        const toolName =
          typeof argumentsValue.toolName === 'string'
            ? argumentsValue.toolName
            : 'unknown';
        const argumentsText =
          typeof argumentsValue.argumentsText === 'string'
            ? argumentsValue.argumentsText.slice(0, 4_096)
            : '';
        const key = JSON.stringify({ toolName, argumentsText });
        guard.repeats.set(key, (guard.repeats.get(key) ?? 0) + 1);
        if (toolName.startsWith('knowledge_') && !knowledgeSelected) {
          return {
            ok: false,
            error: {
              kind: 'knowledgeBaseNotSelected',
              message:
                'No local knowledge base has been selected in this conversation. ' +
                'Do not retry this tool or substitute workspace search. Ask the user to select one with @知识库名称.',
            },
          };
        }
        return {
          ok: false,
          error: {
            kind: 'unsupportedToolArguments',
            message:
              `Tool ${toolName} arguments must be a JSON object. ` +
              'Repair the arguments and issue a new structured tool call.',
          },
        };
      },
    });

  private requestUserInputTool = (
    command: TurnExecutionCommand,
    finalGuard: UserInputFinalGuard,
    planGuard?: PlanSubmissionGuard,
  ): FunctionTool<Schema> =>
    new FunctionTool({
      name: 'request_user_input',
      description:
        'Pause this Turn and ask the user 1 to 3 concise questions. Each question must provide 2 to 3 mutually exclusive choices. The interface also lets the user enter a custom answer, so do not add an Other option. Do not draft the final answer before this call; after the result, produce a complete standalone final answer rather than continuing earlier text.',
      parameters: REQUEST_USER_INPUT_SCHEMA,
      execute: async (input) => {
        if (planGuard?.proposal) {
          return {
            ok: false,
            error: {
              kind: 'planAlreadySubmitted',
              message:
                'The formal plan has already been submitted. Do not ask another question in this Turn.',
            },
          };
        }
        const questions = parseUserInputQuestions(input);
        if (!questions) {
          return {
            ok: false,
            error: {
              kind: 'invalidQuestions',
              message:
                'Provide 1 to 3 unique questions with a short header, snake_case id, prompt, and 2 to 3 labeled options.',
            },
          };
        }
        if (
          [...this.pendingUserInputs.values()].some(
            (pending) => pending.turnId === command.turnId,
          )
        ) {
          return {
            ok: false,
            error: {
              kind: 'userInputAlreadyPending',
              message:
                'This Turn already has a pending user-input request. Wait for its result before asking another question.',
            },
          };
        }
        const inputRequestId = randomUUID();
        finalGuard.questions.push(...questions);
        const submission = await new Promise<RuntimeUserInputSubmission>(
          (resolve) => {
            this.pendingUserInputs.set(inputRequestId, {
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              turnId: command.turnId,
              questions,
              resolve,
            });
            this.emit({
              type: 'turn.userInputRequested',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              turnId: command.turnId,
              inputRequestId,
              questions,
            });
          },
        );
        finalGuard.resolvedRequests += 1;
        return submission;
      },
    });

  private submitPlanTool = (
    command: TurnExecutionCommand,
    guard: PlanSubmissionGuard,
  ): FunctionTool<Schema> =>
    new FunctionTool({
      name: 'submit_plan',
      description:
        'Submit the single formal plan for this planning-only Turn. Call only after all blocking questions are resolved. The content must be complete and actionable and must not end with a question, approval request, or invitation to proceed. This records the plan as a dedicated UI item; do not repeat it in the final response.',
      parameters: SUBMIT_PLAN_SCHEMA,
      execute: async (input) => {
        if (guard.proposal) {
          return {
            ok: false,
            error: {
              kind: 'planAlreadySubmitted',
              message: 'This Turn already has a submitted formal plan.',
            },
          };
        }
        const content =
          isRecord(input) && typeof input.content === 'string'
            ? input.content.trim()
            : '';
        const issue = planSubmissionIssue(content);
        if (issue) {
          return {
            ok: false,
            error: { kind: 'invalidPlan', message: issue },
          };
        }
        const proposal = { planId: randomUUID(), content };
        guard.proposal = proposal;
        this.emit({
          type: 'turn.planProposed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          ...proposal,
        });
        return {
          ok: true,
          planId: proposal.planId,
          message:
            'The formal plan was recorded. Finish this Turn without repeating it or asking whether to proceed.',
        };
      },
    });

  private assertInvalidArgumentProgress = (
    guard: InvalidArgumentGuard,
  ): void => {
    if ([...guard.repeats.values()].some((count) => count >= 2)) {
      throw new ProviderAdapterError({
        kind: 'unsupportedToolArguments',
        retryable: false,
        message: 'The model repeated the same malformed tool arguments twice.',
      });
    }
    if ((guard.repeatedToolFailure?.count ?? 0) >= 3) {
      throw new ProviderAdapterError({
        kind: 'protocol',
        retryable: false,
        message:
          'The model repeated the same failed tool call three times without making recovery progress.',
      });
    }
  };

  private takeRepeatedToolFailureRecovery = (
    guard: InvalidArgumentGuard,
  ): string | undefined => {
    const repeated = guard.repeatedToolFailure;
    if (!repeated || repeated.count < 2 || repeated.recoveryDelivered) {
      return undefined;
    }
    guard.repeatedToolFailure = {
      ...repeated,
      recoveryDelivered: true,
    };
    return repeated.recoveryMarkdown;
  };

  private observeToolProgress = (
    guard: InvalidArgumentGuard,
    event: Event,
  ): void => {
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall?.name) {
        if (part.functionCall.name === SUBMIT_FINAL_RESPONSE_TOOL_NAME) {
          continue;
        }
        const callId = part.functionCall.id ?? part.functionCall.name;
        guard.calls.set(
          callId,
          JSON.stringify({
            name: part.functionCall.name,
            arguments: stableJsonValue(part.functionCall.args ?? {}),
          }),
        );
      }
      if (!part.functionResponse?.name) {
        continue;
      }
      if (part.functionResponse.name === SUBMIT_FINAL_RESPONSE_TOOL_NAME) {
        continue;
      }
      const result = part.functionResponse.response ?? {};
      const failed = toolResultFailed(result);
      const callId = part.functionResponse.id ?? part.functionResponse.name;
      const call = guard.calls.get(callId) ?? part.functionResponse.name;
      const parsedCall = (() => {
        try {
          const value: unknown = JSON.parse(call);
          return isRecord(value) ? value : undefined;
        } catch {
          return undefined;
        }
      })();
      const parsedArguments = isRecord(parsedCall?.arguments)
        ? parsedCall.arguments
        : undefined;
      const failureName =
        part.functionResponse.name === INVALID_TOOL_ARGUMENTS_TOOL_NAME &&
        typeof parsedArguments?.toolName === 'string'
          ? parsedArguments.toolName
          : part.functionResponse.name;
      const recoveryKey = toolFailureRecoveryKey(failureName, parsedArguments);
      if (!failed) {
        guard.unresolvedToolFailures.delete(recoveryKey);
        guard.repeatedToolFailure = undefined;
        if (guard.unresolvedToolFailures.size === 0) {
          guard.finalRecoveryUsed = false;
        }
        continue;
      }
      if (toolResultRequiresFinalRecovery(part.functionResponse.name, result)) {
        guard.unresolvedToolFailures.add(recoveryKey);
        guard.finalRecoveryUsed = false;
      }
      const key = JSON.stringify({ call, error: stableJsonValue(result) });
      const previous = guard.repeatedToolFailure;
      const count = previous?.key === key ? previous.count + 1 : 1;
      const resultRecord = isRecord(result) ? result : {};
      const failedPath =
        typeof resultRecord.failedPath === 'string'
          ? resultRecord.failedPath
          : undefined;
      const errorKind =
        typeof resultRecord.error === 'string'
          ? resultRecord.error
          : 'toolFailure';
      guard.repeatedToolFailure = {
        key,
        count,
        recoveryDelivered:
          previous?.key === key ? previous.recoveryDelivered : false,
        recoveryMarkdown:
          '# Internal recovery after repeated tool failure\n\n' +
          `The same ${part.functionResponse.name} call failed twice with ${errorKind}. ` +
          'Do not submit it unchanged again. Choose a different concrete recovery step. ' +
          (errorKind === 'ExpectedMismatch'
            ? `Re-read ${failedPath ? `\`${failedPath}\`` : 'the reported file'} and build a new small patch from the current content.`
            : 'Inspect the returned error, change the arguments or approach, and then retry.'),
      };
    }
  };

  private consumeToolFailureFinalRecovery = (
    guard: InvalidArgumentGuard,
  ): boolean => {
    if (guard.unresolvedToolFailures.size === 0 || guard.finalRecoveryUsed) {
      return false;
    }
    guard.finalRecoveryUsed = true;
    return true;
  };

  private fallbackOutcome = (event: Event): ModelStepOutcome | undefined => {
    if (event.partial !== false) {
      return undefined;
    }
    const parts = event.content?.parts ?? [];
    if (parts.some((part) => part.functionCall)) {
      return { kind: 'toolCalls' };
    }
    if (
      parts.some(
        (part) =>
          !part.thought &&
          typeof part.text === 'string' &&
          part.text.trim().length > 0,
      )
    ) {
      return { kind: 'final' };
    }
    if (
      parts.some(
        (part) =>
          part.thought &&
          typeof part.text === 'string' &&
          part.text.trim().length > 0,
      )
    ) {
      return { kind: 'continue', reason: 'commentaryOnly' };
    }
    return undefined;
  };

  private runTurnDriver = async (options: TurnDriverOptions): Promise<void> => {
    let message = options.initialMessage;
    let invocation = 0;
    let commentaryOnlyCount = 0;
    let truncationCount = 0;
    let futureActionFinalCount = 0;
    let finalCandidateRecoveryCount = 0;
    const textItems = new Map<string, TextItemState>();
    while (!options.signal.aborted) {
      invocation += 1;
      let outcome: ModelStepOutcome | undefined;
      for await (const event of options.runner.runAsync({
        userId: options.userId,
        sessionId: options.sessionId,
        newMessage: message,
        abortSignal: options.signal,
      })) {
        options.onEvent(event, textItems);
        if (event.partial !== true) {
          options.onCompletedEvent?.(event);
        }
        if (event.partial === false) {
          const nextOutcome =
            readModelStepOutcome(event.content?.parts ?? []) ??
            this.fallbackOutcome(event);
          if (nextOutcome) {
            outcome = nextOutcome;
          }
        }
        if (options.terminalToolResult?.(event, textItems)) {
          return;
        }
      }
      if (options.signal.aborted) {
        return;
      }
      options.validateInvocation?.();
      const providerFailure = options.takeProviderError?.();
      if (providerFailure) {
        throw new ProviderAdapterError(providerFailure);
      }
      if (!outcome) {
        throw new ProviderAdapterError({
          kind: 'protocol',
          retryable: false,
          message: 'The model invocation ended without a structured outcome.',
        });
      }
      if (outcome.kind === 'failed') {
        throw new ProviderAdapterError({
          kind: outcome.errorKind,
          retryable: false,
          message: outcome.message,
        });
      }
      if (outcome.kind === 'final') {
        const pendingSteers = options.consumePendingSteers?.() ?? [];
        if (pendingSteers.length > 0) {
          options.settleFinalCandidate?.(false, textItems);
          message = {
            role: 'user',
            parts: pendingSteers.flatMap((content, index) => [
              ...(index === 0
                ? [
                    {
                      text: '# User adjustment\n\nThe user added the following direction while this Turn was running. Apply it before continuing.',
                    },
                  ]
                : []),
              ...(content.parts ?? []),
            ]),
          };
          commentaryOnlyCount = 0;
          truncationCount = 0;
          continue;
        }
        const pendingResults =
          (await options.consumePendingResults?.()) ?? null;
        if (pendingResults) {
          options.settleFinalCandidate?.(false, textItems);
          message = {
            role: 'user',
            parts: [
              {
                text:
                  '# Internal continuation\n\n' +
                  'Child Agent results completed after your candidate answer. ' +
                  'Consume these results and generate the single final answer. ' +
                  'Keep all visible text in the language of the original user request.\n\n' +
                  pendingResults,
              },
            ],
          };
          commentaryOnlyCount = 0;
          truncationCount = 0;
          continue;
        }
        if (options.retryFinalAfterToolFailure?.()) {
          options.settleFinalCandidate?.(false, textItems);
          message = {
            role: 'user',
            parts: [
              {
                text:
                  '# Internal continuation after tool failure\n\n' +
                  'The most recent tool result failed, so the candidate answer was not accepted as completion. ' +
                  'Continue with a corrected tool call or another concrete approach. If recovery is genuinely impossible, ' +
                  'submit a final answer that names the specific blocker and the work that remains incomplete. ' +
                  'Keep all visible text in the language of the original user request.',
              },
            ],
          };
          commentaryOnlyCount = 0;
          truncationCount = 0;
          continue;
        }
        const rawCandidateText = [...textItems.values()]
          .filter((state) => state.pendingFinal)
          .map((state) => state.text)
          .join('\n\n');
        const recoveredText =
          options.recoverFinalCandidate?.(rawCandidateText);
        const candidateText = recoveredText ?? rawCandidateText;
        const candidateIssue = recoveredText
          ? options.validateRecoveredFinalCandidate?.(candidateText)
          : options.validateFinalCandidate?.(candidateText);
        if (candidateIssue) {
          options.settleFinalCandidate?.(false, textItems);
          finalCandidateRecoveryCount += 1;
          if (finalCandidateRecoveryCount >= 2) {
            throw new ProviderAdapterError({
              kind: 'protocol',
              retryable: false,
              message:
                'The model repeatedly submitted a final answer that exposed internal work or violated the response boundary.',
            });
          }
          message = {
            role: 'user',
            parts: [
              {
                text:
                  '# Internal continuation after invalid final response\n\n' +
                  `${candidateIssue} ` +
                  'If the issue requires submit_final_response, call that tool with the rewritten answer instead of returning ordinary text again. ' +
                  'If that tool cannot be called, return exactly one <final_response>...</final_response> envelope containing only the user-facing answer. ' +
                  'Discard the candidate and rewrite the final answer as one complete, self-contained response from the beginning. ' +
                  'Include every necessary section instead of continuing prior numbering. ' +
                  'Output only user-facing results: do not include analysis, private reasoning, self-instructions, drafting notes, or tool narration. ' +
                  'If a structured question was resolved, incorporate only the resulting decisions and do not repeat its prompts. ' +
                  'Keep all visible text in the language of the original user request.',
              },
            ],
          };
          commentaryOnlyCount = 0;
          truncationCount = 0;
          continue;
        }
        if (isFutureActionOnlyFinal(candidateText)) {
          options.settleFinalCandidate?.(false, textItems);
          futureActionFinalCount += 1;
          if (futureActionFinalCount >= 2) {
            throw new ProviderAdapterError({
              kind: 'protocol',
              retryable: false,
              message:
                'The model repeatedly submitted a promise of future work as its final answer.',
            });
          }
          message = {
            role: 'user',
            parts: [
              {
                text:
                  '# Internal continuation after premature final\n\n' +
                  'The candidate answer only announced future work, so it was not accepted as completion. ' +
                  'Perform the next concrete tool action now. Submit a final answer only after the requested work is complete and verified, ' +
                  'or name the specific blocker and the work that remains incomplete. ' +
                  'Keep all visible text in the language of the original user request.',
              },
            ],
          };
          commentaryOnlyCount = 0;
          truncationCount = 0;
          continue;
        }
        if (options.completionGate && !options.completionGate()) {
          throw new ProviderAdapterError({
            kind: 'protocol',
            retryable: false,
            message:
              'The model submitted a final answer while Turn work remained pending.',
          });
        }
        options.settleFinalCandidate?.(true, textItems, recoveredText);
        return;
      }
      if (outcome.kind === 'toolCalls') {
        throw new ProviderAdapterError({
          kind: 'protocol',
          retryable: false,
          message: 'ADK ended an invocation with unprocessed tool calls.',
        });
      }
      if (outcome.reason === 'commentaryOnly') {
        commentaryOnlyCount += 1;
        if (commentaryOnlyCount >= 3) {
          throw new ProviderAdapterError({
            kind: 'protocol',
            retryable: false,
            message:
              'The model produced commentary without progress three times.',
          });
        }
      } else {
        commentaryOnlyCount = 0;
      }
      if (outcome.reason === 'maxOutputTokens') {
        truncationCount += 1;
        if (truncationCount >= 2) {
          throw new ProviderAdapterError({
            kind: 'outputTooLarge',
            retryable: false,
            message:
              'The model output was truncated twice without a final answer.',
          });
        }
      }
      message = {
        role: 'user',
        parts: [
          {
            text:
              `# Internal continuation ${invocation}\n\n` +
              'Keep all visible text in the language of the original user request. ' +
              (outcome.reason === 'maxOutputTokens'
                ? 'Continue after the output truncation and submit a concise final answer when complete.'
                : outcome.reason === 'pauseTurn'
                  ? 'Resume the paused Turn. Continue tool work or submit the final answer.'
                  : 'Continue the same Turn. Perform the next concrete action or submit the final answer.'),
          },
        ],
      };
    }
  };

  private startTurn = async (command: TurnExecutionCommand): Promise<void> => {
    if (this.activeTurns.has(command.turnId)) {
      this.emitCompleted(command, 'failed', {
        kind: 'invalidRequest',
        retryable: false,
        message: 'The Turn is already active.',
      });
      return;
    }
    const controller = new AbortController();
    let goalTurnStartedAt: number | undefined;
    let goalSession: GoalTurnSession | undefined;
    let revisionCommitted = false;
    let turnContent =
      command.type === 'turn.startQueued'
        ? []
        : this.nativeRuntime
          ? resolveKnowledgeReferences(
              this.nativeRuntime,
              command.workspaceId,
              command.content,
              command.threadId,
            )
          : command.content;
    this.activeTurns.set(command.turnId, controller);
    this.activeTurnThreads.set(command.turnId, command.threadId);
    this.nativeRuntime?.setKnowledgeAgentActive?.(true);
    try {
      const resolved = (() => {
        try {
          return this.resolveProfile(command);
        } catch (error) {
          if (command.type === 'turn.startQueued') {
            const message =
              error instanceof Error
                ? error.message
                : 'The queued model is unavailable.';
            throw new Error(`modelUnavailable: ${message}`);
          }
          throw error;
        }
      })();
      this.activeTurnSelections.set(command.turnId, resolved.selection);
      const queuedSubmissionBeforePromotion =
        command.type === 'turn.startQueued'
          ? parseComposerSubmission(
              command.content
                .filter(
                  (
                    part,
                  ): part is Extract<RuntimeContentPart, { type: 'text' }> =>
                    part.type === 'text',
                )
                .map((part) => part.text)
                .join('\n'),
            )
          : undefined;
      const queuedCompaction =
        queuedSubmissionBeforePromotion?.references.some(
          (reference) =>
            reference.kind === 'command' && reference.target === 'compact',
        ) ?? false;
      let queuedTurnSkills: TurnSkills | undefined;
      if (command.type === 'turn.startQueued') {
        this.contentFromParts(turnContent, resolved.selection);
        if (this.nativeRuntime && !queuedCompaction) {
          queuedTurnSkills = createTurnSkills(
            this.nativeRuntime,
            this.taskWorkspaceBindingId(command.workspaceId, command.threadId),
            command.content,
          );
          this.activeTurnSkills.set(command.turnId, queuedTurnSkills);
        }
      }
      if (command.type === 'turn.startGoal') {
        const native = this.requireNative();
        if (
          !native.currentGoalJson ||
          !native.claimGoalTurnJson ||
          !native.settleGoalTurnJson
        ) {
          throw new Error('The native runtime does not support Goal Turns.');
        }
        withDurableStateWrite(() =>
          native.ensureThread(command.threadId, command.workspaceId),
        );
        await this.ensureSession(command, resolved.selection);
        const currentGoal = this.parseNativeJson<GoalSnapshot | null>(
          native.currentGoalJson(command.threadId),
        );
        if (
          !currentGoal ||
          currentGoal.id !== command.goalId ||
          currentGoal.revision !== command.expectedRevision ||
          currentGoal.status !== 'active'
        ) {
          throw new Error('goalRevisionMismatch');
        }
        turnContent = goalTurnRuntimeContent(
          currentGoal,
          command.reconciliation === true,
        );
        const claimedGoal = this.parseNativeJson<GoalSnapshot | null>(
          withDurableStateWrite(() =>
            native.claimGoalTurnJson?.(
              command.goalId,
              command.expectedRevision,
              command.turnId,
              command.threadId,
              command.requestId,
              resolved.provider.wireApi,
              resolved.provider.model,
              JSON.stringify({
                goalId: command.goalId,
                revision: command.expectedRevision,
                content: turnContent,
              }),
            ) ?? 'null',
          ),
        );
        if (
          !claimedGoal ||
          claimedGoal.status !== 'active' ||
          claimedGoal.activeTurnId !== command.turnId
        ) {
          if (claimedGoal) {
            this.emit({
              type: 'goal.changed',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              goal: claimedGoal,
            });
          }
          throw new Error('Goal budget prevented the next Turn.');
        }
        goalSession = new GoalTurnSession(claimedGoal);
        goalTurnStartedAt = Date.now();
        this.activeGoalSessions.set(command.turnId, goalSession);
      } else if (command.type === 'turn.revise') {
        // Resolve and validate every retained asset before replacing durable history.
        // Once the transaction commits, later provider failures belong to the new Turn.
        this.contentFromParts(command.content, resolved.selection);
        const nativeRuntime = this.requireNative();
        if (
          !this.revisionNativeAvailable ||
          !nativeRuntime.replaceLatestTurnWithUserMessage
        ) {
          throw new Error('The native runtime cannot revise Turns.');
        }
        withDurableStateWrite(() =>
          nativeRuntime.replaceLatestTurnWithUserMessage?.(
            command.replacedTurnId,
            command.turnId,
            command.threadId,
            command.requestId,
            resolved.provider.wireApi,
            resolved.provider.model,
            JSON.stringify(turnContent),
          ),
        );
        this.emitTransient({
          type: 'turn.revised',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          replacedTurnId: command.replacedTurnId,
          model: resolved.selection,
          content: turnContent,
        });
        revisionCommitted = true;
        await this.sessions.deleteSession({
          appName: APPLICATION_NAME,
          userId: command.workspaceId,
          sessionId: command.threadId,
        });
        await this.ensureSession(command, resolved.selection);
      } else if (command.type === 'turn.startQueued') {
        withDurableStateWrite(() =>
          this.nativeRuntime?.ensureThread(
            command.threadId,
            command.workspaceId,
          ),
        );
        await this.ensureSession(command, resolved.selection);
        const promoted = this.parseNativeJson<{
          message: { content: RuntimeContentPart[] };
          queue: RuntimeThreadQueue;
        }>(
          withDurableStateWrite(() =>
            this.requireQueueNative().promoteQueuedMessageJson(
              command.threadId,
              command.queueItemId,
              command.expectedRevision,
              command.turnId,
              command.requestId,
              resolved.provider.wireApi,
              resolved.provider.model,
            ),
          ),
        );
        this.emit({
          type: 'queue.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          queue: promoted.queue,
        });
        turnContent = this.nativeRuntime
          ? resolveKnowledgeReferences(
              this.nativeRuntime,
              command.workspaceId,
              promoted.message.content,
              command.threadId,
            )
          : promoted.message.content;
      } else {
        withDurableStateWrite(() =>
          this.nativeRuntime?.ensureThread(
            command.threadId,
            command.workspaceId,
          ),
        );
        await this.ensureSession(command, resolved.selection);
        withDurableStateWrite(() =>
          this.nativeRuntime?.startTurn(
            command.turnId,
            command.threadId,
            command.requestId,
            resolved.provider.wireApi,
            resolved.provider.model,
          ),
        );
      }
      this.emit({
        type: 'turn.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        model: resolved.selection,
        ...(command.type === 'turn.startGoal'
          ? { goalId: command.goalId }
          : {}),
      });
      const userMessageEvent = {
        type: 'turn.userMessage',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        itemId: `${command.turnId}:user`,
        content: turnContent,
      } as const;
      if (command.type === 'turn.startGoal') {
        // The hidden user context was persisted atomically with the Goal claim.
      } else if (
        command.type === 'turn.revise' ||
        command.type === 'turn.startQueued'
      ) {
        this.emitTransient(userMessageEvent);
      } else {
        this.emit(userMessageEvent);
      }
      if (command.type === 'turn.startQueued' && queuedCompaction) {
        await this.executeManualCompaction(
          command,
          resolved,
          controller,
          queuedSubmissionBeforePromotion?.text.trim() || undefined,
        );
        return;
      }
      if ('generateTitle' in command && command.generateTitle) {
        void this.generateTitle(command, resolved, controller.signal);
      }
      const turnMode = composerTurnMode(turnContent);
      let applicationMcpInstruction = '';
      if (composerRequiresFigmaMcp(turnContent)) {
        const action = await this.mcp.ensureApplicationActive('figma');
        if (action.accepted) {
          this.emit({
            type: 'mcp.sessionAction',
            requestId: command.requestId,
            action,
            activeServerIds: this.mcp.getActiveServerIds(),
          });
        } else {
          applicationMcpInstruction =
            '# Figma capability availability\n\nThe request includes a Figma application, Skill, or link, but the configured Figma Desktop MCP server could not be activated for this Turn. State that exact connection problem and ask the user to confirm Figma Desktop Dev Mode MCP is running. Do not invent Figma tool names, suggest a Figma CLI, or fabricate design context.';
        }
      }
      const turnAccess =
        turnMode === 'execute'
          ? ('workspaceWrite' as const)
          : ('readOnly' as const);
      const collaborationTools =
        this.nativeRuntime && turnMode === 'execute'
          ? this.collaboration.toolsForTurn(
              command,
              {
                createTasks: (tasks) => {
                  this.requireNative().createAgentTasksJson(
                    command.turnId,
                    JSON.stringify(
                      tasks.map((task) => ({
                        id: task.taskId,
                        parentTaskId: null as string | null,
                        title: task.title,
                        status: task.status,
                        payload: task,
                      })),
                    ),
                  );
                },
                updateTask: (task) => {
                  this.requireNative().updateAgentTask(
                    task.taskId,
                    task.status,
                    JSON.stringify(task),
                  );
                },
                publishTask: (task) => {
                  this.emit({
                    type: 'agent.task',
                    requestId: command.requestId,
                    workspaceId: command.workspaceId,
                    threadId: command.threadId,
                    turnId: command.turnId,
                    task,
                  });
                },
                executeTask: (context) =>
                  this.executeAgentTask(
                    command,
                    resolved,
                    context,
                    turnContent,
                  ),
              },
              controller.signal,
            )
          : [];
      const invalidArgumentGuard: InvalidArgumentGuard = {
        repeats: new Map<string, number>(),
        calls: new Map<string, string>(),
        unresolvedToolFailures: new Set<string>(),
        finalRecoveryUsed: false,
      };
      const userInputFinalGuard: UserInputFinalGuard = {
        questions: [],
        resolvedRequests: 0,
        instructionDeliveredFor: 0,
      };
      const planSubmissionGuard: PlanSubmissionGuard = {};
      const finalResponseSubmissionGuard: FinalResponseSubmissionGuard = {};
      const nativeWorkspaceId = this.nativeRuntime
        ? this.taskWorkspaceBindingId(command.workspaceId, command.threadId)
        : command.workspaceId;
      const turnSkills =
        queuedTurnSkills ??
        (this.nativeRuntime
          ? createTurnSkills(this.nativeRuntime, nativeWorkspaceId, turnContent)
          : {
              instruction: '',
              tools: [],
              validateSteering: (): void => undefined,
              steeringInstruction: () => '',
            });
      this.activeTurnSkills.set(command.turnId, turnSkills);
      const turnKnowledge = this.nativeRuntime
        ? createTurnKnowledge(
            this.nativeRuntime,
            command.workspaceId,
            turnContent,
          )
        : {
            instruction: '',
            tools: [],
            validateSteering: (): void => undefined,
            steeringInstruction: () => '',
          };
      const takePendingSteers = (): readonly Content[] => {
        const queued = this.pendingSteersByTurn.get(command.turnId) ?? [];
        this.pendingSteersByTurn.delete(command.turnId);
        return queued.map((content) => {
          const modelContent = this.contentFromParts(
            content,
            resolved.selection,
          );
          const composerInstruction = composerIntentInstruction(content);
          const skillInstruction = turnSkills.steeringInstruction(content);
          const knowledgeInstruction =
            turnKnowledge.steeringInstruction(content);
          const metadata = [
            composerInstruction,
            skillInstruction,
            knowledgeInstruction,
          ]
            .filter(Boolean)
            .join('\n\n');
          return metadata
            ? {
                role: 'user' as const,
                parts: [
                  { text: `# User adjustment metadata\n\n${metadata}` },
                  ...(modelContent.parts ?? []),
                ],
              }
            : modelContent;
        });
      };
      const composerInstruction = composerIntentInstruction(turnContent);
      const contextualGoal =
        command.type !== 'turn.startGoal' && this.nativeRuntime?.currentGoalJson
          ? this.parseNativeJson<GoalSnapshot | null>(
              this.nativeRuntime.currentGoalJson(command.threadId),
            )
          : null;
      const goalContextInstruction = contextualGoal
        ? [
            '# Current durable Goal',
            'The following objective is user-authored context for this conversation. Help the user in a way that preserves progress toward it, but this ordinary Turn does not require update_goal.',
            `Goal objective (JSON string): ${JSON.stringify(contextualGoal.objective)}`,
            contextualGoal.progress
              ? `Goal progress (JSON): ${JSON.stringify(contextualGoal.progress)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n')
        : '';
      const workspaceInstructions = this.nativeRuntime
        ? new WorkspaceInstructionContext(this.nativeRuntime, nativeWorkspaceId)
        : undefined;
      workspaceInstructions?.preloadRoot();
      const currentUserContent = this.contentFromParts(
        turnContent,
        resolved.selection,
      );
      const availableImages = this.nativeRuntime
        ? availableThreadImages(
            this.parseNativeJson<RuntimeThreadSnapshot>(
              this.nativeRuntime.loadThreadJson(command.threadId),
            ),
            turnContent,
          )
        : turnContent.flatMap((part) =>
            part.type === 'asset' && part.asset.kind === 'image'
              ? [part.asset]
              : [],
          );
      const availableVideos = this.nativeRuntime
        ? availableThreadVideos(
            this.parseNativeJson<RuntimeThreadSnapshot>(
              this.nativeRuntime.loadThreadJson(command.threadId),
            ),
            turnContent,
          )
        : turnContent.flatMap((part) =>
            part.type === 'asset' && part.asset.kind === 'video'
              ? [part.asset]
              : [],
          );
      const imageAnalysisTools =
        availableImages.length > 0
          ? [
              createImageAnalysisTool({
                assets: availableImages,
                analysisModel: this.resolveImageAnalysisModel(resolved),
                analyzer: this.imageAnalyzer,
                readAsset: (asset) => {
                  const stored = this.parseNativeJson<StoredImageContent>(
                    this.requireNative().readAssetJson(asset.assetId),
                  );
                  if (!this.sameAsset(stored.asset, asset)) {
                    throw new Error(
                      'Stored image metadata does not match the attachment.',
                    );
                  }
                  return stored;
                },
                signal: controller.signal,
              }),
            ]
          : [];
      const videoAnalysisModel =
        availableVideos.length > 0
          ? this.resolveVideoAnalysisModel(resolved)
          : undefined;
      const transcriptionModel =
        availableVideos.length > 0
          ? this.resolveAudioAnalysisModel(
              resolved,
              videoAnalysisModel?.profileId,
            )
          : undefined;
      const videoAnalysisTools =
        availableVideos.length > 0
          ? [
              createVideoAnalysisTool({
                assets: availableVideos,
                analysisModel: videoAnalysisModel,
                transcriptionModel,
                analyzer: this.videoAnalyzer,
                readAsset: (asset) => {
                  const native = this.requireNative();
                  if (!native.readVideoAssetPathJson) {
                    throw new Error(
                      'The native runtime does not support path-based video analysis.',
                    );
                  }
                  const stored = this.parseNativeJson<StoredVideoContent>(
                    native.readVideoAssetPathJson(asset.assetId),
                  );
                  if (!this.sameAsset(stored.asset, asset)) {
                    throw new Error(
                      'Stored video metadata does not match the attachment.',
                    );
                  }
                  return stored;
                },
                signal: controller.signal,
              }),
            ]
          : [];
      const turnModel = this.createModel(resolved.provider);
      const summarizer = this.createModel({
        ...resolved.provider,
        nativeCompaction: false,
      });
      let recoveryCompaction = false;
      const mainTools = [
        this.invalidArgumentsTool(
          invalidArgumentGuard,
          turnKnowledge.tools.length > 0,
        ),
        ...(goalSession ? [createUpdateGoalTool(goalSession)] : []),
        this.requestUserInputTool(
          command,
          userInputFinalGuard,
          turnMode === 'plan' ? planSubmissionGuard : undefined,
        ),
        ...(turnMode === 'plan'
          ? [this.submitPlanTool(command, planSubmissionGuard)]
          : [
              createSubmitFinalResponseTool({
                guard: finalResponseSubmissionGuard,
                validate: async (content) => {
                  const goalIssue = goalSession?.finalIssue();
                  if (goalIssue) return goalIssue;
                  const responseIssue = finalResponseCandidateIssue(content);
                  if (responseIssue) return responseIssue;
                  if (isFutureActionOnlyFinal(content)) {
                    return 'The submitted response only announces future work. Complete the work first, or report the concrete blocker and remaining work.';
                  }
                  const userInputIssue =
                    userInputFinalGuard.resolvedRequests > 0
                      ? userInputFinalCandidateIssue(
                          content,
                          userInputFinalGuard.questions,
                        )
                      : undefined;
                  if (userInputIssue) return userInputIssue;
                  if (
                    (this.pendingSteersByTurn.get(command.turnId)?.length ??
                      0) > 0
                  ) {
                    return 'The user added a new direction while the response was being prepared. Apply it before submitting the final response again.';
                  }
                  const pendingResults =
                    await this.collaboration.consumePendingResults(
                      command.turnId,
                      controller.signal,
                    );
                  if (pendingResults) {
                    return (
                      'Child Agent results completed before submission. Incorporate the following results and submit a new complete response:\n\n' +
                      pendingResults
                    );
                  }
                  if (
                    controller.signal.aborted ||
                    [...this.pendingUserInputs.values()].some(
                      (pending) => pending.turnId === command.turnId,
                    ) ||
                    [...this.pendingApprovals.values()].some(
                      (approval) => approval.turnId === command.turnId,
                    ) ||
                    this.activeOperations.get(command.turnId)?.size
                  ) {
                    return 'Turn work is still pending. Wait for it to finish before submitting the final response.';
                  }
                  return undefined;
                },
              }),
            ]),
        ...imageAnalysisTools,
        ...videoAnalysisTools,
        ...(this.nativeRuntime
          ? [
              ...createWorkspaceTools(
                this.nativeRuntime,
                command.workspaceId,
                (toolName, argumentsValue, execute) =>
                  this.runPrivilegedTool(
                    command,
                    toolName,
                    argumentsValue,
                    execute,
                  ),
                (operationId, stream, delta) => {
                  this.emit({
                    type: 'operation.output',
                    requestId: command.requestId,
                    workspaceId: command.workspaceId,
                    threadId: command.threadId,
                    turnId: command.turnId,
                    operationId,
                    stream,
                    delta,
                  });
                },
                turnAccess,
                workspaceInstructions,
                command.threadId,
                nativeWorkspaceId,
              ),
              ...(turnMode === 'execute'
                ? this.mcp.toolsForTurn((request) =>
                    this.runMcpTool(command, request),
                  )
                : []),
              ...turnSkills.tools,
              ...turnKnowledge.tools,
              ...collaborationTools,
            ]
          : []),
      ];
      const agent = new LlmAgent({
        name: 'sugarcode_agent',
        description: 'SugarCode local coding agent',
        instruction: buildAgentInstructions({
          role: 'main',
          access: turnAccess,
          turnMode,
          platform: process.platform,
          availableTools: mainTools.map((tool) => tool.name),
          collaborationEnabled: collaborationTools.length > 0,
          composerInstruction,
          skillInstruction: [
            turnSkills.instruction,
            turnKnowledge.instruction,
            goalContextInstruction,
          ]
            .concat(applicationMcpInstruction)
            .filter(Boolean)
            .join('\n\n'),
        }),
        model: turnModel,
        generateContentConfig: {
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        },
        beforeModelCallback: async ({ request }) => {
          for (const steer of takePendingSteers()) {
            request.contents.push(steer);
          }
          this.assertInvalidArgumentProgress(invalidArgumentGuard);
          const repeatedFailureRecovery =
            this.takeRepeatedToolFailureRecovery(invalidArgumentGuard);
          if (repeatedFailureRecovery) {
            request.contents.push({
              role: 'user',
              parts: [{ text: repeatedFailureRecovery }],
            });
          }
          if (
            userInputFinalGuard.instructionDeliveredFor <
            userInputFinalGuard.resolvedRequests
          ) {
            userInputFinalGuard.instructionDeliveredFor =
              userInputFinalGuard.resolvedRequests;
            request.contents.push({
              role: 'user',
              parts: [
                {
                  text:
                    '# Internal post-question response boundary\n\n' +
                    'The structured user-input request has been resolved. Do not continue or append to any draft emitted before request_user_input. ' +
                    'After any remaining tool work, produce one complete and self-contained final answer from the beginning. ' +
                    (turnMode === 'plan'
                      ? 'This Turn remains planning-only: use the answer only to refine the plan and do not implement it. '
                      : turnMode === 'readOnly'
                        ? 'This Turn remains read-only and the answer does not authorize workspace changes. '
                        : '') +
                    'Do not repeat the question prompts in ordinary final-answer text; incorporate the decisions directly where relevant.',
                },
              ],
            });
          }
          try {
            await this.contextManager.compactRequest({
              threadId: command.threadId,
              request,
              currentUserContent,
              selection: reserveContextTokens(
                resolved.provider.nativeCompaction && !recoveryCompaction
                  ? {
                      ...resolved.selection,
                      compactThresholdTokens: Math.min(
                        resolved.selection.contextWindowTokens -
                          DEFAULT_MAX_OUTPUT_TOKENS -
                          Math.max(
                            4_096,
                            Math.ceil(
                              resolved.selection.contextWindowTokens * 0.05,
                            ),
                          ),
                        (resolved.provider.compactThresholdTokens ?? 0) +
                          Math.ceil(
                            resolved.selection.contextWindowTokens * 0.05,
                          ),
                      ),
                    }
                  : resolved.selection,
                workspaceInstructions?.reserveTokens() ?? 0,
              ),
              summarizer,
              signal: controller.signal,
              ...(recoveryCompaction
                ? { trigger: 'recovery' as const, force: true }
                : {}),
              callbacks: {
                onStarted: (event) =>
                  this.emit({
                    type: 'turn.contextCompactionStarted',
                    requestId: command.requestId,
                    workspaceId: command.workspaceId,
                    threadId: command.threadId,
                    turnId: command.turnId,
                    ...event,
                  }),
                onFinished: (event) =>
                  this.emit({
                    type: 'turn.contextCompactionFinished',
                    requestId: command.requestId,
                    workspaceId: command.workspaceId,
                    threadId: command.threadId,
                    turnId: command.turnId,
                    ...event,
                  }),
                persist: (checkpoint) =>
                  this.persistContextCheckpoint(command, checkpoint),
                currentSequence: () => this.sequence,
              },
            });
            recoveryCompaction = false;
          } catch (error) {
            if (controller.signal.aborted || recoveryCompaction) {
              throw error;
            }
            this.emit({
              type: 'runtime.log',
              requestId: command.requestId,
              level: 'warn',
              message:
                error instanceof Error
                  ? `Automatic context compaction failed: ${error.message}`
                  : 'Automatic context compaction failed.',
            });
          }
          workspaceInstructions?.injectIntoRequest(request, currentUserContent);
          return undefined;
        },
        tools: mainTools,
      });
      const providerErrorCapture = new ProviderErrorCapturePlugin();
      const runner = new Runner({
        appName: APPLICATION_NAME,
        agent,
        sessionService: this.sessions,
        plugins: [providerErrorCapture],
      });
      let driverMessage = currentUserContent;
      let contextRecoveryUsed = false;
      let transientRecoveryCount = 0;
      for (;;) {
        try {
          await this.runTurnDriver({
            runner,
            userId: command.workspaceId,
            sessionId: command.threadId,
            initialMessage: driverMessage,
            signal: controller.signal,
            onEvent: (event, textItems) => {
              const goalUsage = usageFromEvent(event);
              if (goalUsage) goalSession?.addTokens(goalUsage.totalTokens);
              this.observeToolProgress(invalidArgumentGuard, event);
              this.publishAgentEvent(
                command,
                resolved.selection,
                event,
                textItems,
                true,
              );
            },
            onCompletedEvent: (event) =>
              this.persistModelHistory(command, event),
            consumePendingResults: () =>
              this.collaboration.consumePendingResults(
                command.turnId,
                controller.signal,
              ),
            consumePendingSteers: takePendingSteers,
            completionGate: () =>
              !controller.signal.aborted &&
              ![...this.pendingUserInputs.values()].some(
                (pending) => pending.turnId === command.turnId,
              ) &&
              ![...this.pendingApprovals.values()].some(
                (approval) => approval.turnId === command.turnId,
              ) &&
              !this.activeOperations.get(command.turnId)?.size,
            retryFinalAfterToolFailure: () =>
              this.consumeToolFailureFinalRecovery(invalidArgumentGuard),
            terminalToolResult: (event, textItems) => {
              const parts = event.content?.parts ?? [];
              if (
                turnMode === 'plan' &&
                parts.some(
                  (part) =>
                    part.functionResponse?.name === 'submit_plan' &&
                    isRecord(part.functionResponse.response) &&
                    part.functionResponse.response.ok === true,
                )
              ) {
                return true;
              }
              const submitted = finalResponseSubmissionGuard.content;
              if (
                turnMode === 'plan' ||
                !submitted ||
                !parts.some(
                  (part) =>
                    part.functionResponse?.name ===
                      SUBMIT_FINAL_RESPONSE_TOOL_NAME &&
                    isRecord(part.functionResponse.response) &&
                    part.functionResponse.response.ok === true,
                )
              ) {
                return false;
              }
              if (
                (this.pendingSteersByTurn.get(command.turnId)?.length ?? 0) >
                0
              ) {
                finalResponseSubmissionGuard.content = undefined;
                return false;
              }
              this.settleFinalCandidate(command, textItems, false);
              this.publishStructuredFinalResponse(command, submitted);
              return true;
            },
            validateFinalCandidate: (candidateText) => {
              if (turnMode !== 'plan') {
                return 'This Turn must finish by calling submit_final_response with the complete user-facing answer. Ordinary assistant text is private working text and cannot complete the Turn.';
              }
              const goalIssue = goalSession?.finalIssue();
              if (goalIssue) return goalIssue;
              const responseIssue = finalResponseCandidateIssue(candidateText);
              if (responseIssue) return responseIssue;
              if (turnMode === 'plan' && !planSubmissionGuard.proposal) {
                return 'Planning mode requires the completed plan to be submitted with submit_plan before the Turn can finish.';
              }
              const planIssue =
                turnMode === 'plan'
                  ? planSubmissionIssue(candidateText)
                  : undefined;
              if (planIssue && candidateText.trim().length > 0) {
                return planIssue;
              }
              return userInputFinalGuard.resolvedRequests > 0
                ? userInputFinalCandidateIssue(
                    candidateText,
                    userInputFinalGuard.questions,
                  )
                : undefined;
            },
            recoverFinalCandidate:
              turnMode === 'plan'
                ? undefined
                : extractDelimitedFinalResponse,
            validateRecoveredFinalCandidate: (candidateText) => {
              const goalIssue = goalSession?.finalIssue();
              if (goalIssue) return goalIssue;
              const responseIssue = finalResponseCandidateIssue(candidateText);
              if (responseIssue) return responseIssue;
              return userInputFinalGuard.resolvedRequests > 0
                ? userInputFinalCandidateIssue(
                    candidateText,
                    userInputFinalGuard.questions,
                  )
                : undefined;
            },
            settleFinalCandidate: (accepted, textItems, recoveredText) => {
              this.settleFinalCandidate(
                command,
                textItems,
                accepted && !recoveredText,
                turnMode === 'plan' && Boolean(planSubmissionGuard.proposal),
              );
              if (accepted && recoveredText) {
                this.publishStructuredFinalResponse(command, recoveredText);
              }
            },
            takeProviderError: providerErrorCapture.takeCapturedError,
            validateInvocation: () =>
              this.assertInvalidArgumentProgress(invalidArgumentGuard),
          });
          break;
        } catch (error) {
          const details = providerError(error);
          if (
            details.kind === 'contextWindowExceeded' &&
            !contextRecoveryUsed
          ) {
            contextRecoveryUsed = true;
            recoveryCompaction = true;
            driverMessage = {
              role: 'user',
              parts: [
                {
                  text: '# Internal context recovery\n\nRetry the original request after SugarCode compacts prior context.',
                },
              ],
            };
            continue;
          }
          if (
            isTransientProviderFailure(details) &&
            transientRecoveryCount < MAX_TRANSIENT_PROVIDER_RECOVERIES
          ) {
            transientRecoveryCount += 1;
            this.emit({
              type: 'runtime.log',
              requestId: command.requestId,
              level: 'warn',
              message:
                `The main Agent model stream ended with ${details.kind}; ` +
                `recovering automatically (${transientRecoveryCount}/${MAX_TRANSIENT_PROVIDER_RECOVERIES}).`,
            });
            driverMessage = providerRecoveryMessage(details);
            continue;
          }
          throw error;
        }
      }
      if (goalSession && !controller.signal.aborted) {
        const update = goalSession.stagedUpdate();
        if (!update) {
          throw new ProviderAdapterError({
            kind: 'protocol',
            retryable: false,
            message: 'The Goal Turn ended without update_goal.',
          });
        }
        const goal = this.parseNativeJson<GoalSnapshot | null>(
          this.requireNative().settleGoalTurnJson?.(
            command.type === 'turn.startGoal' ? command.goalId : '',
            goalSession.snapshot().revision,
            command.turnId,
            JSON.stringify(update),
            goalSession.tokenUsage(),
            Math.min(
              Date.now() - (goalTurnStartedAt ?? Date.now()),
              0xffff_ffff,
            ),
          ) ?? 'null',
        );
        this.emit({
          type: 'goal.changed',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          goal,
        });
        this.emitCompleted(command, 'completed', undefined, false);
      } else {
        this.emitCompleted(
          command,
          controller.signal.aborted ? 'interrupted' : 'completed',
          controller.signal.aborted
            ? this.cancellationError(command.turnId)
            : undefined,
        );
      }
    } catch (error) {
      this.collaboration.cancelTurn(command.turnId);
      const details = providerError(error);
      if (command.type === 'turn.revise' && !revisionCommitted) {
        this.emit({
          type: 'runtime.log',
          requestId: command.requestId,
          level: 'error',
          message: details.message,
        });
      }
      if (goalSession && details.kind !== 'cancelled') {
        try {
          const goal = this.parseNativeJson<GoalSnapshot | null>(
            this.requireNative().settleGoalTurnJson?.(
              command.type === 'turn.startGoal' ? command.goalId : '',
              goalSession.snapshot().revision,
              command.turnId,
              JSON.stringify({
                status: 'failed',
                pauseReason:
                  details.kind === 'protocol'
                    ? 'protocolViolation'
                    : 'failure',
              }),
              goalSession.tokenUsage(),
              Math.min(
                Date.now() - (goalTurnStartedAt ?? Date.now()),
                0xffff_ffff,
              ),
            ) ?? 'null',
          );
          this.emit({
            type: 'goal.changed',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            goal,
          });
        } catch {
          // A concurrent Goal mutation owns the durable state.
        }
      } else if (
        command.type === 'turn.startGoal' &&
        details.message.includes('modelUnavailable')
      ) {
        try {
          const native = this.requireNative();
          const current = this.parseNativeJson<GoalSnapshot | null>(
            native.currentGoalJson?.(command.threadId) ?? 'null',
          );
          if (current?.status === 'active') {
            const goal = this.parseNativeJson<GoalSnapshot | null>(
              native.mutateGoalJson?.(
                command.threadId,
                JSON.stringify({
                  action: 'pause',
                  goalId: current.id,
                  expectedRevision: current.revision,
                  pauseReason: 'modelUnavailable',
                }),
              ) ?? 'null',
            );
            this.emit({
              type: 'goal.changed',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              goal,
            });
          }
        } catch {
          // A concurrent mutation already owns the Goal state.
        }
      }
      this.emitCompleted(
        command,
        details.kind === 'cancelled' ? 'interrupted' : 'failed',
        details.kind === 'cancelled'
          ? (this.cancellationError(command.turnId) ?? details)
          : details,
        !goalSession || details.kind === 'cancelled',
      );
    } finally {
      this.collaboration.releaseTurn(command.turnId);
      this.cancelTurnUserInputs(command.turnId);
      this.activeTurns.delete(command.turnId);
      this.activeTurnThreads.delete(command.turnId);
      if (this.activeTurns.size === 0) {
        this.nativeRuntime?.setKnowledgeAgentActive?.(false);
      }
      this.activeTurnSelections.delete(command.turnId);
      this.activeTurnSkills.delete(command.turnId);
      this.activeGoalSessions.delete(command.turnId);
      this.pendingSteersByTurn.delete(command.turnId);
      this.cancellationSources.delete(command.turnId);
    }
  };

  private cancellationError = (
    turnId: string,
  ): RuntimeProviderError | undefined =>
    this.cancellationSources.get(turnId) === 'stopButton'
      ? {
          kind: 'cancelled',
          retryable: false,
          message: 'The Turn was stopped from the conversation Stop button.',
          code: 'stopButton',
        }
      : undefined;

  private executeManualCompaction = async (
    command: TurnExecutionCommand,
    resolved: ResolvedProfile,
    controller: AbortController,
    focus?: string,
  ): Promise<void> => {
    const session = await this.sessions.getSession({
      appName: APPLICATION_NAME,
      userId: command.workspaceId,
      sessionId: command.threadId,
    });
    const contents = (session?.events ?? []).flatMap((event) =>
      event.content ? [event.content] : [],
    );
    const request: LlmRequest = {
      model: resolved.selection.modelId,
      contents,
      config: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
      liveConnectConfig: {},
      toolsDict: {},
    };
    const compacted = await this.contextManager.compactRequest({
      threadId: command.threadId,
      request,
      selection: resolved.selection,
      summarizer: this.createModel({
        ...resolved.provider,
        nativeCompaction: false,
      }),
      signal: controller.signal,
      trigger: 'manual',
      focus,
      force: true,
      callbacks: {
        onStarted: (event) =>
          this.emit({
            type: 'turn.contextCompactionStarted',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            turnId: command.turnId,
            ...event,
          }),
        onFinished: (event) =>
          this.emit({
            type: 'turn.contextCompactionFinished',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            turnId: command.turnId,
            ...event,
          }),
        persist: (checkpoint) =>
          this.persistContextCheckpoint(command, checkpoint),
        currentSequence: () => this.sequence,
      },
    });
    if (!compacted) {
      const compactionId = randomUUID();
      this.emit({
        type: 'turn.contextCompactionStarted',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        compactionId,
        trigger: 'manual',
        strategy: 'applicationSummary',
        beforeContextTokens: 0,
      });
      this.emit({
        type: 'turn.contextCompactionFinished',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        compactionId,
        trigger: 'manual',
        strategy: 'applicationSummary',
        outcome: 'completed',
        beforeContextTokens: 0,
        afterContextTokens: 0,
        durationMs: 0,
        message: 'There is not enough context to compact.',
      });
    }
    this.emitCompleted(
      command,
      controller.signal.aborted ? 'interrupted' : 'completed',
      controller.signal.aborted
        ? this.cancellationError(command.turnId)
        : undefined,
    );
  };

  private compactContext = async (
    command: Extract<RuntimeCommand, { type: 'context.compact' }>,
  ): Promise<void> => {
    if (this.activeTurns.has(command.turnId)) {
      this.emitCompleted(command, 'failed', {
        kind: 'invalidRequest',
        retryable: false,
        message: 'The context compaction Turn is already active.',
      });
      return;
    }
    const controller = new AbortController();
    this.activeTurns.set(command.turnId, controller);
    this.activeTurnThreads.set(command.turnId, command.threadId);
    this.nativeRuntime?.setKnowledgeAgentActive?.(true);
    try {
      const resolved = this.resolveProfile(command);
      withDurableStateWrite(() =>
        this.nativeRuntime?.ensureThread(command.threadId, command.workspaceId),
      );
      await this.ensureSession(command, resolved.selection);
      withDurableStateWrite(() =>
        this.nativeRuntime?.startTurn(
          command.turnId,
          command.threadId,
          command.requestId,
          resolved.provider.wireApi,
          resolved.provider.model,
        ),
      );
      this.emit({
        type: 'turn.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        model: resolved.selection,
      });
      const session = await this.sessions.getSession({
        appName: APPLICATION_NAME,
        userId: command.workspaceId,
        sessionId: command.threadId,
      });
      const contents = (session?.events ?? []).flatMap((event) =>
        event.content ? [event.content] : [],
      );
      const request: LlmRequest = {
        model: resolved.selection.modelId,
        contents,
        config: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
        liveConnectConfig: {},
        toolsDict: {},
      };
      const compacted = await this.contextManager.compactRequest({
        threadId: command.threadId,
        request,
        selection: resolved.selection,
        summarizer: this.createModel({
          ...resolved.provider,
          nativeCompaction: false,
        }),
        signal: controller.signal,
        trigger: 'manual',
        focus: command.focus,
        force: true,
        callbacks: {
          onStarted: (event) =>
            this.emit({
              type: 'turn.contextCompactionStarted',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              turnId: command.turnId,
              ...event,
            }),
          onFinished: (event) =>
            this.emit({
              type: 'turn.contextCompactionFinished',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              turnId: command.turnId,
              ...event,
            }),
          persist: (checkpoint) =>
            this.persistContextCheckpoint(command, checkpoint),
          currentSequence: () => this.sequence,
        },
      });
      if (!compacted) {
        const compactionId = randomUUID();
        this.emit({
          type: 'turn.contextCompactionStarted',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          compactionId,
          trigger: 'manual',
          strategy: 'applicationSummary',
          beforeContextTokens: 0,
        });
        this.emit({
          type: 'turn.contextCompactionFinished',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          compactionId,
          trigger: 'manual',
          strategy: 'applicationSummary',
          outcome: 'completed',
          beforeContextTokens: 0,
          afterContextTokens: 0,
          durationMs: 0,
          message: 'There is not enough context to compact.',
        });
      }
      this.emitCompleted(
        command,
        controller.signal.aborted ? 'interrupted' : 'completed',
        controller.signal.aborted
          ? this.cancellationError(command.turnId)
          : undefined,
      );
    } catch (error) {
      const details = providerError(error);
      this.emitCompleted(
        command,
        details.kind === 'cancelled' ? 'interrupted' : 'failed',
        details.kind === 'cancelled'
          ? (this.cancellationError(command.turnId) ?? details)
          : details,
      );
    } finally {
      this.activeTurns.delete(command.turnId);
      this.activeTurnThreads.delete(command.turnId);
      if (this.activeTurns.size === 0) {
        this.nativeRuntime?.setKnowledgeAgentActive?.(false);
      }
      this.cancellationSources.delete(command.turnId);
    }
  };

  private generateTitle = async (
    command: TurnExecutionCommand,
    resolved: ResolvedProfile,
    signal: AbortSignal,
  ): Promise<void> => {
    const source = titleSourceFromContent(command.content);
    if (!source || !this.nativeRuntime) {
      return;
    }
    const title = await generateThreadTitle(
      this.createModel(resolved.provider),
      source,
      signal,
    );
    if (!title || signal.aborted || !this.nativeRuntime) {
      return;
    }
    try {
      const snapshot = this.parseNativeJson<RuntimeThreadSnapshot>(
        this.nativeRuntime.updateThreadTitleJson(
          command.threadId,
          command.workspaceId,
          title,
          true,
        ),
      );
      if (snapshot.thread.title !== title) {
        return;
      }
      this.emit({
        type: 'thread.mutated',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        operation: 'generateTitle',
        threadId: command.threadId,
        snapshot,
      });
    } catch {
      // Title metadata failure never changes the owning Turn outcome.
    }
  };

  private executeAgentTask = async (
    command: TurnExecutionCommand,
    resolved: ResolvedProfile,
    context: AgentTaskExecutionContext,
    turnContent: readonly RuntimeContentPart[],
  ): Promise<{
    status: 'completed' | 'failed' | 'interrupted';
    summaryMarkdown: string;
    durationMs: number;
    partial?: boolean;
    attempts?: number;
    error?: RuntimeProviderError;
  }> => {
    const startedAt = Date.now();
    const sessionKey = {
      appName: APPLICATION_NAME,
      userId: command.workspaceId,
      sessionId: context.task.childThreadId,
    };
    context.publishProgress(
      'waitingForModel',
      'Initializing the isolated subagent session.',
    );
    await this.sessions.createSession(sessionKey);
    const dependencyContext = context.dependencyResults
      .map(
        (dependency) =>
          `## Dependency result: ${dependency.title}\n\n` +
          `Status: ${dependency.status}\n\n` +
          (dependency.result?.summaryMarkdown ?? ''),
      )
      .join('\n\n');
    let input =
      dependencyContext.length > 0
        ? `${context.task.taskMarkdown}\n\n# Dependency results\n\n${dependencyContext}`
        : context.task.taskMarkdown;
    if (context.task.role === 'auditor') {
      input +=
        `\n\n# Mandatory audit report format\n\n` +
        `Return only a Markdown report with these headings:\n\n` +
        `## Verdict\n\n## Findings\n\n## Acceptance criteria\n\n## Residual risks\n\n` +
        `Each finding must include severity, evidence, and a concrete remediation.`;
    }
    let streamedSummary = '';
    let completedSummary = '';
    let bestPartialSummary = '';
    let attempts = 0;
    let lastProgressAt = 0;
    let lastProgressStage:
      'waitingForModel' | 'streaming' | 'runningTool' | null = null;
    let lastProgressSummary = '';
    try {
      const publishProgress = (
        stage: 'waitingForModel' | 'streaming' | 'runningTool',
        summaryMarkdown: string,
        force = false,
      ): void => {
        const now = Date.now();
        if (
          !force &&
          stage === lastProgressStage &&
          summaryMarkdown === lastProgressSummary
        ) {
          return;
        }
        if (
          !force &&
          stage === 'streaming' &&
          now - lastProgressAt < AGENT_PROGRESS_PERSIST_INTERVAL_MS
        ) {
          return;
        }
        lastProgressAt = now;
        lastProgressStage = stage;
        lastProgressSummary = summaryMarkdown;
        context.publishProgress(stage, summaryMarkdown);
      };
      const rememberPartialSummary = (summaryMarkdown: string): void => {
        const candidate = summaryMarkdown.trim();
        if (candidate.length >= bestPartialSummary.length) {
          bestPartialSummary = candidate.slice(0, 16 * 1024);
        }
      };
      const progressWithRecoveredWork = (message: string): string =>
        bestPartialSummary.length > 0
          ? `${message}\n\n${bestPartialSummary}`
          : message;
      publishProgress(
        'waitingForModel',
        'Subagent started and is waiting for the model response.',
        true,
      );
      const runWithApprovalState = async <T>(
        operation: () => Promise<T>,
      ): Promise<T> => {
        let waitingVisible = false;
        const timer = setTimeout(() => {
          waitingVisible = true;
          context.setWaitingApproval(true);
        }, AGENT_APPROVAL_STATUS_DELAY_MS);
        timer.unref();
        try {
          return await operation();
        } finally {
          clearTimeout(timer);
          if (waitingVisible) {
            context.setWaitingApproval(false);
          }
        }
      };
      const nativeWorkspaceId = this.nativeRuntime
        ? this.taskWorkspaceBindingId(command.workspaceId, command.threadId)
        : command.workspaceId;
      const workspaceInstructions = this.nativeRuntime
        ? new WorkspaceInstructionContext(this.nativeRuntime, nativeWorkspaceId)
        : undefined;
      workspaceInstructions?.preloadRoot();
      const tools = this.nativeRuntime
        ? [
            ...createWorkspaceTools(
              this.nativeRuntime,
              command.workspaceId,
              (toolName, argumentsValue, execute) =>
                runWithApprovalState(() =>
                  this.runPrivilegedTool(
                    command,
                    toolName,
                    argumentsValue,
                    execute,
                  ),
                ),
              (operationId, stream, delta) => {
                this.emit({
                  type: 'operation.output',
                  requestId: command.requestId,
                  workspaceId: command.workspaceId,
                  threadId: command.threadId,
                  turnId: command.turnId,
                  operationId,
                  stream,
                  delta,
                });
              },
              context.task.access,
              workspaceInstructions,
              command.threadId,
              nativeWorkspaceId,
            ),
            ...(context.task.role === 'worker'
              ? this.mcp.toolsForTurn((request) =>
                  runWithApprovalState(() => this.runMcpTool(command, request)),
                )
              : []),
          ]
        : [];
      const invalidArgumentGuard: InvalidArgumentGuard = {
        repeats: new Map<string, number>(),
        calls: new Map<string, string>(),
        unresolvedToolFailures: new Set<string>(),
        finalRecoveryUsed: false,
      };
      const turnSkills = this.nativeRuntime
        ? createTurnSkills(this.nativeRuntime, nativeWorkspaceId, turnContent)
        : {
            instruction: '',
            tools: [],
            validateSteering: (): void => undefined,
            steeringInstruction: () => '',
          };
      const turnKnowledge = this.nativeRuntime
        ? createTurnKnowledge(
            this.nativeRuntime,
            command.workspaceId,
            turnContent,
          )
        : {
            instruction: '',
            tools: [],
            validateSteering: (): void => undefined,
            steeringInstruction: () => '',
          };
      const agentTools = [
        this.invalidArgumentsTool(
          invalidArgumentGuard,
          turnKnowledge.tools.length > 0,
        ),
        ...tools,
        ...turnSkills.tools,
        ...turnKnowledge.tools,
      ];
      const agent = new LlmAgent({
        name: `sugarcode_${context.task.role}_agent`,
        description: `${context.task.role} subagent for ${context.task.title}`,
        instruction: buildAgentInstructions({
          role: context.task.role,
          access: context.task.access,
          platform: process.platform,
          availableTools: agentTools.map((tool) => tool.name),
          collaborationEnabled: false,
          skillInstruction: [turnSkills.instruction, turnKnowledge.instruction]
            .filter(Boolean)
            .join('\n\n'),
        }),
        model: this.createModel(resolved.provider),
        generateContentConfig: {
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        },
        tools: agentTools,
        includeContents: 'none',
        beforeModelCallback: ({ request }) => {
          this.assertInvalidArgumentProgress(invalidArgumentGuard);
          const repeatedFailureRecovery =
            this.takeRepeatedToolFailureRecovery(invalidArgumentGuard);
          if (repeatedFailureRecovery) {
            request.contents.push({
              role: 'user',
              parts: [{ text: repeatedFailureRecovery }],
            });
          }
          workspaceInstructions?.injectIntoRequest(request);
          publishProgress(
            'waitingForModel',
            progressWithRecoveredWork(
              streamedSummary || completedSummary || bestPartialSummary
                ? 'The subagent is waiting for the model to continue after its latest work.'
                : 'Subagent started and is waiting for the model response.',
            ),
            true,
          );
          const amendments = context.takeAmendments();
          if (amendments.length > 0) {
            request.contents.push({
              role: 'user',
              parts: [
                {
                  text: `# Task amendments\n\n${amendments
                    .map((amendment, index) => `${index + 1}. ${amendment}`)
                    .join('\n\n')}`,
                },
              ],
            });
          }
          return undefined;
        },
      });
      const providerErrorCapture = new ProviderErrorCapturePlugin();
      const runner = new Runner({
        appName: APPLICATION_NAME,
        agent,
        sessionService: this.sessions,
        plugins: [providerErrorCapture],
      });
      let driverMessage: Content = {
        role: 'user',
        parts: [{ text: input }],
      };
      let transientRecoveryCount = 0;
      for (;;) {
        attempts += 1;
        try {
          await this.runTurnDriver({
            runner,
            userId: command.workspaceId,
            sessionId: context.task.childThreadId,
            initialMessage: driverMessage,
            signal: context.signal,
            onEvent: (event) => {
              this.observeToolProgress(invalidArgumentGuard, event);
              const parts = event.content?.parts ?? [];
              const text = parts
                .filter((part) => !part.thought && typeof part.text === 'string')
                .map((part) => part.text ?? '')
                .join('');
              if (event.partial && text.length > 0) {
                streamedSummary += text;
                rememberPartialSummary(streamedSummary);
                publishProgress('streaming', streamedSummary.slice(-16 * 1024));
              } else if (event.partial === false && text.length > 0) {
                const outcome =
                  readModelStepOutcome(parts) ?? this.fallbackOutcome(event);
                if (outcome?.kind === 'final') {
                  completedSummary = parts
                    .filter((part) => {
                      const metadata = readModelItemMetadata(part);
                      return (
                        !part.thought &&
                        metadata?.phase !== 'commentary' &&
                        typeof part.text === 'string'
                      );
                    })
                    .map((part) => part.text ?? '')
                    .join('');
                }
                rememberPartialSummary(completedSummary || streamedSummary);
                publishProgress(
                  'streaming',
                  (completedSummary || streamedSummary).slice(-16 * 1024),
                  true,
                );
              }
              const calledTools = parts.flatMap((part) =>
                part.functionCall?.name ? [part.functionCall.name] : [],
              );
              if (calledTools.length > 0) {
                publishProgress(
                  'runningTool',
                  `Running tool: ${[...new Set(calledTools)].map((name) => `\`${name}\``).join(', ')}`,
                  true,
                );
              }
              const completedTools = parts.flatMap((part) =>
                part.functionResponse?.name ? [part.functionResponse.name] : [],
              );
              if (completedTools.length > 0) {
                publishProgress(
                  'waitingForModel',
                  progressWithRecoveredWork(
                    `Tool completed; waiting for the model: ${[...new Set(completedTools)].map((name) => `\`${name}\``).join(', ')}`,
                  ),
                  true,
                );
              }
            },
            completionGate: () => !context.signal.aborted,
            retryFinalAfterToolFailure: () =>
              this.consumeToolFailureFinalRecovery(invalidArgumentGuard),
            takeProviderError: providerErrorCapture.takeCapturedError,
            validateInvocation: () =>
              this.assertInvalidArgumentProgress(invalidArgumentGuard),
          });
          break;
        } catch (error) {
          const details = providerError(error);
          rememberPartialSummary(completedSummary || streamedSummary);
          if (
            !context.signal.aborted &&
            isTransientProviderFailure(details) &&
            transientRecoveryCount < MAX_TRANSIENT_PROVIDER_RECOVERIES
          ) {
            transientRecoveryCount += 1;
            publishProgress(
              'waitingForModel',
              progressWithRecoveredWork(
                `The model stream ended with ${details.kind}; SugarCode is recovering automatically (${transientRecoveryCount}/${MAX_TRANSIENT_PROVIDER_RECOVERIES}).`,
              ),
              true,
            );
            driverMessage = providerRecoveryMessage(
              details,
              bestPartialSummary,
            );
            streamedSummary = '';
            completedSummary = '';
            continue;
          }
          throw error;
        }
      }
      if (!completedSummary.trim()) {
        throw new ProviderAdapterError({
          kind: 'protocol',
          retryable: false,
          message: 'The subagent ended without a non-empty final answer.',
        });
      }
      return {
        status: context.signal.aborted ? 'interrupted' : 'completed',
        summaryMarkdown: completedSummary.slice(0, 16 * 1024),
        durationMs: Date.now() - startedAt,
        attempts,
      };
    } catch (error) {
      const details = providerError(error);
      const partialSummary = bestPartialSummary.trim();
      return {
        status: context.signal.aborted ? 'interrupted' : 'failed',
        summaryMarkdown: context.signal.aborted
          ? 'Agent task interrupted.'
          : partialSummary.length > 0
            ? `## Agent task failed\n\n${details.message}\n\n## Recovered partial result\n\n${partialSummary}`
            : details.message,
        durationMs: Date.now() - startedAt,
        attempts: Math.max(1, attempts),
        ...(context.signal.aborted
          ? {}
          : {
              partial: partialSummary.length > 0,
              error: details,
            }),
      };
    } finally {
      await this.sessions.deleteSession(sessionKey);
    }
  };

  private publishAgentEvent = (
    command: TurnExecutionCommand,
    selection: RuntimeModelSelection,
    event: Event,
    textItems: Map<string, TextItemState>,
    bufferModelText = false,
  ): void => {
    const parts = event.content?.parts ?? [];
    this.publishNativeCompaction(command, selection, event, parts);
    const hasUserInputCall = parts.some(
      (part) => part.functionCall?.name === 'request_user_input',
    );
    const hasPlanSubmissionCall = parts.some(
      (part) => part.functionCall?.name === 'submit_plan',
    );
    const userInputQuestions = parts.flatMap((part) => {
      if (part.functionCall?.name !== 'request_user_input') return [];
      return parseUserInputQuestions(part.functionCall.args) ?? [];
    });
    const userText = command.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const publishToolStatus = (itemId: string, status: string): void => {
      const duplicate = [...textItems.entries()].some(
        ([id, item]) =>
          isTrustedCommentaryId(command.turnId, id) &&
          item.completed &&
          item.phase === 'commentary' &&
          item.text === status,
      );
      if (duplicate) {
        return;
      }
      textItems.set(itemId, {
        phase: 'commentary',
        text: status,
        started: true,
        completed: true,
        pendingFinal: false,
      });
      this.emit({
        type: 'turn.textCompleted',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        itemId,
        phase: 'commentary',
        text: status,
      });
    };
    for (const [index, part] of parts.entries()) {
      if (isVisibleModelTextPart(part)) {
        const metadata = readModelItemMetadata(part);
        const initialPhase: ModelTextPhase =
          metadata?.phase ?? (part.thought ? 'commentary' : 'provisional');
        const existingItem = [...textItems.entries()].find(
          ([, item]) => !item.completed && item.phase === initialPhase,
        );
        const itemId =
          metadata?.itemId ??
          existingItem?.[0] ??
          `${command.turnId}:text:${textItems.size}`;
        const state = textItems.get(itemId) ?? {
          phase: initialPhase,
          text: '',
          started: false,
          completed: false,
          pendingFinal: false,
        };
        if (!state.started) {
          state.started = true;
          this.emitTransient({
            type: 'turn.textStarted',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            turnId: command.turnId,
            itemId,
            phase: initialPhase,
          });
        }
        if (event.partial === false) {
          const outcome =
            metadata?.outcome ??
            readModelStepOutcome(event.content?.parts ?? []) ??
            this.fallbackOutcome(event);
          const completedPhase =
            hasUserInputCall ||
            hasPlanSubmissionCall ||
            part.thought ||
            initialPhase === 'commentary' ||
            outcome?.kind !== 'final'
              ? ('commentary' as const)
              : ('final' as const);
          const completedText = hasUserInputCall
            ? userInputBoundaryCommentary(
                part.text,
                userText,
                userInputQuestions.map((question) => question.question),
              )
            : hasPlanSubmissionCall
              ? planSubmissionBoundaryCommentary(userText)
              : part.text;
          if (
            state.completed &&
            state.phase === completedPhase &&
            state.text === completedText
          ) {
            continue;
          }
          state.phase = completedPhase;
          state.text = completedText;
          if (completedPhase === 'final') {
            state.pendingFinal = true;
          } else {
            state.completed = true;
          }
        } else {
          state.text += part.text;
          if (!bufferModelText) {
            this.emitTransient({
              type: 'turn.textDelta',
              requestId: command.requestId,
              workspaceId: command.workspaceId,
              threadId: command.threadId,
              turnId: command.turnId,
              itemId,
              phase: initialPhase,
              delta: part.text,
            });
          }
        }
        textItems.set(itemId, state);
      }
      if (part.functionCall?.name) {
        if (part.functionCall.name === SUBMIT_FINAL_RESPONSE_TOOL_NAME) {
          continue;
        }
        const metadata = readModelItemMetadata(part);
        const callId = part.functionCall.id ?? `${event.id}:${index}`;
        if (event.partial === false) {
          const progress = toolProgressSummary(
            userText,
            part.functionCall.name,
            part.functionCall.args ?? {},
          );
          if (progress) {
            publishToolStatus(
              toolProgressCommentaryId(command.turnId, callId),
              progress,
            );
          }
        }
        this.emit({
          type: 'turn.toolCall',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          itemId:
            metadata?.itemId ?? part.functionCall.id ?? `${event.id}:${index}`,
          callId,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
      if (part.functionResponse?.name) {
        if (part.functionResponse.name === SUBMIT_FINAL_RESPONSE_TOOL_NAME) {
          continue;
        }
        const metadata = readModelItemMetadata(part);
        if (
          event.partial !== true &&
          isRecord(part.functionResponse.response)
        ) {
          const summary = toolResultSummary(
            userText,
            part.functionResponse.name,
            part.functionResponse.response,
          );
          if (summary) {
            publishToolStatus(
              toolProgressCommentaryId(
                command.turnId,
                `result:${part.functionResponse.id ?? event.id}:${index}`,
              ),
              summary,
            );
          }
        }
        this.emit({
          type: 'turn.toolResult',
          requestId: command.requestId,
          workspaceId: command.workspaceId,
          threadId: command.threadId,
          turnId: command.turnId,
          itemId:
            metadata?.itemId ??
            part.functionResponse.id ??
            `${event.id}:${index}`,
          callId: part.functionResponse.id ?? `${event.id}:${index}`,
          result: part.functionResponse.response ?? {},
        });
      }
    }
    const usage = usageFromEvent(event);
    if (usage) {
      this.emit({
        type: 'turn.usage',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        usage,
      });
    }
  };

  private publishNativeCompaction = (
    command: TurnExecutionCommand,
    selection: RuntimeModelSelection,
    event: Event,
    parts: readonly Part[],
  ): void => {
    if (event.partial !== false) {
      return;
    }
    for (const part of parts) {
      if (!isRecord(part.partMetadata)) {
        continue;
      }
      const openAi = part.partMetadata.openaiCompaction;
      const anthropic = part.partMetadata.anthropicCompaction;
      const artifact = isRecord(openAi)
        ? openAi
        : isRecord(anthropic)
          ? anthropic
          : undefined;
      if (!artifact) {
        continue;
      }
      const strategy = isRecord(openAi)
        ? ('openaiNative' as const)
        : ('anthropicNative' as const);
      const compactionId =
        typeof artifact.id === 'string' ? artifact.id : randomUUID();
      const beforeContextTokens =
        isRecord(event.customMetadata) &&
        typeof event.customMetadata.contextInputTokens === 'number'
          ? event.customMetadata.contextInputTokens
          : undefined;
      const startedAt = Date.now();
      this.emit({
        type: 'turn.contextCompactionStarted',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        compactionId,
        trigger: 'auto',
        strategy,
        ...(beforeContextTokens === undefined ? {} : { beforeContextTokens }),
      });
      const readableSummary =
        typeof artifact.content === 'string' ? artifact.content : undefined;
      this.persistContextCheckpoint(command, {
        version: 1,
        checkpointId: compactionId,
        trigger: 'auto',
        strategy,
        coveredThroughSequence: this.sequence,
        ...(readableSummary === undefined ? {} : { summary: readableSummary }),
        retainedItemIds: [],
        providerArtifact: {
          providerFamily: selection.providerFamily,
          wireApi: selection.wireApi,
          modelId: selection.modelId,
          compatibilityKey: `${selection.providerFamily}:${selection.wireApi}:${selection.modelId}`,
          payload: artifact,
        },
        ...(beforeContextTokens === undefined ? {} : { beforeContextTokens }),
        createdAt: new Date().toISOString(),
      });
      this.emit({
        type: 'turn.contextCompactionFinished',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        compactionId,
        trigger: 'auto',
        strategy,
        outcome: 'completed',
        ...(beforeContextTokens === undefined ? {} : { beforeContextTokens }),
        durationMs: Date.now() - startedAt,
        ...(readableSummary === undefined ? {} : { readableSummary }),
        opaqueCheckpoint: strategy === 'openaiNative',
      });
    }
  };

  private settleFinalCandidate = (
    command: TurnExecutionCommand,
    textItems: Map<string, TextItemState>,
    accepted: boolean,
    suppressFinal = false,
  ): void => {
    for (const [itemId, state] of textItems) {
      if (!state.pendingFinal) {
        continue;
      }
      state.phase = accepted && !suppressFinal ? 'final' : 'commentary';
      state.pendingFinal = false;
      state.completed = true;
      if (!accepted || suppressFinal) {
        continue;
      }
      this.emit({
        type: 'turn.textCompleted',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        itemId,
        phase: state.phase,
        text: state.text,
      });
    }
  };

  private publishStructuredFinalResponse = (
    command: TurnExecutionCommand,
    text: string,
  ): void => {
    this.emit({
      type: 'turn.textCompleted',
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.turnId,
      itemId: `${command.turnId}:final-response`,
      phase: 'final',
      text,
    });
  };

  private runPrivilegedTool = async (
    command: TurnExecutionCommand,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    execute: (operationId: string) => Promise<unknown>,
  ): Promise<unknown> => {
    const operationId = randomUUID();
    const approvalId = randomUUID();
    const argumentsJson = JSON.stringify(argumentsValue);
    const requestHash = createHash('sha256')
      .update(argumentsJson)
      .digest('hex');
    const approvalPresentation = {
      kind: 'command' as const,
      purpose: this.approvalPurpose(toolName, argumentsValue),
      argumentsSummary: this.approvalArgumentsSummary(
        toolName,
        argumentsValue,
        argumentsJson,
      ),
      fullAccess:
        toolName === 'project_environment_trust' ||
        (toolName === 'shell_exec' && argumentsValue.mode === 'fullAccess'),
      ...(toolName === 'project_environment_trust'
        ? { projectEnvironmentTrust: true as const }
        : {}),
    };
    this.requireNative().proposeOperation(
      operationId,
      approvalId,
      command.turnId,
      toolName,
      requestHash,
      argumentsJson,
      JSON.stringify(approvalPresentation),
    );
    const requiresApproval = this.commandRequiresApproval(
      toolName,
      argumentsValue,
    );
    if (!requiresApproval) {
      try {
        this.requireNative().resolveApproval(approvalId, 'approved');
      } catch {
        return { ok: false, error: 'automaticApprovalFailed' };
      }
      return this.executeWorkspaceOperation(command, operationId, execute);
    }
    const decision = await new Promise<'approved' | 'denied'>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        kind: 'command',
        recovered: false,
        requiresApproval: true,
        publish: () => {
          this.emit({
            type: 'approval.requested',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            turnId: command.turnId,
            approvalId,
            operationId,
            toolName,
            purpose: approvalPresentation.purpose,
            argumentsSummary: approvalPresentation.argumentsSummary,
            fullAccess: approvalPresentation.fullAccess,
            ...(approvalPresentation.projectEnvironmentTrust
              ? { projectEnvironmentTrust: true }
              : {}),
          });
        },
        resolve,
      });
      this.publishApproval(approvalId);
    });
    if (decision === 'denied') {
      return { ok: false, error: 'userDenied' };
    }
    return this.executeWorkspaceOperation(command, operationId, execute);
  };

  private executeWorkspaceOperation = async (
    command: TurnExecutionCommand,
    operationId: string,
    execute: (operationId: string) => Promise<unknown>,
  ): Promise<unknown> => {
    const operations =
      this.activeOperations.get(command.turnId) ?? new Set<string>();
    operations.add(operationId);
    this.activeOperations.set(command.turnId, operations);
    try {
      this.emit({
        type: 'operation.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
      });
      const result = await execute(operationId);
      const succeeded = !(
        isRecord(result) &&
        (result.ok === false ||
          result.status === 'error' ||
          result.status === 'cancelled')
      );
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        succeeded,
      );
      this.emit({
        type: 'operation.completed',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        succeeded,
        result: isRecord(result) ? result : { value: result },
      });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : 'privilegedToolFailed',
      };
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        false,
      );
      this.emit({
        type: 'operation.completed',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        succeeded: false,
        result,
      });
      return result;
    } finally {
      const active = this.activeOperations.get(command.turnId);
      active?.delete(operationId);
      if (active?.size === 0) {
        this.activeOperations.delete(command.turnId);
      }
    }
  };

  private setMcpSession = async (
    command: Extract<RuntimeCommand, { type: 'mcp.sessionSet' }>,
  ): Promise<void> => {
    const hasBlockingApproval = [...this.pendingApprovals.values()].some(
      (approval) => !approval.recovered || approval.kind !== 'mcp',
    );
    const action =
      this.activeTurns.size > 0
        ? { accepted: false as const, reason: 'turnActive' as const }
        : hasBlockingApproval
          ? { accepted: false as const, reason: 'approvalPending' as const }
          : await this.mcp.setActive(command.serverIds);
    this.emit({
      type: 'mcp.sessionAction',
      requestId: command.requestId,
      action,
      activeServerIds: this.mcp.getActiveServerIds(),
    });
  };

  private runMcpTool = async (
    command: TurnExecutionCommand,
    request: McpToolApproval,
  ): Promise<unknown> => {
    const operationId = randomUUID();
    const approvalId = randomUUID();
    const argumentsJson = JSON.stringify(
      stableJsonValue(request.argumentsValue),
    );
    if (Buffer.byteLength(argumentsJson, 'utf8') > MAX_MCP_ARGUMENT_BYTES) {
      return { ok: false, error: 'mcpArgumentsTooLarge' };
    }
    const argumentsSha256 = createHash('sha256')
      .update(argumentsJson)
      .digest('hex');
    const approvalPresentation = {
      kind: 'mcp' as const,
      serverId: request.serverId,
      name: request.name,
      purpose: request.purpose,
      argumentsBytes: Buffer.byteLength(argumentsJson, 'utf8'),
      argumentsSha256,
      inventorySha256: request.inventorySha256,
    };
    this.requireNative().proposeOperation(
      operationId,
      approvalId,
      command.turnId,
      request.name,
      argumentsSha256,
      argumentsJson,
      JSON.stringify(approvalPresentation),
    );
    const decision = await new Promise<'approved' | 'denied'>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        kind: 'mcp',
        recovered: false,
        requiresApproval: true,
        publish: () => {
          this.emit({
            type: 'mcp.approvalRequested',
            requestId: command.requestId,
            workspaceId: command.workspaceId,
            threadId: command.threadId,
            turnId: command.turnId,
            approvalId,
            operationId,
            serverId: request.serverId,
            name: request.name,
            purpose: request.purpose,
            argumentsJson,
            argumentsBytes: approvalPresentation.argumentsBytes,
            argumentsSha256,
            inventorySha256: request.inventorySha256,
          });
        },
        resolve,
      });
      this.publishApproval(approvalId);
    });
    if (decision === 'denied') {
      return { ok: false, error: 'userDenied' };
    }
    const operations =
      this.activeOperations.get(command.turnId) ?? new Set<string>();
    operations.add(operationId);
    this.activeOperations.set(command.turnId, operations);
    try {
      this.emit({
        type: 'operation.started',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
      });
      const output = await request.execute();
      const result = isRecord(output) ? output : { value: output };
      const succeeded = result.isError !== true;
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        succeeded,
      );
      this.emit({
        type: 'operation.completed',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        succeeded,
        result,
      });
      return output;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : 'mcpToolFailed',
      };
      this.requireNative().completeOperation(
        operationId,
        JSON.stringify(result),
        false,
      );
      this.emit({
        type: 'operation.completed',
        requestId: command.requestId,
        workspaceId: command.workspaceId,
        threadId: command.threadId,
        turnId: command.turnId,
        operationId,
        succeeded: false,
        result,
      });
      return result;
    } finally {
      const active = this.activeOperations.get(command.turnId);
      active?.delete(operationId);
      if (active?.size === 0) {
        this.activeOperations.delete(command.turnId);
      }
    }
  };

  private restorePendingApprovals = (): void => {
    const value = this.parseNativeJson<unknown>(
      this.requireNative().listPendingApprovalsJson(),
    );
    if (!Array.isArray(value)) {
      throw new Error('Native pending approvals were invalid.');
    }
    for (const item of value) {
      const record = this.recoveredApprovalRecord(item);
      if (!record) {
        throw new Error('Native pending approval coordinates were invalid.');
      }
      let argumentsValue: Readonly<Record<string, unknown>> | null = null;
      try {
        const parsed = JSON.parse(record.argumentsJson) as unknown;
        if (isRecord(parsed)) {
          argumentsValue = parsed;
        }
      } catch {
        // Rejected below without exposing malformed persisted arguments.
      }
      const requestHash = createHash('sha256')
        .update(record.argumentsJson)
        .digest('hex');
      const presentation =
        argumentsValue && requestHash === record.requestHash
          ? this.recoveredApprovalPresentation(record, argumentsValue)
          : null;
      if (!argumentsValue || !presentation) {
        this.rejectUnrecoverableApproval(record);
        continue;
      }
      const pending: PendingApproval = {
        requestId: record.requestId,
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.turnId,
        operationId: record.operationId,
        kind: presentation.kind,
        recovered: true,
        requiresApproval:
          presentation.kind === 'mcp' ||
          this.commandRequiresApproval(record.toolName, argumentsValue),
        publish: () => {
          if (presentation.kind === 'command') {
            this.emitTransient({
              type: 'approval.requested',
              requestId: record.requestId,
              workspaceId: record.workspaceId,
              threadId: record.threadId,
              turnId: record.turnId,
              approvalId: record.approvalId,
              operationId: record.operationId,
              toolName: record.toolName,
              purpose: presentation.purpose,
              argumentsSummary: presentation.argumentsSummary,
              fullAccess: presentation.fullAccess,
              ...(presentation.projectEnvironmentTrust
                ? { projectEnvironmentTrust: true }
                : {}),
              recovered: true,
            });
          } else {
            this.emitTransient({
              type: 'mcp.approvalRequested',
              requestId: record.requestId,
              workspaceId: record.workspaceId,
              threadId: record.threadId,
              turnId: record.turnId,
              approvalId: record.approvalId,
              operationId: record.operationId,
              serverId: presentation.serverId,
              name: presentation.name,
              purpose: presentation.purpose,
              argumentsJson: record.argumentsJson,
              argumentsBytes: presentation.argumentsBytes,
              argumentsSha256: presentation.argumentsSha256,
              inventorySha256: presentation.inventorySha256,
              recovered: true,
            });
          }
        },
        resolve: (decision) => {
          if (decision === 'approved') {
            void this.executeRecoveredApproval(
              record,
              argumentsValue,
              presentation,
            );
          }
        },
      };
      this.pendingApprovals.set(record.approvalId, pending);
    }
  };

  private recoveredApprovalRecord = (
    value: unknown,
  ): RecoveredApprovalRecord | null => {
    if (!isRecord(value)) {
      return null;
    }
    const stringField = (name: string): string | null =>
      typeof value[name] === 'string' && value[name].length > 0
        ? value[name]
        : null;
    const approvalId = stringField('approvalId');
    const operationId = stringField('operationId');
    const turnId = stringField('turnId');
    const requestId = stringField('requestId');
    const threadId = stringField('threadId');
    const workspaceId = stringField('workspaceId');
    const toolName = stringField('toolName');
    const requestHash = stringField('requestHash');
    const argumentsJson = stringField('argumentsJson');
    if (
      !approvalId ||
      !operationId ||
      !turnId ||
      !requestId ||
      !threadId ||
      !workspaceId ||
      !toolName ||
      !requestHash ||
      !argumentsJson ||
      !/^[0-9a-f]{64}$/u.test(requestHash)
    ) {
      return null;
    }
    return {
      approvalId,
      operationId,
      turnId,
      requestId,
      threadId,
      workspaceId,
      toolName,
      requestHash,
      argumentsJson,
      approval: value.approval,
    };
  };

  private recoveredApprovalPresentation = (
    record: RecoveredApprovalRecord,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): RecoveredApprovalPresentation | null => {
    const payload = record.approval;
    if (!record.toolName.startsWith('mcp__')) {
      const fullAccess =
        record.toolName === 'project_environment_trust' ||
        (record.toolName === 'shell_exec' &&
          argumentsValue.mode === 'fullAccess');
      const computed: RecoveredApprovalPresentation = {
        kind: 'command',
        purpose: this.approvalPurpose(record.toolName, argumentsValue),
        argumentsSummary: this.approvalArgumentsSummary(
          record.toolName,
          argumentsValue,
          record.argumentsJson,
        ),
        fullAccess,
        ...(record.toolName === 'project_environment_trust'
          ? { projectEnvironmentTrust: true }
          : {}),
      };
      if (payload === null || payload === undefined) {
        return computed;
      }
      const legacyArgumentsSummary = `${record.toolName} (${Buffer.byteLength(record.argumentsJson, 'utf8')} bytes)`;
      return isRecord(payload) &&
        payload.kind === 'command' &&
        (payload.purpose === undefined || payload.purpose === computed.purpose) &&
        (payload.argumentsSummary === computed.argumentsSummary ||
          (record.toolName === 'workspace_apply_patch' &&
            payload.argumentsSummary === legacyArgumentsSummary)) &&
        payload.fullAccess === computed.fullAccess &&
        payload.projectEnvironmentTrust === computed.projectEnvironmentTrust
        ? computed
        : null;
    }
    if (
      !isRecord(payload) ||
      payload.kind !== 'mcp' ||
      typeof payload.serverId !== 'string' ||
      typeof payload.name !== 'string' ||
      payload.name !== record.toolName ||
      !record.toolName.startsWith(`mcp__${payload.serverId}__`) ||
      typeof payload.argumentsBytes !== 'number' ||
      payload.argumentsBytes !==
        Buffer.byteLength(record.argumentsJson, 'utf8') ||
      payload.argumentsSha256 !== record.requestHash ||
      typeof payload.inventorySha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(payload.inventorySha256)
    ) {
      return null;
    }
    return {
      kind: 'mcp',
      serverId: payload.serverId,
      name: payload.name,
      purpose:
        typeof payload.purpose === 'string' &&
        payload.purpose.trim().length > 0 &&
        Buffer.byteLength(payload.purpose, 'utf8') <= 512
          ? payload.purpose.trim()
          : `使用 ${payload.serverId} 完成当前任务。`,
      argumentsBytes: payload.argumentsBytes,
      argumentsSha256: record.requestHash,
      inventorySha256: payload.inventorySha256,
    };
  };

  private rejectUnrecoverableApproval = (
    record: RecoveredApprovalRecord,
  ): void => {
    this.requireNative().resolveApproval(record.approvalId, 'denied');
    this.emit({
      type: record.toolName.startsWith('mcp__')
        ? 'mcp.approvalResolved'
        : 'approval.resolved',
      requestId: record.requestId,
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      turnId: record.turnId,
      approvalId: record.approvalId,
      operationId: record.operationId,
      decision: 'denied',
      source: 'system',
    });
    this.emit({
      type: 'runtime.log',
      requestId: record.requestId,
      level: 'warn',
      message: `Rejected unrecoverable approval ${record.approvalId}.`,
    });
  };

  private executeRecoveredApproval = async (
    record: RecoveredApprovalRecord,
    argumentsValue: Readonly<Record<string, unknown>>,
    presentation: RecoveredApprovalPresentation,
  ): Promise<void> => {
    const operations =
      this.activeOperations.get(record.turnId) ?? new Set<string>();
    operations.add(record.operationId);
    this.activeOperations.set(record.turnId, operations);
    this.emit({
      type: 'operation.started',
      requestId: record.requestId,
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      turnId: record.turnId,
      operationId: record.operationId,
    });
    try {
      const output =
        presentation.kind === 'command'
          ? await executePrivilegedWorkspaceTool(
              this.requireNative(),
              record.operationId,
              record.toolName === 'workspace_apply_patch'
                ? this.taskWorkspaceBindingId(
                    record.workspaceId,
                    record.threadId,
                  )
                : record.workspaceId,
              record.toolName,
              argumentsValue,
              (operationId, stream, delta) => {
                this.emit({
                  type: 'operation.output',
                  requestId: record.requestId,
                  workspaceId: record.workspaceId,
                  threadId: record.threadId,
                  turnId: record.turnId,
                  operationId,
                  stream,
                  delta,
                });
              },
              record.threadId,
            )
          : await this.mcp.executeRecovered(
              presentation.serverId,
              presentation.name,
              argumentsValue,
              presentation.inventorySha256,
              new AbortController().signal,
            );
      const result = isRecord(output) ? output : { value: output };
      const succeeded =
        presentation.kind === 'mcp'
          ? result.isError !== true
          : !(
              result.ok === false ||
              result.status === 'error' ||
              result.status === 'cancelled'
            );
      this.requireNative().completeOperation(
        record.operationId,
        JSON.stringify(result),
        succeeded,
      );
      this.emit({
        type: 'operation.completed',
        requestId: record.requestId,
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.turnId,
        operationId: record.operationId,
        succeeded,
        result,
      });
    } catch (error) {
      const result = {
        ok: false,
        error:
          error instanceof Error ? error.message : 'recoveredOperationFailed',
      };
      this.requireNative().completeOperation(
        record.operationId,
        JSON.stringify(result),
        false,
      );
      this.emit({
        type: 'operation.completed',
        requestId: record.requestId,
        workspaceId: record.workspaceId,
        threadId: record.threadId,
        turnId: record.turnId,
        operationId: record.operationId,
        succeeded: false,
        result,
      });
    } finally {
      const active = this.activeOperations.get(record.turnId);
      active?.delete(record.operationId);
      if (active?.size === 0) {
        this.activeOperations.delete(record.turnId);
      }
    }
  };

  private commandRequiresApproval = (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): boolean => {
    if (toolName === 'workspace_apply_patch') {
      return false;
    }
    return !(toolName === 'shell_exec' && argumentsValue.mode === 'sandboxed');
  };

  private publishApproval = (approvalId: string): void => {
    if (!this.initialized) {
      return;
    }
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return;
    }
    if (!pending.requiresApproval) {
      this.finishApproval(
        approvalId,
        pending,
        'approved',
        pending.requestId,
        'policy',
      );
    } else {
      pending.publish();
    }
  };

  private publishPendingApprovals = (): void => {
    for (const approvalId of [...this.pendingApprovals.keys()]) {
      this.publishApproval(approvalId);
    }
  };

  private finishApproval = (
    approvalId: string,
    pending: PendingApproval,
    decision: 'approved' | 'denied',
    requestId: string,
    source: 'user' | 'policy' | 'system',
  ): void => {
    let effectiveDecision = decision;
    try {
      this.requireNative().resolveApproval(approvalId, decision);
    } catch {
      effectiveDecision = 'denied';
    }
    this.pendingApprovals.delete(approvalId);
    this.emit({
      type:
        pending.kind === 'mcp' ? 'mcp.approvalResolved' : 'approval.resolved',
      requestId,
      workspaceId: pending.workspaceId,
      threadId: pending.threadId,
      turnId: pending.turnId,
      approvalId,
      operationId: pending.operationId,
      decision: effectiveDecision,
      source,
    });
    pending.resolve(effectiveDecision);
  };

  private cancelTurnApprovals = (turnId: string): void => {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) {
        continue;
      }
      this.finishApproval(
        approvalId,
        pending,
        'denied',
        pending.requestId,
        'system',
      );
    }
  };

  private cancelTurnUserInputs = (turnId: string): void => {
    for (const [inputRequestId, pending] of this.pendingUserInputs) {
      if (pending.turnId !== turnId) {
        continue;
      }
      this.pendingUserInputs.delete(inputRequestId);
      const submission: RuntimeUserInputSubmission = {
        kind: 'cancelled',
        decisions: [],
      };
      this.emit({
        type: 'turn.userInputResolved',
        requestId: pending.requestId,
        workspaceId: pending.workspaceId,
        threadId: pending.threadId,
        turnId: pending.turnId,
        inputRequestId,
        submission,
      });
      pending.resolve(submission);
    }
  };

  private cancelTurnOperations = (turnId: string): void => {
    const operations = this.activeOperations.get(turnId);
    if (!operations) {
      return;
    }
    for (const operationId of operations) {
      try {
        this.nativeRuntime?.cancelOperation(operationId);
      } catch {
        // Native operation recovery marks unfinished execution retryable on restart.
      }
    }
  };

  private approvalArgumentsSummary = (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    argumentsJson: string,
  ): string => {
    if (toolName === 'project_environment_trust') {
      const project = argumentsValue.projectEnvironment;
      if (!isRecord(project)) {
        return 'Trust project environment configuration';
      }
      const scripts = [
        typeof project.setupScript === 'string'
          ? `# setup\n${project.setupScript}`
          : '',
        typeof project.environmentScript === 'string'
          ? `# environment\n${project.environmentScript}`
          : '',
        ...(Array.isArray(project.actions)
          ? project.actions.flatMap((action) =>
              isRecord(action) &&
              typeof action.label === 'string' &&
              typeof action.command === 'string'
                ? [`# action: ${action.label}\n${action.command}`]
                : [],
            )
          : []),
      ].filter(Boolean);
      const header =
        `Trust ${String(project.configPath ?? '.sugarcode/project.json')}\n` +
        `Hash: ${String(project.configHash ?? '')}` +
        (typeof argumentsValue.projectActionId === 'string'
          ? `\nRun after trust: ${argumentsValue.projectActionId}`
          : '');
      const summary = `${header}\n\n${scripts.join('\n\n')}`;
      return summary.length <= 32_768
        ? summary
        : `${summary.slice(0, 32_765)}...`;
    }
    if (
      toolName === 'workspace_apply_patch' &&
      typeof argumentsValue.patch === 'string'
    ) {
      return workspacePatchApprovalSummary(argumentsValue.patch);
    }
    if (
      toolName !== 'shell_exec' ||
      typeof argumentsValue.command !== 'string'
    ) {
      return `${toolName} (${Buffer.byteLength(argumentsJson, 'utf8')} bytes)`;
    }
    const commandArguments =
      Array.isArray(argumentsValue.arguments) &&
      argumentsValue.arguments.every((argument) => typeof argument === 'string')
        ? argumentsValue.arguments
            .map((argument) => JSON.stringify(argument))
            .join(' ')
        : '';
    const rendered = [argumentsValue.command, commandArguments]
      .filter((part) => part.length > 0)
      .join(' ');
    const prefix =
      argumentsValue.mode === 'fullAccess' ? 'Full Access' : 'Sandboxed';
    const summary = `${prefix}: ${rendered}`;
    return summary.length <= 4_096 ? summary : `${summary.slice(0, 4_093)}...`;
  };

  private approvalPurpose = (
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): string => {
    if (typeof argumentsValue.approvalPurpose === 'string') {
      const purpose = argumentsValue.approvalPurpose.trim();
      if (purpose.length > 0 && Buffer.byteLength(purpose, 'utf8') <= 512) {
        return purpose;
      }
    }
    if (toolName === 'project_environment_trust') {
      return '信任并运行当前项目声明的环境配置。';
    }
    if (toolName === 'workspace_apply_patch') {
      return '将 Agent 准备的更改应用到当前项目文件。';
    }
    return '运行当前任务所需的终端操作。';
  };

  private emitCompleted = (
    command: TurnContextCommand,
    status: 'completed' | 'interrupted' | 'failed',
    error?: RuntimeProviderError,
    persist = true,
  ): void => {
    try {
      if (persist) {
        this.nativeRuntime?.finishTurn(
          command.turnId,
          status,
          error ? JSON.stringify(error) : undefined,
        );
      }
    } catch (persistenceError) {
      this.emit({
        type: 'runtime.log',
        requestId: command.requestId,
        level: 'error',
        message:
          persistenceError instanceof Error
            ? persistenceError.message
            : 'Failed to persist the terminal Turn state.',
      });
    }
    this.emit({
      type: 'turn.completed',
      requestId: command.requestId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      turnId: command.turnId,
      status,
      ...(error ? { error } : {}),
    });
  };

  private emit = (event: RuntimeEventInput): void => {
    this.sequence += 1;
    const normalized = { ...event, sequence: this.sequence } as RuntimeEvent;
    const nativeRuntime = this.nativeRuntime;
    if (
      nativeRuntime &&
      normalized.type !== 'runtime.ready' &&
      normalized.type !== 'runtime.log' &&
      normalized.type !== 'turn.completed' &&
      'turnId' in normalized
    ) {
      const itemId =
        'itemId' in normalized
          ? normalized.itemId
          : normalized.type === 'agent.task'
            ? normalized.task.taskId
            : 'approvalId' in normalized
              ? normalized.approvalId
              : 'inputRequestId' in normalized
                ? normalized.inputRequestId
                : String(normalized.sequence);
      withDurableStateWrite(() =>
        nativeRuntime.appendItem(
          normalized.type === 'turn.textCompleted'
            ? `${normalized.type}:${normalized.turnId}:${itemId}`
            : `${normalized.type}:${normalized.turnId}:${itemId}:${normalized.sequence}`,
          normalized.turnId,
          normalized.sequence,
          normalized.type,
          JSON.stringify(normalized),
        ),
      );
    }
    this.postEvent(normalized);
  };

  private emitTransient = (event: RuntimeEventInput): void => {
    this.sequence += 1;
    this.postEvent({ ...event, sequence: this.sequence } as RuntimeEvent);
  };
}
