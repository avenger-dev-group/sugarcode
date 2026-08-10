export const CONVERSATION_STATE_GET_CHANNEL = 'conversation-state:get';
export const CONVERSATION_STATE_CHANGED_CHANNEL = 'conversation-state:changed';
export const CONVERSATION_THREAD_PROJECTION_GET_CHANNEL =
  'conversation-thread-projection:get';
export const CONVERSATION_THREAD_PROJECTION_CHANGED_CHANNEL =
  'conversation-thread-projection:changed';
export const CONVERSATION_THREAD_DELTA_CHANNEL =
  'conversation-thread-projection:delta';
export const CONVERSATION_SEND_CHANNEL = 'conversation:send';
export const CONVERSATION_STOP_CHANNEL = 'conversation:stop';
export const CONVERSATION_USER_INPUT_RESPONSE_CHANNEL =
  'conversation:user-input-response';
export const CONVERSATION_THREAD_SEARCH_CHANNEL = 'conversation-thread:search';
export const CONVERSATION_THREAD_SELECT_CHANNEL = 'conversation-thread:select';
export const CONVERSATION_THREAD_NEW_CHANNEL = 'conversation-thread:new';
export const CONVERSATION_THREAD_DELETE_CHANNEL = 'conversation-thread:delete';

export const MAX_CONVERSATION_INPUT_BYTES = 64 * 1024;
export const MAX_CONVERSATION_ATTACHMENTS = 10;
export const MAX_CONVERSATION_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_THREAD_SEARCH_BYTES = 256;
export const MAX_CONVERSATION_TITLE_BYTES = 256;
export const MAX_FILE_CHANGE_DIFF_BYTES = 192 * 1024;
export const MAX_FILE_CHANGE_DIFF_LINES = 5_000;
export const MAX_USER_INPUT_QUESTIONS = 3;
export const MAX_USER_INPUT_OPTIONS = 3;
export const MAX_USER_INPUT_ANSWER_BYTES = 2 * 1024;

export type ConversationPhase =
  'idle' | 'starting' | 'inProgress' | 'stopping' | 'ready' | 'unavailable';

export type ConversationTurnStatus =
  'inProgress' | 'completed' | 'failed' | 'interrupted';

export type ConversationTerminalTurnStatus = Exclude<
  ConversationTurnStatus,
  'inProgress'
>;

export type ConversationMessageStatus = 'inProgress' | 'completed';

export type ConversationMessage = Readonly<{
  id: string;
  role: 'user' | 'agent';
  text: string;
  attachments?: readonly ConversationAttachment[];
  status: ConversationMessageStatus;
}>;

export type ConversationAttachment = Readonly<{
  assetId: string;
  sha256: string;
  mediaType: string;
  originalName: string;
  sizeBytes: number;
  kind: 'image' | 'pdf' | 'text';
  previewUrl?: string;
}>;

export type ConversationAttachmentUpload = Readonly<{
  fileName: string;
  mediaType?: string;
  data: string;
}>;

export type ConversationCommentaryActivity = Readonly<{
  id: string;
  text: string;
  status: ConversationMessageStatus;
}>;

export type ConversationAgentOutput = Readonly<{
  responseOrdinal: number;
  outputIndex: number;
  text: string;
}>;

export type ConversationWorkspaceReadOutcome =
  | Readonly<{
      type: 'success';
      bytes: number;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceReadActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceReadOutcome;
  }>;
}>;

export type ConversationWorkspaceListOutcome =
  | Readonly<{
      type: 'success';
      entries: number;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceListActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceListOutcome;
  }>;
}>;

export type ConversationWorkspaceSearchOutcome =
  | Readonly<{
      type: 'success';
      matches: number;
      truncated: boolean;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
    }>;

export type ConversationWorkspaceSearchActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  query: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationWorkspaceSearchOutcome;
  }>;
}>;

export type ConversationSkillOutcome =
  | Readonly<{
      type: 'success';
      purpose?: string;
      description?: string;
      content?: string;
      sha256?: string;
    }>
  | Readonly<{ type: 'error'; kind: string }>;

export type ConversationSkillActivity = Readonly<{
  id: string;
  callId: string;
  name: string;
  purpose?: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationSkillOutcome;
  }>;
}>;

export type ConversationFileChangeProposal = Readonly<{
  id: string;
  status: ConversationMessageStatus;
  path: string;
  kind: 'create' | 'update' | 'delete';
  diff: string;
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  newlineStyle: 'lf' | 'crLf';
  finalNewline: boolean;
}>;

export type ConversationFileChangeResultOutcome =
  | Readonly<{
      type: 'success';
      path: string;
      beforeSha256: string;
      afterSha256: string;
      beforeBytes: number;
      afterBytes: number;
    }>
  | Readonly<{
      type: 'success';
      files: readonly Readonly<{
        path: string;
        kind: 'create' | 'update' | 'delete';
        beforeSha256: string;
        afterSha256: string;
        beforeBytes: number;
        afterBytes: number;
      }>[];
    }>
  | Readonly<{ type: 'error'; kind: string }>;

export type ConversationFileChangeActivity = Readonly<{
  id: string;
  callId: string;
  path: string;
  paths?: readonly string[];
  callStatus: ConversationMessageStatus;
  change?: ConversationFileChangeProposal;
  changes?: readonly ConversationFileChangeProposal[];
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationFileChangeResultOutcome;
  }>;
}>;

export type ConversationCommandApprovalDecision =
  | 'approved'
  | 'denied'
  | 'timedOut'
  | 'unsupported'
  | 'cancelled'
  | 'clientDisconnected';

export type ConversationWorkspacePatchFile = Readonly<{
  path: string;
  kind: 'create' | 'update' | 'delete';
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  diff?: string;
  newlineStyle?: 'lf' | 'crLf';
  finalNewline?: boolean;
}>;

export type ConversationCommandExecutionResultOutcome =
  | Readonly<{
      type: 'error';
      kind: string;
      message?: string;
      failedPath?: string;
    }>
  | Readonly<{
      type: 'workspacePatch';
      filesChanged: number;
      files?: readonly ConversationWorkspacePatchFile[];
    }>
  | Readonly<{
      type: 'process';
      stdoutBytes: number;
      stderrBytes: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      encoding: 'utf8Lossy';
      durationMs: number;
      outcome:
        | Readonly<{ type: 'exitCode'; code: number }>
        | Readonly<{ type: 'signal'; signal: number }>
        | Readonly<{ type: 'timedOut' }>;
      sandboxPolicy?: 'filesystemReadOnlyV1';
      networkPolicy?: 'networkDeniedV1';
    }>;

export type ConversationCommandApprovalActivity = Readonly<{
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  operationKind?: 'workspacePatch' | 'shell';
  command: string;
  argumentCount: number;
  fullAccess?: boolean;
  liveOutput?: Readonly<{ stdout: string; stderr: string }>;
  requestStatus: ConversationMessageStatus;
  decision?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    value: ConversationCommandApprovalDecision;
    source?: 'user' | 'policy' | 'system';
  }>;
  executionAttempt?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
  }>;
  executionResult?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome: ConversationCommandExecutionResultOutcome;
  }>;
}>;

