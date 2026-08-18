import { randomUUID } from 'node:crypto';
import { parseComposerSubmission } from '../../shared/composer.ts';

import {
  isConversationThreadProjectionDelta,
  isConversationThreadProjectionSnapshot,
  isConversationStateSnapshot,
  isConversationSendRequest,
  isConversationReviseTurnRequest,
  isConversationQueuedMessageMutationRequest,
  isConversationQueuedMessageUpdateRequest,
  isConversationSteerQueuedMessageRequest,
  isConversationUserInputResponse,
  isValidConversationTitle,
  isValidThreadSearchInput,
  type ConversationActionResult,
  type ConversationAttachment,
  type ConversationStateListener,
  type ConversationStateSnapshot,
  type ConversationThreadDeltaListener,
  type ConversationThreadProjectionDelta,
  type ConversationThreadProjectionListener,
  type ConversationThreadProjectionSnapshot,
  type ConversationTokenUsage,
  type ConversationThreadNavigatorSnapshot,
  type ConversationThreadQueue,
  type ConversationTurn,
  type ConversationUserInputResponse,
} from '../../shared/conversation.ts';
import {
  type RuntimeContentPart,
  type RuntimeEvent,
  type RuntimeThreadRecord,
  type RuntimeThreadQueue as NativeThreadQueue,
} from '../../runtime/protocol.ts';
import {
  appendUserInputActivity,
  appendToolCallActivity,
  applyToolResultActivity,
  resolveUserInputActivity,
} from './conversation-tool-activities.ts';
import {
  attachmentFromPart,
  commandOutcome,
  orchestrationActivity,
  projectThread,
  projectThreadQueue,
  visibleRuntimeError,
} from './conversation-projection.ts';
import {
  initialTurnContent,
  revisedTurnContent,
} from './conversation-turn-content.ts';
import { createUuidV7 } from './id.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

const accepted = (
  result: Pick<ConversationActionResult, 'disposition' | 'queueItemId'> = {},
): ConversationActionResult => ({ accepted: true, reason: 'accepted', ...result });
const rejected = (
  reason: Exclude<ConversationActionResult['reason'], 'accepted'>,
): ConversationActionResult => ({ accepted: false, reason });

const knowledgeReferencesFromParts = (content: readonly RuntimeContentPart[]) =>
  content.flatMap((part) =>
    part.type === 'knowledgeReferences' ? part.references : [],
  );

const withoutUserInputRequest = (turn: ConversationTurn): ConversationTurn => {
  const copy: {
    -readonly [Key in keyof ConversationTurn]: ConversationTurn[Key];
  } = { ...turn };
  delete copy.userInputRequest;
  return copy;
};

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

