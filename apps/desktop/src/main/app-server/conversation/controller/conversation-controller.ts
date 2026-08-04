import type {
  ThreadListResponse,
  TurnInputPart,
} from '@sugarcode/app-server-protocol';

import type {
  ConversationActionResult,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationThreadNavigatorSnapshot,
} from '@/shared/conversation';
import {
  isConversationSendRequest,
  isValidThreadSearchInput,
} from '@/shared/conversation';

import {
  type ConversationLifecycle,
  type ConversationLifecycleRoute,
  type ResumeSnapshot,
  parseConversationLifecycle,
  parseConversationLifecycleRoute,
} from '../protocol';
import { ConversationLifecycleController } from './lifecycle-controller';
import type { MutableTurn } from './mutable-state';
import { recoverConversation, type RecoveredConversation } from '../recovery';
import {
  createConversationSnapshot,
  createMutableTurns,
} from './projection';
import type { ConversationRpc } from '../rpc-client';
import {
  createThreadNavigator,
  isKnownThread,
  type MutableThreadNavigator,
  resetThreadSearch,
} from '../thread-navigator';
import {
  ConnectionClosedError,
  RpcResponseError,
} from '../../transport/jsonl-client';
import type { ServerMessage } from '../../transport/server-message';
import {
  ThreadRuntime,
  type ThreadRuntimeState,
} from './thread-runtime';
import {
  ThreadRegistryProtocolError,
  type ThreadRegistry,
} from '../../thread-registry';

const MAX_BUFFERED_LIFECYCLE = 64;

type PendingThreadStart = {
  readonly workspaceId: string;
  candidateThreadId: string | null;
  lifecycleBuffer: ConversationLifecycle[];
};

type ConversationControllerOptions = Readonly<{
  threadRegistry: ThreadRegistry;
  getRpc: () => ConversationRpc | null;
  onProtocolFailure: () => void;
  onThreadProjectionFailure?: (threadId: string) => void;
  getActionBlocked?: () => boolean;
}>;

const accepted = (): ConversationActionResult => ({
  accepted: true,
  reason: 'accepted',
});

const rejected = (
  reason: Exclude<ConversationActionResult['reason'], 'accepted'>,
): ConversationActionResult => ({ accepted: false, reason });

export class ConversationController extends ConversationLifecycleController {
  private readonly getRpc: ConversationControllerOptions['getRpc'];
  private readonly threadRegistry: ThreadRegistry;
  private readonly onProtocolFailure: ConversationControllerOptions['onProtocolFailure'];
  private readonly onThreadProjectionFailure: (threadId: string) => void;
  private readonly getActionBlocked: () => boolean;
  private readonly listeners = new Set<ConversationStateListener>();
  private workspaceId: string | null = null;
  private revision = 0;
  private pendingThreadStart: PendingThreadStart | null = null;
  private searchAbortController: AbortController | null = null;
  private selectionAbortController: AbortController | null = null;
  private mutationAbortController: AbortController | null = null;
  private searchGeneration = 0;
  private selectionGeneration = 0;
  private readonly navigator: MutableThreadNavigator = createThreadNavigator();

  constructor(options: ConversationControllerOptions) {
    super();
    this.threadRegistry = options.threadRegistry;
    this.getRpc = options.getRpc;
    this.onProtocolFailure = options.onProtocolFailure;
    this.onThreadProjectionFailure =
      options.onThreadProjectionFailure ?? (() => undefined);
    this.getActionBlocked = options.getActionBlocked ?? (() => false);
  }