export type ConversationMcpResultReceipt =
  | Readonly<{
      type: 'completed';
      isError: boolean;
      observedBytes: number;
      canonicalBytes: number;
      retainedBytes: number;
      truncated: boolean;
      sha256: string;
      contentBlocks: number;
      structuredContent: boolean;
    }>
  | Readonly<{
      type: 'error';
      kind: string;
      requestState: string;
    }>;

export type ConversationMcpActivity = Readonly<{
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  serverId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  callStatus: ConversationMessageStatus;
  requestStatus: ConversationMessageStatus;
  decision?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    value: ConversationCommandApprovalDecision;
  }>;
  executionAttempt?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
  }>;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    receipt: ConversationMcpResultReceipt;
  }>;
}>;

export type ConversationAgentTaskStatus =
  | 'queued'
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type ConversationAgentTask = Readonly<{
  id: string;
  taskId: string;
  clientTaskKey: string;
  childThreadId: string;
  title: string;
  role: 'explorer' | 'worker' | 'auditor';
  access: 'readOnly' | 'workspaceWrite';
  dependsOn: readonly string[];
  taskMarkdown: string;
  status: ConversationAgentTaskStatus;
  amendments: readonly Readonly<{
    id: string;
    markdown: string;
  }>[];
  progress?: Readonly<{
    stage: 'waitingForModel' | 'streaming' | 'runningTool';
    summaryMarkdown: string;
    updatedAt: number;
  }>;
  result?: Readonly<{
    id: string;
    summaryMarkdown: string;
    durationMs: number;
  }>;
}>;

export type ConversationOrchestrationActivity = Readonly<{
  id: string;
  tasks: readonly ConversationAgentTask[];
}>;

export type ConversationActivity =
  | Readonly<{
      type: 'commentary';
      activity: ConversationCommentaryActivity;
    }>
  | Readonly<{
      type: 'workspaceRead';
      activity: ConversationWorkspaceReadActivity;
    }>
  | Readonly<{
      type: 'workspaceList';
      activity: ConversationWorkspaceListActivity;
    }>
  | Readonly<{
      type: 'workspaceSearch';
      activity: ConversationWorkspaceSearchActivity;
    }>
  | Readonly<{
      type: 'skill';
      activity: ConversationSkillActivity;
    }>
  | Readonly<{
      type: 'fileChange';
      activity: ConversationFileChangeActivity;
    }>
  | Readonly<{
      type: 'commandApproval';
      activity: ConversationCommandApprovalActivity;
    }>
  | Readonly<{
      type: 'mcp';
      activity: ConversationMcpActivity;
    }>
  | Readonly<{
      type: 'orchestration';
      activity: ConversationOrchestrationActivity;
    }>;

export type ConversationTurnError = Readonly<{
  kind:
    | 'authentication'
    | 'contextWindowExceeded'
    | 'invalidRequest'
    | 'rateLimited'
    | 'timeout'
    | 'transport'
    | 'disconnected'
    | 'server'
    | 'protocol'
    | 'incomplete'
    | 'filtered'
    | 'unsupportedOutput'
    | 'unsupportedToolArguments'
    | 'providerRequestTooLarge'
    | 'providerResponseTooLarge'
    | 'outputTooLarge'
    | 'stateUnavailable';
  retryable: boolean;
  protocol?: Readonly<{
    stage:
      | 'streamEvent'
      | 'responseAssembly'
      | 'outputNormalization'
      | 'runtimeClassification';
    code:
      | 'wireMismatch'
      | 'invalidEventShape'
      | 'ambiguousOutputReconciliation'
      | 'malformedToolCall'
      | 'terminalLifecycleViolation'
      | 'continuationOutputMismatch'
      | 'outputIndexMismatch';
    eventType?: string;
    shapeSha256: string;
  }>;
}>;

export type ConversationTokenUsage = Readonly<{
  lastRequest: Readonly<{
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }>;
  turnTotal: Readonly<{
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }>;
  requestCount: number;
  contextWindowTokens: number;
  source: 'provider' | 'estimated';
}>;

export type ConversationModelSelection = Readonly<{
  profileId: string;
  providerFamily: 'openai' | 'anthropic';
  wireApi:
    | 'openaiResponses'
    | 'openaiChatCompletions'
    | 'anthropicMessages';
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  effectiveCapabilities: Readonly<{
    toolCalls: boolean;
    strictTools: boolean;
    parallelTools: boolean;
    imageInput: boolean;
    pdfInput: boolean;
  }>;
}>;

export type ConversationUserInputOption = Readonly<{
  label: string;
  description: string;
}>;

export type ConversationUserInputQuestion = Readonly<{
  id: string;
  header: string;
  question: string;
  options: readonly ConversationUserInputOption[];
}>;

export type ConversationUserInputRequest = Readonly<{
  id: string;
  questions: readonly ConversationUserInputQuestion[];
}>;

export type ConversationUserInputAnswer = Readonly<{
  questionId: string;
  answer: string;
}>;

export type ConversationUserInputResponse = Readonly<{
  threadId: string;
  turnId: string;
  inputRequestId: string;
  answers: readonly ConversationUserInputAnswer[];
}>;

export type ConversationTurn = Readonly<{
  id: string;
  status: ConversationTurnStatus;
  model?: ConversationModelSelection;
  messages: readonly ConversationMessage[];
  pendingAgentOutputs?: readonly ConversationAgentOutput[];
  activities?: readonly ConversationActivity[];
  workspaceRead?: ConversationWorkspaceReadActivity;
  workspaceList?: ConversationWorkspaceListActivity;
  workspaceSearch?: ConversationWorkspaceSearchActivity;
  fileChange?: ConversationFileChangeActivity;
  commandApproval?: ConversationCommandApprovalActivity;
  mcpActivities?: readonly ConversationMcpActivity[];
  userInputRequest?: ConversationUserInputRequest;
  error?: ConversationTurnError;
  usage?: ConversationTokenUsage;
}>;

const isTokenUsage = (value: unknown): value is ConversationTokenUsage => {
  const isSample = (sample: unknown): boolean =>
    isRecord(sample) &&
    Object.values(sample).every(
      (token) => Number.isSafeInteger(token) && (token as number) >= 0,
    );
  return (
    isRecord(value) &&
    isSample(value.lastRequest) &&
    isSample(value.turnTotal) &&
    Number.isSafeInteger(value.requestCount) &&
    (value.requestCount as number) >= 1 &&
    Number.isInteger(value.contextWindowTokens) &&
    (value.contextWindowTokens as number) >= 4_096 &&
    (value.contextWindowTokens as number) <= 2_097_152 &&
    (value.source === 'provider' || value.source === 'estimated')
  );
};

export type ConversationNotice = Readonly<{
  kind: 'requestFailed' | 'connectionLost' | 'warning';
  summary: string;
}>;

export type ConversationThreadNavigatorSnapshot = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  activeThreadIds: readonly string[];
  activeThreadTitles: Readonly<Record<string, string>>;
  activeTruncated: boolean;
  runningThreadIds?: readonly string[];
  unreadThreadStatuses?: Readonly<
    Record<string, ConversationTerminalTurnStatus>
  >;
  search: Readonly<{
    query: string;
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
    threadIds: readonly string[];
    threadTitles: Readonly<Record<string, string>>;
    truncated: boolean;
    summary?: string;
  }>;
  pendingThreadId?: string;
  pendingMutation?: Readonly<{
    kind: 'rename' | 'delete';
    threadId: string;
  }>;
  selectionNotice?: string;
  mutationNotice?: string;
}>;