const emptyNavigator = (): ConversationThreadNavigatorSnapshot => ({
  status: 'unavailable',
  activeThreadIds: [],
  activeThreadTitles: {},
  activeTruncated: false,
  runningThreadIds: [],
  inputRequiredThreadIds: [],
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
  private readonly queuesByThread = new Map<string, ConversationThreadQueue>();
  private readonly runtimeQueuesByThread = new Map<string, NativeThreadQueue>();
  private readonly queueOperationTails = new Map<string, Promise<void>>();
  private readonly promotingQueueItemsByThread = new Map<string, string>();
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
  private readonly outputDeltaTimers = new Map<
    string,
    Readonly<{ timer: NodeJS.Timeout; turnId: string }>
  >();
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
      ...(this.threadId
        ? {
            queue: this.queuesByThread.get(this.threadId) ?? {
              paused: false,
              messages: [],
            },
          }
        : {}),
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
    const submission = parseComposerSubmission(input.input);
    const compactCommand = submission.references.some(
      (reference) => reference.kind === 'command' && reference.target === 'compact',
    );
    let generateTitle = threadId
      ? this.threadRecords.get(threadId)?.title === null
      : true;
    const pendingStart = this.pendingTurnStartWorkspaces.has(workspaceId);
    if ((pendingStart && !threadId) || this.navigator.pendingMutation) {
      return rejected('turnActive');
    }
    const currentQueue = threadId
      ? this.queuesByThread.get(threadId)
      : undefined;
    const shouldQueue = Boolean(
      threadId &&
        (pendingStart ||
          this.activeTurnsByThread.has(threadId) ||
          currentQueue?.paused ||
          (currentQueue?.messages.length ?? 0) > 0),
    );
    const releaseQueueOperation = shouldQueue && threadId
      ? await this.acquireQueueOperation(threadId)
      : undefined;
    if (compactCommand && !shouldQueue) {
      if (!threadId || (input.attachments?.length ?? 0) > 0) {
        return rejected('invalidInput');
      }
      const turnId = createUuidV7();
      this.turnsByThread.set(threadId, [
        ...(this.turnsByThread.get(threadId) ?? []),
        { id: turnId, status: 'inProgress', messages: [] },
      ]);
      this.activeTurnsByThread.set(threadId, {
        workspaceId,
        turnId,
        phase: 'starting',
      });
      this.unreadThreadStatuses.delete(threadId);
      this.runtime.send({
        type: 'context.compact',
        requestId: randomUUID(),
        workspaceId,
        threadId,
        turnId,
        ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
        ...(submission.text.trim() ? { focus: submission.text.trim() } : {}),
      });
      this.refreshNavigator();
      this.publishThreadProjection(threadId, true);
      this.publish();
      return accepted({ disposition: 'started' });
    }
    if (!shouldQueue) {
      this.pendingTurnStartWorkspaces.add(workspaceId);
    }
    this.notice = undefined;
    this.publish();
    let optimisticTurn: Readonly<{ threadId: string; turnId: string }> | undefined;
    try {
      const content = initialTurnContent(input.input);
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
          },
          'thread.mutated',
        );
        if (!created.snapshot) {
          throw new Error('The local runtime did not return the new Thread.');
        }
        threadId = created.threadId;
        generateTitle = true;
        this.threadRecords.set(created.threadId, created.snapshot.thread);
        this.turnsByThread.set(created.threadId, []);
        this.queuesByThread.set(
          created.threadId,
          projectThreadQueue(created.snapshot.queue),
        );
        this.runtimeQueuesByThread.set(created.threadId, created.snapshot.queue);
        if (this.workspaceId === workspaceId && !this.threadId) {
          this.threadSelectionGeneration += 1;
          this.threadId = created.threadId;
        }
        this.refreshNavigator();
      }
      if (shouldQueue) {
        const queueItemId = createUuidV7();
        const event = await this.runtime.request(
          {
            type: 'queue.messageCreate',
            requestId: randomUUID(),
            workspaceId,
            threadId,
            queueItemId,
            content,
            ...(input.modelProfileId
              ? { modelProfileId: input.modelProfileId }
              : {}),
          },
          'queue.changed',
        );
        if (this.applyRuntimeQueue(threadId, event.queue)) {
          this.publishThreadProjection(threadId, true);
          this.publish();
        }
        releaseQueueOperation?.();
        if (!this.activeTurnsByThread.has(threadId)) {
          const terminalStatus = this.turnsByThread.get(threadId)?.at(-1)?.status;
          if (
            terminalStatus === 'completed' ||
            terminalStatus === 'failed' ||
            terminalStatus === 'interrupted'
          ) {
            await this.finishQueueAfterTurn(threadId, terminalStatus);
          }
        }
        return accepted({ disposition: 'queued', queueItemId });
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
        ...(generateTitle ? { generateTitle: true } : {}),
        content,
      });
      this.publishThreadProjection(threadId, true);
      this.publish();
      return accepted({ disposition: 'started' });
    } catch {
      releaseQueueOperation?.();
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

  updateQueuedMessage = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationQueuedMessageUpdateRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.workspaceId;
    const thread = this.threadRecords.get(input.threadId);
    if (!workspaceId || !this.available || thread?.workspaceId !== workspaceId) {
      return rejected('unknownThread');
    }
    const existing = this.runtimeQueuesByThread
      .get(input.threadId)
      ?.messages.find((message) => message.id === input.queueItemId);
    if (!existing) {
      return rejected('queueItemNotFound');
    }
    if (this.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId) {
      return rejected('turnActive');
    }
    const content: RuntimeContentPart[] = [
      ...initialTurnContent(input.input),
      ...existing.content.filter(
        (part) => part.type === 'asset' || part.type === 'knowledgeReferences',
      ),
    ];
    const releaseQueueOperation = await this.acquireQueueOperation(input.threadId);
    try {
      const event = await this.runtime.request(
        {
          type: 'queue.messageUpdate',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
          content,
          ...(input.modelProfileId ? { modelProfileId: input.modelProfileId } : {}),
        },
        'queue.changed',
      );
      if (this.applyRuntimeQueue(input.threadId, event.queue)) {
        this.publishThreadProjection(input.threadId, true);
        this.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.queueErrorReason(error);
      if (reason === 'queueRevisionMismatch' || reason === 'queueItemNotFound') {
        await this.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  deleteQueuedMessage = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationQueuedMessageMutationRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.workspaceId;
    const thread = this.threadRecords.get(input.threadId);
    if (!workspaceId || !this.available || thread?.workspaceId !== workspaceId) {
      return rejected('unknownThread');
    }
    if (this.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId) {
      return rejected('turnActive');
    }
    const releaseQueueOperation = await this.acquireQueueOperation(input.threadId);
    try {
      const event = await this.runtime.request(
        {
          type: 'queue.messageDelete',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
        },
        'queue.changed',
      );
      if (this.applyRuntimeQueue(input.threadId, event.queue)) {
        this.publishThreadProjection(input.threadId, true);
        this.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.queueErrorReason(error);
      if (reason === 'queueRevisionMismatch' || reason === 'queueItemNotFound') {
        await this.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  steerQueuedMessage = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationSteerQueuedMessageRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.workspaceId;
    const active = this.activeTurnsByThread.get(input.threadId);
    if (!workspaceId || !active || active.turnId !== input.expectedTurnId) {
      return rejected('turnMismatch');
    }
    if (active.phase !== 'inProgress') {
      return rejected('notSteerable');
    }
    if (this.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId) {
      return rejected('turnActive');
    }
    const releaseQueueOperation = await this.acquireQueueOperation(input.threadId);
    try {
      const event = await this.runtime.request(
        {
          type: 'turn.steerQueued',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          expectedTurnId: input.expectedTurnId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
        },
        'turn.steered',
      );
      const changed = this.applyRuntimeQueue(input.threadId, event.queue);
      const appended = this.appendSteeredUserMessage(event);
      if (changed || appended) {
        this.publishThreadProjection(input.threadId, true);
        this.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.queueErrorReason(error);
      if (reason === 'queueRevisionMismatch' || reason === 'queueItemNotFound') {
        await this.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  resumeQueue = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string') {
      return rejected('unknownThread');
    }
    const workspaceId = this.workspaceId;
    if (!workspaceId || this.threadRecords.get(threadId)?.workspaceId !== workspaceId) {
      return rejected('unknownThread');
    }
    const releaseQueueOperation = await this.acquireQueueOperation(threadId);
    try {
      const event = await this.runtime.request(
        {
          type: 'queue.resume',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'queue.changed',
      );
      if (this.applyRuntimeQueue(threadId, event.queue)) {
        this.publishThreadProjection(threadId, true);
        this.publish();
      }
    } catch (error) {
      return rejected(this.queueErrorReason(error));
    } finally {
      releaseQueueOperation();
    }
    await this.dispatchQueuedMessage(threadId);
    return accepted();
  };

  reviseTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationReviseTurnRequest(input)) {
      return rejected('invalidInput');
    }
    if (!this.workspaceId || !this.available) {
      return rejected('unavailable');
    }
    if (!this.threadId || input.threadId !== this.threadId) {
      return rejected('unknownThread');
    }
    const workspaceId = this.workspaceId;
    const turns = this.turnsByThread.get(input.threadId) ?? [];
    const latestTurn = turns.at(-1);
    if (!latestTurn || latestTurn.id !== input.turnId) {
      return rejected('notLatestTurn');
    }
    if (
      latestTurn.status === 'inProgress' ||
      this.pendingTurnStartWorkspaces.has(workspaceId) ||
      this.activeTurnsByThread.has(input.threadId) ||
      this.navigator.pendingMutation
    ) {
      return rejected('turnActive');
    }
    const userMessage = latestTurn.messages.find(
      (message) => message.role === 'user',
    );
    if (!userMessage) {
      return rejected('notLatestTurn');
    }
    const content = revisedTurnContent(userMessage, input.text);
    if (!content) {
      return rejected('invalidInput');
    }
    const turnId = createUuidV7();
    this.pendingTurnStartWorkspaces.add(workspaceId);
    this.notice = undefined;
    this.publish();
    try {
      await this.runtime.request(
        {
          type: 'turn.revise',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          turnId,
          replacedTurnId: input.turnId,
          ...(input.modelProfileId
            ? { modelProfileId: input.modelProfileId }
            : {}),
          content,
        },
        'turn.revised',
      );
      return accepted();
    } catch {
      const reconciliation = await this.reconcileTurnRevision({
        workspaceId,
        threadId: input.threadId,
        replacedTurnId: input.turnId,
        turnId,
      });
      if (reconciliation === 'committed') {
        return accepted();
      }
      this.notice = {
        kind: 'requestFailed',
        summary: 'The last Turn could not be revised safely.',
      };
      return rejected('unavailable');
    } finally {
      this.pendingTurnStartWorkspaces.delete(workspaceId);
      this.publish();
    }
  };

  private reconcileTurnRevision = async ({
    workspaceId,
    threadId,
    replacedTurnId,
    turnId,
  }: Readonly<{
    workspaceId: string;
    threadId: string;
    replacedTurnId: string;
    turnId: string;
  }>): Promise<'committed' | 'notCommitted' | 'unavailable'> => {
    try {
      const event = await this.runtime.request(
        {
          type: 'thread.load',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'thread.loaded',
      );
      if (
        event.workspaceId !== workspaceId ||
        event.snapshot.thread.id !== threadId ||
        event.snapshot.thread.workspaceId !== workspaceId
      ) {
        return 'unavailable';
      }
      const turns = [...projectThread(event.snapshot)];
      this.threadRecords.set(threadId, event.snapshot.thread);
      this.turnsByThread.set(threadId, turns);
      this.applyRuntimeQueue(threadId, event.snapshot.queue);
      this.activeTurnsByThread.delete(threadId);
      this.refreshNavigator();
      if (this.threadId === threadId) {
        this.publishThreadProjection(threadId, true);
      }
      this.publish();
      if (turns.some((turn) => turn.id === turnId)) {
        this.notice = undefined;
        return 'committed';
      }
      return turns.at(-1)?.id === replacedTurnId
        ? 'notCommitted'
        : 'unavailable';
    } catch {
      return 'unavailable';
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
      source: 'stopButton',
    });
    this.publishThreadDelta(threadId, activeTurn.turnId);
    this.publish();
    return accepted();
  };

  respondToUserInput = async (
    input: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isConversationUserInputResponse(input)) {
      return rejected('invalidInput');
    }
    const activeTurn = this.activeTurnsByThread.get(input.threadId);
    const turn = this.turnsByThread
      .get(input.threadId)
      ?.find((candidate) => candidate.id === input.turnId);
    if (
      !activeTurn ||
      activeTurn.turnId !== input.turnId ||
      turn?.userInputRequest?.id !== input.inputRequestId
    ) {
      return rejected('noActiveTurn');
    }
    const questions = turn.userInputRequest.questions;
    const questionIds = questions.map(
      (question) => question.id,
    );
    const decisionIds = new Set(
      input.submission.decisions.map((decision) => decision.questionId),
    );
    const questionById = new Map(
      questions.map((question) => [question.id, question]),
    );
    const decisionsValid = input.submission.decisions.every((decision) => {
      const question = questionById.get(decision.questionId);
      return Boolean(
        question &&
          (decision.kind !== 'answered' ||
            decision.source !== 'option' ||
            question.options.some((option) => option.label === decision.answer)),
      );
    });
    if (
      !decisionsValid ||
      (input.submission.kind === 'submitted' &&
        (questionIds.length !== input.submission.decisions.length ||
          !questionIds.every((id) => decisionIds.has(id))))
    ) {
      return rejected('invalidInput');
    }
    const response: ConversationUserInputResponse = input;
    this.runtime.send({
      type: 'turn.userInputResponse',
      requestId: randomUUID(),
      workspaceId: activeTurn.workspaceId,
      threadId: response.threadId,
      turnId: response.turnId,
      inputRequestId: response.inputRequestId,
      submission: response.submission,
    });
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
      this.applyRuntimeQueue(threadId, event.snapshot.queue);
      this.unreadThreadStatuses.delete(threadId);
      this.refreshNavigator();
      this.navigator = withoutNavigatorFields(this.navigator, [
        'pendingThreadId',
        'selectionNotice',
      ]);
      this.publish();
      this.publishThreadProjection(threadId, true);
      void this.dispatchQueuedMessage(threadId);
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
      'pendingThreadId',
      'selectionNotice',
    ]);
    this.publish();
    return accepted();
  };

  deleteThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.deleteThreadRecord(threadId);

  renameThread = async (
    threadId: unknown,
    title: unknown,
  ): Promise<ConversationActionResult> => {
    if (
      typeof threadId !== 'string' ||
      !isValidConversationTitle(title) ||
      !this.threadRecords.has(threadId)
    ) {
      return rejected('invalidInput');
    }
    const thread = this.threadRecords.get(threadId);
    if (
      !thread ||
      thread.workspaceId !== this.workspaceId ||
      !this.workspaceId ||
      this.navigator.pendingMutation
    ) {
      return rejected('unavailable');
    }
    const workspaceId = this.workspaceId;
    const normalizedTitle = title.trim();
    this.navigator = {
      ...this.navigator,
      pendingMutation: { kind: 'rename', threadId },
    };
    this.publish();
    try {
      const event = await this.runtime.request(
        {
          type: 'thread.rename',
          requestId: randomUUID(),
          workspaceId,
          threadId,
          title: normalizedTitle,
        },
        'thread.mutated',
      );
      if (
        event.operation !== 'rename' ||
        event.workspaceId !== workspaceId ||
        !event.snapshot
      ) {
        throw new Error('Thread rename returned a mismatched snapshot.');
      }
      this.threadRecords.set(threadId, event.snapshot.thread);
      if (this.workspaceId === workspaceId) {
        this.navigator = withoutNavigatorFields(this.navigator, [
          'pendingMutation',
          'mutationNotice',
        ]);
        this.refreshNavigator();
        this.publish();
      }
      return accepted();
    } catch {
      if (this.workspaceId === workspaceId) {
        this.navigator = {
          ...withoutNavigatorFields(this.navigator, ['pendingMutation']),
          mutationNotice: '会话名称修改失败，请重试。',
        };
        this.publish();
      }
      return rejected('unavailable');
    }
  };

  private deleteThreadRecord = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || !this.threadRecords.has(threadId)) {
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
    this.navigator = {
      ...this.navigator,
      pendingMutation: { kind: 'delete', threadId },
    };
    this.publish();
    try {
      const event = await this.runtime.request(
        {
          type: 'thread.delete',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'thread.mutated',
      );
      if (event.workspaceId !== workspaceId) {
        throw new Error('Thread mutation crossed workspace ownership.');
      }
      if (this.workspaceId !== workspaceId) {
        return accepted();
      }
      if (event.operation !== 'delete' || event.deleted !== true) {
        throw new Error('The runtime did not confirm Thread deletion.');
      }
      this.threadRecords.delete(threadId);
      this.turnsByThread.delete(threadId);
      this.queuesByThread.delete(threadId);
      this.runtimeQueuesByThread.delete(threadId);
      this.threadRevisions.delete(threadId);
      this.unreadThreadStatuses.delete(threadId);
      if (this.threadId === threadId) {
        this.threadSelectionGeneration += 1;
        this.threadId = null;
      }
      this.navigator = withoutNavigatorFields(this.navigator, [
        'pendingMutation',
      ]);
      this.refreshNavigator();
      this.publish();
      return accepted();
    } catch {
      if (this.workspaceId !== workspaceId) {
        return accepted();
      }
      this.navigator = {
        ...withoutNavigatorFields(this.navigator, ['pendingMutation']),
        mutationNotice: 'The Thread deletion was rejected.',
      };
      this.publish();
      return rejected('unavailable');
    }
  };

  private handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'queue.changed') {
      const thread = this.threadRecords.get(event.threadId);
      if (thread?.workspaceId === event.workspaceId) {
        if (this.applyRuntimeQueue(event.threadId, event.queue)) {
          this.publishThreadProjection(event.threadId, true);
          if (this.workspaceId === event.workspaceId) {
            this.publish();
          }
        }
      }
      return;
    }
    if (event.type === 'turn.steered') {
      const thread = this.threadRecords.get(event.threadId);
      if (thread?.workspaceId === event.workspaceId) {
        const changed = this.applyRuntimeQueue(event.threadId, event.queue);
        const appended = this.appendSteeredUserMessage(event);
        if (changed || appended) {
          this.publishThreadProjection(event.threadId, true);
          if (this.workspaceId === event.workspaceId) {
            this.publish();
          }
        }
      }
      return;
    }
    if (
      event.type === 'thread.mutated' &&
      (event.operation === 'rename' || event.operation === 'generateTitle') &&
      event.snapshot
    ) {
      const current = this.threadRecords.get(event.threadId);
      if (current?.workspaceId === event.workspaceId) {
        this.threadRecords.set(event.threadId, event.snapshot.thread);
        if (this.workspaceId === event.workspaceId) {
          this.refreshNavigator();
          this.publish();
        }
      }
      return;
    }
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
    if (event.type === 'turn.revised') {
      const replacedIndex = turns.findIndex(
        (turn) => turn.id === event.replacedTurnId,
      );
      const replacedTurn = turns[replacedIndex];
      const previousUserMessage = replacedTurn?.messages.find(
        (message) => message.role === 'user',
      );
      if (
        replacedIndex < 0 ||
        replacedIndex !== turns.length - 1 ||
        !previousUserMessage
      ) {
        return;
      }
      const text = event.content
        .filter(
          (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
            part.type === 'text',
        )
        .map((part) => part.text)
        .join('\n');
      const knowledgeReferences = knowledgeReferencesFromParts(event.content);
      turns[replacedIndex] = {
        id: event.turnId,
        status: 'inProgress',
        model: event.model,
        messages: [
          {
            id: `${event.turnId}:user`,
            role: 'user',
            text,
            ...(previousUserMessage.attachments?.length
              ? { attachments: previousUserMessage.attachments }
              : {}),
            ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
            status: 'inProgress',
          },
        ],
      };
      this.turnsByThread.set(event.threadId, turns);
      this.activeTurnsByThread.set(event.threadId, {
        workspaceId: event.workspaceId,
        turnId: event.turnId,
        phase: 'starting',
      });
      this.unreadThreadStatuses.delete(event.threadId);
      this.refreshNavigator();
      this.publishThreadProjection(event.threadId, true);
      this.publish();
      return;
    }
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
        {
          const text = event.content
            .filter((part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
              part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const attachments = event.content.flatMap((part) =>
            part.type === 'asset' ? [attachmentFromPart(part)] : []);
          const knowledgeReferences = knowledgeReferencesFromParts(event.content);
          const existingUser = turn.messages.find((message) => message.role === 'user');
          const userMessage = {
            id: existingUser?.id ?? event.itemId,
            role: 'user' as const,
            text: text || existingUser?.text || '',
            ...(attachments.length > 0
              ? { attachments }
              : existingUser?.attachments?.length
                ? { attachments: existingUser.attachments }
                : {}),
            ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
            status: 'completed' as const,
          };
        turns[index] = {
          ...turn,
          messages: [
            userMessage,
            ...turn.messages.filter((message) => message.role !== 'user'),
          ],
        };
        }
        break;
      case 'turn.textStarted':
        break;
      case 'turn.textDelta': {
        if (event.phase !== 'final') {
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
      case 'turn.planProposed': {
        turns[index] = {
          ...turn,
          planProposal: {
            id: event.planId,
            content: event.content,
          },
        };
        break;
      }
      case 'turn.toolCall': {
        const activities = [...(turn.activities ?? [])];
        appendToolCallActivity(
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
        applyToolResultActivity(
          activities,
          event.itemId,
          event.callId,
          event.result,
        );
        turns[index] = { ...turn, activities };
        break;
      }
      case 'turn.userInputRequested': {
        const activities = [...(turn.activities ?? [])];
        appendUserInputActivity(
          activities,
          event.inputRequestId,
          event.questions,
        );
        turns[index] = {
          ...turn,
          activities,
          userInputRequest: {
            id: event.inputRequestId,
            questions: event.questions,
          },
        };
        break;
      }
      case 'turn.userInputResolved': {
        const activities = [...(turn.activities ?? [])];
        resolveUserInputActivity(
          activities,
          event.inputRequestId,
          event.submission,
        );
        if (turn.userInputRequest?.id === event.inputRequestId) {
          turns[index] = {
            ...withoutUserInputRequest(turn),
            activities,
          };
        } else {
          turns[index] = { ...turn, activities };
        }
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
      case 'turn.contextCompactionStarted': {
        const activities = [...(turn.activities ?? [])];
        activities.push({
          type: 'contextCompaction',
          activity: {
            id: event.compactionId,
            status: 'inProgress',
            trigger: event.trigger,
            strategy: event.strategy,
            ...(event.beforeContextTokens === undefined
              ? {}
              : { beforeContextTokens: event.beforeContextTokens }),
          },
        });
        turns[index] = { ...turn, activities };
        break;
      }
      case 'turn.contextCompactionFinished': {
        const activities = [...(turn.activities ?? [])];
        const activityIndex = activities.findIndex(
          (activity) => activity.type === 'contextCompaction' &&
            activity.activity.id === event.compactionId,
        );
        const next = {
          type: 'contextCompaction' as const,
          activity: {
            id: event.compactionId,
            status: event.outcome,
            trigger: event.trigger,
            strategy: event.strategy,
            ...(event.beforeContextTokens === undefined
              ? {}
              : { beforeContextTokens: event.beforeContextTokens }),
            ...(event.afterContextTokens === undefined
              ? {}
              : { afterContextTokens: event.afterContextTokens }),
            durationMs: event.durationMs,
            ...(event.readableSummary === undefined
              ? {}
              : { readableSummary: event.readableSummary }),
            ...(event.opaqueCheckpoint === undefined
              ? {}
              : { opaqueCheckpoint: event.opaqueCheckpoint }),
            ...(event.message === undefined ? {} : { message: event.message }),
          },
        };
        if (activityIndex >= 0) {
          activities[activityIndex] = next;
        } else {
          activities.push(next);
        }
        turns[index] = { ...turn, activities };
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
            operationKind:
              event.projectEnvironmentTrust
                ? 'projectEnvironment'
                : event.toolName === 'workspace_apply_patch'
                ? 'workspacePatch'
                : 'shell',
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
                    ...(event.source ? { source: event.source } : {}),
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
        const promotingItemId = this.promotingQueueItemsByThread.get(
          event.threadId,
        );
        const promotionFailedBeforeCommit =
          event.status === 'failed' &&
          promotingItemId !== undefined &&
          this.runtimeQueuesByThread
            .get(event.threadId)
            ?.messages.some((message) => message.id === promotingItemId);
        if (promotionFailedBeforeCommit) {
          turns.splice(index, 1);
          this.promotingQueueItemsByThread.delete(event.threadId);
          if (
            this.activeTurnsByThread.get(event.threadId)?.turnId ===
            event.turnId
          ) {
            this.activeTurnsByThread.delete(event.threadId);
          }
          this.refreshNavigator();
          this.notice = {
            kind: 'warning',
            summary: event.error?.message.includes('modelUnavailable')
              ? 'The queued message is paused because its saved model is unavailable.'
              : 'The queued message could not start and remains safely paused.',
          };
          void this.finishQueueAfterTurn(event.threadId, 'failed');
          break;
        }
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
        const completedTurn = withoutUserInputRequest(turn);
        turns[index] = {
          ...completedTurn,
          status: event.status,
          messages,
          ...(activities ? { activities } : {}),
          ...(event.error
            ? (() => {
                const error = visibleRuntimeError(event.error, event.status);
                return error ? { error } : {};
              })()
            : {}),
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
        void this.finishQueueAfterTurn(event.threadId, event.status);
        break;
      }
      default:
        return;
    }
    this.turnsByThread.set(event.threadId, turns);
    if (
      event.type === 'turn.userInputRequested' ||
      event.type === 'turn.userInputResolved'
    ) {
      this.refreshNavigator();
    }
    if (event.type === 'operation.output') {
      this.scheduleOutputDelta(event.threadId, event.turnId);
    } else {
      this.cancelOutputDelta(event.threadId);
      this.publishThreadDelta(event.threadId, event.turnId);
    }
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.userInputRequested' ||
      event.type === 'turn.userInputResolved'
    ) {
      this.publish();
    }
  };

  private scheduleOutputDelta = (threadId: string, turnId: string): void => {
    if (this.outputDeltaTimers.has(threadId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.outputDeltaTimers.delete(threadId);
      this.publishThreadDelta(threadId, turnId);
    }, 50);
    timer.unref();
    this.outputDeltaTimers.set(threadId, { timer, turnId });
  };

  private cancelOutputDelta = (threadId: string): void => {
    const pending = this.outputDeltaTimers.get(threadId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.outputDeltaTimers.delete(threadId);
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
        this.queuesByThread.delete(threadId);
        this.runtimeQueuesByThread.delete(threadId);
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
      inputRequiredThreadIds: [...this.activeTurnsByThread.entries()].flatMap(
        ([threadId, activeTurn]) =>
          this.turnsByThread
            .get(threadId)
            ?.find((turn) => turn.id === activeTurn.turnId)
            ?.userInputRequest
            ? [threadId]
            : [],
      ),
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
      queue: this.queuesByThread.get(threadId) ?? {
        paused: false,
        messages: [],
      },
    };
  };

  private applyRuntimeQueue = (
    threadId: string,
    queue: NativeThreadQueue,
  ): boolean => {
    if (this.runtimeQueuesByThread.get(threadId) === queue) {
      return false;
    }
    this.runtimeQueuesByThread.set(threadId, queue);
    this.queuesByThread.set(threadId, projectThreadQueue(queue));
    const promoting = this.promotingQueueItemsByThread.get(threadId);
    if (promoting && !queue.messages.some((message) => message.id === promoting)) {
      this.promotingQueueItemsByThread.delete(threadId);
    }
    return true;
  };

  private acquireQueueOperation = async (
    threadId: string,
  ): Promise<() => void> => {
    const previous = this.queueOperationTails.get(threadId) ?? Promise.resolve();
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch((): void => undefined).then(() => current);
    this.queueOperationTails.set(threadId, tail);
    await previous.catch((): void => undefined);
    return () => {
      releaseCurrent();
      if (this.queueOperationTails.get(threadId) === tail) {
        this.queueOperationTails.delete(threadId);
      }
    };
  };

  private queueErrorReason = (
    error: unknown,
  ): Exclude<ConversationActionResult['reason'], 'accepted'> => {
    const message = error instanceof Error ? error.message : String(error);
    for (const reason of [
      'queueFull',
      'queueItemNotFound',
      'queueRevisionMismatch',
      'turnMismatch',
      'notSteerable',
      'modelUnavailable',
    ] as const) {
      if (message.includes(reason)) {
        return reason;
      }
    }
    return 'unavailable';
  };

  private refreshRuntimeQueue = async (
    threadId: string,
    workspaceId: string,
  ): Promise<void> => {
    try {
      const event = await this.runtime.request(
        {
          type: 'thread.load',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'thread.loaded',
      );
      if (
        event.snapshot.thread.id === threadId &&
        event.snapshot.thread.workspaceId === workspaceId &&
        this.applyRuntimeQueue(threadId, event.snapshot.queue)
      ) {
        this.publishThreadProjection(threadId, true);
        if (this.workspaceId === workspaceId) {
          this.publish();
        }
      }
    } catch {
      // Keep the local draft; the next durable projection can still reconcile it.
    }
  };

  private appendSteeredUserMessage = (
    event: Extract<RuntimeEvent, { type: 'turn.steered' }>,
  ): boolean => {
    const turns = [...(this.turnsByThread.get(event.threadId) ?? [])];
    const index = turns.findIndex((turn) => turn.id === event.turnId);
    const turn = turns[index];
    if (turn?.messages.some((message) => message.id === event.itemId)) {
      return false;
    }
    if (!turn) {
      return false;
    }
    const text = event.content
      .filter((part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
        part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const attachments = event.content.flatMap((part) =>
      part.type === 'asset' ? [attachmentFromPart(part)] : []);
    const knowledgeReferences = knowledgeReferencesFromParts(event.content);
    turns[index] = {
      ...turn,
      messages: [
        ...turn.messages,
        {
          id: event.itemId,
          role: 'user',
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
          status: 'completed',
        },
      ],
    };
    this.turnsByThread.set(event.threadId, turns);
    return true;
  };

  private dispatchQueuedMessage = async (threadId: string): Promise<void> => {
    const releaseQueueOperation = await this.acquireQueueOperation(threadId);
    try {
      const active = this.activeTurnsByThread.get(threadId);
      const queue = this.runtimeQueuesByThread.get(threadId);
      const head = queue?.messages[0];
      const thread = this.threadRecords.get(threadId);
      if (active || !queue || queue.paused || !head || !thread) {
        return;
      }
      const turnId = createUuidV7();
    const text = head.content
      .filter((part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
        part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const attachments = head.content.flatMap((part) =>
      part.type === 'asset' ? [attachmentFromPart(part)] : []);
    const knowledgeReferences = knowledgeReferencesFromParts(head.content);
    this.turnsByThread.set(threadId, [
      ...(this.turnsByThread.get(threadId) ?? []),
      {
        id: turnId,
        status: 'inProgress',
        messages: [
          {
            id: `${turnId}:user`,
            role: 'user',
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
            status: 'inProgress',
          },
        ],
      },
    ]);
    this.activeTurnsByThread.set(threadId, {
      workspaceId: thread.workspaceId,
      turnId,
      phase: 'starting',
    });
    this.unreadThreadStatuses.delete(threadId);
    this.promotingQueueItemsByThread.set(threadId, head.id);
    this.refreshNavigator();
    this.runtime.send({
      type: 'turn.startQueued',
      requestId: randomUUID(),
      workspaceId: thread.workspaceId,
      threadId,
      turnId,
      queueItemId: head.id,
      expectedRevision: head.revision,
      ...(head.modelProfileId ? { modelProfileId: head.modelProfileId } : {}),
      content: head.content,
    });
      this.publishThreadProjection(threadId, true);
      this.publish();
    } finally {
      releaseQueueOperation();
    }
  };

  private finishQueueAfterTurn = async (
    threadId: string,
    status: 'completed' | 'failed' | 'interrupted',
  ): Promise<void> => {
    await Promise.resolve();
    this.promotingQueueItemsByThread.delete(threadId);
    const queue = this.runtimeQueuesByThread.get(threadId);
    if (!queue || queue.messages.length === 0) {
      return;
    }
    if (status === 'completed' && !queue.paused) {
      await this.dispatchQueuedMessage(threadId);
      return;
    }
    const thread = this.threadRecords.get(threadId);
    if (!thread || queue.paused) {
      return;
    }
    const releaseQueueOperation = await this.acquireQueueOperation(threadId);
    try {
      const event = await this.runtime.request(
        {
          type: 'queue.pause',
          requestId: randomUUID(),
          workspaceId: thread.workspaceId,
          threadId,
        },
        'queue.changed',
      );
      if (this.applyRuntimeQueue(threadId, event.queue)) {
        this.publishThreadProjection(threadId, true);
        if (this.workspaceId === thread.workspaceId) {
          this.publish();
        }
      }
    } catch {
      this.notice = {
        kind: 'warning',
        summary: 'The queued messages could not be paused safely.',
      };
      this.publish();
    } finally {
      releaseQueueOperation();
    }
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