  getSnapshot = (): ConversationStateSnapshot => this.createSnapshot();

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  waitForTurnStartSettlement = async (): Promise<void> => {
    if (this.phase !== 'starting') {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe = (): void => undefined;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        resolve();
      };
      unsubscribe = this.subscribe((snapshot) => {
        if (snapshot.phase !== 'starting') {
          finish();
        }
      });
      if (this.phase !== 'starting') {
        finish();
      }
    });
  };

  setAgentApprovalTasks = (waitingTaskIds: ReadonlySet<string>): void => {
    let changed = false;
    const turnCollections = new Set<MutableTurn[]>([
      this.turns,
      ...this.threadRegistry.runtimes().map((runtime) => runtime.getTurns()),
    ]);
    for (const turn of [...turnCollections].flat()) {
      const orchestration = turn.orchestration;
      if (!orchestration) {
        continue;
      }
      for (const task of orchestration.tasks) {
        if (task.status !== 'running' && task.status !== 'waitingApproval') {
          continue;
        }
        const nextStatus = waitingTaskIds.has(task.taskId)
          ? 'waitingApproval'
          : 'running';
        if (task.status !== nextStatus) {
          task.status = nextStatus;
          changed = true;
        }
      }
    }
    if (changed) {
      this.publish();
    }
  };

  switchWorkspace = async (
    workspaceId: string,
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const rpc = this.getRpc();
    if (!rpc || this.phase === 'starting') {
      return false;
    }
    this.saveSelectedProjection();
    this.workspaceId = workspaceId;
    this.selectionAbortController?.abort();
    this.searchAbortController?.abort();
    const abortController = new AbortController();
    this.actionAbortController = abortController;
    this.clearSelectedConversation();
    this.phase = 'unavailable';
    this.navigator.status = 'loading';
    this.navigator.activeTruncated = false;
    this.navigator.pendingThreadId = undefined;
    this.navigator.pendingMutation = undefined;
    resetThreadSearch(this.navigator);
    this.publish();
    try {
      const listed = await this.listActiveThreads(rpc, abortController.signal);
      this.applyActiveThreadList(listed);
      if (preferredThreadId) {
        if (!listed.data.some((thread) => thread.id === preferredThreadId)) {
          throw new Error('Preferred Thread is not bound to this workspace.');
        }
        const cached = this.threadRegistry.isReloadRequired(preferredThreadId)
          ? undefined
          : this.threadRegistry.getRuntime(preferredThreadId) ?? undefined;
        if (cached?.workspaceId === workspaceId) {
          this.restoreProjection(preferredThreadId, cached);
        } else {
          const snapshot = await rpc.resumeThread(
            preferredThreadId,
            abortController.signal,
          );
          const recovered = recoverConversation(preferredThreadId, snapshot);
          this.replaceRecoveredConversation(recovered, snapshot);
          this.phase = 'ready';
        }
        this.threadRegistry.clearReloadRequired(preferredThreadId);
        this.threadRegistry.clearUnread(preferredThreadId);
      } else {
        this.phase = 'idle';
      }
      this.notice = undefined;
      this.publish();
      return true;
    } catch (error) {
      if (error instanceof ThreadRegistryProtocolError) {
        this.onProtocolFailure();
        return false;
      }
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        this.transportClosed();
      } else {
        this.navigator.status = 'error';
        this.navigator.selectionNotice =
          error instanceof RpcResponseError
            ? 'This workspace could not be restored safely.'
            : 'This workspace contains an unsupported Thread lifecycle.';
        if (preferredThreadId && !(error instanceof RpcResponseError)) {
          this.threadRegistry.markReloadRequired(preferredThreadId);
        }
        this.publish();
      }
      return false;
    } finally {
      if (this.actionAbortController === abortController) {
        this.actionAbortController = null;
      }
    }
  };

  restoreForConnection = async (
    workspaceId: string,
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const rpc = this.getRpc();
    if (!rpc || this.phase !== 'unavailable') {
      return false;
    }

    const abortController = new AbortController();
    this.workspaceId = workspaceId;
    this.actionAbortController = abortController;
    try {
      const listed = rpc.listActiveThreads
        ? await rpc.listActiveThreads(abortController.signal)
        : null;
      const fallbackThreadId = listed
        ? null
        : await rpc.findLatestActiveThread(abortController.signal);
      if (listed) {
        this.threadRegistry.replaceWorkspaceIndex(workspaceId, listed.data);
      } else {
        this.threadRegistry.replaceWorkspaceIndex(
          workspaceId,
          fallbackThreadId
            ? [{ id: fallbackThreadId, workspaceId }]
            : [],
        );
      }
      this.navigator.activeTruncated = listed
        ? listed.nextCursor !== null
        : false;
      this.navigator.status = 'ready';
      if (!preferredThreadId) {
        this.clearSelectedConversation();
        return true;
      }
      const snapshot = await rpc.resumeThread(
        preferredThreadId,
        abortController.signal,
      );
      const recovered = recoverConversation(preferredThreadId, snapshot);
      this.replaceRecoveredConversation(recovered, snapshot);
      this.threadRegistry.clearReloadRequired(preferredThreadId);
      return true;
    } catch (error) {
      if (error instanceof ThreadRegistryProtocolError) {
        this.onProtocolFailure();
        return false;
      }
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        throw error;
      }
      this.clearSelectedConversation();
      this.navigator.status = 'ready';
      this.navigator.selectionNotice =
        error instanceof RpcResponseError
          ? 'The selected Thread could not be loaded. Other Threads remain available.'
          : 'The selected Thread contains an unsupported lifecycle. Other Threads remain available.';
      if (preferredThreadId && !(error instanceof RpcResponseError)) {
        this.threadRegistry.markReloadRequired(preferredThreadId);
      }
      this.publish();
      return true;
    } finally {
      if (this.actionAbortController === abortController) {
        this.actionAbortController = null;
      }
    }
  };

  connectionReady = (): void => {
    if (this.phase !== 'unavailable') {
      return;
    }
    this.phase = this.threadId ? 'ready' : 'idle';
    if (this.navigator.status === 'loading') {
      this.navigator.status = 'ready';
    }
    this.notice = undefined;
    this.publish();
  };

  connectionRestarting = (): void => {
    this.setTransportUnavailable(false);
  };

  transportClosed = (): void => {
    this.setTransportUnavailable(true);
  };

  private setTransportUnavailable = (showConnectionLost: boolean): void => {
    this.actionAbortController?.abort();
    this.actionAbortController = null;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
    this.selectionAbortController?.abort();
    this.selectionAbortController = null;
    this.mutationAbortController?.abort();
    this.mutationAbortController = null;
    this.searchGeneration += 1;
    this.selectionGeneration += 1;
    this.navigator.status = 'unavailable';
    this.navigator.pendingThreadId = undefined;
    this.navigator.pendingMutation = undefined;
    this.navigator.archivedUndoThreadId = undefined;
    this.navigator.mutationNotice = undefined;
    this.pendingThreadStart = null;
    for (const runtime of this.threadRegistry.runtimes()) {
      runtime.resetTurnStart();
    }
    for (const [threadId, runtime] of this.threadRegistry.runtimeEntries()) {
      if (threadId !== this.threadId && runtime.getActiveTurnId() !== null) {
        this.threadRegistry.deleteRuntime(threadId);
        this.threadRegistry.markReloadRequired(threadId);
        this.threadRegistry.clearUnread(threadId);
      }
    }
    const clearedAgentOutput = this.clearPendingAgentOutputs();
    const alreadyUnavailable = this.phase === 'unavailable';
    this.phase = 'unavailable';
    if (showConnectionLost) {
      const alreadyReported = this.notice?.kind === 'connectionLost';
      this.notice = {
        kind: 'connectionLost',
        summary: 'The local Agent connection is unavailable.',
      };
      if (!alreadyUnavailable || !alreadyReported || clearedAgentOutput) {
        this.publish();
      }
      return;
    }
    const hadNotice = this.notice !== undefined;
    this.notice = undefined;
    if (!alreadyUnavailable || hadNotice || clearedAgentOutput) {
      this.publish();
    }
  };

  searchThreads = async (query: unknown): Promise<ConversationActionResult> => {
    if (!isValidThreadSearchInput(query)) {
      return rejected('invalidSearch');
    }
    if (this.getActionBlocked()) {
      return rejected('unavailable');
    }
    if (this.navigator.pendingMutation) {
      return rejected('unavailable');
    }
    const rpc = this.getRpc();
    if (!rpc?.searchThreads || this.phase === 'unavailable') {
      return rejected('unavailable');
    }

    const normalized = query.trim();
    this.searchAbortController?.abort();
    const generation = ++this.searchGeneration;
    if (normalized.length === 0) {
      this.searchAbortController = null;
      this.navigator.search = {
        query: '',
        status: 'idle',
        threadIds: [],
        threadTitles: {},
        truncated: false,
      };
      this.publish();
      return accepted();
    }

    const abortController = new AbortController();
    this.searchAbortController = abortController;
    this.navigator.search = {
      query: normalized,
      status: 'loading',
      threadIds: [],
      threadTitles: {},
      truncated: false,
    };
    this.publish();
    try {
      const response = await rpc.searchThreads(
        normalized,
        abortController.signal,
      );
      if (generation !== this.searchGeneration) {
        return accepted();
      }
      response.data.forEach(this.threadRegistry.registerDiscoveredThread);
      const threadIds = response.data.map((thread) => thread.id);
      this.navigator.search = {
        query: normalized,
        status: threadIds.length === 0 ? 'empty' : 'ready',
        threadIds,
        threadTitles: Object.fromEntries(
          response.data.flatMap((thread) =>
            thread.title ? [[thread.id, thread.title]] : [],
          ),
        ),
        truncated: response.nextCursor !== null,
      };
      this.publish();
      return accepted();
    } catch (error) {
      if (generation !== this.searchGeneration || isAbortError(error)) {
        return accepted();
      }
      if (error instanceof ConnectionClosedError) {
        this.transportClosed();
        return rejected('unavailable');
      }
      if (error instanceof RpcResponseError) {
        this.navigator.search = {
          query: normalized,
          status: 'error',
          threadIds: [],
          threadTitles: {},
          truncated: false,
          summary: 'Thread search is temporarily unavailable.',
        };
        this.publish();
        return rejected('unavailable');
      }
      this.onProtocolFailure();
      return rejected('unavailable');
    } finally {
      if (this.searchAbortController === abortController) {
        this.searchAbortController = null;
      }
    }
  };

  selectThread = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (
      typeof threadId !== 'string' ||
      !isKnownThread(
        this.navigator,
        this.threadId,
        threadId,
        this.getForegroundThreadView().threadIds,
      )
    ) {
      return rejected('unknownThread');
    }
    if (this.getActionBlocked()) {
      return rejected('unavailable');
    }
    if (
      this.navigator.pendingMutation ||
      this.navigator.search.status === 'loading'
    ) {
      return rejected('unavailable');
    }
    const rpc = this.getRpc();
    if (!rpc || this.phase === 'unavailable') {
      return rejected('unavailable');
    }
    if (threadId === this.threadId && !this.navigator.pendingThreadId) {
      this.threadRegistry.clearUnread(threadId);
      if (!this.threadRegistry.getTitle(threadId)) {
        void rpc
          .generateThreadTitle?.(threadId)
          .catch((): undefined => undefined);
      }
      return accepted();
    }

    const reloadRequired = this.threadRegistry.isReloadRequired(threadId);
    const cached = reloadRequired
      ? undefined
      : this.threadRegistry.getRuntime(threadId) ?? undefined;
    if (cached) {
      this.saveSelectedProjection();
      this.restoreProjection(threadId, cached);
      this.threadRegistry.clearUnread(threadId);
      this.navigator.pendingThreadId = undefined;
      this.publish();
      if (!this.threadRegistry.getTitle(threadId)) {
        void rpc
          .generateThreadTitle?.(threadId)
          .catch((): undefined => undefined);
      }
      return accepted();
    }

    this.selectionAbortController?.abort();
    const abortController = new AbortController();
    const generation = ++this.selectionGeneration;
    this.selectionAbortController = abortController;
    this.navigator.pendingThreadId = threadId;
    this.navigator.selectionNotice = undefined;
    this.publish();
    try {
      const snapshot = await rpc.resumeThread(threadId, abortController.signal);
      const recovered = recoverConversation(threadId, snapshot);
      if (generation !== this.selectionGeneration) {
        return accepted();
      }
      this.replaceRecoveredConversation(recovered, snapshot);
      this.phase = 'ready';
      this.threadRegistry.clearReloadRequired(threadId);
      this.threadRegistry.clearUnread(threadId);
      this.navigator.pendingThreadId = undefined;
      this.notice = undefined;
      this.publish();
      if (!this.threadRegistry.getTitle(threadId)) {
        void rpc
          .generateThreadTitle?.(threadId)
          .catch((): undefined => undefined);
      }
      return accepted();
    } catch (error) {
      if (generation !== this.selectionGeneration || isAbortError(error)) {
        return accepted();
      }
      this.navigator.pendingThreadId = undefined;
      if (error instanceof ThreadRegistryProtocolError) {
        this.onProtocolFailure();
        return rejected('unavailable');
      }
      if (error instanceof ConnectionClosedError) {
        this.transportClosed();
        return rejected('unavailable');
      }
      this.navigator.selectionNotice =
        error instanceof RpcResponseError
          ? 'That Thread could not be restored safely.'
          : 'That Thread contains an unsupported lifecycle. The local Agent is still available.';
      if (reloadRequired || !(error instanceof RpcResponseError)) {
        this.threadRegistry.markReloadRequired(threadId);
      }
      this.publish();
      return rejected('unavailable');
    } finally {
      if (this.selectionAbortController === abortController) {
        this.selectionAbortController = null;
      }
    }
  };

  forkThread = async (threadId: unknown): Promise<ConversationActionResult> => {
    const blocked = this.getThreadMutationBlock(threadId);
    if (blocked) {
      return rejected(blocked);
    }
    const rpc = this.getRpc();
    if (!rpc?.forkThread) {
      return rejected('unavailable');
    }
    const abortController = this.beginThreadMutation(
      'fork',
      threadId as string,
    );
    try {
      const snapshot = await rpc.forkThread(
        threadId as string,
        abortController.signal,
      );
      if (
        snapshot.threadId === threadId ||
        isKnownThread(
          this.navigator,
          this.threadId,
          snapshot.threadId,
          this.getForegroundThreadView().threadIds,
        )
      ) {
        throw new Error(
          'thread/fork did not return a new durable Thread identity.',
        );
      }
      const recovered = recoverConversation(snapshot.threadId, snapshot);
      this.threadRegistry.registerActiveThread({
        id: snapshot.threadId,
        workspaceId: snapshot.workspaceId,
        ...(snapshot.title ? { title: snapshot.title } : {}),
      });
      this.replaceRecoveredConversation(recovered, snapshot);
      this.phase = 'ready';
      resetThreadSearch(this.navigator);
      this.navigator.archivedUndoThreadId = undefined;
      this.navigator.mutationNotice = `Forked and selected Thread ${recovered.threadId}.`;
      return accepted();
    } catch (error) {
      return this.handleThreadMutationFailure(error, false);
    } finally {
      this.finishThreadMutation(abortController);
    }
  };

  startNewThread = (): ConversationActionResult => {
    if (
      this.getActionBlocked() ||
      this.navigator.pendingThreadId ||
      this.navigator.pendingMutation ||
      this.navigator.search.status === 'loading'
    ) {
      return rejected('turnActive');
    }
    if (!this.getRpc() || this.phase === 'unavailable') {
      return rejected('unavailable');
    }
    this.selectionAbortController?.abort();
    this.selectionGeneration += 1;
    this.navigator.pendingThreadId = undefined;
    this.navigator.selectionNotice = undefined;
    this.navigator.archivedUndoThreadId = undefined;
    resetThreadSearch(this.navigator);
    this.saveSelectedProjection();
    this.clearSelectedThread();
    this.publish();
    return accepted();
  };

  archiveThread = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    const blocked = this.getThreadMutationBlock(threadId);
    if (blocked) {
      return rejected(blocked);
    }
    const rpc = this.getRpc();
    if (!rpc?.archiveThread) {
      return rejected('unavailable');
    }
    const exactThreadId = threadId as string;
    const abortController = this.beginThreadMutation('archive', exactThreadId);
    let committed = false;
    try {
      await rpc.archiveThread(exactThreadId, abortController.signal);
      committed = true;
      const removedCurrent = this.threadId === exactThreadId;
      if (removedCurrent) {
        this.clearSelectedThread();
      }
      this.navigator.archivedUndoThreadId = exactThreadId;
      await this.reconcileRemovedThread(
        rpc,
        abortController.signal,
        exactThreadId,
        removedCurrent,
      );
      this.navigator.mutationNotice = `Archived Thread ${exactThreadId}. Undo is available until another lifecycle action or reconnect.`;
      return accepted();
    } catch (error) {
      return this.handleThreadMutationFailure(error, committed);
    } finally {
      this.finishThreadMutation(abortController);
    }
  };

  unarchiveThread = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (
      typeof threadId !== 'string' ||
      this.navigator.archivedUndoThreadId !== threadId
    ) {
      return rejected('unknownThread');
    }
    const blocked = this.getThreadMutationBlock(threadId, true);
    if (blocked) {
      return rejected(blocked);
    }
    const rpc = this.getRpc();
    if (!rpc?.unarchiveThread) {
      return rejected('unavailable');
    }
    const abortController = this.beginThreadMutation('unarchive', threadId);
    let committed = false;
    try {
      await rpc.unarchiveThread(threadId, abortController.signal);
      committed = true;
      this.navigator.archivedUndoThreadId = undefined;
      const listed = await this.listActiveThreads(rpc, abortController.signal);
      if (!listed.data.some((thread) => thread.id === threadId)) {
        throw new Error(
          'thread/unarchive did not restore the Thread to the active index.',
        );
      }
      const snapshot = await rpc.resumeThread(threadId, abortController.signal);
      const recovered = recoverConversation(threadId, snapshot);
      this.applyActiveThreadList(listed);
      this.replaceRecoveredConversation(recovered, snapshot);
      this.phase = 'ready';
      this.navigator.mutationNotice = `Restored and selected Thread ${threadId}.`;
      return accepted();
    } catch (error) {
      return this.handleThreadMutationFailure(error, committed);
    } finally {
      this.finishThreadMutation(abortController);
    }
  };

  deleteThread = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    const blocked = this.getThreadMutationBlock(threadId);
    if (blocked) {
      return rejected(blocked);
    }
    const rpc = this.getRpc();
    if (!rpc?.deleteThread) {
      return rejected('unavailable');
    }
    const exactThreadId = threadId as string;
    const abortController = this.beginThreadMutation('delete', exactThreadId);
    let committed = false;
    try {
      await rpc.deleteThread(exactThreadId, abortController.signal);
      committed = true;
      const removedCurrent = this.threadId === exactThreadId;
      if (removedCurrent) {
        this.clearSelectedThread();
      }
      this.navigator.archivedUndoThreadId = undefined;
      await this.reconcileRemovedThread(
        rpc,
        abortController.signal,
        exactThreadId,
        removedCurrent,
      );
      this.threadRegistry.removeThread(exactThreadId);
      this.navigator.mutationNotice = `Deleted Thread ${exactThreadId}.`;
      return accepted();
    } catch (error) {
      return this.handleThreadMutationFailure(error, committed);
    } finally {
      this.finishThreadMutation(abortController);
    }
  };

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationSendRequest(input)) {
      return rejected('invalidInput');
    }
    if (this.getActionBlocked()) {
      return rejected('unavailable');
    }
    if (
      this.phase === 'starting' ||
      this.phase === 'inProgress' ||
      this.phase === 'stopping' ||
      this.navigator.pendingThreadId ||
      this.navigator.pendingMutation
    ) {
      return rejected('turnActive');
    }
    const rpc = this.getRpc();
    if (!rpc || this.phase === 'unavailable') {
      return rejected('unavailable');
    }

    this.phase = 'starting';
    this.notice = undefined;
    this.pendingThreadStart = this.threadId
      ? null
      : {
          workspaceId: this.workspaceId ?? 'unbound',
          candidateThreadId: null,
          lifecycleBuffer: [],
        };
    this.actionAbortController = new AbortController();
    this.publish();
    const importedPreviewIds: string[] = [];

    try {
      if (!this.threadId) {
        const response = await rpc.startThread(
          this.actionAbortController.signal,
        );
        if (response.thread.workspaceId !== this.workspaceId) {
          throw new Error('thread/start crossed Workspace ownership.');
        }
        this.threadId = response.thread.id;
        this.threadRegistry.registerActiveThread(response.thread);
        this.saveSelectedProjection();
        this.drainPendingThreadLifecycle(response.thread.id);
      }

      const turnInput: TurnInputPart[] = [];
      if (input.input.length > 0) {
        turnInput.push({ type: 'text', text: input.input });
      }
      for (const attachment of input.attachments ?? []) {
        const imported = await rpc.importAsset(
          {
            fileName: attachment.fileName,
            ...(attachment.mediaType
              ? { mediaType: attachment.mediaType }
              : {}),
            data: attachment.data,
          },
          this.actionAbortController.signal,
        );
        if (imported.asset.kind === 'image') {
          importedPreviewIds.push(imported.asset.assetId);
          this.attachmentPreviews.set(
            imported.asset.assetId,
            `data:${imported.asset.mediaType};base64,${attachment.data}`,
          );
        }
        turnInput.push(
          imported.asset.kind === 'image'
            ? { type: 'image', asset: imported.asset }
            : { type: 'document', asset: imported.asset },
        );
      }
      const runtime = this.threadRegistry.getRuntime(this.threadId);
      if (!runtime) {
        throw new Error('Thread Runtime is unavailable before turn/start.');
      }
      runtime.beginTurnStart();
      const response = await rpc.startTurn(
        this.threadId,
        turnInput,
        input.modelProfileId,
        this.actionAbortController.signal,
      );
      const turn: MutableTurn = {
        id: response.turn.id,
        status: 'inProgress',
        ...(response.turn.model ? { model: response.turn.model } : {}),
        messages: [],
        pendingAgentOutputs: [],
        activities: [],
      };
      this.turns.push(turn);
      this.activeTurnId = turn.id;
      this.phase = 'inProgress';
      this.publish();
      const buffered = runtime.acceptTurnStart();
      for (const lifecycle of buffered) {
        this.applySelectedLifecycle(lifecycle);
      }
      if (buffered.length > 0) {
        this.publish();
      }
      if (!this.threadRegistry.getTitle(this.threadId)) {
        void rpc
          .generateThreadTitle?.(this.threadId)
          .catch((): undefined => undefined);
      }
      return accepted();
    } catch (error) {
      for (const assetId of importedPreviewIds) {
        this.attachmentPreviews.delete(assetId);
      }
      this.pendingThreadStart = null;
      if (this.threadId) {
        this.threadRegistry.getRuntime(this.threadId)?.failTurnStart();
      }
      this.actionAbortController = null;
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        this.transportClosed();
        return rejected('unavailable');
      }
      if (!(error instanceof RpcResponseError)) {
        this.onProtocolFailure();
        return rejected('unavailable');
      }
      this.phase = this.threadId ? 'ready' : 'idle';
      this.notice = {
        kind: 'requestFailed',
        summary: 'The local Agent could not start this Turn.',
      };
      this.publish();
      return rejected('unavailable');
    } finally {
      this.actionAbortController = null;
    }
  };

  stopTurn = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string') {
      return rejected('unknownThread');
    }
    const selected = threadId === this.threadId;
    const projection = selected
      ? null
      : this.threadRegistry.getRuntime(threadId);
    const activeTurnId = selected
      ? this.activeTurnId
      : projection?.getActiveTurnId() ?? null;
    const phase = selected ? this.phase : projection?.getPhase();
    if (phase !== 'inProgress' || !activeTurnId) {
      return rejected(
        phase === 'unavailable' ? 'unavailable' : 'noActiveTurn',
      );
    }
    const rpc = this.getRpc();
    if (!rpc) {
      return rejected('unavailable');
    }

    const turnId = activeTurnId;
    if (selected) {
      this.phase = 'stopping';
    } else if (projection) {
      projection.setPhase('stopping');
    }
    this.publish();
    try {
      await rpc.interruptTurn(threadId, turnId);
      return accepted();
    } catch (error) {
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        this.transportClosed();
      } else if (!(error instanceof RpcResponseError)) {
        this.onProtocolFailure();
      } else {
        this.notice = {
          kind: 'requestFailed',
          summary: 'The local Agent could not stop this Turn safely.',
        };
        if (selected && this.activeTurnId === turnId) {
          this.phase = 'inProgress';
        } else if (projection?.getActiveTurnId() === turnId) {
          projection.setPhase('inProgress');
        }
        this.publish();
      }
      return rejected('unavailable');
    }
  };

  handleNotification = (
    message: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    let route;
    try {
      route = parseConversationLifecycleRoute(message);
    } catch {
      this.onProtocolFailure();
      return;
    }
    if (!route) {
      this.onProtocolFailure();
      return;
    }
    if (this.threadRegistry.isReloadRequired(route.threadId)) {
      return;
    }

    const belongsToPendingNewThread =
      this.pendingThreadStart !== null &&
      route.workspaceId === this.pendingThreadStart.workspaceId &&
      this.threadId === null &&
      this.phase === 'starting' &&
      !this.threadRegistry.getRuntime(route.threadId);
    const target = this.threadRegistry.getRuntime(route.threadId);
    if (
      (route.threadId === this.threadId &&
        route.workspaceId !== this.workspaceId) ||
      (target && target.workspaceId !== route.workspaceId) ||
      (!belongsToPendingNewThread &&
        route.threadId !== this.threadId &&
        !target)
    ) {
      this.onProtocolFailure();
      return;
    }

    let lifecycle: ConversationLifecycle | null;
    try {
      lifecycle = parseConversationLifecycle(message);
      if (!lifecycle) {
        return;
      }
      if (lifecycle.type === 'threadTitleUpdated') {
        if (belongsToPendingNewThread) {
          this.bufferPendingThreadLifecycle(route, lifecycle);
          return;
        }
        this.threadRegistry.updateTitle(
          route.workspaceId,
          lifecycle.params.threadId,
          lifecycle.params.title,
        );
        this.publish();
        return;
      }
      if (belongsToPendingNewThread) {
        this.bufferPendingThreadLifecycle(route, lifecycle);
        return;
      }
      if (route.threadId === this.threadId) {
        this.saveSelectedProjection();
        const selectedRuntime = this.threadRegistry.getRuntime(route.threadId);
        if (!selectedRuntime) {
          throw new Error('Selected Thread runtime is unavailable.');
        }
        if (
          selectedRuntime.isTurnStartPending() &&
          lifecycle.type !== 'threadStarted'
        ) {
          selectedRuntime.bufferLifecycle(lifecycle);
          return;
        }
        selectedRuntime.acceptLifecycle(lifecycle);
        this.restoreProjection(route.threadId, selectedRuntime);
        this.publish();
        return;
      }
      if (target?.isTurnStartPending() && lifecycle.type !== 'threadStarted') {
        target.bufferLifecycle(lifecycle);
        return;
      }
      target?.acceptLifecycle(lifecycle);
      if (
        lifecycle.type === 'turnCompleted' &&
        lifecycle.params.turn.status !== 'inProgress'
      ) {
        this.threadRegistry.markUnread(
          route.threadId,
          lifecycle.params.turn.status,
        );
      }
      this.publish();
    } catch {
      if (belongsToPendingNewThread) {
        this.onProtocolFailure();
      } else {
        this.quarantineThread(route.threadId, route.workspaceId);
      }
    }
  };

  private bufferPendingThreadLifecycle = (
    route: ConversationLifecycleRoute,
    lifecycle: ConversationLifecycle,
  ): void => {
    const pending = this.pendingThreadStart;
    if (
      !pending ||
      pending.workspaceId !== route.workspaceId ||
      (pending.candidateThreadId !== null &&
        pending.candidateThreadId !== route.threadId) ||
      pending.lifecycleBuffer.length >= MAX_BUFFERED_LIFECYCLE
    ) {
      throw new Error('Pending Thread start lifecycle is inconsistent.');
    }
    pending.candidateThreadId = route.threadId;
    pending.lifecycleBuffer.push(lifecycle);
  };

  private drainPendingThreadLifecycle = (threadId: string): void => {
    const pending = this.pendingThreadStart;
    this.pendingThreadStart = null;
    if (!pending) {
      return;
    }
    if (
      pending.workspaceId !== this.workspaceId ||
      (pending.candidateThreadId !== null &&
        pending.candidateThreadId !== threadId)
    ) {
      throw new Error('thread/start response did not match buffered lifecycle.');
    }
    for (const lifecycle of pending.lifecycleBuffer) {
      if (lifecycle.type === 'threadTitleUpdated') {
        this.threadRegistry.updateTitle(
          pending.workspaceId,
          threadId,
          lifecycle.params.title,
        );
      } else {
        this.applySelectedLifecycle(lifecycle);
      }
    }
  };

  private applySelectedLifecycle = (
    lifecycle: ConversationLifecycle,
  ): void => {
    if (!this.threadId) {
      throw new Error('Selected Thread runtime is unavailable.');
    }
    this.saveSelectedProjection();
    const runtime = this.threadRegistry.getRuntime(this.threadId);
    if (!runtime) {
      throw new Error('Selected Thread runtime is unavailable.');
    }
    runtime.acceptLifecycle(lifecycle);
    this.restoreProjection(this.threadId, runtime);
  };

  private getThreadMutationBlock = (
    threadId: unknown,
    archivedUndo = false,
  ): Exclude<ConversationActionResult['reason'], 'accepted'> | null => {
    if (
      typeof threadId !== 'string' ||
      (!archivedUndo &&
        !isKnownThread(
          this.navigator,
          this.threadId,
          threadId,
          this.getForegroundThreadView().threadIds,
        ))
    ) {
      return 'unknownThread';
    }
    const exactThreadId = threadId as string;
    const targetActive =
      this.threadId === exactThreadId
        ? this.activeTurnId !== null
        : this.threadRegistry.getRuntime(exactThreadId)?.getActiveTurnId() !=
          null;
    if (targetActive) {
      return 'turnActive';
    }
    if (
      this.getActionBlocked() ||
      this.phase === 'unavailable' ||
      this.navigator.pendingThreadId ||
      this.navigator.pendingMutation ||
      this.navigator.search.status === 'loading'
    ) {
      return 'unavailable';
    }
    return null;
  };

  private beginThreadMutation = (
    kind: NonNullable<
      ConversationThreadNavigatorSnapshot['pendingMutation']
    >['kind'],
    threadId: string,
  ): AbortController => {
    const abortController = new AbortController();
    this.mutationAbortController = abortController;
    this.navigator.pendingMutation = { kind, threadId };
    this.navigator.mutationNotice = undefined;
    this.publish();
    return abortController;
  };

  private finishThreadMutation = (abortController: AbortController): void => {
    if (this.mutationAbortController !== abortController) {
      return;
    }
    this.mutationAbortController = null;
    this.navigator.pendingMutation = undefined;
    this.publish();
  };

  private listActiveThreads = async (
    rpc: ConversationRpc,
    signal: AbortSignal,
  ): Promise<ThreadListResponse> => {
    if (!rpc.listActiveThreads) {
      throw new Error('Thread mutation requires active Thread discovery.');
    }
    return rpc.listActiveThreads(signal);
  };

  private applyActiveThreadList = (listed: ThreadListResponse): void => {
    if (
      !this.workspaceId ||
      listed.data.some((thread) => thread.workspaceId !== this.workspaceId)
    ) {
      throw new Error('Thread index crossed workspace ownership.');
    }
    this.threadRegistry.replaceWorkspaceIndex(this.workspaceId, listed.data);
    this.navigator.activeTruncated = listed.nextCursor !== null;
    this.navigator.status = 'ready';
    this.navigator.selectionNotice = undefined;
    resetThreadSearch(this.navigator);
  };

  private reconcileRemovedThread = async (
    rpc: ConversationRpc,
    signal: AbortSignal,
    removedThreadId: string,
    selectFallback: boolean,
  ): Promise<void> => {
    const listed = await this.listActiveThreads(rpc, signal);
    if (listed.data.some((thread) => thread.id === removedThreadId)) {
      throw new Error('A removed Thread remained present in the active index.');
    }
    if (
      !selectFallback &&
      this.threadId &&
      !listed.data.some((thread) => thread.id === this.threadId)
    ) {
      throw new Error(
        'Thread lifecycle refresh omitted the unchanged selected Thread.',
      );
    }
    this.applyActiveThreadList(listed);
    if (!selectFallback) {
      return;
    }
    const fallbackThreadId = listed.data[0]?.id;
    if (!fallbackThreadId) {
      return;
    }
    const snapshot = await rpc.resumeThread(fallbackThreadId, signal);
    const recovered = recoverConversation(fallbackThreadId, snapshot);
    this.replaceRecoveredConversation(recovered, snapshot);
    this.phase = 'ready';
    this.notice = undefined;
  };

  private clearSelectedThread = (): void => {
    this.clearSelectedConversation();
    this.phase = 'idle';
  };

  private clearSelectedConversation = (): void => {
    this.threadId = null;
    this.activeTurnId = null;
    this.turns = [];
    this.notice = undefined;
  };

  private saveSelectedProjection = (): void => {
    if (!this.threadId) {
      return;
    }
    const state = this.captureSelectedProjection();
    const runtime = this.threadRegistry.getRuntime(this.threadId);
    if (runtime) {
      runtime.replaceProjection(state);
      return;
    }
    this.threadRegistry.setRuntime(this.threadId, new ThreadRuntime(state));
  };

  private captureSelectedProjection = (): ThreadRuntimeState => ({
    workspaceId: this.workspaceId ?? 'unbound',
    threadId: this.threadId as string,
    phase: this.phase,
    activeTurnId: this.activeTurnId,
    turns: this.turns,
    notice: this.notice,
    attachmentPreviews: new Map(this.attachmentPreviews),
  });

  private restoreProjection = (
    threadId: string | null,
    runtime: ThreadRuntime,
  ): void => {
    const projection = runtime.capture();
    if (this.workspaceId !== projection.workspaceId) {
      throw new Error('Conversation projection belongs to another workspace.');
    }
    this.threadId = threadId;
    this.phase = projection.phase;
    this.activeTurnId = projection.activeTurnId;
    this.turns = projection.turns;
    this.notice = projection.notice;
    this.attachmentPreviews.clear();
    for (const [assetId, preview] of projection.attachmentPreviews) {
      this.attachmentPreviews.set(assetId, preview);
    }
  };

  private quarantineThread = (
    threadId: string,
    workspaceId: string,
  ): void => {
    const runtime = this.threadRegistry.getRuntime(threadId);
    if (runtime && runtime.workspaceId !== workspaceId) {
      this.onProtocolFailure();
      return;
    }
    this.threadRegistry.deleteRuntime(threadId);
    this.threadRegistry.markReloadRequired(threadId);
    this.threadRegistry.clearUnread(threadId);
    this.onThreadProjectionFailure(threadId);
    if (this.threadId === threadId) {
      this.clearSelectedConversation();
      this.phase = 'idle';
    }
    this.navigator.selectionNotice =
      'This Thread could not be updated safely. Select it to reload from saved history. Other Threads remain available.';
    this.publish();
  };

  private handleThreadMutationFailure = (
    error: unknown,
    committed: boolean,
  ): ConversationActionResult => {
    if (error instanceof ConnectionClosedError || isAbortError(error)) {
      this.transportClosed();
      return committed ? accepted() : rejected('unavailable');
    }
    if (error instanceof RpcResponseError) {
      this.navigator.mutationNotice = committed
        ? 'The Thread lifecycle change was saved, but Desktop could not refresh the durable index.'
        : 'The Thread lifecycle change was rejected.';
      return committed ? accepted() : rejected('unavailable');
    }
    this.onProtocolFailure();
    return committed ? accepted() : rejected('unavailable');
  };

  private replaceRecoveredConversation = (
    recovered: RecoveredConversation,
    snapshot: ResumeSnapshot,
  ): void => {
    this.threadRegistry.registerDiscoveredThread({
      id: snapshot.threadId,
      workspaceId: snapshot.workspaceId,
      ...(snapshot.title ? { title: snapshot.title } : {}),
    });
    if (this.threadId !== recovered.threadId) {
      this.saveSelectedProjection();
    }
    this.threadId = recovered.threadId;
    this.activeTurnId = null;
    this.turns = createMutableTurns(recovered);
  };

  private createSnapshot = (): ConversationStateSnapshot => {
    const active = this.getForegroundThreadView();
    const snapshot = createConversationSnapshot({
      revision: this.revision,
      phase: this.phase,
      threadId: this.threadId,
      activeTurnId: this.activeTurnId,
      turns: this.turns,
      navigator: this.navigator,
      activeThreadIds:
        this.navigator.status === 'loading' ? [] : active.threadIds,
      activeThreadTitles:
        this.navigator.status === 'loading' ? {} : active.threadTitles,
      notice: this.notice,
    });
    return {
      ...snapshot,
      navigator: {
        ...snapshot.navigator,
        runningThreadIds: this.threadRegistry.getRunningThreadIds(),
        unreadThreadStatuses: this.threadRegistry.getUnreadStatuses(),
        reloadRequiredThreadIds:
          this.threadRegistry.getReloadRequiredThreadIds(),
      },
    };
  };

  private getForegroundThreadView = () =>
    this.workspaceId
      ? this.threadRegistry.getWorkspaceView(this.workspaceId)
      : { threadIds: [], threadTitles: {} };

  protected publish = (): void => {
    this.saveSelectedProjection();
    this.revision += 1;
    const snapshot = this.createSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
