import { randomUUID } from 'node:crypto';

import {
  isConversationThreadProjectionDelta,
  isConversationThreadProjectionSnapshot,
  isConversationStateSnapshot,
  isConversationSendRequest,
  isValidThreadSearchInput,
  type ConversationActionResult,
  type ConversationActivity,
  type ConversationAttachment,
  type ConversationCommandExecutionResultOutcome,
  type ConversationStateListener,
  type ConversationStateSnapshot,
  type ConversationThreadDeltaListener,
  type ConversationThreadProjectionDelta,
  type ConversationThreadProjectionListener,
  type ConversationThreadProjectionSnapshot,
  type ConversationTokenUsage,
  type ConversationThreadNavigatorSnapshot,
  type ConversationTurn,
  type ConversationTurnError,
} from '../../shared/conversation.ts';
import {
  isRuntimeAgentTask,
  type RuntimeAgentTask,
  type RuntimeContentPart,
  type RuntimeEvent,
  type RuntimeModelSelection,
  type RuntimeProviderError,
  type RuntimeThreadRecord,
  type RuntimeThreadSnapshot,
  type RuntimeTurnItemRecord,
} from '../../runtime/protocol.ts';
import {
  appendWorkspaceToolCall,
  applyWorkspaceToolResult,
  projectTurnActivities,
} from './conversation-tool-activities.ts';
import { createUuidV7 } from './id.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

const accepted = (): ConversationActionResult => ({ accepted: true, reason: 'accepted' });
const rejected = (
  reason: Exclude<ConversationActionResult['reason'], 'accepted'>,
): ConversationActionResult => ({ accepted: false, reason });

type TokenUsageSample = ConversationTokenUsage['lastRequest'];