export type ConversationStateSnapshot = Readonly<{
  revision: number;
  workspaceId?: string;
  phase: ConversationPhase;
  threadId?: string;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
  navigator: ConversationThreadNavigatorSnapshot;
  notice?: ConversationNotice;
}>;

export type ConversationThreadProjectionSnapshot = Readonly<{
  revision: number;
  workspaceId: string;
  threadId: string;
  phase: Exclude<ConversationPhase, 'idle' | 'unavailable'>;
  activeTurnId?: string;
  turns: readonly ConversationTurn[];
}>;

export type ConversationThreadProjectionDelta = Readonly<{
  revision: number;
  workspaceId: string;
  threadId: string;
  phase: Exclude<ConversationPhase, 'idle' | 'unavailable'>;
  activeTurnId?: string;
  turn: ConversationTurn;
}>;

export type ConversationActionResult = Readonly<{
  accepted: boolean;
  reason:
    | 'accepted'
    | 'invalidInput'
    | 'invalidSearch'
    | 'unknownThread'
    | 'turnActive'
    | 'unavailable'
    | 'noActiveTurn';
}>;

export type ConversationStateListener = (
  snapshot: ConversationStateSnapshot,
) => void;

export type ConversationThreadProjectionListener = (
  snapshot: ConversationThreadProjectionSnapshot,
) => void;

export type ConversationThreadDeltaListener = (
  delta: ConversationThreadProjectionDelta,
) => void;

export type ConversationProjectionDiagnostic = Readonly<{
  kind: 'shapeInvalid';
  projection: 'snapshot' | 'delta';
  threadId?: string;
  revision?: number;
}>;

export type ConversationApi = Readonly<{
  getConversationState: () => Promise<ConversationStateSnapshot>;
  onConversationStateChanged: (
    listener: ConversationStateListener,
  ) => () => void;
  getConversationThreadProjection: (
    threadId: string,
  ) => Promise<ConversationThreadProjectionSnapshot>;
  onConversationThreadProjectionChanged: (
    listener: ConversationThreadProjectionListener,
    onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
  ) => () => void;
  onConversationThreadDelta: (
    listener: ConversationThreadDeltaListener,
    onDiagnostic?: (diagnostic: ConversationProjectionDiagnostic) => void,
  ) => () => void;
  sendConversationMessage: (
    request: ConversationSendRequest,
  ) => Promise<ConversationActionResult>;
  stopConversationTurn: (threadId: string) => Promise<ConversationActionResult>;
  respondToConversationUserInput: (
    response: ConversationUserInputResponse,
  ) => Promise<ConversationActionResult>;
  searchConversationThreads: (
    query: string,
  ) => Promise<ConversationActionResult>;
  selectConversationThread: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
  startNewConversationThread: () => Promise<ConversationActionResult>;
  deleteConversationThread: (
    threadId: string,
  ) => Promise<ConversationActionResult>;
}>;

export type ConversationSendRequest = Readonly<{
  input: string;
  attachments?: readonly ConversationAttachmentUpload[];
  modelProfileId?: string;
}>;

const PHASES = new Set<ConversationPhase>([
  'idle',
  'starting',
  'inProgress',
  'stopping',
  'ready',
  'unavailable',
]);

const TURN_STATUSES = new Set<ConversationTurnStatus>([
  'inProgress',
  'completed',
  'failed',
  'interrupted',
]);

const TERMINAL_TURN_STATUSES = new Set<ConversationTerminalTurnStatus>([
  'completed',
  'failed',
  'interrupted',
]);

const MESSAGE_STATUSES = new Set<ConversationMessageStatus>([
  'inProgress',
  'completed',
]);

const ERROR_KINDS = new Set<ConversationTurnError['kind']>([
  'authentication',
  'contextWindowExceeded',
  'invalidRequest',
  'rateLimited',
  'timeout',
  'transport',
  'disconnected',
  'server',
  'protocol',
  'incomplete',
  'filtered',
  'unsupportedOutput',
  'unsupportedToolArguments',
  'providerRequestTooLarge',
  'providerResponseTooLarge',
  'outputTooLarge',
  'stateUnavailable',
]);

const PROTOCOL_STAGES = new Set<
  NonNullable<ConversationTurnError['protocol']>['stage']
>([
  'streamEvent',
  'responseAssembly',
  'outputNormalization',
  'runtimeClassification',
]);

const PROTOCOL_CODES = new Set<
  NonNullable<ConversationTurnError['protocol']>['code']
>([
  'wireMismatch',
  'invalidEventShape',
  'ambiguousOutputReconciliation',
  'malformedToolCall',
  'terminalLifecycleViolation',
  'continuationOutputMismatch',
  'outputIndexMismatch',
]);

const COMMAND_APPROVAL_DECISIONS = new Set<ConversationCommandApprovalDecision>(
  [
    'approved',
    'denied',
    'timedOut',
    'unsupported',
    'cancelled',
    'clientDisconnected',
  ],
);

const ACTION_REASONS = new Set<ConversationActionResult['reason']>([
  'accepted',
  'invalidInput',
  'invalidSearch',
  'unknownThread',
  'turnActive',
  'unavailable',
  'noActiveTurn',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const hasBoundedText = (
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === 'string' &&
  (allowEmpty || value.trim().length > 0) &&
  new TextEncoder().encode(value).byteLength <= maxBytes &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));

const isUserInputQuestion = (
  value: unknown,
): value is ConversationUserInputQuestion =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['id', 'header', 'question', 'options'].includes(key),
  ) &&
  typeof value.id === 'string' &&
  /^[a-z][a-z0-9_]{0,63}$/u.test(value.id) &&
  hasBoundedText(value.header, 48) &&
  Array.from(value.header as string).length <= 12 &&
  hasBoundedText(value.question, 512) &&
  Array.isArray(value.options) &&
  value.options.length >= 2 &&
  value.options.length <= MAX_USER_INPUT_OPTIONS &&
  value.options.every(
    (option) =>
      isRecord(option) &&
      Object.keys(option).every((key) =>
        ['label', 'description'].includes(key),
      ) &&
      hasBoundedText(option.label, 96) &&
      hasBoundedText(option.description, 384),
  ) &&
  new Set(
    value.options.map((option) =>
      isRecord(option) ? option.label : undefined,
    ),
  ).size === value.options.length;

const isUserInputRequest = (
  value: unknown,
): value is ConversationUserInputRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['id', 'questions'].includes(key)) &&
  isId(value.id) &&
  Array.isArray(value.questions) &&
  value.questions.length >= 1 &&
  value.questions.length <= MAX_USER_INPUT_QUESTIONS &&
  value.questions.every(isUserInputQuestion) &&
  new Set(value.questions.map((question) => question.id)).size ===
    value.questions.length;

export const isValidSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export const isValidFileChangePath = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1_024 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(value) ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const components = value.split(/[\\/]/u);
  return (
    components.length <= 64 &&
    components.every(
      (component) =>
        component.length > 0 && component !== '.' && component !== '..',
    )
  );
};

