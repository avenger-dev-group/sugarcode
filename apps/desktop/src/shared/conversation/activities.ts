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
  knowledgeReferences?: readonly Readonly<{
    knowledgeBaseId: string;
    name: string;
  }>[];
  status: ConversationMessageStatus;
}>;

export type ConversationPlanProposal = Readonly<{
  id: string;
  content: string;
}>;

export type ConversationAttachment = Readonly<{
  assetId: string;
  sha256: string;
  mediaType: string;
  originalName: string;
  sizeBytes: number;
  kind: 'image' | 'pdf' | 'text';
  pdfPages?: number;
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

export type ConversationKnowledgeCitation = Readonly<{
  citation: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  fileName: string;
  relativePath: string;
  heading?: string;
  pageNumber?: number;
  contentKind?: 'text' | 'code';
  language?: string;
  startLine?: number;
  endLine?: number;
  content: string;
}>;

export type ConversationKnowledgeActivity = Readonly<{
  id: string;
  callId: string;
  operation: 'search' | 'listDocuments' | 'read';
  query?: string;
  callStatus: ConversationMessageStatus;
  result?: Readonly<{
    id: string;
    status: ConversationMessageStatus;
    outcome:
      | Readonly<{
          type: 'success';
          mode: 'fullText' | 'hybrid' | 'documentList' | 'read';
          matches: number;
          knowledgeBases: readonly Readonly<{ id: string; name: string }>[];
          citations?: readonly ConversationKnowledgeCitation[];
        }>
      | Readonly<{ type: 'error'; kind: string }>;
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
  operationKind?: 'workspacePatch' | 'shell' | 'projectEnvironment';
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

export type ConversationContextCompactionActivity = Readonly<{
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  trigger: 'auto' | 'manual' | 'recovery';
  strategy: 'applicationSummary' | 'openaiNative' | 'anthropicNative';
  beforeContextTokens?: number;
  afterContextTokens?: number;
  durationMs?: number;
  readableSummary?: string;
  opaqueCheckpoint?: boolean;
  message?: string;
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
      type: 'knowledge';
      activity: ConversationKnowledgeActivity;
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
    }>
  | Readonly<{
      type: 'contextCompaction';
      activity: ConversationContextCompactionActivity;
    }>
  | Readonly<{
      type: 'userInput';
      activity: ConversationUserInputActivity;
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
    contextInputTokens?: number;
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
  autoCompaction?: 'auto' | 'enabled' | 'disabled';
  compactThresholdTokens?: number;
  nativeCompaction?: 'auto' | 'enabled' | 'disabled';
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

export type ConversationUserInputDecision =
  | Readonly<{
      questionId: string;
      kind: 'answered';
      source: 'option' | 'custom';
      answer: string;
    }>
  | Readonly<{
      questionId: string;
      kind: 'skipped';
    }>;

export type ConversationUserInputSubmission =
  | Readonly<{
      kind: 'submitted';
      decisions: readonly ConversationUserInputDecision[];
    }>
  | Readonly<{
      kind: 'cancelled';
      decisions: readonly ConversationUserInputDecision[];
    }>;

export type ConversationUserInputActivity = Readonly<{
  id: string;
  questions: readonly ConversationUserInputQuestion[];
  state: 'awaiting' | 'submitted' | 'cancelled' | 'interrupted';
  decisions: readonly ConversationUserInputDecision[];
}>;

export type ConversationUserInputResponse = Readonly<{
  threadId: string;
  turnId: string;
  inputRequestId: string;
  submission: ConversationUserInputSubmission;
}>;
