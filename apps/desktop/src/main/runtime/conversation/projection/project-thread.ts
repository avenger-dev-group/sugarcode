import type {
  ConversationActivity,
  ConversationAttachment,
  ConversationCommandExecutionResultOutcome,
  ConversationTurn,
  ConversationThreadQueue,
  ConversationTurnError,
  ConversationWorkspacePatchFile,
} from '../../../../shared/conversation.ts';
import {
  isRuntimeAgentTask,
  type RuntimeAgentTask,
  type RuntimeContentPart,
  type RuntimeModelSelection,
  type RuntimeProviderError,
  type RuntimeThreadSnapshot,
  type RuntimeThreadQueue,
  type RuntimeTurnItemRecord,
} from '../../../../runtime/contracts/protocol.ts';
import {
  interruptPendingUserInputActivities,
  projectTurnActivities,
} from './tool-activities.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const workspacePatchFile = (
  value: unknown,
): ConversationWorkspacePatchFile | undefined => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !['create', 'update', 'delete'].includes(String(value.kind)) ||
    typeof value.beforeSha256 !== 'string' ||
    typeof value.afterSha256 !== 'string' ||
    !Number.isSafeInteger(value.beforeBytes) ||
    !Number.isSafeInteger(value.afterBytes)
  ) {
    return undefined;
  }
  const hasReview =
    typeof value.diff === 'string' &&
    (value.newlineStyle === 'lf' || value.newlineStyle === 'crLf') &&
    typeof value.finalNewline === 'boolean';
  return {
    path: value.path,
    kind: value.kind as 'create' | 'update' | 'delete',
    beforeSha256: value.beforeSha256,
    afterSha256: value.afterSha256,
    beforeBytes: value.beforeBytes as number,
    afterBytes: value.afterBytes as number,
    ...(hasReview
      ? {
          diff: value.diff as string,
          newlineStyle: value.newlineStyle as 'lf' | 'crLf',
          finalNewline: value.finalNewline as boolean,
        }
      : {}),
  };
};

export const commandOutcome = (
  result: Readonly<Record<string, unknown>>,
): ConversationCommandExecutionResultOutcome => {
  if (
    result.ok === true &&
    Array.isArray(result.files) &&
    result.files.length >= 1
  ) {
    const files = result.files.flatMap((file) => {
      const projected = workspacePatchFile(file);
      return projected ? [projected] : [];
    });
    return {
      type: 'workspacePatch',
      filesChanged: result.files.length,
      ...(files.length === result.files.length ? { files } : {}),
    };
  }
  const output = result.output;
  if (
    result.status !== 'completed' ||
    !isRecord(output) ||
    typeof output.stdoutBytes !== 'number' ||
    typeof output.stderrBytes !== 'number' ||
    typeof output.stdoutTruncated !== 'boolean' ||
    typeof output.stderrTruncated !== 'boolean' ||
    typeof output.durationMs !== 'number' ||
    !isRecord(output.outcome) ||
    typeof output.outcome.type !== 'string'
  ) {
    const kind = typeof result.kind === 'string'
      ? result.kind
      : typeof result.error === 'string'
        ? result.error
        : String(result.status ?? 'unavailable');
    return {
      type: 'error',
      kind,
      ...(typeof result.message === 'string' && result.message.length > 0
        ? { message: result.message }
        : {}),
      ...(typeof result.failedPath === 'string' && result.failedPath.length > 0
        ? { failedPath: result.failedPath }
        : {}),
    };
  }
  const processOutcome = output.outcome.type === 'exitCode' &&
    typeof output.outcome.code === 'number'
    ? { type: 'exitCode' as const, code: output.outcome.code }
    : output.outcome.type === 'signal' &&
        typeof output.outcome.signal === 'number'
      ? { type: 'signal' as const, signal: output.outcome.signal }
      : { type: 'timedOut' as const };
  return {
    type: 'process',
    stdoutBytes: output.stdoutBytes,
    stderrBytes: output.stderrBytes,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    encoding: 'utf8Lossy',
    durationMs: output.durationMs,
    outcome: processOutcome,
    ...(result.mode === 'sandboxed'
      ? {
          sandboxPolicy: 'filesystemReadOnlyV1' as const,
          networkPolicy: 'networkDeniedV1' as const,
        }
      : {}),
  };
};