export const isValidFileChangeDiff = (
  value: unknown,
  path: string,
  kind: ConversationFileChangeProposal['kind'] = 'update',
): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.endsWith('\n') ||
    value.includes('\r') ||
    new TextEncoder().encode(value).byteLength > MAX_FILE_CHANGE_DIFF_BYTES
  ) {
    return false;
  }
  const lines = value.slice(0, -1).split('\n');
  if (
    lines.length > MAX_FILE_CHANGE_DIFF_LINES ||
    lines[0] !== (kind === 'create' ? '--- /dev/null' : `--- a/${path}`) ||
    lines[1] !== (kind === 'delete' ? '+++ /dev/null' : `+++ b/${path}`)
  ) {
    return false;
  }
  let index = 2;
  let hunks = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(
      lines[index] ?? '',
    );
    if (!header) {
      return false;
    }
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = Number(header[4]);
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldCount) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newCount) ||
      oldStart > 256 * 1024 + 1 ||
      oldCount > 20_000 ||
      newStart > 256 * 1024 + 1 ||
      newCount > 20_000
    ) {
      return false;
    }
    index += 1;
    let observedOld = 0;
    let observedNew = 0;
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      const line = lines[index] ?? '';
      if (line.startsWith(' ')) {
        observedOld += 1;
        observedNew += 1;
      } else if (line.startsWith('-')) {
        observedOld += 1;
      } else if (line.startsWith('+')) {
        observedNew += 1;
      } else {
        return false;
      }
      index += 1;
    }
    if (observedOld !== oldCount || observedNew !== newCount) {
      return false;
    }
    hunks += 1;
  }
  return hunks > 0 || (lines.length === 2 && kind !== 'update');
};

const isTurnError = (value: unknown): value is ConversationTurnError =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  ERROR_KINDS.has(value.kind as ConversationTurnError['kind']) &&
  typeof value.retryable === 'boolean' &&
  (value.protocol === undefined ||
    (isRecord(value.protocol) &&
      typeof value.protocol.stage === 'string' &&
      PROTOCOL_STAGES.has(
        value.protocol.stage as NonNullable<
          ConversationTurnError['protocol']
        >['stage'],
      ) &&
      typeof value.protocol.code === 'string' &&
      PROTOCOL_CODES.has(
        value.protocol.code as NonNullable<
          ConversationTurnError['protocol']
        >['code'],
      ) &&
      (value.protocol.eventType === undefined ||
        (typeof value.protocol.eventType === 'string' &&
          /^[A-Za-z0-9_./-]{1,128}$/.test(value.protocol.eventType))) &&
      typeof value.protocol.shapeSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.protocol.shapeSha256)));

const isMessage = (value: unknown): value is ConversationMessage =>
  isRecord(value) &&
  isId(value.id) &&
  (value.role === 'user' || value.role === 'agent') &&
  typeof value.text === 'string' &&
  typeof value.status === 'string' &&
  MESSAGE_STATUSES.has(value.status as ConversationMessageStatus) &&
  (value.attachments === undefined ||
    (Array.isArray(value.attachments) &&
      value.attachments.length <= MAX_CONVERSATION_ATTACHMENTS &&
      value.attachments.every(isConversationAttachment)));

const isConversationAttachment = (
  value: unknown,
): value is ConversationAttachment =>
  isRecord(value) &&
  typeof value.assetId === 'string' &&
  typeof value.sha256 === 'string' &&
  typeof value.mediaType === 'string' &&
  typeof value.originalName === 'string' &&
  typeof value.sizeBytes === 'number' &&
  Number.isSafeInteger(value.sizeBytes) &&
  value.sizeBytes > 0 &&
  (value.kind === 'image' || value.kind === 'pdf' || value.kind === 'text') &&
  (value.previewUrl === undefined ||
    (value.kind === 'image' &&
      typeof value.previewUrl === 'string' &&
      value.previewUrl.startsWith(`data:${value.mediaType};base64,`) &&
      value.previewUrl.length <= 12 * 1024 * 1024));

const isWorkspaceReadOutcome = (
  value: unknown,
): value is ConversationWorkspaceReadOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.bytes === 'number' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceReadActivity = (
  value: unknown,
): value is ConversationWorkspaceReadActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceReadOutcome(value.result.outcome)
  );
};

const isWorkspaceListOutcome = (
  value: unknown,
): value is ConversationWorkspaceListOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.entries === 'number' &&
      Number.isSafeInteger(value.entries) &&
      value.entries >= 0 &&
      value.entries <= 1_000
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceListActivity = (
  value: unknown,
): value is ConversationWorkspaceListActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceListOutcome(value.result.outcome)
  );
};

const isWorkspaceSearchOutcome = (
  value: unknown,
): value is ConversationWorkspaceSearchOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.matches === 'number' &&
      Number.isSafeInteger(value.matches) &&
      value.matches >= 0 &&
      value.matches <= 200 &&
      typeof value.truncated === 'boolean'
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

const isWorkspaceSearchActivity = (
  value: unknown,
): value is ConversationWorkspaceSearchActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.query !== 'string' ||
    value.query.length === 0 ||
    new TextEncoder().encode(value.query).byteLength > 256 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceSearchOutcome(value.result.outcome)
  );
};

const isFileChangeResultOutcome = (
  value: unknown,
): value is ConversationFileChangeResultOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      Object.keys(value).length === 2 &&
      typeof value.kind === 'string' &&
      value.kind.length > 0
    );
  }
  if (
    value.type === 'success' &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.files)
  ) {
    return (
      value.files.length > 0 &&
      value.files.length <= 64 &&
      value.files.every(
        (receipt) =>
          isRecord(receipt) &&
          Object.keys(receipt).length === 6 &&
          isValidFileChangePath(receipt.path) &&
          (receipt.kind === 'create' ||
            receipt.kind === 'update' ||
            receipt.kind === 'delete') &&
          isValidSha256(receipt.beforeSha256) &&
          isValidSha256(receipt.afterSha256) &&
          typeof receipt.beforeBytes === 'number' &&
          Number.isSafeInteger(receipt.beforeBytes) &&
          receipt.beforeBytes >= 0 &&
          receipt.beforeBytes <= 256 * 1024 &&
          typeof receipt.afterBytes === 'number' &&
          Number.isSafeInteger(receipt.afterBytes) &&
          receipt.afterBytes >= 0 &&
          receipt.afterBytes <= 256 * 1024,
      )
    );
  }
  return (
    value.type === 'success' &&
    Object.keys(value).length === 6 &&
    isValidFileChangePath(value.path) &&
    isValidSha256(value.beforeSha256) &&
    isValidSha256(value.afterSha256) &&
    typeof value.beforeBytes === 'number' &&
    Number.isSafeInteger(value.beforeBytes) &&
    value.beforeBytes >= 0 &&
    value.beforeBytes <= 256 * 1024 &&
    typeof value.afterBytes === 'number' &&
    Number.isSafeInteger(value.afterBytes) &&
    value.afterBytes >= 0 &&
    value.afterBytes <= 256 * 1024
  );
};