const addTokenUsage = (
  previous: TokenUsageSample | undefined,
  current: TokenUsageSample,
): TokenUsageSample => {
  const add = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const inputTokens = add(previous?.inputTokens, current.inputTokens);
  const outputTokens = add(previous?.outputTokens, current.outputTokens);
  const reasoningTokens = add(
    previous?.reasoningTokens,
    current.reasoningTokens,
  );
  const cachedInputTokens = add(
    previous?.cachedInputTokens,
    current.cachedInputTokens,
  );
  const totalTokens = add(previous?.totalTokens, current.totalTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const commandOutcome = (
  result: Readonly<Record<string, unknown>>,
): ConversationCommandExecutionResultOutcome => {
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
    return { type: 'error', kind };
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

const emptyNavigator = (): ConversationThreadNavigatorSnapshot => ({
  status: 'unavailable',
  activeThreadIds: [],
  activeThreadTitles: {},
  activeTruncated: false,
  runningThreadIds: [],
  search: {
    query: '',
    status: 'idle',
    threadIds: [],
    threadTitles: {},
    truncated: false,
  },
});

type ClearableNavigatorField =
  | 'pendingThreadId'
  | 'pendingMutation'
  | 'archivedUndoThreadId'
  | 'selectionNotice'
  | 'mutationNotice'
  | 'unreadThreadStatuses';

const withoutNavigatorFields = (
  navigator: ConversationThreadNavigatorSnapshot,
  fields: readonly ClearableNavigatorField[],
): ConversationThreadNavigatorSnapshot => {
  const next = { ...navigator };
  for (const field of fields) {
    delete next[field];
  }
  return next;
};

const titleFromInput = (input: string): string | undefined => {
  const title = input.trim().replace(/\s+/gu, ' ').slice(0, 80);
  return title || undefined;
};

const runtimeError = (error: RuntimeProviderError): ConversationTurnError => {
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
                    'invalidRequest',
                    'timeout',
                    'protocol',
                    'server',
                    'filtered',
                    'unsupportedToolArguments',
                    'outputTooLarge',
                  ].includes(kind)
                ? kind as ConversationTurnError['kind']
                : 'stateUnavailable',
    retryable: error.retryable === true,
  };
};

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

const attachmentFromPart = (
  part: Extract<RuntimeContentPart, { type: 'asset' }>,
): ConversationAttachment => ({
  assetId: part.asset.assetId,
  sha256: part.asset.sha256,
  mediaType: part.asset.mediaType,
  originalName: part.asset.originalName,
  sizeBytes: part.asset.sizeBytes,
  kind: part.asset.kind,
});

const orchestrationActivity = (
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

const projectThread = (
  snapshot: RuntimeThreadSnapshot,
): readonly ConversationTurn[] =>
  snapshot.turns.map((record) => {
    const items = snapshot.items.filter((item) => item.turnId === record.id);
    const model = modelFromItems(
      items,
      fallbackModel(record.providerWireApi, record.model),
    );
    const user = items.find((item) => item.kind === 'turn.userMessage')?.payload;
    const userContent = Array.isArray(user?.content) ? user.content : [];
    const userText = userContent
          .filter(
            (part): part is { type: 'text'; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string',
          )
          .map((part) => part.text)
          .join('\n');
    const attachments = userContent.flatMap((part): readonly ConversationAttachment[] =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'asset' &&
      typeof (part as { asset?: unknown }).asset === 'object' &&
      (part as { asset?: unknown }).asset !== null
        ? [attachmentFromPart(part as Extract<RuntimeContentPart, { type: 'asset' }>)]
        : [],
    );
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
    const restoredActivities = projectTurnActivities(items);
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
      ...(restoredOrchestration ? [restoredOrchestration] : []),
    ];
    const messages = [
      ...(userText || attachments.length > 0
        ? [{
            id: `${record.id}:user`,
            role: 'user' as const,
            text: userText,
            ...(attachments.length > 0 ? { attachments } : {}),
            status: 'completed' as const,
          }]
        : []),
      ...(finalText
        ? [{ id: `${record.id}:agent`, role: 'agent' as const, text: finalText, status: 'completed' as const }]
        : []),
    ];
    const error = record.errorJson
      ? (() => {
          try {
            return runtimeError(JSON.parse(record.errorJson) as RuntimeProviderError);
          } catch {
            return { kind: 'stateUnavailable' as const, retryable: true };
          }
        })()
      : undefined;
    return {
      id: record.id,
      status: record.status === 'running' ? 'interrupted' : record.status,
      model,
      messages,
      ...(activities.length > 0 ? { activities } : {}),
      ...(error ? { error } : {}),
    };
  });

export class RuntimeConversationController {
  private readonly runtime: RuntimeSupervisor;
  private readonly listeners = new Set<ConversationStateListener>();
  private readonly threadProjectionListeners =
    new Set<ConversationThreadProjectionListener>();
  private readonly threadDeltaListeners =
    new Set<ConversationThreadDeltaListener>();
  private readonly threadRevisions = new Map<string, number>();
  private readonly threadRecords = new Map<string, RuntimeThreadRecord>();
  private readonly turnsByThread = new Map<string, ConversationTurn[]>();
  private readonly unreadThreadStatuses = new Map<
    string,
    'completed' | 'failed' | 'interrupted'
  >();
  private readonly activeTurnsByThread = new Map<
    string,
    Readonly<{
      workspaceId: string;
      turnId: string;
      phase: Extract<
        ConversationStateSnapshot['phase'],
        'starting' | 'inProgress' | 'stopping'
      >;
    }>
  >();
  private readonly pendingTurnStartWorkspaces = new Set<string>();
  private workspaceId: string | null = null;
  private workspaceGeneration = 0;
  private threadSelectionGeneration = 0;
  private revision = 0;
  private available = false;
  private threadId: string | null = null;
  private navigator = emptyNavigator();
  private notice: ConversationStateSnapshot['notice'];

  constructor(runtime: RuntimeSupervisor) {
    this.runtime = runtime;
    runtime.subscribe(this.handleRuntimeEvent);
  }

  getSnapshot = (): ConversationStateSnapshot => {
    const activeTurn = this.threadId
      ? this.activeTurnsByThread.get(this.threadId)
      : undefined;
    const phase: ConversationStateSnapshot['phase'] = !this.available
      ? 'unavailable'
      : this.workspaceId && this.pendingTurnStartWorkspaces.has(this.workspaceId)
        ? 'starting'
        : activeTurn?.phase ?? (this.threadId ? 'ready' : 'idle');
    return {
      revision: this.revision,
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      phase,
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(activeTurn ? { activeTurnId: activeTurn.turnId } : {}),
      turns: this.threadId ? this.turnsByThread.get(this.threadId) ?? [] : [],
      navigator: this.navigator,
      ...(this.notice ? { notice: this.notice } : {}),
    };
  };

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getThreadProjection = (
    threadId: unknown,
  ): ConversationThreadProjectionSnapshot | null =>
    typeof threadId === 'string'
      ? this.buildThreadProjection(threadId)
      : null;

  subscribeThreadProjection = (
    listener: ConversationThreadProjectionListener,
  ): (() => void) => {
    this.threadProjectionListeners.add(listener);
    return () => this.threadProjectionListeners.delete(listener);
  };

  subscribeThreadDelta = (
    listener: ConversationThreadDeltaListener,
  ): (() => void) => {
    this.threadDeltaListeners.add(listener);
    return () => this.threadDeltaListeners.delete(listener);
  };

  switchWorkspace = async (workspaceId: string): Promise<boolean> => {
    const generation = ++this.workspaceGeneration;
    this.threadSelectionGeneration += 1;
    this.workspaceId = workspaceId;
    this.threadId = null;
    this.available = false;
    this.navigator = { ...emptyNavigator(), status: 'loading' };
    this.notice = undefined;
    this.refreshNavigator('loading');
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.list', requestId: randomUUID(), workspaceId },
        'thread.listResult',
      );
      if (
        this.workspaceGeneration !== generation ||
        this.workspaceId !== workspaceId
      ) {
        return true;
      }
      this.available = true;
      this.applyThreadList(workspaceId, event.threads);
      this.publish();
      return true;
    } catch {
      if (
        this.workspaceGeneration === generation &&
        this.workspaceId === workspaceId
      ) {
        this.navigator = { ...this.navigator, status: 'error' };
        this.notice = { kind: 'requestFailed', summary: 'Threads could not be loaded from local storage.' };
        this.publish();
      }
      return false;
    }
  };

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationSendRequest(input)) {
      return rejected('invalidInput');
    }
    if (!this.workspaceId || !this.available) {
      return rejected('unavailable');
    }
    const workspaceId = this.workspaceId;
    let threadId = this.threadId;
    if (
      this.pendingTurnStartWorkspaces.has(workspaceId) ||
      (threadId && this.activeTurnsByThread.has(threadId)) ||
      this.navigator.pendingMutation
    ) {
      return rejected('turnActive');
    }
    this.pendingTurnStartWorkspaces.add(workspaceId);
    this.notice = undefined;
    this.publish();
    let optimisticTurn: Readonly<{ threadId: string; turnId: string }> | undefined;
    try {
      const content: RuntimeContentPart[] = input.input.length > 0
        ? [{ type: 'text', text: input.input }]
        : [];
      const attachments: ConversationAttachment[] = [];
      for (const attachment of input.attachments ?? []) {
        const imported = await this.runtime.request(
          {
            type: 'asset.import',
            requestId: randomUUID(),
            fileName: attachment.fileName,
            ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
            data: attachment.data,
          },
          'asset.imported',
        );
        content.push({ type: 'asset', asset: imported.asset });
        attachments.push({
          ...attachmentFromPart({ type: 'asset', asset: imported.asset }),
          ...(imported.asset.kind === 'image'
            ? { previewUrl: `data:${imported.asset.mediaType};base64,${attachment.data}` }
            : {}),
        });
      }
      if (!threadId) {
        const created = await this.runtime.request(
          {
            type: 'thread.create',
            requestId: randomUUID(),
            workspaceId,
            ...(titleFromInput(input.input) ? { title: titleFromInput(input.input) } : {}),
          },
          'thread.mutated',
        );
        if (!created.snapshot) {
          throw new Error('The local runtime did not return the new Thread.');
        }
        threadId = created.threadId;
        this.threadRecords.set(created.threadId, created.snapshot.thread);
        this.turnsByThread.set(created.threadId, []);
        if (this.workspaceId === workspaceId && !this.threadId) {
          this.threadSelectionGeneration += 1;
          this.threadId = created.threadId;
        }
        this.refreshNavigator();
      }
      const turnId = createUuidV7();
      const userMessage = {
        id: `${turnId}:user`,
        role: 'user' as const,
        text: input.input,
        ...(attachments.length > 0 ? { attachments } : {}),
        status: 'inProgress' as const,
      };
      this.turnsByThread.set(threadId, [
        ...(this.turnsByThread.get(threadId) ?? []),
        { id: turnId, status: 'inProgress', messages: [userMessage] },
      ]);
      this.activeTurnsByThread.set(threadId, {
        workspaceId,
        turnId,
        phase: 'starting',
      });
      this.unreadThreadStatuses.delete(threadId);
      optimisticTurn = { threadId, turnId };
      this.pendingTurnStartWorkspaces.delete(workspaceId);
      this.refreshNavigator();
      this.runtime.send({
        type: 'turn.start',
        requestId: randomUUID(),
        workspaceId,
        threadId,
        turnId,
        ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
        content,
      });
      this.publishThreadProjection(threadId, true);
      this.publish();
      return accepted();
    } catch {
      this.pendingTurnStartWorkspaces.delete(workspaceId);
      if (
        optimisticTurn &&
        this.activeTurnsByThread.get(optimisticTurn.threadId)?.turnId ===
          optimisticTurn.turnId
      ) {
        this.activeTurnsByThread.delete(optimisticTurn.threadId);
        this.turnsByThread.set(
          optimisticTurn.threadId,
          (this.turnsByThread.get(optimisticTurn.threadId) ?? []).filter(
            (turn) => turn.id !== optimisticTurn.turnId,
          ),
        );
        this.refreshNavigator();
      }
      if (this.workspaceId === workspaceId) {
        this.notice = { kind: 'requestFailed', summary: 'The local Agent could not start this Turn.' };
      }
      this.publish();
      return rejected('unavailable');
    }
  };

  stopTurn = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || threadId !== this.threadId) {
      return rejected('unknownThread');
    }
    const activeTurn = this.activeTurnsByThread.get(threadId);
    if (!this.workspaceId || !activeTurn) {
      return rejected('noActiveTurn');
    }
    this.activeTurnsByThread.set(threadId, {
      ...activeTurn,
      phase: 'stopping',
    });
    this.runtime.send({
      type: 'turn.cancel',
      requestId: randomUUID(),
      workspaceId: activeTurn.workspaceId,
      threadId,
      turnId: activeTurn.turnId,
    });
    this.publishThreadDelta(threadId, activeTurn.turnId);
    this.publish();
    return accepted();
  };

  searchThreads = async (query: unknown): Promise<ConversationActionResult> => {
    if (!isValidThreadSearchInput(query)) {
      return rejected('invalidSearch');
    }
    if (!this.workspaceId) {
      return rejected('unavailable');
    }
    const workspaceId = this.workspaceId;
    const normalizedQuery = query.trim();
    this.navigator = {
      ...this.navigator,
      search: { ...this.navigator.search, query: normalizedQuery, status: 'loading' },
    };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.list', requestId: randomUUID(), workspaceId, query: normalizedQuery },
        'thread.listResult',
      );
      if (
        this.workspaceId !== workspaceId ||
        this.navigator.search.query !== normalizedQuery
      ) {
        return accepted();
      }
      const titles = Object.fromEntries(
        event.threads.flatMap((thread) => thread.title ? [[thread.id, thread.title]] : []),
      );
      this.navigator = {
        ...this.navigator,
        search: {
          query: normalizedQuery,
          status: event.threads.length > 0 ? 'ready' : 'empty',
          threadIds: event.threads.map((thread) => thread.id),
          threadTitles: titles,
          truncated: event.threads.length === 200,
        },
      };
      this.publish();
      return accepted();
    } catch {
      if (
        this.workspaceId !== workspaceId ||
        this.navigator.search.query !== normalizedQuery
      ) {
        return accepted();
      }
      this.navigator = { ...this.navigator, search: { ...this.navigator.search, status: 'error' } };
      this.publish();
      return rejected('unavailable');
    }
  };

  selectThread = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string') {
      return rejected('unknownThread');
    }
    const thread = this.threadRecords.get(threadId);
    if (!thread || thread.workspaceId !== this.workspaceId) {
      return rejected('unknownThread');
    }
    if (!this.workspaceId) {
      return rejected('unavailable');
    }
    const selectionGeneration = ++this.threadSelectionGeneration;
    const workspaceId = this.workspaceId;
    if (threadId === this.threadId) {
      this.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.navigator = withoutNavigatorFields(this.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.publish();
      this.publishThreadProjection(threadId);
      return accepted();
    }
    if (
      this.workspaceId &&
      this.pendingTurnStartWorkspaces.has(this.workspaceId)
    ) {
      return rejected('turnActive');
    }
    if (this.activeTurnsByThread.has(threadId) && this.turnsByThread.has(threadId)) {
      this.threadId = threadId;
      this.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.navigator = withoutNavigatorFields(this.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.publish();
      this.publishThreadProjection(threadId);
      return accepted();
    }
    this.navigator = {
      ...withoutNavigatorFields(this.navigator, ['selectionNotice']),
      pendingThreadId: threadId,
    };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: 'thread.load', requestId: randomUUID(), workspaceId, threadId },
        'thread.loaded',
      );
      if (
        event.workspaceId !== workspaceId ||
        event.snapshot.thread.workspaceId !== workspaceId
      ) {
        throw new Error('Thread crossed workspace ownership.');
      }
      if (
        this.workspaceId !== workspaceId ||
        this.threadSelectionGeneration !== selectionGeneration
      ) {
        return accepted();
      }
      this.threadId = threadId;
      this.turnsByThread.set(threadId, [...projectThread(event.snapshot)]);
      this.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.navigator = withoutNavigatorFields(this.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.publish();
      this.publishThreadProjection(threadId, true);
      return accepted();
    } catch {
      if (
        this.workspaceId !== workspaceId ||
        this.threadSelectionGeneration !== selectionGeneration
      ) {
        return accepted();
      }
      this.navigator = {
        ...this.navigator,
        pendingThreadId: threadId,
        selectionNotice:
          'That Thread could not be restored safely. Select it to retry.',
      };
      this.publish();
      return rejected('unavailable');
    }
  };

  startNewThread = (): ConversationActionResult => {
    const pendingTurnStart = this.workspaceId
      ? this.pendingTurnStartWorkspaces.has(this.workspaceId)
      : false;
    if (!this.workspaceId || !this.available || pendingTurnStart) {
      return rejected(pendingTurnStart ? 'turnActive' : 'unavailable');
    }
    this.threadSelectionGeneration += 1;
    this.threadId = null;
    this.navigator = withoutNavigatorFields(this.navigator, [
      'archivedUndoThreadId',
      'pendingThreadId',
      'selectionNotice',
    ]);
    this.publish();
    return accepted();
  };

  forkThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('fork', threadId);

  archiveThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('archive', threadId);

  unarchiveThread = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (threadId !== this.navigator.archivedUndoThreadId) {
      return rejected('unknownThread');
    }
    return this.mutateThread('unarchive', threadId);
  };

  deleteThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.mutateThread('delete', threadId);

  private mutateThread = async (
    operation: 'fork' | 'archive' | 'unarchive' | 'delete',
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || (!this.threadRecords.has(threadId) && operation !== 'unarchive')) {
      return rejected('unknownThread');
    }
    if (
      !this.workspaceId ||
      this.pendingTurnStartWorkspaces.has(this.workspaceId) ||
      this.activeTurnsByThread.has(threadId) ||
      this.navigator.pendingMutation
    ) {
      return rejected(
        this.pendingTurnStartWorkspaces.has(this.workspaceId) ||
          this.activeTurnsByThread.has(threadId)
          ? 'turnActive'
          : 'unavailable',
      );
    }
    const workspaceId = this.workspaceId;
    this.navigator = { ...this.navigator, pendingMutation: { kind: operation, threadId } };
    this.publish();
    try {
      const event = await this.runtime.request(
        { type: `thread.${operation}`, requestId: randomUUID(), workspaceId, threadId } as const,
        'thread.mutated',
      );
      if (event.workspaceId !== workspaceId) {
        throw new Error('Thread mutation crossed workspace ownership.');
      }
      if (this.workspaceId !== workspaceId) {
        return accepted();
      }
      if (operation === 'fork' && event.snapshot) {
        this.threadRecords.set(event.threadId, event.snapshot.thread);
        this.turnsByThread.set(event.threadId, [...projectThread(event.snapshot)]);
        this.threadSelectionGeneration += 1;
        this.threadId = event.threadId;
        this.publishThreadProjection(event.threadId, true);
      } else if (operation === 'unarchive' && event.snapshot) {
        this.threadRecords.set(threadId, event.snapshot.thread);
        this.turnsByThread.set(threadId, [...projectThread(event.snapshot)]);
        this.threadSelectionGeneration += 1;
        this.threadId = threadId;
        this.publishThreadProjection(threadId, true);
      } else if (operation === 'archive' || operation === 'delete') {
        this.threadRecords.delete(threadId);
        this.turnsByThread.delete(threadId);
        this.threadRevisions.delete(threadId);
        this.unreadThreadStatuses.delete(threadId);
        if (this.threadId === threadId) {
          this.threadSelectionGeneration += 1;
          this.threadId = null;
        }
      }
      this.navigator = {
        ...withoutNavigatorFields(this.navigator, [
          'pendingMutation',
          'archivedUndoThreadId',
        ]),
        ...(operation === 'archive'
          ? { archivedUndoThreadId: threadId }
          : {}),
      };
      this.refreshNavigator();
      this.publish();
      return accepted();
    } catch {
      if (this.workspaceId !== workspaceId) {
        return accepted();
      }
      this.navigator = {
        ...withoutNavigatorFields(this.navigator, ['pendingMutation']),
        mutationNotice: 'The Thread lifecycle change was rejected.',
      };
      this.publish();
      return rejected('unavailable');
    }
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (
      (!event.type.startsWith('turn.') &&
        !event.type.startsWith('agent.') &&
        !event.type.startsWith('approval.') &&
        !event.type.startsWith('operation.')) ||
      !('threadId' in event) ||
      !('turnId' in event)
    ) {
      return;
    }
    const activeTurn = this.activeTurnsByThread.get(event.threadId);
    const thread = this.threadRecords.get(event.threadId);
    if (
      !('workspaceId' in event) ||
      (activeTurn?.workspaceId ?? thread?.workspaceId) !== event.workspaceId
    ) {
      return;
    }
    const turns = [...(this.turnsByThread.get(event.threadId) ?? [])];
    const index = turns.findIndex((turn) => turn.id === event.turnId);
    if (index < 0) {
      return;
    }
    const turn = turns[index];
    switch (event.type) {
      case 'turn.started':
        turns[index] = { ...turn, model: event.model };
        if (this.activeTurnsByThread.get(event.threadId)?.turnId === event.turnId) {
          this.activeTurnsByThread.set(event.threadId, {
            workspaceId: event.workspaceId,
            turnId: event.turnId,
            phase: 'inProgress',
          });
          this.refreshNavigator();
        }
        break;
      case 'turn.userMessage':
        turns[index] = {
          ...turn,
          messages: turn.messages.map((message) => message.role === 'user' ? { ...message, status: 'completed' } : message),
        };
        break;
      case 'turn.textStarted':
        break;
      case 'turn.textDelta': {
        if (event.phase === 'commentary') {
          const activities = [...(turn.activities ?? [])];
          const activityIndex = activities.findIndex(
            (activity) =>
              activity.type === 'commentary' &&
              activity.activity.id === event.itemId,
          );
          const current = activities[activityIndex];
          if (activityIndex >= 0 && current?.type === 'commentary') {
            activities[activityIndex] = {
              type: 'commentary',
              activity: {
                ...current.activity,
                text: current.activity.text + event.delta,
              },
            };
          } else {
            activities.push({ type: 'commentary', activity: { id: event.itemId, text: event.delta, status: 'inProgress' } });
          }
          turns[index] = { ...turn, activities };
        } else {
          const messages = [...turn.messages];
          const agentIndex = messages.findIndex(
            (message) => message.role === 'agent' && message.id === event.itemId,
          );
          if (agentIndex >= 0) {
            const current = messages[agentIndex];
            messages[agentIndex] = { ...current, text: current.text + event.delta };
          } else {
            messages.push({ id: event.itemId, role: 'agent', text: event.delta, status: 'inProgress' });
          }
          turns[index] = { ...turn, messages };
        }
        break;
      }
      case 'turn.textCompleted': {
        if (event.phase === 'commentary') {
          const messages = turn.messages.filter(
            (message) => message.role !== 'agent' || message.id !== event.itemId,
          );
          const activities = [...(turn.activities ?? [])];
          const activityIndex = activities.findIndex(
            (activity) =>
              activity.type === 'commentary' &&
              activity.activity.id === event.itemId,
          );
          const completed = {
            type: 'commentary' as const,
            activity: {
              id: event.itemId,
              text: event.text,
              status: 'completed' as const,
            },
          };
          if (activityIndex >= 0) {
            activities[activityIndex] = completed;
          } else {
            activities.push(completed);
          }
          turns[index] = { ...turn, messages, activities };
        } else {
          const messages = [
            ...turn.messages.filter((message) => message.role === 'user'),
            {
              id: event.itemId,
              role: 'agent' as const,
              text: event.text,
              status: 'completed' as const,
            },
          ];
          const activities = turn.activities?.filter(
            (activity) =>
              activity.type !== 'commentary' ||
              activity.activity.id !== event.itemId,
          );
          turns[index] = {
            ...turn,
            messages,
            ...(activities ? { activities } : {}),
          };
        }
        break;
      }
      case 'turn.toolCall': {
        const activities = [...(turn.activities ?? [])];
        appendWorkspaceToolCall(
          activities,
          event.itemId,
          event.callId,
          event.name,
          event.arguments,
        );
        turns[index] = { ...turn, activities };
        break;
      }
      case 'turn.toolResult': {
        const activities = [...(turn.activities ?? [])];
        applyWorkspaceToolResult(
          activities,
          event.itemId,
          event.callId,
          event.result,
        );
        turns[index] = { ...turn, activities };
        break;
      }
      case 'turn.usage': {
        const previous = turn.usage;
        const turnTotal = addTokenUsage(previous?.turnTotal, event.usage);
        turns[index] = {
          ...turn,
          usage: {
            lastRequest: event.usage,
            turnTotal,
            requestCount: (previous?.requestCount ?? 0) + 1,
            contextWindowTokens: turn.model?.contextWindowTokens ?? 128_000,
            source: 'provider',
          },
        };
        break;
      }
      case 'agent.task': {
        const activities = [...(turn.activities ?? [])];
        const orchestrationIndex = activities.findIndex(
          (activity) => activity.type === 'orchestration',
        );
        const projected = orchestrationActivity([event.task]);
        if (!projected || projected.type !== 'orchestration') {
          return;
        }
        const projectedTask = projected.activity.tasks[0];
        if (!projectedTask) {
          return;
        }
        if (orchestrationIndex < 0) {
          activities.push(projected);
        } else {
          const activity = activities[orchestrationIndex];
          if (
            activity?.type !== 'orchestration' ||
            activity.activity.id !== event.task.orchestrationId
          ) {
            return;
          }
          const tasks = [...activity.activity.tasks];
          const taskIndex = tasks.findIndex(
            (task) => task.taskId === event.task.taskId,
          );
          if (taskIndex >= 0) {
            tasks[taskIndex] = projectedTask;
          } else {
            tasks.push(projectedTask);
          }
          activities[orchestrationIndex] = {
            type: 'orchestration',
            activity: { ...activity.activity, tasks },
          };
        }
        turns[index] = { ...turn, activities };
        break;
      }
      case 'approval.requested': {
        const activities = [...(turn.activities ?? [])];
        const nextActivity = {
          type: 'commandApproval',
          activity: {
            callItemId: event.operationId,
            id: `${event.approvalId}:request`,
            callId: event.operationId,
            approvalId: event.approvalId,
            command: event.argumentsSummary,
            argumentCount: 0,
            fullAccess: event.fullAccess,
            requestStatus: 'inProgress',
          },
        } as const;
        const existingIndex = activities.findIndex(
          (activity) =>
            activity.type === 'commandApproval' &&
            activity.activity.approvalId === event.approvalId,
        );
        if (existingIndex >= 0) {
          activities[existingIndex] = nextActivity;
        } else {
          activities.push(nextActivity);
        }
        turns[index] = { ...turn, activities };
        break;
      }
      case 'approval.resolved': {
        const activities = turn.activities?.map((activity) =>
          activity.type === 'commandApproval' &&
          activity.activity.approvalId === event.approvalId
            ? {
                type: 'commandApproval' as const,
                activity: {
                  ...activity.activity,
                  requestStatus: 'completed' as const,
                  decision: {
                    id: `${event.approvalId}:decision`,
                    status: 'completed' as const,
                    value: event.decision,
                  },
                },
              }
            : activity,
        );
        turns[index] = { ...turn, ...(activities ? { activities } : {}) };
        break;
      }
      case 'operation.started': {
        const activities = turn.activities?.map((activity) =>
          activity.type === 'commandApproval' &&
          activity.activity.callId === event.operationId
            ? {
                type: 'commandApproval' as const,
                activity: {
                  ...activity.activity,
                  executionAttempt: {
                    id: `${event.operationId}:attempt`,
                    status: 'inProgress' as const,
                  },
                },
              }
            : activity,
        );
        turns[index] = { ...turn, ...(activities ? { activities } : {}) };
        break;
      }
      case 'operation.output': {
        const activities = turn.activities?.map((activity) => {
          if (
            activity.type !== 'commandApproval' ||
            activity.activity.callId !== event.operationId
          ) {
            return activity;
          }
          const liveOutput = activity.activity.liveOutput ?? {
            stdout: '',
            stderr: '',
          };
          return {
            type: 'commandApproval' as const,
            activity: {
              ...activity.activity,
              liveOutput: {
                ...liveOutput,
                [event.stream]: `${liveOutput[event.stream]}${event.delta}`.slice(
                  -64 * 1024,
                ),
              },
            },
          };
        });
        turns[index] = { ...turn, ...(activities ? { activities } : {}) };
        break;
      }
      case 'operation.completed': {
        const activities = turn.activities?.map((activity) =>
          activity.type === 'commandApproval' &&
          activity.activity.callId === event.operationId
            ? {
                type: 'commandApproval' as const,
                activity: {
                  ...activity.activity,
                  executionAttempt: {
                    id: `${event.operationId}:attempt`,
                    status: 'completed' as const,
                  },
                  executionResult: {
                    id: `${event.operationId}:result`,
                    status: 'completed' as const,
                    outcome: commandOutcome(event.result),
                  },
                },
              }
            : activity,
        );
        turns[index] = { ...turn, ...(activities ? { activities } : {}) };
        break;
      }
      case 'turn.completed': {
        const messages = turn.messages.map((message) => ({ ...message, status: 'completed' as const }));
        const activities = turn.activities?.map((activity) => {
          if (activity.type === 'commentary') {
            return {
              type: 'commentary' as const,
              activity: { ...activity.activity, status: 'completed' as const },
            };
          }
          if (activity.type === 'orchestration' && event.status !== 'completed') {
            return {
              type: 'orchestration' as const,
              activity: {
                ...activity.activity,
                tasks: activity.activity.tasks.map((task) =>
                  ['queued', 'running', 'waitingApproval'].includes(task.status)
                    ? { ...task, status: 'interrupted' as const }
                    : task,
                ),
              },
            };
          }
          return activity;
        });
        turns[index] = {
          ...turn,
          status: event.status,
          messages,
          ...(activities ? { activities } : {}),
          ...(event.error ? { error: runtimeError(event.error) } : {}),
        };
        if (this.activeTurnsByThread.get(event.threadId)?.turnId === event.turnId) {
          this.activeTurnsByThread.delete(event.threadId);
        }
        if (event.threadId === this.threadId) {
          this.unreadThreadStatuses.delete(event.threadId);
        } else {
          this.unreadThreadStatuses.set(event.threadId, event.status);
        }
        this.refreshNavigator();
        break;
      }
      default:
        return;
    }
    this.turnsByThread.set(event.threadId, turns);
    this.publishThreadDelta(event.threadId, event.turnId);
    if (event.type === 'turn.completed') {
      this.publish();
    }
  };

  private applyThreadList = (
    workspaceId: string,
    threads: readonly RuntimeThreadRecord[],
  ): void => {
    for (const [threadId, thread] of this.threadRecords) {
      if (
        thread.workspaceId === workspaceId &&
        !this.activeTurnsByThread.has(threadId)
      ) {
        this.threadRecords.delete(threadId);
        this.turnsByThread.delete(threadId);
        this.threadRevisions.delete(threadId);
      }
    }
    for (const thread of threads) {
      this.threadRecords.set(thread.id, thread);
    }
    this.refreshNavigator();
  };

  private refreshNavigator = (
    status: ConversationThreadNavigatorSnapshot['status'] =
      this.available ? 'ready' : this.navigator.status,
  ): void => {
    const threads = [...this.threadRecords.values()]
      .filter((thread) => thread.workspaceId === this.workspaceId)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
      );
    this.navigator = {
      ...withoutNavigatorFields(this.navigator, ['unreadThreadStatuses']),
      status,
      activeThreadIds: threads.map((thread) => thread.id),
      activeThreadTitles: Object.fromEntries(
        threads.flatMap((thread) => thread.title ? [[thread.id, thread.title]] : []),
      ),
      activeTruncated: threads.length === 200,
      runningThreadIds: [...this.activeTurnsByThread.keys()],
      ...(this.unreadThreadStatuses.size > 0
        ? {
            unreadThreadStatuses: Object.fromEntries(
              this.unreadThreadStatuses,
            ),
          }
        : {}),
    };
  };

  private buildThreadProjection = (
    threadId: string,
  ): ConversationThreadProjectionSnapshot | null => {
    const thread = this.threadRecords.get(threadId);
    const turns = this.turnsByThread.get(threadId);
    if (!thread || !turns) {
      return null;
    }
    const activeTurn = this.activeTurnsByThread.get(threadId);
    return {
      revision: this.threadRevisions.get(threadId) ?? 0,
      workspaceId: thread.workspaceId,
      threadId,
      phase: activeTurn?.phase ?? 'ready',
      ...(activeTurn ? { activeTurnId: activeTurn.turnId } : {}),
      turns,
    };
  };

  private publishThreadProjection = (
    threadId: string,
    changed = false,
  ): void => {
    if (changed) {
      this.threadRevisions.set(
        threadId,
        (this.threadRevisions.get(threadId) ?? 0) + 1,
      );
    }
    const snapshot = this.buildThreadProjection(threadId);
    if (!snapshot) {
      return;
    }
    const revision = snapshot.revision;
    if (!isConversationThreadProjectionSnapshot(snapshot)) {
      throw new Error(
        `Thread projection invariant failed for ${threadId} at revision ${revision}.`,
      );
    }
    for (const listener of this.threadProjectionListeners) {
      listener(snapshot);
    }
  };

  private publishThreadDelta = (threadId: string, turnId: string): void => {
    const projection = this.buildThreadProjection(threadId);
    const turn = projection?.turns.find((candidate) => candidate.id === turnId);
    if (!projection || !turn) {
      return;
    }
    const revision = (this.threadRevisions.get(threadId) ?? 0) + 1;
    this.threadRevisions.set(threadId, revision);
    const delta: ConversationThreadProjectionDelta = {
      revision,
      workspaceId: projection.workspaceId,
      threadId,
      phase: projection.phase,
      ...(projection.activeTurnId
        ? { activeTurnId: projection.activeTurnId }
        : {}),
      turn,
    };
    if (!isConversationThreadProjectionDelta(delta)) {
      throw new Error(
        `Thread delta invariant failed for ${threadId} at revision ${revision}.`,
      );
    }
    for (const listener of this.threadDeltaListeners) {
      listener(delta);
    }
  };

  private publish = (): void => {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    const revision = snapshot.revision;
    if (!isConversationStateSnapshot(snapshot)) {
      throw new Error(
        `Conversation projection invariant failed at revision ${revision}.`,
      );
    }
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}