export const runtimeError = (
  error: RuntimeProviderError,
): ConversationTurnError => {
  const kind = String(error.kind);
  return {
    kind:
      kind === 'rateLimit'
        ? 'rateLimited'
        : kind === 'connection'
          ? 'transport'
          : kind === 'cancelled' || kind === 'runtimeRestart'
            ? 'incomplete'
            : kind === 'unknown'
              ? 'server'
              : [
                    'authentication',
                    'contextWindowExceeded',
                    'invalidRequest',
                    'timeout',
                    'protocol',
                    'incomplete',
                    'server',
                    'filtered',
                    'unsupportedToolArguments',
                    'outputTooLarge',
                    'stateUnavailable',
                  ].includes(kind)
                ? kind as ConversationTurnError['kind']
                : 'stateUnavailable',
    retryable: error.retryable === true,
    ...(error.protocol ? { protocol: error.protocol } : {}),
  };
};

export const visibleRuntimeError = (
  error: RuntimeProviderError,
  status: 'running' | 'completed' | 'failed' | 'interrupted',
): ConversationTurnError | undefined =>
  status === 'interrupted' && error.kind === 'cancelled'
    ? undefined
    : runtimeError(error);

const fallbackModel = (
  wireApi: RuntimeThreadSnapshot['turns'][number]['providerWireApi'],
  model: string,
): RuntimeModelSelection => ({
  profileId: 'recovered',
  providerFamily: wireApi === 'anthropicMessages' ? 'anthropic' : 'openai',
  wireApi,
  modelId: model,
  displayName: model,
  contextWindowTokens: 128_000,
  effectiveCapabilities: {
    toolCalls: true,
    strictTools: false,
    parallelTools: true,
    imageInput: true,
    pdfInput: wireApi === 'anthropicMessages',
  },
});

const modelFromItems = (
  items: readonly RuntimeTurnItemRecord[],
  fallback: RuntimeModelSelection,
): RuntimeModelSelection => {
  const started = items.find((item) => item.kind === 'turn.started')?.payload;
  return started && typeof started.model === 'object' && started.model !== null
    ? (started.model as RuntimeModelSelection)
    : fallback;
};

export const attachmentFromPart = (
  part: Extract<RuntimeContentPart, { type: 'asset' }>,
): ConversationAttachment => ({
  assetId: part.asset.assetId,
  sha256: part.asset.sha256,
  mediaType: part.asset.mediaType,
  originalName: part.asset.originalName,
  sizeBytes: part.asset.sizeBytes,
  kind: part.asset.kind,
  ...(part.asset.pdfPages === undefined
    ? {}
    : { pdfPages: part.asset.pdfPages }),
});

const messageFromContent = (
  id: string,
  content: readonly unknown[],
): ConversationTurn['messages'][number] | undefined => {
  const text = content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
  const attachments = content.flatMap(
    (part): readonly ConversationAttachment[] =>
      isRecord(part) &&
      part.type === 'asset' &&
      isRecord(part.asset)
        ? [attachmentFromPart(part as Extract<RuntimeContentPart, { type: 'asset' }>)]
        : [],
  );
  const knowledgeReferences = content.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== 'knowledgeReferences' ||
      !Array.isArray(part.references)
    ) {
      return [];
    }
    return part.references.flatMap((reference) =>
      isRecord(reference) &&
      typeof reference.knowledgeBaseId === 'string' &&
      /^kb_[0-9a-f]{32}$/u.test(reference.knowledgeBaseId) &&
      typeof reference.name === 'string' &&
      reference.name.length > 0 &&
      reference.name.length <= 80
        ? [{
            knowledgeBaseId: reference.knowledgeBaseId,
            name: reference.name,
          }]
        : [],
    );
  });
  return text || attachments.length > 0 || knowledgeReferences.length > 0
    ? {
        id,
        role: 'user',
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
        status: 'completed',
      }
    : undefined;
};