const isFileChangeActivity = (
  value: unknown,
): value is ConversationFileChangeActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isValidFileChangePath(value.path) ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  const change = value.change;
  const validProposal = (proposal: unknown): proposal is ConversationFileChangeProposal =>
    isRecord(proposal) &&
    isId(proposal.id) &&
    proposal.id !== value.id &&
    typeof proposal.status === 'string' &&
    MESSAGE_STATUSES.has(proposal.status as ConversationMessageStatus) &&
    isValidFileChangePath(proposal.path) &&
    (proposal.kind === 'create' || proposal.kind === 'update' || proposal.kind === 'delete') &&
    isValidFileChangeDiff(proposal.diff, proposal.path, proposal.kind) &&
    isValidSha256(proposal.beforeSha256) &&
    isValidSha256(proposal.afterSha256) &&
    typeof proposal.beforeBytes === 'number' &&
    Number.isSafeInteger(proposal.beforeBytes) &&
    proposal.beforeBytes >= 0 &&
    proposal.beforeBytes <= 256 * 1024 &&
    typeof proposal.afterBytes === 'number' &&
    Number.isSafeInteger(proposal.afterBytes) &&
    proposal.afterBytes >= 0 &&
    proposal.afterBytes <= 256 * 1024 &&
    (proposal.newlineStyle === 'lf' || proposal.newlineStyle === 'crLf') &&
    typeof proposal.finalNewline === 'boolean';
  if (
    change !== undefined &&
    (!validProposal(change) || change.path !== value.path)
  ) {
    return false;
  }
  const changes = value.changes;
  if (
    changes !== undefined &&
    (!Array.isArray(changes) ||
      changes.length > 64 ||
      changes.some((proposal) => !validProposal(proposal)) ||
      new Set(changes.map((proposal) => (proposal as ConversationFileChangeProposal).path)).size !==
        changes.length)
  ) {
    return false;
  }
  const result = value.result;
  if (
    result !== undefined &&
    (!isRecord(result) ||
      !isId(result.id) ||
      result.id === value.id ||
      result.id ===
        (change as ConversationFileChangeProposal | undefined)?.id ||
      typeof result.status !== 'string' ||
      !MESSAGE_STATUSES.has(result.status as ConversationMessageStatus) ||
      !isFileChangeResultOutcome(result.outcome))
  ) {
    return false;
  }
  const parsedResult = result as
    ConversationFileChangeActivity['result'] | undefined;
  const parsedChange = change as ConversationFileChangeProposal | undefined;
  if (
    parsedResult?.outcome.type === 'success' &&
    !('files' in parsedResult.outcome) &&
    (!parsedChange ||
      parsedResult.outcome.path !== parsedChange.path ||
      parsedResult.outcome.beforeSha256 !== parsedChange.beforeSha256 ||
      parsedResult.outcome.afterSha256 !== parsedChange.afterSha256 ||
      parsedResult.outcome.beforeBytes !== parsedChange.beforeBytes ||
      parsedResult.outcome.afterBytes !== parsedChange.afterBytes)
  ) {
    return false;
  }
  if (
    parsedResult?.outcome.type === 'success' &&
    'files' in parsedResult.outcome &&
    (!Array.isArray(changes) || parsedResult.outcome.files.length !== changes.length)
  ) {
    return false;
  }
  return true;
};

const isCommandExecutionResultOutcome = (
  value: unknown,
): value is ConversationCommandExecutionResultOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      Object.keys(value).length >= 2 &&
      Object.keys(value).length <= 4 &&
      typeof value.kind === 'string' &&
      value.kind.length > 0 &&
      (!Object.hasOwn(value, 'message') ||
        (typeof value.message === 'string' && value.message.length > 0)) &&
      (!Object.hasOwn(value, 'failedPath') ||
        (typeof value.failedPath === 'string' && value.failedPath.length > 0))
    );
  }
  if (value.type === 'workspacePatch') {
    const files = value.files;
    return (
      [2, 3].includes(Object.keys(value).length) &&
      typeof value.filesChanged === 'number' &&
      Number.isSafeInteger(value.filesChanged) &&
      value.filesChanged >= 1 &&
      (!Object.hasOwn(value, 'files') ||
        (Array.isArray(files) &&
          files.length === value.filesChanged &&
          files.every((file) => {
            if (
              !isRecord(file) ||
              ![6, 9].includes(Object.keys(file).length) ||
              typeof file.path !== 'string' ||
              file.path.length === 0 ||
              !['create', 'update', 'delete'].includes(String(file.kind)) ||
              typeof file.beforeSha256 !== 'string' ||
              typeof file.afterSha256 !== 'string' ||
              !Number.isSafeInteger(file.beforeBytes) ||
              (file.beforeBytes as number) < 0 ||
              !Number.isSafeInteger(file.afterBytes) ||
              (file.afterBytes as number) < 0
            ) {
              return false;
            }
            const hasReview = Object.hasOwn(file, 'diff');
            return (
              hasReview === Object.hasOwn(file, 'newlineStyle') &&
              hasReview === Object.hasOwn(file, 'finalNewline') &&
              (!hasReview ||
                (typeof file.diff === 'string' &&
                  (file.newlineStyle === 'lf' ||
                    file.newlineStyle === 'crLf') &&
                  typeof file.finalNewline === 'boolean'))
            );
          })))
    );
  }
  if (
    value.type !== 'process' ||
    ![8, 10].includes(Object.keys(value).length) ||
    typeof value.stdoutBytes !== 'number' ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    value.stdoutBytes < 0 ||
    typeof value.stderrBytes !== 'number' ||
    !Number.isSafeInteger(value.stderrBytes) ||
    value.stderrBytes < 0 ||
    typeof value.stdoutTruncated !== 'boolean' ||
    typeof value.stderrTruncated !== 'boolean' ||
    value.encoding !== 'utf8Lossy' ||
    typeof value.durationMs !== 'number' ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0 ||
    ((Object.hasOwn(value, 'sandboxPolicy') ||
      Object.hasOwn(value, 'networkPolicy')) &&
      (value.sandboxPolicy !== 'filesystemReadOnlyV1' ||
        value.networkPolicy !== 'networkDeniedV1')) ||
    Object.hasOwn(value, 'sandboxPolicy') !==
      Object.hasOwn(value, 'networkPolicy') ||
    !isRecord(value.outcome)
  ) {
    return false;
  }
  if (value.outcome.type === 'timedOut') {
    return Object.keys(value.outcome).length === 1;
  }
  if (value.outcome.type === 'exitCode') {
    return (
      Object.keys(value.outcome).length === 2 &&
      typeof value.outcome.code === 'number' &&
      Number.isSafeInteger(value.outcome.code)
    );
  }
  return (
    value.outcome.type === 'signal' &&
    Object.keys(value.outcome).length === 2 &&
    typeof value.outcome.signal === 'number' &&
    Number.isSafeInteger(value.outcome.signal)
  );
};

