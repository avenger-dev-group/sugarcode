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
  parseConversationLifecycle,
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
  recordActiveThread,
  resetThreadSearch,
} from '../thread-navigator';
import { deriveThreadTitle } from '../thread-title';
import {
  ConnectionClosedError,
  RpcResponseError,
} from '../../transport/jsonl-client';
import type { ServerMessage } from '../../transport/server-message';

const MAX_BUFFERED_LIFECYCLE = 64;

type ConversationProjection = {
  workspaceId: string;
  phase: ConversationStateSnapshot['phase'];
  activeTurnId: string | null;
  turns: MutableTurn[];
  notice: ConversationStateSnapshot['notice'];
};

export type ScopedConversationStateListener = (
  workspaceId: string,
  snapshot: ConversationStateSnapshot,
) => void;

type ConversationControllerOptions = Readonly<{
  getRpc: () => ConversationRpc | null;
  onProtocolFailure: () => void;
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
  private readonly onProtocolFailure: ConversationControllerOptions['onProtocolFailure'];
  private readonly getActionBlocked: () => boolean;
  private readonly listeners = new Set<ConversationStateListener>();
  private readonly scopedListeners = new Set<ScopedConversationStateListener>();
  private workspaceId: string | null = null;
  private revision = 0;
  private bufferedLifecycle: ConversationLifecycle[] = [];
  private awaitingTurnResponse = false;
  private searchAbortController: AbortController | null = null;
  private selectionAbortController: AbortController | null = null;
  private mutationAbortController: AbortController | null = null;
  private searchGeneration = 0;
  private selectionGeneration = 0;
  private readonly navigator: MutableThreadNavigator = createThreadNavigator();
  private readonly projections = new Map<string, ConversationProjection>();
  private readonly unreadThreadIds = new Set<string>();
  private publishSuspended = false;

  constructor(options: ConversationControllerOptions) {
    super();
    this.getRpc = options.getRpc;
    this.onProtocolFailure = options.onProtocolFailure;
    this.getActionBlocked = options.getActionBlocked ?? (() => false);
  }

  getSnapshot = (): ConversationStateSnapshot => this.createSnapshot();

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeScoped = (listener: ScopedConversationStateListener): (() => void) => {
    this.scopedListeners.add(listener);
    return () => this.scopedListeners.delete(listener);
  };

  setAgentApprovalTasks = (waitingTaskIds: ReadonlySet<string>): void => {
    let changed = false;
    const turnCollections = new Set<MutableTurn[]>([
      this.turns,
      ...[...this.projections.values()].map((projection) => projection.turns),
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
        const cached = this.projections.get(preferredThreadId);
        if (cached?.workspaceId === workspaceId) {
          this.restoreProjection(preferredThreadId, cached);
        } else {
          const snapshot = await rpc.resumeThread(
            preferredThreadId,
            abortController.signal,
          );
          const recovered = recoverConversation(preferredThreadId, snapshot);
          this.replaceRecoveredConversation(recovered);
          this.phase = 'ready';
        }
        this.unreadThreadIds.delete(preferredThreadId);
      } else {
        this.phase = 'idle';
      }
      this.notice = undefined;
      this.publish();
      return true;
    } catch (error) {
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        this.transportClosed();
      } else {
        this.navigator.status = 'error';
        this.navigator.selectionNotice =
          error instanceof RpcResponseError
            ? 'This workspace could not be restored safely.'
            : 'This workspace contains an unsupported Thread lifecycle.';
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
      this.navigator.activeThreadIds = listed
        ? listed.data.map((thread) => thread.id)
        : fallbackThreadId
          ? [fallbackThreadId]
          : [];
      this.navigator.activeThreadTitles = listed
        ? Object.fromEntries(
            listed.data.flatMap((thread) =>
              thread.title ? [[thread.id, thread.title]] : [],
            ),
          )
        : {};
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
      this.replaceRecoveredConversation(recovered);
      return true;
    } catch (error) {
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        throw error;
      }
      this.clearSelectedConversation();
      this.navigator.status = 'ready';
      this.navigator.selectionNotice =
        error instanceof RpcResponseError
          ? 'The selected Thread could not be loaded. Other Threads remain available.'
          : 'The selected Thread contains an unsupported lifecycle. Other Threads remain available.';
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
    this.awaitingTurnResponse = false;
    this.bufferedLifecycle = [];
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
      !isKnownThread(this.navigator, this.threadId, threadId)
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
      this.unreadThreadIds.delete(threadId);
      return accepted();
    }

    const cached = this.projections.get(threadId);
    if (cached) {
      this.saveSelectedProjection();
      this.restoreProjection(threadId, cached);
      this.unreadThreadIds.delete(threadId);
      this.navigator.pendingThreadId = undefined;
      this.publish();
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
      this.replaceRecoveredConversation(recovered);
      this.phase = 'ready';
      this.navigator.pendingThreadId = undefined;
      this.notice = undefined;
      this.publish();
      return accepted();
    } catch (error) {
      if (generation !== this.selectionGeneration || isAbortError(error)) {
        return accepted();
      }
      this.navigator.pendingThreadId = undefined;
      if (error instanceof ConnectionClosedError) {
        this.transportClosed();
        return rejected('unavailable');
      }
      this.navigator.selectionNotice =
        error instanceof RpcResponseError
          ? 'That Thread could not be restored safely.'
          : 'That Thread contains an unsupported lifecycle. The local Agent is still available.';
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
        isKnownThread(this.navigator, this.threadId, snapshot.threadId)
      ) {
        throw new Error(
          'thread/fork did not return a new durable Thread identity.',
        );
      }
      const recovered = recoverConversation(snapshot.threadId, snapshot);
      this.replaceRecoveredConversation(recovered);
      this.phase = 'ready';
      recordActiveThread(this.navigator, recovered.threadId, snapshot.title);
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
      this.replaceRecoveredConversation(recovered);
      this.phase = 'ready';
      recordActiveThread(this.navigator, threadId, snapshot.title);
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
    this.bufferedLifecycle = [];
    this.actionAbortController = new AbortController();
    this.publish();
    const importedPreviewIds: string[] = [];

    try {
      if (!this.threadId) {
        const response = await rpc.startThread(
          this.actionAbortController.signal,
        );
        this.threadId = response.thread.id;
        recordActiveThread(this.navigator, response.thread.id);
        this.drainBufferedThreadLifecycle();
      }

      if (!this.navigator.activeThreadTitles[this.threadId]) {
        const title = deriveThreadTitle(
          input.input,
          input.attachments?.[0]?.fileName,
        );
        if (title) {
          recordActiveThread(this.navigator, this.threadId, title);
        }
      }

      this.awaitingTurnResponse = true;
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
      this.awaitingTurnResponse = false;
      this.publish();
      this.drainBufferedLifecycle();
      return accepted();
    } catch (error) {
      for (const assetId of importedPreviewIds) {
        this.attachmentPreviews.delete(assetId);
      }
      this.awaitingTurnResponse = false;
      this.bufferedLifecycle = [];
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
    const projection = selected ? null : this.projections.get(threadId);
    const activeTurnId = selected
      ? this.activeTurnId
      : projection?.activeTurnId ?? null;
    const phase = selected ? this.phase : projection?.phase;
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
      projection.phase = 'stopping';
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
        } else if (projection?.activeTurnId === turnId) {
          projection.phase = 'inProgress';
        }
        this.publish();
      }
      return rejected('unavailable');
    }
  };

  handleNotification = (
    message: Extract<ServerMessage, { kind: 'notification' }>,
    workspaceId: string,
  ): void => {
    let lifecycle: ConversationLifecycle | null;
    try {
      lifecycle = parseConversationLifecycle(message);
      if (!lifecycle) {
        return;
      }
      const targetThreadId =
        lifecycle.type === 'threadStarted'
          ? lifecycle.params.thread.id
          : lifecycle.params.threadId;
      if (
        lifecycle.type === 'threadStarted' &&
        lifecycle.params.thread.workspaceId !== workspaceId
      ) {
        throw new Error('Thread lifecycle workspace binding changed in transit.');
      }
      const belongsToPendingNewThread =
        workspaceId === this.workspaceId &&
        this.threadId === null &&
        this.phase === 'starting';
      if (targetThreadId === this.threadId && workspaceId !== this.workspaceId) {
        throw new Error('Selected Thread received another workspace lifecycle.');
      }
      if (!belongsToPendingNewThread && targetThreadId !== this.threadId) {
        const target = this.projections.get(targetThreadId);
        if (!target || target.workspaceId !== workspaceId) {
          throw new Error('Lifecycle referenced an unknown background Thread.');
        }
        const selectedThreadId = this.threadId;
        const selectedProjection = this.captureSelectedProjection();
        const selectedWorkspaceId = this.workspaceId;
        this.saveSelectedProjection();
        this.workspaceId = workspaceId;
        this.restoreProjection(targetThreadId, target);
        this.publishSuspended = true;
        try {
          this.applyLifecycle(lifecycle);
          this.saveSelectedProjection();
        } finally {
          this.publishSuspended = false;
          this.workspaceId = selectedWorkspaceId;
          this.restoreProjection(selectedThreadId, selectedProjection);
        }
        if (
          lifecycle.type === 'turnCompleted' &&
          lifecycle.params.turn.status !== 'inProgress'
        ) {
          this.unreadThreadIds.add(targetThreadId);
        }
        this.publish();
        return;
      }
      if (this.shouldBuffer(lifecycle)) {
        this.bufferLifecycle(lifecycle);
        return;
      }
      this.applyLifecycle(lifecycle);
    } catch {
      this.onProtocolFailure();
    }
  };

  private shouldBuffer = (lifecycle: ConversationLifecycle): boolean => {
    if (this.phase !== 'starting') {
      return false;
    }
    if (lifecycle.type === 'threadStarted') {
      return !this.threadId;
    }
    return this.awaitingTurnResponse;
  };

  private bufferLifecycle = (lifecycle: ConversationLifecycle): void => {
    if (this.bufferedLifecycle.length >= MAX_BUFFERED_LIFECYCLE) {
      throw new Error('Conversation lifecycle buffer exceeded its limit.');
    }
    this.bufferedLifecycle.push(lifecycle);
  };

  private drainBufferedThreadLifecycle = (): void => {
    const remaining: ConversationLifecycle[] = [];
    for (const lifecycle of this.bufferedLifecycle) {
      if (lifecycle.type === 'threadStarted') {
        this.applyLifecycle(lifecycle);
      } else {
        remaining.push(lifecycle);
      }
    }
    this.bufferedLifecycle = remaining;
  };

  private drainBufferedLifecycle = (): void => {
    const buffered = this.bufferedLifecycle;
    this.bufferedLifecycle = [];
    for (const lifecycle of buffered) {
      this.applyLifecycle(lifecycle);
    }
  };

  private getThreadMutationBlock = (
    threadId: unknown,
    archivedUndo = false,
  ): Exclude<ConversationActionResult['reason'], 'accepted'> | null => {
    if (
      typeof threadId !== 'string' ||
      (!archivedUndo && !isKnownThread(this.navigator, this.threadId, threadId))
    ) {
      return 'unknownThread';
    }
    const exactThreadId = threadId as string;
    const targetActive =
      this.threadId === exactThreadId
        ? this.activeTurnId !== null
        : this.projections.get(exactThreadId)?.activeTurnId != null;
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
    this.navigator.activeThreadIds = listed.data.map((thread) => thread.id);
    this.navigator.activeThreadTitles = Object.fromEntries(
      listed.data.flatMap((thread) =>
        thread.title ? [[thread.id, thread.title]] : [],
      ),
    );
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
    this.replaceRecoveredConversation(recovered);
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
    this.projections.set(this.threadId, this.captureSelectedProjection());
  };

  private captureSelectedProjection = (): ConversationProjection => ({
    workspaceId: this.workspaceId ?? 'unbound',
    phase: this.phase,
    activeTurnId: this.activeTurnId,
    turns: this.turns,
    notice: this.notice,
  });

  private restoreProjection = (
    threadId: string | null,
    projection: ConversationProjection,
  ): void => {
    if (this.workspaceId !== projection.workspaceId) {
      throw new Error('Conversation projection belongs to another workspace.');
    }
    this.threadId = threadId;
    this.phase = projection.phase;
    this.activeTurnId = projection.activeTurnId;
    this.turns = projection.turns;
    this.notice = projection.notice;
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
  ): void => {
    if (this.threadId !== recovered.threadId) {
      this.saveSelectedProjection();
    }
    this.threadId = recovered.threadId;
    this.activeTurnId = null;
    this.turns = createMutableTurns(recovered);
  };

  private createSnapshot = (): ConversationStateSnapshot => {
    const snapshot = createConversationSnapshot({
      revision: this.revision,
      phase: this.phase,
      threadId: this.threadId,
      activeTurnId: this.activeTurnId,
      turns: this.turns,
      navigator: this.navigator,
      notice: this.notice,
    });
    const runningThreadIds = [...this.projections.entries()]
      .filter(
        ([, projection]) =>
          projection.workspaceId === this.workspaceId &&
          projection.activeTurnId !== null,
      )
      .map(([threadId]) => threadId);
    return {
      ...snapshot,
      navigator: {
        ...snapshot.navigator,
        runningThreadIds,
        unreadThreadIds: [...this.unreadThreadIds].filter(
          (threadId) =>
            this.projections.get(threadId)?.workspaceId === this.workspaceId,
        ),
      },
    };
  };

  protected publish = (): void => {
    if (this.publishSuspended) {
      return;
    }
    this.saveSelectedProjection();
    this.revision += 1;
    const snapshot = this.createSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    if (this.workspaceId) {
      for (const listener of this.scopedListeners) {
        listener(this.workspaceId, snapshot);
      }
    }
  };
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