export const projectThreadQueue = (
  queue: RuntimeThreadQueue,
): ConversationThreadQueue => ({
  paused: queue.paused,
  messages: queue.messages.map((message) => {
    const projected = messageFromContent(message.id, message.content);
    return {
      id: message.id,
      position: message.position,
      revision: message.revision,
      input: projected?.text ?? '',
      attachments: projected?.attachments ?? [],
      ...(message.modelProfileId
        ? { modelProfileId: message.modelProfileId }
        : {}),
      ...(message.modelRequest ? { modelRequest: message.modelRequest } : {}),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }),
});

export const orchestrationActivity = (
  tasks: readonly RuntimeAgentTask[],
): ConversationActivity | undefined => {
  if (tasks.length === 0) {
    return undefined;
  }
  const orchestrationId = tasks[0]?.orchestrationId;
  if (
    !orchestrationId ||
    tasks.some((task) => task.orchestrationId !== orchestrationId)
  ) {
    return undefined;
  }
  return {
    type: 'orchestration',
    activity: {
      id: orchestrationId,
      tasks: tasks.map((task) => ({
        id: task.taskId,
        taskId: task.taskId,
        clientTaskKey: task.clientTaskKey,
        childThreadId: task.childThreadId,
        title: task.title,
        role: task.role,
        access: task.access,
        dependsOn: [...task.dependsOn],
        taskMarkdown: task.taskMarkdown,
        status: task.status,
        amendments: task.amendments.map((amendment) => ({ ...amendment })),
        ...(task.progress ? { progress: { ...task.progress } } : {}),
        ...(task.result ? { result: { ...task.result } } : {}),
      })),
    },
  };
};

const contextCompactionActivities = (
  items: readonly RuntimeTurnItemRecord[],
): ConversationActivity[] => {
  const activities = new Map<
    string,
    Extract<ConversationActivity, { type: 'contextCompaction' }>
  >();
  for (const item of items) {
    const payload = item.payload;
    if (
      item.kind !== 'turn.contextCompactionStarted' &&
      item.kind !== 'turn.contextCompactionFinished'
    ) {
      continue;
    }
    if (
      typeof payload.compactionId !== 'string' ||
      !['auto', 'manual', 'recovery'].includes(String(payload.trigger)) ||
      !['applicationSummary', 'openaiNative', 'anthropicNative'].includes(
        String(payload.strategy),
      )
    ) {
      continue;
    }
    const previous = activities.get(payload.compactionId);
    const finished = item.kind === 'turn.contextCompactionFinished';
    activities.set(payload.compactionId, {
      type: 'contextCompaction',
      activity: {
        id: payload.compactionId,
        status: finished && ['completed', 'failed', 'interrupted'].includes(
          String(payload.outcome),
        )
          ? payload.outcome as 'completed' | 'failed' | 'interrupted'
          : previous?.activity.status ?? 'inProgress',
        trigger: payload.trigger as 'auto' | 'manual' | 'recovery',
        strategy: payload.strategy as
          | 'applicationSummary'
          | 'openaiNative'
          | 'anthropicNative',
        ...(typeof payload.beforeContextTokens === 'number'
          ? { beforeContextTokens: payload.beforeContextTokens }
          : previous?.activity.beforeContextTokens === undefined
            ? {}
            : { beforeContextTokens: previous.activity.beforeContextTokens }),
        ...(typeof payload.afterContextTokens === 'number'
          ? { afterContextTokens: payload.afterContextTokens }
          : {}),
        ...(typeof payload.durationMs === 'number'
          ? { durationMs: payload.durationMs }
          : {}),
        ...(typeof payload.readableSummary === 'string'
          ? { readableSummary: payload.readableSummary }
          : {}),
        ...(typeof payload.opaqueCheckpoint === 'boolean'
          ? { opaqueCheckpoint: payload.opaqueCheckpoint }
          : {}),
        ...(typeof payload.message === 'string'
          ? { message: payload.message }
          : {}),
      },
    });
  }
  return [...activities.values()];
};

export const projectThread = (
  snapshot: RuntimeThreadSnapshot,
): readonly ConversationTurn[] => {
  const currentGoalContextTurnIds = snapshot.goal
    ? snapshot.items
        .filter(
          (item) =>
            item.kind === 'turn.goalContext' &&
            item.payload.goalId === snapshot.goal?.id,
        )
        .map((item) => item.turnId)
    : [];
  const legacyGoalObjectiveTurnId = currentGoalContextTurnIds.some((turnId) =>
    snapshot.items.some(
      (item) => item.turnId === turnId && item.kind === 'turn.goalObjective',
    ),
  )
    ? undefined
    : currentGoalContextTurnIds[0];

  return snapshot.turns.map((record) => {
    const items = snapshot.items.filter((item) => item.turnId === record.id);
    const model = modelFromItems(
      items,
      fallbackModel(record.providerWireApi, record.model),
    );
    const userMessages = items
      .filter(
        (item) =>
          item.kind === 'turn.userMessage' ||
          item.kind === 'turn.goalObjective',
      )
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap((item, index) => {
        const content = Array.isArray(item.payload.content)
          ? item.payload.content
          : [];
        const message = messageFromContent(
          item.kind === 'turn.goalObjective'
            ? item.id
            : index === 0
              ? `${record.id}:user`
              : item.id,
          content,
        );
        return message ? [message] : [];
      });
    const completedTextItems = items.filter(
      (item) => item.kind === 'turn.textCompleted',
    );
    const completedFinalItems = completedTextItems.filter(
      (item) => item.payload.phase === 'final',
    );
    const finalText = completedFinalItems.length > 0
      ? completedFinalItems.map((item) => String(item.payload.text ?? '')).join('')
      : items
          .filter(
            (item) =>
              item.kind === 'turn.textDelta' && item.payload.phase === 'final',
          )
          .map((item) => String(item.payload.delta ?? ''))
          .join('');
    const proposedPlanItem = items.findLast(
      (item) => item.kind === 'turn.planProposed',
    );
    const planProposal =
      proposedPlanItem &&
        typeof proposedPlanItem.payload.planId === 'string' &&
        typeof proposedPlanItem.payload.content === 'string'
        ? {
            id: proposedPlanItem.payload.planId,
            content: proposedPlanItem.payload.content,
          }
        : undefined;
    const restoredActivities = interruptPendingUserInputActivities(
      projectTurnActivities(items),
    );
    const durableTasks = snapshot.agentTasks
      .filter((task) => task.turnId === record.id)
      .map((task) => ({ ...task.payload, status: task.status }));
    const itemTasks = new Map<string, RuntimeAgentTask>();
    if (durableTasks.length === 0) {
      for (const item of items) {
        const task = item.kind === 'agent.task' ? item.payload.task : undefined;
        if (isRuntimeAgentTask(task)) {
          itemTasks.set(task.taskId, task);
        }
      }
    }
    const restoredTasks = durableTasks.length > 0
      ? durableTasks
      : [...itemTasks.values()];
    const restoredOrchestration = orchestrationActivity(restoredTasks);
    const activities = [
      ...restoredActivities,
      ...contextCompactionActivities(items),
      ...(restoredOrchestration ? [restoredOrchestration] : []),
    ];
    const legacyGoalObjective =
      record.id === legacyGoalObjectiveTurnId && snapshot.goal
        ? {
            id: `${record.id}:goal-objective`,
            role: 'user' as const,
            text: snapshot.goal.objective,
            status: 'completed' as const,
          }
        : undefined;
    const messages = [
      ...(legacyGoalObjective ? [legacyGoalObjective] : []),
      ...userMessages,
      ...(finalText
        ? [
            {
              id: `${record.id}:agent`,
              role: 'agent' as const,
              text: finalText,
              status: 'completed' as const,
            },
          ]
        : []),
    ];
    const error = record.errorJson
      ? (() => {
          try {
            return visibleRuntimeError(
              JSON.parse(record.errorJson) as RuntimeProviderError,
              record.status,
            );
          } catch {
            return { kind: 'stateUnavailable' as const, retryable: true };
          }
        })()
      : undefined;
    return {
      id: record.id,
      status: record.status === 'running' ? 'interrupted' : record.status,
      ...(record.completedAt === null
        ? {}
        : {
            durationMs: Math.max(
              0,
              (record.completedAt - record.startedAt) * 1_000,
            ),
          }),
      model,
      messages,
      ...(items.some((item) => item.kind === 'turn.goalContext')
        ? { origin: 'goal' as const }
        : {}),
      ...(planProposal ? { planProposal } : {}),
      ...(activities.length > 0 ? { activities } : {}),
      ...(error ? { error } : {}),
    };
  });
};