const isCommandApprovalActivity = (
  value: unknown,
): value is ConversationCommandApprovalActivity => {
  const fullAccess =
    isRecord(value) && value.fullAccess === true;
  const liveOutputValid =
    !isRecord(value) ||
    !Object.hasOwn(value, 'liveOutput') ||
    (isRecord(value.liveOutput) &&
      typeof value.liveOutput.stdout === 'string' &&
      new TextEncoder().encode(value.liveOutput.stdout).byteLength <= 65_536 &&
      typeof value.liveOutput.stderr === 'string' &&
      new TextEncoder().encode(value.liveOutput.stderr).byteLength <= 65_536);
  if (
    !isRecord(value) ||
    !isId(value.callItemId) ||
    !isId(value.id) ||
    value.callItemId === value.id ||
    !isId(value.callId) ||
    !isId(value.approvalId) ||
    (Object.hasOwn(value, 'operationKind') &&
      value.operationKind !== 'workspacePatch' &&
      value.operationKind !== 'shell') ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    new TextEncoder().encode(value.command).byteLength >
      (fullAccess ? 32_768 : 1_024) ||
    (fullAccess
      ? value.command.includes('\0')
      : Array.from(value.command).some((character) => /\p{Cc}/u.test(character))) ||
    (Object.hasOwn(value, 'fullAccess') && typeof value.fullAccess !== 'boolean') ||
    !liveOutputValid ||
    typeof value.argumentCount !== 'number' ||
    !Number.isSafeInteger(value.argumentCount) ||
    value.argumentCount < 0 ||
    value.argumentCount > 64 ||
    typeof value.requestStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.requestStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'decision')) {
    return (
      !Object.hasOwn(value, 'executionAttempt') &&
      !Object.hasOwn(value, 'executionResult')
    );
  }
  if (!(
    value.requestStatus === 'completed' &&
    isRecord(value.decision) &&
    isId(value.decision.id) &&
    value.decision.id !== value.id &&
    value.decision.id !== value.callItemId &&
    typeof value.decision.status === 'string' &&
    MESSAGE_STATUSES.has(value.decision.status as ConversationMessageStatus) &&
    typeof value.decision.value === 'string' &&
    COMMAND_APPROVAL_DECISIONS.has(
      value.decision.value as ConversationCommandApprovalDecision,
    ) &&
    (value.decision.source === undefined ||
      ['user', 'policy', 'system'].includes(String(value.decision.source)))
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionAttempt')) {
    return !Object.hasOwn(value, 'executionResult');
  }
  if (!(
    value.decision.value === 'approved' &&
    value.decision.status === 'completed' &&
    isRecord(value.executionAttempt) &&
    isId(value.executionAttempt.id) &&
    value.executionAttempt.id !== value.id &&
    value.executionAttempt.id !== value.callItemId &&
    value.executionAttempt.id !== value.decision.id &&
    typeof value.executionAttempt.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionAttempt.status as ConversationMessageStatus,
    )
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionResult')) {
    return true;
  }
  return (
    value.executionAttempt.status === 'completed' &&
    isRecord(value.executionResult) &&
    isId(value.executionResult.id) &&
    value.executionResult.id !== value.id &&
    value.executionResult.id !== value.callItemId &&
    value.executionResult.id !== value.decision.id &&
    value.executionResult.id !== value.executionAttempt.id &&
    typeof value.executionResult.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionResult.status as ConversationMessageStatus,
    ) &&
    isCommandExecutionResultOutcome(value.executionResult.outcome)
  );
};

const isMcpResultReceipt = (
  value: unknown,
): value is ConversationMcpResultReceipt => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      typeof value.kind === 'string' &&
      value.kind.length > 0 &&
      typeof value.requestState === 'string' &&
      value.requestState.length > 0
    );
  }
  return (
    value.type === 'completed' &&
    typeof value.isError === 'boolean' &&
    [value.observedBytes, value.canonicalBytes, value.retainedBytes].every(
      (count) =>
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    ) &&
    typeof value.truncated === 'boolean' &&
    isValidSha256(value.sha256) &&
    typeof value.contentBlocks === 'number' &&
    Number.isSafeInteger(value.contentBlocks) &&
    value.contentBlocks >= 0 &&
    value.contentBlocks <= 32 &&
    typeof value.structuredContent === 'boolean'
  );
};

const isMcpActivity = (value: unknown): value is ConversationMcpActivity => {
  if (
    !isRecord(value) ||
    !isId(value.callItemId) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isId(value.approvalId) ||
    typeof value.serverId !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.serverId) ||
    typeof value.name !== 'string' ||
    !value.name.startsWith(`mcp__${value.serverId}__`) ||
    typeof value.argumentsBytes !== 'number' ||
    !Number.isSafeInteger(value.argumentsBytes) ||
    value.argumentsBytes < 0 ||
    value.argumentsBytes > 32 * 1024 ||
    !isValidSha256(value.argumentsSha256) ||
    !isValidSha256(value.inventorySha256) ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus) ||
    typeof value.requestStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.requestStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, 'decision') &&
    (!isRecord(value.decision) ||
      !isId(value.decision.id) ||
      typeof value.decision.status !== 'string' ||
      !MESSAGE_STATUSES.has(
        value.decision.status as ConversationMessageStatus,
      ) ||
      typeof value.decision.value !== 'string' ||
      !COMMAND_APPROVAL_DECISIONS.has(
        value.decision.value as ConversationCommandApprovalDecision,
      ))
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, 'executionAttempt') &&
    (!isRecord(value.executionAttempt) ||
      !isId(value.executionAttempt.id) ||
      typeof value.executionAttempt.status !== 'string' ||
      !MESSAGE_STATUSES.has(
        value.executionAttempt.status as ConversationMessageStatus,
      ))
  ) {
    return false;
  }
  return (
    !Object.hasOwn(value, 'result') ||
    (isRecord(value.result) &&
      isId(value.result.id) &&
      typeof value.result.status === 'string' &&
      MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
      isMcpResultReceipt(value.result.receipt))
  );
};

const isTurn = (value: unknown): value is ConversationTurn => {
  const pendingAgentOutputs = isRecord(value)
    ? value.pendingAgentOutputs
    : undefined;
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    typeof value.status !== 'string' ||
    !TURN_STATUSES.has(value.status as ConversationTurnStatus) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    (Object.hasOwn(value, 'model') &&
      (!isRecord(value.model) ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(
          value.model.profileId as string,
        ) ||
        ![
          'openai',
          'anthropic',
        ].includes(value.model.providerFamily as string) ||
        ![
          'openaiResponses',
          'openaiChatCompletions',
          'anthropicMessages',
        ].includes(value.model.wireApi as string) ||
        typeof value.model.modelId !== 'string' ||
        typeof value.model.displayName !== 'string' ||
        !Number.isInteger(value.model.contextWindowTokens) ||
        (value.model.contextWindowTokens as number) < 4_096 ||
        !isRecord(value.model.effectiveCapabilities) ||
        ![
          'toolCalls',
          'strictTools',
          'parallelTools',
          'imageInput',
          'pdfInput',
        ].every(
          (key) =>
            typeof (
              (value.model as Record<string, unknown>)
                .effectiveCapabilities as Record<string, unknown>
            )[key] === 'boolean',
        ))) ||
    (Object.hasOwn(value, 'pendingAgentOutputs') &&
      (!Array.isArray(pendingAgentOutputs) ||
        pendingAgentOutputs.length > 1 ||
        !pendingAgentOutputs.every(
          (output) =>
            isRecord(output) &&
            Number.isSafeInteger(output.responseOrdinal) &&
            (output.responseOrdinal as number) >= 1 &&
            Number.isSafeInteger(output.outputIndex) &&
            (output.outputIndex as number) >= 0 &&
            typeof output.text === 'string' &&
            output.text.length > 0 &&
            new TextEncoder().encode(output.text).byteLength <= 512 * 1024,
        ))) ||
    (Object.hasOwn(value, 'workspaceRead') &&
      !isWorkspaceReadActivity(value.workspaceRead)) ||
    (Object.hasOwn(value, 'workspaceList') &&
      !isWorkspaceListActivity(value.workspaceList)) ||
    (Object.hasOwn(value, 'workspaceSearch') &&
      !isWorkspaceSearchActivity(value.workspaceSearch)) ||
    (Object.hasOwn(value, 'fileChange') &&
      !isFileChangeActivity(value.fileChange)) ||
    (Object.hasOwn(value, 'commandApproval') &&
      !isCommandApprovalActivity(value.commandApproval)) ||
    (Object.hasOwn(value, 'mcpActivities') &&
      (!Array.isArray(value.mcpActivities) ||
        value.mcpActivities.length > 4 ||
        !value.mcpActivities.every(isMcpActivity))) ||
    (Object.hasOwn(value, 'userInputRequest') &&
      !isUserInputRequest(value.userInputRequest)) ||
    (Object.hasOwn(value, 'usage') && !isTokenUsage(value.usage))
  ) {
    return false;
  }

  if (
    value.status !== 'inProgress' &&
    (value.messages.some((message) => message.status !== 'completed') ||
      (Array.isArray(pendingAgentOutputs) ? pendingAgentOutputs.length : 0) > 0 ||
      Object.hasOwn(value, 'userInputRequest'))
  ) {
    return false;
  }

  const workspaceRead = value.workspaceRead as
    ConversationWorkspaceReadActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceRead &&
    (workspaceRead.callStatus !== 'completed' ||
      (workspaceRead.result && workspaceRead.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceRead.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceList = value.workspaceList as
    ConversationWorkspaceListActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceList &&
    (workspaceList.callStatus !== 'completed' ||
      (workspaceList.result && workspaceList.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceList.result?.status !== 'completed'))
  ) {
    return false;
  }

  const workspaceSearch = value.workspaceSearch as
    ConversationWorkspaceSearchActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    workspaceSearch &&
    (workspaceSearch.callStatus !== 'completed' ||
      (workspaceSearch.result &&
        workspaceSearch.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        workspaceSearch.result?.status !== 'completed'))
  ) {
    return false;
  }

  const fileChange = value.fileChange as
    ConversationFileChangeActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    fileChange &&
    (fileChange.callStatus !== 'completed' ||
      (fileChange.change && fileChange.change.status !== 'completed') ||
      (fileChange.result && fileChange.result.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        fileChange.result?.status !== 'completed'))
  ) {
    return false;
  }

  const commandApproval = value.commandApproval as
    ConversationCommandApprovalActivity | undefined;
  if (
    value.status !== 'inProgress' &&
    commandApproval &&
    (commandApproval.requestStatus !== 'completed' ||
      (commandApproval.decision &&
        commandApproval.decision.status !== 'completed') ||
      (commandApproval.executionAttempt &&
        commandApproval.executionAttempt.status !== 'completed') ||
      (commandApproval.executionResult &&
        commandApproval.executionResult.status !== 'completed') ||
      (value.status !== 'interrupted' &&
        (commandApproval.decision?.status !== 'completed' ||
          (commandApproval.executionAttempt &&
            commandApproval.executionResult?.status !== 'completed'))))
  ) {
    return false;
  }

  const mcpActivities = value.mcpActivities as
    readonly ConversationMcpActivity[] | undefined;
  if (
    value.status !== 'inProgress' &&
    mcpActivities?.some(
      (activity) =>
        activity.callStatus !== 'completed' ||
        activity.requestStatus !== 'completed' ||
        (activity.decision && activity.decision.status !== 'completed') ||
        (activity.executionAttempt &&
          activity.executionAttempt.status !== 'completed') ||
        (activity.result && activity.result.status !== 'completed') ||
        (value.status !== 'interrupted' &&
          (!activity.decision || !activity.result)),
    )
  ) {
    return false;
  }

  const hasError = Object.hasOwn(value, 'error');
  if (value.status === 'failed') {
    return hasError && isTurnError(value.error);
  }
  if (value.status === 'interrupted') {
    return !hasError || isTurnError(value.error);
  }
  return !hasError;
};

const isNotice = (value: unknown): value is ConversationNotice =>
  isRecord(value) &&
  (value.kind === 'requestFailed' ||
    value.kind === 'connectionLost' ||
    value.kind === 'warning') &&
  typeof value.summary === 'string' &&
  value.summary.length > 0;

const isThreadNavigator = (
  value: unknown,
): value is ConversationThreadNavigatorSnapshot => {
  const pendingMutation =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).pendingMutation
      : undefined;
  if (
    !isRecord(value) ||
    !['loading', 'ready', 'error', 'unavailable'].includes(
      value.status as string,
    ) ||
    !Array.isArray(value.activeThreadIds) ||
    !value.activeThreadIds.every(isId) ||
    new Set(value.activeThreadIds).size !== value.activeThreadIds.length ||
    !isThreadTitleMap(value.activeThreadTitles, value.activeThreadIds) ||
    typeof value.activeTruncated !== 'boolean' ||
    (Object.hasOwn(value, 'runningThreadIds') &&
      (!Array.isArray(value.runningThreadIds) ||
        !value.runningThreadIds.every(isId))) ||
    (Object.hasOwn(value, 'unreadThreadStatuses') &&
      (!isRecord(value.unreadThreadStatuses) ||
        !Object.entries(value.unreadThreadStatuses).every(
          ([threadId, status]) =>
            isId(threadId) &&
            TERMINAL_TURN_STATUSES.has(
              status as ConversationTerminalTurnStatus,
            ),
        ))) ||
    !isRecord(value.search) ||
    typeof value.search.query !== 'string' ||
    new TextEncoder().encode(value.search.query).byteLength >
      MAX_THREAD_SEARCH_BYTES ||
    !['idle', 'loading', 'ready', 'empty', 'error'].includes(
      value.search.status as string,
    ) ||
    !Array.isArray(value.search.threadIds) ||
    !value.search.threadIds.every(isId) ||
    new Set(value.search.threadIds).size !== value.search.threadIds.length ||
    !isThreadTitleMap(value.search.threadTitles, value.search.threadIds) ||
    typeof value.search.truncated !== 'boolean' ||
    (Object.hasOwn(value.search, 'summary') &&
      (typeof value.search.summary !== 'string' ||
        value.search.summary.length === 0)) ||
    (Object.hasOwn(value, 'pendingThreadId') && !isId(value.pendingThreadId)) ||
    (Object.hasOwn(value, 'pendingMutation') &&
      (!isRecord(pendingMutation) ||
        !['rename', 'delete'].includes(
          pendingMutation.kind as string,
        ) ||
        !isId(pendingMutation.threadId))) ||
    (Object.hasOwn(value, 'pendingThreadId') &&
      Object.hasOwn(value, 'pendingMutation')) ||
    (Object.hasOwn(value, 'selectionNotice') &&
      (typeof value.selectionNotice !== 'string' ||
        value.selectionNotice.length === 0)) ||
    (Object.hasOwn(value, 'mutationNotice') &&
      (typeof value.mutationNotice !== 'string' ||
        value.mutationNotice.length === 0))
  ) {
    return false;
  }
  return (
    (value.search.status === 'idle'
      ? value.search.query.length === 0 &&
        value.search.threadIds.length === 0 &&
        !value.search.truncated
      : value.search.query.trim().length > 0) &&
    (value.search.status === 'empty'
      ? value.search.threadIds.length === 0
      : true)
  );
};

const isThreadTitleMap = (
  value: unknown,
  threadIds: readonly unknown[],
): value is Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    return false;
  }
  const knownIds = new Set(threadIds);
  return Object.entries(value).every(
    ([threadId, title]) =>
      knownIds.has(threadId) &&
      typeof title === 'string' &&
      title.trim().length > 0 &&
      new TextEncoder().encode(title).byteLength <= 256,
  );
};

const hasValidActiveTurn = (
  phase: ConversationPhase,
  activeTurnId: unknown,
  turns: readonly ConversationTurn[],
  threadSelected: boolean,
): boolean => {
  const activeTurns = turns.filter((turn) => turn.status === 'inProgress');
  const phaseHasActiveTurn = phase === 'inProgress' || phase === 'stopping';
  if (phase === 'starting') {
    return activeTurns.length === 0
      ? activeTurnId === undefined
      : activeTurns.length === 1 &&
          activeTurnId === activeTurns[0]?.id &&
          threadSelected;
  }
  if (phaseHasActiveTurn) {
    return (
      activeTurns.length === 1 &&
      activeTurnId === activeTurns[0]?.id &&
      threadSelected
    );
  }
  if (phase === 'unavailable' && activeTurns.length === 1) {
    return activeTurnId === activeTurns[0]?.id && threadSelected;
  }
  return activeTurns.length === 0 && activeTurnId === undefined;
};

export const isConversationThreadProjectionSnapshot = (
  value: unknown,
): value is ConversationThreadProjectionSnapshot =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['revision', 'workspaceId', 'threadId', 'phase', 'activeTurnId', 'turns'].includes(
      key,
    ),
  ) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 0 &&
  isId(value.workspaceId) &&
  isId(value.threadId) &&
  ['starting', 'inProgress', 'stopping', 'ready'].includes(
    String(value.phase),
  ) &&
  (!Object.hasOwn(value, 'activeTurnId') || isId(value.activeTurnId)) &&
  Array.isArray(value.turns) &&
  value.turns.every(isTurn) &&
  hasValidActiveTurn(
    value.phase as ConversationPhase,
    value.activeTurnId,
    value.turns,
    true,
  );

export const isConversationThreadProjectionDelta = (
  value: unknown,
): value is ConversationThreadProjectionDelta =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['revision', 'workspaceId', 'threadId', 'phase', 'activeTurnId', 'turn'].includes(
      key,
    ),
  ) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 1 &&
  isId(value.workspaceId) &&
  isId(value.threadId) &&
  ['starting', 'inProgress', 'stopping', 'ready'].includes(
    String(value.phase),
  ) &&
  (!Object.hasOwn(value, 'activeTurnId') || isId(value.activeTurnId)) &&
  isTurn(value.turn) &&
  ((value.phase === 'inProgress' || value.phase === 'stopping')
    ? value.activeTurnId === value.turn.id && value.turn.status === 'inProgress'
    : value.phase === 'starting'
      ? value.activeTurnId === undefined ||
        (value.activeTurnId === value.turn.id && value.turn.status === 'inProgress')
      : value.activeTurnId === undefined || value.activeTurnId !== value.turn.id);

export const isConversationStateSnapshot = (
  value: unknown,
): value is ConversationStateSnapshot => {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    (Object.hasOwn(value, 'workspaceId') && !isId(value.workspaceId)) ||
    typeof value.phase !== 'string' ||
    !PHASES.has(value.phase as ConversationPhase) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn) ||
    !isThreadNavigator(value.navigator) ||
    (Object.hasOwn(value, 'threadId') && !isId(value.threadId)) ||
    (Object.hasOwn(value, 'activeTurnId') && !isId(value.activeTurnId)) ||
    (Object.hasOwn(value, 'notice') && !isNotice(value.notice))
  ) {
    return false;
  }

  const activeTurnId = value.activeTurnId as string | undefined;
  return hasValidActiveTurn(
    value.phase as ConversationPhase,
    activeTurnId,
    value.turns,
    isId(value.threadId),
  );
};

export const isConversationActionResult = (
  value: unknown,
): value is ConversationActionResult =>
  isRecord(value) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  ACTION_REASONS.has(value.reason as ConversationActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');

export const isValidConversationInput = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_INPUT_BYTES;

export const isConversationSendRequest = (
  value: unknown,
): value is ConversationSendRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['input', 'attachments', 'modelProfileId'].includes(key),
  ) &&
  typeof value.input === 'string' &&
  new TextEncoder().encode(value.input).byteLength <=
    MAX_CONVERSATION_INPUT_BYTES &&
  (value.input.trim().length > 0 ||
    (Array.isArray(value.attachments) && value.attachments.length > 0)) &&
  (value.attachments === undefined ||
    (Array.isArray(value.attachments) &&
      value.attachments.length <= MAX_CONVERSATION_ATTACHMENTS &&
      value.attachments.every(isConversationAttachmentUpload))) &&
  (value.modelProfileId === undefined ||
    (typeof value.modelProfileId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId)));

export const isConversationUserInputResponse = (
  value: unknown,
): value is ConversationUserInputResponse =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'turnId', 'inputRequestId', 'answers'].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.turnId) &&
  isId(value.inputRequestId) &&
  Array.isArray(value.answers) &&
  value.answers.length >= 1 &&
  value.answers.length <= MAX_USER_INPUT_QUESTIONS &&
  value.answers.every(
    (answer) =>
      isRecord(answer) &&
      Object.keys(answer).every((key) =>
        ['questionId', 'answer'].includes(key),
      ) &&
      typeof answer.questionId === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(answer.questionId) &&
      hasBoundedText(answer.answer, MAX_USER_INPUT_ANSWER_BYTES),
  ) &&
  new Set(value.answers.map((answer) => answer.questionId)).size ===
    value.answers.length;

const isConversationAttachmentUpload = (
  value: unknown,
): value is ConversationAttachmentUpload =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['fileName', 'mediaType', 'data'].includes(key),
  ) &&
  typeof value.fileName === 'string' &&
  value.fileName.length > 0 &&
  value.fileName.length <= 255 &&
  !/[\\/\p{Cc}]/u.test(value.fileName) &&
  (value.mediaType === undefined ||
    (typeof value.mediaType === 'string' && value.mediaType.length <= 127)) &&
  typeof value.data === 'string' &&
  value.data.length > 0 &&
  value.data.length <= 27_962_032;

export const isValidThreadSearchInput = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_THREAD_SEARCH_BYTES ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const query = value.trim();
  return query.length === 0 || query.split(/\s+/u).length <= 16;
};

export const isValidConversationTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_TITLE_BYTES &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));
