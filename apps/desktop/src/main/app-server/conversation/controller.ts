import type { ThreadListResponse } from '@sugarcode/app-server-protocol';

import type {
  ConversationActionResult,
  ConversationActivity,
  ConversationAgentTaskStatus,
  ConversationCommandApprovalDecision,
  ConversationCommentaryActivity,
  ConversationCommandExecutionResultOutcome,
  ConversationContextCompactionActivity,
  ConversationFileChangeActivity,
  ConversationFileChangeProposal,
  ConversationFileChangeResultOutcome,
  ConversationMessage,
  ConversationMcpActivity,
  ConversationMcpResultReceipt,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationThreadNavigatorSnapshot,
  ConversationTurn,
  ConversationTurnError,
  ConversationTurnStatus,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceListOutcome,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceReadOutcome,
  ConversationWorkspaceSearchActivity,
  ConversationWorkspaceSearchOutcome,
} from '@/shared/conversation';
import {
  isValidConversationInput,
  isValidThreadSearchInput,
} from '@/shared/conversation';

import {
  type ConversationLifecycle,
  parseConversationLifecycle,
} from './protocol';
import type {
  WorkspacePatchChangeItem,
  WorkspacePatchResultItem,
} from './file-change-protocol';
import { recoverConversation, type RecoveredConversation } from './recovery';
import type { ConversationRpc } from './rpc-client';
import {
  createThreadNavigator,
  isKnownThread,
  type MutableThreadNavigator,
  recordActiveThread,
  resetThreadSearch,
  snapshotThreadNavigator,
} from './thread-navigator';
import {
  ConnectionClosedError,
  RpcResponseError,
} from '../transport/jsonl-client';
import type { ServerMessage } from '../transport/server-message';

const MAX_BUFFERED_LIFECYCLE = 64;

type MutableMessage = {
  id: string;
  role: ConversationMessage['role'];
  text: string;
  status: ConversationMessage['status'];
};

type MutableContextCompactionActivity = {
  -readonly [
    Key in keyof ConversationContextCompactionActivity
  ]: ConversationContextCompactionActivity[Key];
};

type MutableCommentaryActivity = {
  -readonly [
    Key in keyof ConversationCommentaryActivity
  ]: ConversationCommentaryActivity[Key];
};

type MutableConversationActivity =
  | { type: 'commentary'; activity: MutableCommentaryActivity }
  | { type: 'contextCompaction'; activity: MutableContextCompactionActivity }
  | { type: 'workspaceRead'; activity: MutableWorkspaceReadActivity }
  | { type: 'workspaceList'; activity: MutableWorkspaceListActivity }
  | { type: 'workspaceSearch'; activity: MutableWorkspaceSearchActivity }
  | { type: 'fileChange'; activity: MutableFileChangeActivity }
  | { type: 'commandApproval'; activity: MutableCommandApprovalActivity }
  | { type: 'mcp'; activity: MutableMcpActivity }
  | { type: 'orchestration'; activity: MutableOrchestrationActivity };

type MutableAgentTask = {
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
  amendments: Array<{ id: string; markdown: string }>;
  result?: { id: string; summaryMarkdown: string; durationMs: number };
};

type MutableOrchestrationActivity = {
  id: string;
  tasks: MutableAgentTask[];
};

type MutableWorkspaceReadActivity = {
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationWorkspaceReadActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceReadActivity['callStatus'];
    outcome: ConversationWorkspaceReadOutcome;
  };
};

type MutableWorkspaceListActivity = {
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationWorkspaceListActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceListActivity['callStatus'];
    outcome: ConversationWorkspaceListOutcome;
  };
};

type MutableWorkspaceSearchActivity = {
  id: string;
  callId: string;
  path: string;
  query: string;
  callStatus: ConversationWorkspaceSearchActivity['callStatus'];
  result?: {
    id: string;
    status: ConversationWorkspaceSearchActivity['callStatus'];
    outcome: ConversationWorkspaceSearchOutcome;
  };
};

type MutableFileChangeActivity = {
  id: string;
  callId: string;
  path: string;
  callStatus: ConversationMessage['status'];
  change?: ConversationFileChangeProposal;
  result?: {
    id: string;
    status: ConversationMessage['status'];
    outcome: ConversationFileChangeResultOutcome;
  };
};

type MutableCommandCall = {
  id: string;
  callId: string;
  command: string;
  arguments: readonly string[];
  status: ConversationMessage['status'];
};

type MutableCommandApprovalActivity = {
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  command: string;
  argumentCount: number;
  requestStatus: ConversationMessage['status'];
  decision?: {
    id: string;
    status: ConversationMessage['status'];
    value: ConversationCommandApprovalDecision;
  };
  executionAttempt?: {
    id: string;
    status: ConversationMessage['status'];
  };
  executionResult?: {
    id: string;
    status: ConversationMessage['status'];
    outcome: ConversationCommandExecutionResultOutcome;
  };
  argumentSignature: string;
};

type MutableMcpCall = {
  id: string;
  callId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
  status: ConversationMessage['status'];
};

type MutableMcpActivity = {
  callItemId: string;
  id: string;
  callId: string;
  approvalId: string;
  serverId: string;
  name: string;
  argumentsBytes: number;
  argumentsSha256: string;
  inventorySha256: string;
  argumentSignature: string;
  callStatus: ConversationMessage['status'];
  requestStatus: ConversationMessage['status'];
  decision?: {
    id: string;
    status: ConversationMessage['status'];
    value: ConversationCommandApprovalDecision;
  };
  executionAttempt?: {
    id: string;
    status: ConversationMessage['status'];
  };
  result?: {
    id: string;
    status: ConversationMessage['status'];
    receipt: ConversationMcpResultReceipt;
  };
};

type MutableTurn = {
  id: string;
  status: ConversationTurnStatus;
  messages: MutableMessage[];
  activities: MutableConversationActivity[];
  contextCompactions?: MutableContextCompactionActivity[];
  workspaceRead?: MutableWorkspaceReadActivity;
  workspaceList?: MutableWorkspaceListActivity;
  workspaceSearch?: MutableWorkspaceSearchActivity;
  fileChange?: MutableFileChangeActivity;
  pendingCommandCall?: MutableCommandCall;
  commandApproval?: MutableCommandApprovalActivity;
  pendingMcpCall?: MutableMcpCall;
  mcpActivities?: MutableMcpActivity[];
  orchestration?: MutableOrchestrationActivity;
  error?: ConversationTurnError;
};

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

export class ConversationController {
  private readonly getRpc: ConversationControllerOptions['getRpc'];
  private readonly onProtocolFailure: ConversationControllerOptions['onProtocolFailure'];
  private readonly getActionBlocked: () => boolean;
  private readonly listeners = new Set<ConversationStateListener>();
  private revision = 0;
  private phase: ConversationStateSnapshot['phase'] = 'unavailable';
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private turns: MutableTurn[] = [];
  private notice: ConversationStateSnapshot['notice'];
  private bufferedLifecycle: ConversationLifecycle[] = [];
  private awaitingTurnResponse = false;
  private actionAbortController: AbortController | null = null;
  private searchAbortController: AbortController | null = null;
  private selectionAbortController: AbortController | null = null;
  private mutationAbortController: AbortController | null = null;
  private searchGeneration = 0;
  private selectionGeneration = 0;
  private readonly navigator: MutableThreadNavigator = createThreadNavigator();

  constructor(options: ConversationControllerOptions) {
    this.getRpc = options.getRpc;
    this.onProtocolFailure = options.onProtocolFailure;
    this.getActionBlocked = options.getActionBlocked ?? (() => false);
  }

  getSnapshot = (): ConversationStateSnapshot => this.createSnapshot();

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAgentApprovalTasks = (waitingTaskIds: ReadonlySet<string>): void => {
    let changed = false;
    for (const turn of this.turns) {
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

  loadThreadIndex = async (): Promise<boolean> => {
    return this.restoreForConnection();
  };

  restoreForConnection = async (
    preferredThreadId?: string,
  ): Promise<boolean> => {
    const rpc = this.getRpc();
    if (!rpc || this.phase !== 'unavailable') {
      return false;
    }

    const abortController = new AbortController();
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
      this.navigator.activeTruncated = listed
        ? listed.nextCursor !== null
        : false;
      this.navigator.status = 'ready';
      if (!preferredThreadId) {
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
      if (error instanceof RpcResponseError) {
        this.navigator.status = 'error';
        this.notice = {
          kind: 'requestFailed',
          summary: 'The durable conversation could not be restored safely.',
        };
        this.publish();
        return false;
      }
      this.onProtocolFailure();
      return false;
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
    const alreadyUnavailable = this.phase === 'unavailable';
    this.phase = 'unavailable';
    if (showConnectionLost) {
      const alreadyReported = this.notice?.kind === 'connectionLost';
      this.notice = {
        kind: 'connectionLost',
        summary: 'The local Agent connection is unavailable.',
      };
      if (!alreadyUnavailable || !alreadyReported) {
        this.publish();
      }
      return;
    }
    const hadNotice = this.notice !== undefined;
    this.notice = undefined;
    if (!alreadyUnavailable || hadNotice) {
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
    if (
      this.phase === 'starting' ||
      this.phase === 'inProgress' ||
      this.phase === 'stopping'
    ) {
      return rejected('turnActive');
    }
    const rpc = this.getRpc();
    if (!rpc || this.phase === 'unavailable') {
      return rejected('unavailable');
    }
    if (threadId === this.threadId && !this.navigator.pendingThreadId) {
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
      if (error instanceof RpcResponseError) {
        this.navigator.selectionNotice =
          'That Thread could not be restored safely.';
        this.publish();
        return rejected('unavailable');
      }
      this.onProtocolFailure();
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
      recordActiveThread(this.navigator, recovered.threadId);
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
      this.phase === 'starting' ||
      this.phase === 'inProgress' ||
      this.phase === 'stopping' ||
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
      recordActiveThread(this.navigator, threadId);
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
    if (!isValidConversationInput(input)) {
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

    try {
      if (!this.threadId) {
        const response = await rpc.startThread(
          this.actionAbortController.signal,
        );
        this.threadId = response.thread.id;
        recordActiveThread(this.navigator, response.thread.id);
        this.drainBufferedThreadLifecycle();
      }

      this.awaitingTurnResponse = true;
      const response = await rpc.startTurn(
        this.threadId,
        input,
        this.actionAbortController.signal,
      );
      const turn: MutableTurn = {
        id: response.turn.id,
        status: 'inProgress',
        messages: [],
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

  stopTurn = async (): Promise<ConversationActionResult> => {
    if (this.phase !== 'inProgress' || !this.threadId || !this.activeTurnId) {
      return rejected(
        this.phase === 'unavailable' ? 'unavailable' : 'noActiveTurn',
      );
    }
    const rpc = this.getRpc();
    if (!rpc) {
      return rejected('unavailable');
    }

    const turnId = this.activeTurnId;
    this.phase = 'stopping';
    this.publish();
    try {
      await rpc.interruptTurn(this.threadId, turnId);
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
        if (this.activeTurnId === turnId) {
          this.phase = 'inProgress';
        }
        this.publish();
      }
      return rejected('unavailable');
    }
  };

  handleNotification = (
    message: Extract<ServerMessage, { kind: 'notification' }>,
  ): void => {
    let lifecycle: ConversationLifecycle | null;
    try {
      lifecycle = parseConversationLifecycle(message);
      if (!lifecycle) {
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

  private applyLifecycle = (lifecycle: ConversationLifecycle): void => {
    switch (lifecycle.type) {
      case 'threadStarted':
        this.requireThread(lifecycle.params.thread.id);
        return;
      case 'turnStarted': {
        this.requireThread(lifecycle.params.threadId);
        this.requireActiveTurn(lifecycle.params.turn.id);
        return;
      }
      case 'itemStarted': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        if (this.hasItemId(turn, lifecycle.params.item.id)) {
          throw new Error('Duplicate conversation Item ID.');
        }
        if (
          lifecycle.params.item.type === 'userMessage' ||
          lifecycle.params.item.type === 'agentMessage'
        ) {
          turn.messages.push({
            id: lifecycle.params.item.id,
            role:
              lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent',
            text: lifecycle.params.item.text,
            status: 'inProgress',
          });
        } else if (lifecycle.params.item.type === 'agentCommentary') {
          turn.activities.push({
            type: 'commentary',
            activity: {
              id: lifecycle.params.item.id,
              text: lifecycle.params.item.text,
              status: 'inProgress',
            },
          });
        } else if (lifecycle.params.item.type === 'agentTask') {
          const item = lifecycle.params.item;
          if (
            turn.orchestration &&
            turn.orchestration.id !== item.orchestrationId
          ) {
            throw new Error('A Turn cannot contain multiple orchestrations.');
          }
          turn.orchestration ??= {
            id: item.orchestrationId,
            tasks: [],
          };
          if (
            turn.orchestration.tasks.some(
              (task) =>
                task.taskId === item.taskId ||
                task.clientTaskKey === item.clientTaskKey,
            )
          ) {
            throw new Error('Duplicate agent task.');
          }
          turn.orchestration.tasks.push({
            id: item.id,
            taskId: item.taskId,
            clientTaskKey: item.clientTaskKey,
            childThreadId: item.childThreadId,
            title: item.title,
            role: item.role,
            access: item.access,
            dependsOn: [...item.dependsOn],
            taskMarkdown: item.taskMarkdown,
            status: item.dependsOn.length === 0 ? 'running' : 'queued',
            amendments: [],
          });
          if (
            !turn.activities.some((entry) => entry.type === 'orchestration')
          ) {
            turn.activities.push({
              type: 'orchestration',
              activity: turn.orchestration,
            });
          }
        } else if (lifecycle.params.item.type === 'agentTaskAmendment') {
          const task = this.requireAgentTask(
            turn,
            lifecycle.params.item.orchestrationId,
            lifecycle.params.item.taskId,
          );
          task.amendments.push({
            id: lifecycle.params.item.id,
            markdown: lifecycle.params.item.amendmentMarkdown,
          });
        } else if (lifecycle.params.item.type === 'agentTaskResult') {
          const task = this.requireAgentTask(
            turn,
            lifecycle.params.item.orchestrationId,
            lifecycle.params.item.taskId,
          );
          if (task.result) {
            throw new Error('Duplicate agent task result.');
          }
          task.status = lifecycle.params.item.status;
          task.result = {
            id: lifecycle.params.item.id,
            summaryMarkdown: lifecycle.params.item.summaryMarkdown,
            durationMs: lifecycle.params.item.durationMs,
          };
          this.activateReadyAgentTasks(turn);
        } else if (lifecycle.params.item.type === 'contextCompaction') {
          const item = lifecycle.params.item;
          turn.contextCompactions ??= [];
          if (
            item.outcome ||
            turn.contextCompactions.some(
              (activity) => activity.ordinal === item.ordinal,
            )
          ) {
            throw new Error('Invalid started context compaction.');
          }
          const activity: MutableContextCompactionActivity = {
            id: item.id,
            strategy: item.strategy,
            ordinal: item.ordinal,
            preContextBytes: item.preContextBytes,
            sourceMessages: item.sourceMessages,
            sourceBytes: item.sourceBytes,
            sourceSha256: item.sourceSha256,
            status: 'inProgress',
          };
          turn.contextCompactions.push(activity);
          turn.activities.push({ type: 'contextCompaction', activity });
        } else if (lifecycle.params.item.type === 'workspaceReadCall') {
          const callId = lifecycle.params.item.callId;
          if (
            turn.activities.some(
              (entry) =>
                entry.type === 'workspaceRead' &&
                entry.activity.callId === callId,
            )
          ) {
            throw new Error('Duplicate workspace/read call.');
          }
          const activity: MutableWorkspaceReadActivity = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
          turn.workspaceRead = activity;
          turn.activities.push({ type: 'workspaceRead', activity });
        } else if (lifecycle.params.item.type === 'workspaceReadResult') {
          const workspaceRead = this.requireWorkspaceRead(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceRead.callStatus !== 'completed' ||
            workspaceRead.result
          ) {
            throw new Error('Workspace read result started out of order.');
          }
          workspaceRead.result = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            outcome: { ...lifecycle.params.item.outcome },
          };
        } else if (lifecycle.params.item.type === 'workspaceListCall') {
          const callId = lifecycle.params.item.callId;
          if (
            turn.activities.some(
              (entry) =>
                entry.type === 'workspaceList' &&
                entry.activity.callId === callId,
            )
          ) {
            throw new Error('Duplicate workspace/list call.');
          }
          const activity: MutableWorkspaceListActivity = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
          turn.workspaceList = activity;
          turn.activities.push({ type: 'workspaceList', activity });
        } else if (lifecycle.params.item.type === 'workspaceListResult') {
          const workspaceList = this.requireWorkspaceList(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceList.callStatus !== 'completed' ||
            workspaceList.result
          ) {
            throw new Error('Workspace list result started out of order.');
          }
          workspaceList.result = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            outcome: { ...lifecycle.params.item.outcome },
          };
        } else if (lifecycle.params.item.type === 'workspaceSearchCall') {
          const callId = lifecycle.params.item.callId;
          if (
            turn.activities.some(
              (entry) =>
                entry.type === 'workspaceSearch' &&
                entry.activity.callId === callId,
            )
          ) {
            throw new Error('Duplicate workspace/search call.');
          }
          const activity: MutableWorkspaceSearchActivity = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            query: lifecycle.params.item.query,
            callStatus: 'inProgress',
          };
          turn.workspaceSearch = activity;
          turn.activities.push({ type: 'workspaceSearch', activity });
        } else if (lifecycle.params.item.type === 'workspaceSearchResult') {
          const workspaceSearch = this.requireWorkspaceSearch(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceSearch.callStatus !== 'completed' ||
            workspaceSearch.result
          ) {
            throw new Error('Workspace search result started out of order.');
          }
          workspaceSearch.result = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            outcome: { ...lifecycle.params.item.outcome },
          };
        } else if (lifecycle.params.item.type === 'workspacePatchCall') {
          if (turn.fileChange && !turn.fileChange.result) {
            throw new Error('Duplicate workspace/apply-patch activity.');
          }
          const activity: MutableFileChangeActivity = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
          turn.fileChange = activity;
          turn.activities.push({ type: 'fileChange', activity });
        } else if (lifecycle.params.item.type === 'workspacePatchChange') {
          const activity = this.requireFileChange(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            activity.callStatus !== 'completed' ||
            activity.path !== lifecycle.params.item.path ||
            activity.change ||
            activity.result
          ) {
            throw new Error('FileChange proposal started out of order.');
          }
          activity.change = toFileChangeProposal(lifecycle.params.item);
        } else if (lifecycle.params.item.type === 'workspacePatchResult') {
          const activity = this.requireFileChange(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            activity.callStatus !== 'completed' ||
            activity.result ||
            !patchResultMatchesChange(
              lifecycle.params.item.outcome,
              activity.change,
            )
          ) {
            throw new Error(
              'Workspace apply-patch result started out of order.',
            );
          }
          activity.result = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            outcome: { ...lifecycle.params.item.outcome },
          };
        } else if (lifecycle.params.item.type === 'mcpCall') {
          if (
            turn.pendingMcpCall ||
            (turn.mcpActivities?.length ?? 0) >= 4 ||
            turn.mcpActivities?.some((activity) => !activity.result)
          ) {
            throw new Error(
              'MCP call started outside the sequential boundary.',
            );
          }
          turn.pendingMcpCall = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            name: lifecycle.params.item.name,
            argumentsBytes: lifecycle.params.item.argumentsBytes,
            argumentsSha256: lifecycle.params.item.argumentsSha256,
            inventorySha256: lifecycle.params.item.inventorySha256,
            argumentSignature: lifecycle.params.item.argumentSignature,
            status: 'inProgress',
          };
        } else if (lifecycle.params.item.type === 'mcpApprovalRequest') {
          const call = turn.pendingMcpCall;
          const server = /^mcp__([a-z][a-z0-9]*(?:-[a-z0-9]+)*)__.+$/u.exec(
            lifecycle.params.item.name,
          )?.[1];
          if (
            !call ||
            call.status !== 'completed' ||
            !server ||
            call.callId !== lifecycle.params.item.callId ||
            call.name !== lifecycle.params.item.name ||
            call.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
            call.argumentsSha256 !== lifecycle.params.item.argumentsSha256 ||
            call.inventorySha256 !== lifecycle.params.item.inventorySha256 ||
            call.argumentSignature !== lifecycle.params.item.argumentSignature
          ) {
            throw new Error('MCP approval request did not match its call.');
          }
          const activity: MutableMcpActivity = {
            callItemId: call.id,
            id: lifecycle.params.item.id,
            callId: call.callId,
            approvalId: lifecycle.params.item.approvalId,
            serverId: server,
            name: call.name,
            argumentsBytes: call.argumentsBytes,
            argumentsSha256: call.argumentsSha256,
            inventorySha256: call.inventorySha256,
            argumentSignature: call.argumentSignature,
            callStatus: call.status,
            requestStatus: 'inProgress',
          };
          turn.mcpActivities ??= [];
          turn.mcpActivities.push(activity);
          turn.activities.push({ type: 'mcp', activity });
          turn.pendingMcpCall = undefined;
        } else if (lifecycle.params.item.type === 'mcpApprovalDecision') {
          const activity = this.requireMcpActivityByApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          if (activity.requestStatus !== 'completed' || activity.decision) {
            throw new Error('MCP approval decision started out of order.');
          }
          activity.decision = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            value: lifecycle.params.item.decision,
          };
        } else if (lifecycle.params.item.type === 'mcpExecutionAttempt') {
          const activity = this.requireMcpActivityByApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          if (
            activity.callId !== lifecycle.params.item.callId ||
            activity.inventorySha256 !==
              lifecycle.params.item.inventorySha256 ||
            activity.decision?.status !== 'completed' ||
            activity.decision.value !== 'approved' ||
            activity.executionAttempt
          ) {
            throw new Error('MCP execution attempt started out of order.');
          }
          activity.executionAttempt = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
          };
        } else if (lifecycle.params.item.type === 'mcpResult') {
          const activity = this.requireMcpActivityByCall(
            turn,
            lifecycle.params.item.callId,
          );
          const approved = activity.decision?.value === 'approved';
          if (
            activity.name !== lifecycle.params.item.name ||
            activity.decision?.status !== 'completed' ||
            activity.result ||
            (approved
              ? activity.executionAttempt?.status !== 'completed'
              : Boolean(activity.executionAttempt))
          ) {
            throw new Error('MCP result started out of order.');
          }
          activity.result = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            receipt: { ...lifecycle.params.item.receipt },
          };
        } else if (lifecycle.params.item.type === 'commandCall') {
          if (turn.pendingCommandCall || turn.pendingMcpCall) {
            throw new Error('Duplicate command approval activity.');
          }
          turn.pendingCommandCall = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            command: lifecycle.params.item.command,
            arguments: [...lifecycle.params.item.arguments],
            status: 'inProgress',
          };
        } else if (lifecycle.params.item.type === 'commandApprovalRequest') {
          const call = turn.pendingCommandCall;
          if (
            !call ||
            call.status !== 'completed' ||
            call.callId !== lifecycle.params.item.callId ||
            call.command !== lifecycle.params.item.command ||
            JSON.stringify(call.arguments) !==
              JSON.stringify(lifecycle.params.item.arguments)
          ) {
            throw new Error('Command approval request did not match its call.');
          }
          const activity: MutableCommandApprovalActivity = {
            callItemId: call.id,
            id: lifecycle.params.item.id,
            callId: call.callId,
            approvalId: lifecycle.params.item.approvalId,
            command: call.command,
            argumentCount: call.arguments.length,
            requestStatus: 'inProgress',
            argumentSignature: JSON.stringify(call.arguments),
          };
          turn.commandApproval = activity;
          turn.activities.push({ type: 'commandApproval', activity });
          turn.pendingCommandCall = undefined;
        } else if (lifecycle.params.item.type === 'commandApprovalDecision') {
          const activity = turn.commandApproval;
          if (!activity) {
            return;
          }
          if (
            activity.requestStatus !== 'completed' ||
            activity.approvalId !== lifecycle.params.item.approvalId ||
            activity.decision
          ) {
            throw new Error('Command approval decision started out of order.');
          }
          activity.decision = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            value: lifecycle.params.item.decision,
          };
        } else if (lifecycle.params.item.type === 'commandExecutionAttempt') {
          if (!turn.commandApproval) {
            const ignoredCall = turn.pendingCommandCall;
            if (
              ignoredCall?.status === 'completed' &&
              ignoredCall.callId === lifecycle.params.item.callId
            ) {
              return;
            }
          }
          const activity = this.requireCommandApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          if (
            activity.callId !== lifecycle.params.item.callId ||
            activity.requestStatus !== 'completed' ||
            activity.decision?.status !== 'completed' ||
            activity.decision.value !== 'approved' ||
            activity.executionAttempt
          ) {
            throw new Error('Command execution attempt started out of order.');
          }
          activity.executionAttempt = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
          };
        } else {
          const activity = turn.commandApproval;
          if (!activity) {
            const ignoredCall = turn.pendingCommandCall;
            if (
              ignoredCall?.status === 'completed' &&
              ignoredCall.callId === lifecycle.params.item.callId
            ) {
              return;
            }
          }
          if (
            activity?.callId === lifecycle.params.item.callId &&
            activity.decision?.status === 'completed' &&
            activity.decision.value !== 'approved' &&
            !activity.executionAttempt
          ) {
            return;
          }
          if (
            !activity ||
            activity.callId !== lifecycle.params.item.callId ||
            activity.decision?.status !== 'completed' ||
            activity.decision.value !== 'approved' ||
            activity.executionAttempt?.status !== 'completed' ||
            activity.executionResult
          ) {
            throw new Error('Command execution result started out of order.');
          }
          activity.executionResult = {
            id: lifecycle.params.item.id,
            status: 'inProgress',
            outcome: { ...lifecycle.params.item.outcome },
          };
        }
        this.publish();
        return;
      }
      case 'agentDelta': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        const message = this.requireMessage(turn, lifecycle.params.itemId);
        if (message.role !== 'agent' || message.status !== 'inProgress') {
          throw new Error('Agent delta did not match an active AgentMessage.');
        }
        message.text += lifecycle.params.delta;
        this.publish();
        return;
      }
      case 'itemCompleted': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turnId,
        );
        if (
          lifecycle.params.item.type === 'userMessage' ||
          lifecycle.params.item.type === 'agentMessage'
        ) {
          const message = this.requireMessage(turn, lifecycle.params.item.id);
          const role =
            lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent';
          if (message.role !== role || message.status !== 'inProgress') {
            throw new Error('Completed Item did not match its started Item.');
          }
          message.text = lifecycle.params.item.text;
          message.status = 'completed';
        } else if (lifecycle.params.item.type === 'agentCommentary') {
          const commentary = turn.activities.find(
            (
              entry,
            ): entry is Extract<
              MutableConversationActivity,
              { type: 'commentary' }
            > =>
              entry.type === 'commentary' &&
              entry.activity.id === lifecycle.params.item.id,
          );
          if (!commentary || commentary.activity.status !== 'inProgress') {
            throw new Error(
              'Completed Commentary did not match its started Item.',
            );
          }
          commentary.activity.text = lifecycle.params.item.text;
          commentary.activity.status = 'completed';
        } else if (lifecycle.params.item.type === 'contextCompaction') {
          const activity = turn.contextCompactions?.find(
            (candidate) => candidate.id === lifecycle.params.item.id,
          );
          if (
            !activity ||
            activity.status !== 'inProgress' ||
            !lifecycle.params.item.outcome ||
            activity.ordinal !== lifecycle.params.item.ordinal ||
            activity.preContextBytes !==
              lifecycle.params.item.preContextBytes ||
            activity.sourceMessages !== lifecycle.params.item.sourceMessages ||
            activity.sourceBytes !== lifecycle.params.item.sourceBytes ||
            activity.sourceSha256 !== lifecycle.params.item.sourceSha256
          ) {
            throw new Error(
              'Completed context compaction did not match its started Item.',
            );
          }
          activity.status = 'completed';
          activity.outcome = lifecycle.params.item.outcome;
        } else if (lifecycle.params.item.type === 'workspaceReadCall') {
          const workspaceRead = this.requireWorkspaceRead(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceRead.id !== lifecycle.params.item.id ||
            workspaceRead.path !== lifecycle.params.item.path ||
            workspaceRead.callStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed workspace/read call did not match its started Item.',
            );
          }
          workspaceRead.callStatus = 'completed';
        } else if (lifecycle.params.item.type === 'workspaceReadResult') {
          const workspaceRead = this.requireWorkspaceRead(
            turn,
            lifecycle.params.item.callId,
          );
          const result = workspaceRead.result;
          if (
            !result ||
            result.id !== lifecycle.params.item.id ||
            result.status !== 'inProgress' ||
            !outcomesEqual(result.outcome, lifecycle.params.item.outcome)
          ) {
            throw new Error(
              'Completed workspace/read result did not match its started Item.',
            );
          }
          result.status = 'completed';
        } else if (lifecycle.params.item.type === 'workspaceListCall') {
          const workspaceList = this.requireWorkspaceList(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceList.id !== lifecycle.params.item.id ||
            workspaceList.path !== lifecycle.params.item.path ||
            workspaceList.callStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed workspace/list call did not match its started Item.',
            );
          }
          workspaceList.callStatus = 'completed';
        } else if (lifecycle.params.item.type === 'workspaceListResult') {
          const workspaceList = this.requireWorkspaceList(
            turn,
            lifecycle.params.item.callId,
          );
          const result = workspaceList.result;
          if (
            !result ||
            result.id !== lifecycle.params.item.id ||
            result.status !== 'inProgress' ||
            !listOutcomesEqual(result.outcome, lifecycle.params.item.outcome)
          ) {
            throw new Error(
              'Completed workspace/list result did not match its started Item.',
            );
          }
          result.status = 'completed';
        } else if (lifecycle.params.item.type === 'workspaceSearchCall') {
          const workspaceSearch = this.requireWorkspaceSearch(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            workspaceSearch.id !== lifecycle.params.item.id ||
            workspaceSearch.path !== lifecycle.params.item.path ||
            workspaceSearch.query !== lifecycle.params.item.query ||
            workspaceSearch.callStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed workspace/search call did not match its started Item.',
            );
          }
          workspaceSearch.callStatus = 'completed';
        } else if (lifecycle.params.item.type === 'workspaceSearchResult') {
          const workspaceSearch = this.requireWorkspaceSearch(
            turn,
            lifecycle.params.item.callId,
          );
          const result = workspaceSearch.result;
          if (
            !result ||
            result.id !== lifecycle.params.item.id ||
            result.status !== 'inProgress' ||
            !searchOutcomesEqual(result.outcome, lifecycle.params.item.outcome)
          ) {
            throw new Error(
              'Completed workspace/search result did not match its started Item.',
            );
          }
          result.status = 'completed';
        } else if (lifecycle.params.item.type === 'workspacePatchCall') {
          const activity = this.requireFileChange(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            activity.id !== lifecycle.params.item.id ||
            activity.path !== lifecycle.params.item.path ||
            activity.callStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed workspace/apply-patch call did not match its started Item.',
            );
          }
          activity.callStatus = 'completed';
        } else if (lifecycle.params.item.type === 'workspacePatchChange') {
          const activity = this.requireFileChange(
            turn,
            lifecycle.params.item.callId,
          );
          if (
            !activity.change ||
            activity.change.status !== 'inProgress' ||
            !fileChangeProposalsEqual(
              activity.change,
              toFileChangeProposal(lifecycle.params.item),
            )
          ) {
            throw new Error(
              'Completed FileChange did not match its started Item.',
            );
          }
          activity.change = {
            ...activity.change,
            status: 'completed',
          };
        } else if (lifecycle.params.item.type === 'workspacePatchResult') {
          const activity = this.requireFileChange(
            turn,
            lifecycle.params.item.callId,
          );
          const result = activity.result;
          if (
            !result ||
            result.id !== lifecycle.params.item.id ||
            result.status !== 'inProgress' ||
            !fileChangeResultsEqual(
              result.outcome,
              lifecycle.params.item.outcome,
            )
          ) {
            throw new Error(
              'Completed workspace/apply-patch result did not match its started Item.',
            );
          }
          result.status = 'completed';
        } else if (lifecycle.params.item.type === 'mcpCall') {
          const call = turn.pendingMcpCall;
          if (
            !call ||
            call.id !== lifecycle.params.item.id ||
            call.callId !== lifecycle.params.item.callId ||
            call.name !== lifecycle.params.item.name ||
            call.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
            call.argumentsSha256 !== lifecycle.params.item.argumentsSha256 ||
            call.inventorySha256 !== lifecycle.params.item.inventorySha256 ||
            call.argumentSignature !==
              lifecycle.params.item.argumentSignature ||
            call.status !== 'inProgress'
          ) {
            throw new Error(
              'Completed MCP call did not match its started Item.',
            );
          }
          call.status = 'completed';
        } else if (lifecycle.params.item.type === 'mcpApprovalRequest') {
          const activity = this.requireMcpActivityByApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          if (
            activity.id !== lifecycle.params.item.id ||
            activity.callId !== lifecycle.params.item.callId ||
            activity.name !== lifecycle.params.item.name ||
            activity.argumentsBytes !== lifecycle.params.item.argumentsBytes ||
            activity.argumentsSha256 !==
              lifecycle.params.item.argumentsSha256 ||
            activity.inventorySha256 !==
              lifecycle.params.item.inventorySha256 ||
            activity.argumentSignature !==
              lifecycle.params.item.argumentSignature ||
            activity.requestStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed MCP approval request did not match its started Item.',
            );
          }
          activity.requestStatus = 'completed';
        } else if (lifecycle.params.item.type === 'mcpApprovalDecision') {
          const activity = this.requireMcpActivityByApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          const decision = activity.decision;
          if (
            !decision ||
            decision.id !== lifecycle.params.item.id ||
            decision.status !== 'inProgress' ||
            decision.value !== lifecycle.params.item.decision
          ) {
            throw new Error(
              'Completed MCP approval decision did not match its started Item.',
            );
          }
          decision.status = 'completed';
        } else if (lifecycle.params.item.type === 'mcpExecutionAttempt') {
          const activity = this.requireMcpActivityByApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          const attempt = activity.executionAttempt;
          if (
            activity.callId !== lifecycle.params.item.callId ||
            activity.inventorySha256 !==
              lifecycle.params.item.inventorySha256 ||
            !attempt ||
            attempt.id !== lifecycle.params.item.id ||
            attempt.status !== 'inProgress'
          ) {
            throw new Error(
              'Completed MCP execution attempt did not match its started Item.',
            );
          }
          attempt.status = 'completed';
        } else if (lifecycle.params.item.type === 'mcpResult') {
          const activity = this.requireMcpActivityByCall(
            turn,
            lifecycle.params.item.callId,
          );
          const result = activity.result;
          if (
            activity.name !== lifecycle.params.item.name ||
            !result ||
            result.id !== lifecycle.params.item.id ||
            result.status !== 'inProgress' ||
            JSON.stringify(result.receipt) !==
              JSON.stringify(lifecycle.params.item.receipt)
          ) {
            throw new Error(
              'Completed MCP result did not match its started Item.',
            );
          }
          result.status = 'completed';
        } else if (
          lifecycle.params.item.type === 'agentTask' ||
          lifecycle.params.item.type === 'agentTaskAmendment' ||
          lifecycle.params.item.type === 'agentTaskResult'
        ) {
          // Collaboration records are append-only and become visible on
          // item/started. Completion carries the same immutable payload.
        } else if (lifecycle.params.item.type === 'commandCall') {
          const call = turn.pendingCommandCall;
          if (
            !call ||
            call.id !== lifecycle.params.item.id ||
            call.callId !== lifecycle.params.item.callId ||
            call.command !== lifecycle.params.item.command ||
            JSON.stringify(call.arguments) !==
              JSON.stringify(lifecycle.params.item.arguments) ||
            call.status !== 'inProgress'
          ) {
            throw new Error(
              'Completed command call did not match its started Item.',
            );
          }
          call.status = 'completed';
        } else if (lifecycle.params.item.type === 'commandApprovalRequest') {
          const activity = this.requireCommandApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          if (
            activity.id !== lifecycle.params.item.id ||
            activity.callId !== lifecycle.params.item.callId ||
            activity.command !== lifecycle.params.item.command ||
            activity.argumentSignature !==
              JSON.stringify(lifecycle.params.item.arguments) ||
            activity.requestStatus !== 'inProgress'
          ) {
            throw new Error(
              'Completed command approval request did not match its started Item.',
            );
          }
          activity.requestStatus = 'completed';
        } else if (lifecycle.params.item.type === 'commandApprovalDecision') {
          const activity = turn.commandApproval;
          if (!activity) {
            return;
          }
          const decision = activity.decision;
          if (
            activity.approvalId !== lifecycle.params.item.approvalId ||
            !decision ||
            decision.id !== lifecycle.params.item.id ||
            decision.status !== 'inProgress' ||
            decision.value !== lifecycle.params.item.decision
          ) {
            throw new Error(
              'Completed command approval decision did not match its started Item.',
            );
          }
          decision.status = 'completed';
        } else if (lifecycle.params.item.type === 'commandExecutionAttempt') {
          if (!turn.commandApproval) {
            const ignoredCall = turn.pendingCommandCall;
            if (
              ignoredCall?.status === 'completed' &&
              ignoredCall.callId === lifecycle.params.item.callId
            ) {
              return;
            }
          }
          const activity = this.requireCommandApproval(
            turn,
            lifecycle.params.item.approvalId,
          );
          const executionAttempt = activity.executionAttempt;
          if (
            activity.callId !== lifecycle.params.item.callId ||
            !executionAttempt ||
            executionAttempt.id !== lifecycle.params.item.id ||
            executionAttempt.status !== 'inProgress'
          ) {
            throw new Error(
              'Completed command execution attempt did not match its started Item.',
            );
          }
          executionAttempt.status = 'completed';
        } else {
          const activity = turn.commandApproval;
          if (!activity) {
            const ignoredCall = turn.pendingCommandCall;
            if (
              ignoredCall?.status === 'completed' &&
              ignoredCall.callId === lifecycle.params.item.callId
            ) {
              return;
            }
          }
          if (
            activity?.callId === lifecycle.params.item.callId &&
            activity.decision?.status === 'completed' &&
            activity.decision.value !== 'approved' &&
            !activity.executionAttempt
          ) {
            return;
          }
          const executionResult = activity?.executionResult;
          if (
            !activity ||
            activity.callId !== lifecycle.params.item.callId ||
            !executionResult ||
            executionResult.id !== lifecycle.params.item.id ||
            executionResult.status !== 'inProgress' ||
            !commandExecutionOutcomesEqual(
              executionResult.outcome,
              lifecycle.params.item.outcome,
            )
          ) {
            throw new Error(
              'Completed command execution result did not match its started Item.',
            );
          }
          executionResult.status = 'completed';
        }
        this.publish();
        return;
      }
      case 'turnCompleted': {
        const turn = this.requireCorrelatedTurn(
          lifecycle.params.threadId,
          lifecycle.params.turn.id,
        );
        if (turn.messages.some((message) => message.status !== 'completed')) {
          throw new Error('Turn completed before all text Items completed.');
        }
        if (
          turn.contextCompactions?.some(
            (activity) => activity.status !== 'completed' || !activity.outcome,
          )
        ) {
          throw new Error(
            'Turn completed before context compaction activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceRead' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/read activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceList' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/list activity completed.',
          );
        }
        if (
          turn.activities.some(
            (entry) =>
              entry.type === 'workspaceSearch' &&
              (entry.activity.callStatus !== 'completed' ||
                (lifecycle.params.turn.status !== 'interrupted' &&
                  entry.activity.result?.status !== 'completed') ||
                (entry.activity.result &&
                  entry.activity.result.status !== 'completed')),
          )
        ) {
          throw new Error(
            'Turn completed before workspace/search activity completed.',
          );
        }
        if (
          turn.fileChange &&
          (turn.fileChange.callStatus !== 'completed' ||
            (turn.fileChange.change &&
              turn.fileChange.change.status !== 'completed') ||
            (turn.fileChange.result &&
              turn.fileChange.result.status !== 'completed') ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.fileChange.result?.status !== 'completed'))
        ) {
          throw new Error(
            'Turn completed before workspace/apply-patch activity completed.',
          );
        }
        if (
          turn.commandApproval &&
          (turn.commandApproval.requestStatus !== 'completed' ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.commandApproval.decision?.status !== 'completed') ||
            (turn.commandApproval.decision &&
              turn.commandApproval.decision.status !== 'completed') ||
            (turn.commandApproval.executionAttempt &&
              turn.commandApproval.executionAttempt.status !== 'completed') ||
            (turn.commandApproval.executionResult &&
              turn.commandApproval.executionResult.status !== 'completed') ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.commandApproval.executionAttempt &&
              turn.commandApproval.executionResult?.status !== 'completed'))
        ) {
          throw new Error(
            'Turn completed before command approval activity completed.',
          );
        }
        if (
          turn.pendingMcpCall ||
          turn.mcpActivities?.some(
            (activity) =>
              activity.callStatus !== 'completed' ||
              activity.requestStatus !== 'completed' ||
              (activity.decision && activity.decision.status !== 'completed') ||
              (activity.executionAttempt &&
                activity.executionAttempt.status !== 'completed') ||
              (activity.result && activity.result.status !== 'completed') ||
              (lifecycle.params.turn.status !== 'interrupted' &&
                (!activity.decision || !activity.result)),
          )
        ) {
          throw new Error('Turn completed before MCP activity completed.');
        }
        turn.status = lifecycle.params.turn.status;
        turn.error = lifecycle.params.turn.error;
        this.activeTurnId = null;
        this.phase = 'ready';
        this.actionAbortController = null;
        this.publish();
      }
    }
  };

  private requireThread = (threadId: string): void => {
    if (!this.threadId || this.threadId !== threadId) {
      throw new Error('Conversation lifecycle referenced another Thread.');
    }
  };

  private requireActiveTurn = (turnId: string): MutableTurn => {
    if (!this.activeTurnId || this.activeTurnId !== turnId) {
      throw new Error('Conversation lifecycle referenced another Turn.');
    }
    const turn = this.turns.find((candidate) => candidate.id === turnId);
    if (!turn || turn.status !== 'inProgress') {
      throw new Error('Conversation active Turn is unavailable.');
    }
    return turn;
  };

  private requireCorrelatedTurn = (
    threadId: string,
    turnId: string,
  ): MutableTurn => {
    this.requireThread(threadId);
    return this.requireActiveTurn(turnId);
  };

  private requireMessage = (
    turn: MutableTurn,
    itemId: string,
  ): MutableMessage => {
    const message = turn.messages.find((candidate) => candidate.id === itemId);
    if (!message) {
      throw new Error('Conversation lifecycle referenced another Item.');
    }
    return message;
  };

  private requireWorkspaceRead = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceReadActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceRead' }
      > => entry.type === 'workspaceRead' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace read lifecycle referenced another call.');
    }
    return activity;
  };

  private requireWorkspaceList = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceListActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceList' }
      > => entry.type === 'workspaceList' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace list lifecycle referenced another call.');
    }
    return activity;
  };

  private requireWorkspaceSearch = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceSearchActivity => {
    const activity = turn.activities.find(
      (
        entry,
      ): entry is Extract<
        MutableConversationActivity,
        { type: 'workspaceSearch' }
      > => entry.type === 'workspaceSearch' && entry.activity.callId === callId,
    )?.activity;
    if (!activity) {
      throw new Error('Workspace search lifecycle referenced another call.');
    }
    return activity;
  };

  private requireFileChange = (
    turn: MutableTurn,
    callId: string,
  ): MutableFileChangeActivity => {
    if (!turn.fileChange || turn.fileChange.callId !== callId) {
      throw new Error(
        'Workspace apply-patch lifecycle referenced another call.',
      );
    }
    return turn.fileChange;
  };

  private requireCommandApproval = (
    turn: MutableTurn,
    approvalId: string,
  ): MutableCommandApprovalActivity => {
    if (
      !turn.commandApproval ||
      turn.commandApproval.approvalId !== approvalId
    ) {
      throw new Error('Command approval lifecycle referenced another request.');
    }
    return turn.commandApproval;
  };

  private requireMcpActivityByApproval = (
    turn: MutableTurn,
    approvalId: string,
  ): MutableMcpActivity => {
    const activity = turn.mcpActivities?.find(
      (candidate) => candidate.approvalId === approvalId,
    );
    if (!activity) {
      throw new Error('MCP lifecycle referenced another approval.');
    }
    return activity;
  };

  private requireMcpActivityByCall = (
    turn: MutableTurn,
    callId: string,
  ): MutableMcpActivity => {
    const activity = turn.mcpActivities?.find(
      (candidate) => candidate.callId === callId,
    );
    if (!activity) {
      throw new Error('MCP lifecycle referenced another call.');
    }
    return activity;
  };

  private requireAgentTask = (
    turn: MutableTurn,
    orchestrationId: string,
    taskId: string,
  ): MutableAgentTask => {
    if (turn.orchestration?.id !== orchestrationId) {
      throw new Error('Agent task lifecycle referenced another orchestration.');
    }
    const task = turn.orchestration.tasks.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!task) {
      throw new Error('Agent task lifecycle referenced another task.');
    }
    return task;
  };

  private activateReadyAgentTasks = (turn: MutableTurn): void => {
    if (!turn.orchestration) {
      return;
    }
    const byKey = new Map(
      turn.orchestration.tasks.map((task) => [task.clientTaskKey, task]),
    );
    for (const task of turn.orchestration.tasks) {
      if (task.status !== 'queued') {
        continue;
      }
      const dependencies = task.dependsOn
        .map((dependency) => byKey.get(dependency))
        .filter((dependency): dependency is MutableAgentTask =>
          Boolean(dependency),
        );
      if (
        task.role === 'auditor'
          ? dependencies.every((dependency) =>
              ['completed', 'failed', 'interrupted', 'cancelled'].includes(
                dependency.status,
              ),
            )
          : dependencies.every(
              (dependency) => dependency.status === 'completed',
            )
      ) {
        task.status = 'running';
      }
    }
  };

  private hasItemId = (turn: MutableTurn, itemId: string): boolean =>
    Boolean(
      turn.messages.some((message) => message.id === itemId) ||
      turn.activities.some(
        (entry) => entry.type === 'commentary' && entry.activity.id === itemId,
      ) ||
      turn.activities.some(
        (entry) =>
          (entry.type === 'workspaceRead' ||
            entry.type === 'workspaceList' ||
            entry.type === 'workspaceSearch') &&
          (entry.activity.id === itemId ||
            entry.activity.result?.id === itemId),
      ) ||
      turn.contextCompactions?.some((activity) => activity.id === itemId) ||
      turn.workspaceRead?.id === itemId ||
      turn.workspaceRead?.result?.id === itemId ||
      turn.workspaceList?.id === itemId ||
      turn.workspaceList?.result?.id === itemId ||
      turn.workspaceSearch?.id === itemId ||
      turn.workspaceSearch?.result?.id === itemId ||
      turn.fileChange?.id === itemId ||
      turn.fileChange?.change?.id === itemId ||
      turn.fileChange?.result?.id === itemId ||
      turn.pendingCommandCall?.id === itemId ||
      turn.commandApproval?.callItemId === itemId ||
      turn.commandApproval?.id === itemId ||
      turn.commandApproval?.decision?.id === itemId ||
      turn.commandApproval?.executionAttempt?.id === itemId ||
      turn.commandApproval?.executionResult?.id === itemId ||
      turn.pendingMcpCall?.id === itemId ||
      turn.orchestration?.tasks.some(
        (task) =>
          task.id === itemId ||
          task.amendments.some((amendment) => amendment.id === itemId) ||
          task.result?.id === itemId,
      ) ||
      turn.mcpActivities?.some(
        (activity) =>
          activity.callItemId === itemId ||
          activity.id === itemId ||
          activity.decision?.id === itemId ||
          activity.executionAttempt?.id === itemId ||
          activity.result?.id === itemId,
      ),
    );

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
    if (
      this.phase === 'starting' ||
      this.phase === 'inProgress' ||
      this.phase === 'stopping'
    ) {
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
    this.navigator.activeThreadIds = listed.data.map((thread) => thread.id);
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
    this.threadId = null;
    this.activeTurnId = null;
    this.turns = [];
    this.phase = 'idle';
    this.notice = undefined;
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
    this.threadId = recovered.threadId;
    this.activeTurnId = null;
    this.turns = recovered.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      messages: turn.messages.map((message) => ({ ...message })),
      activities: (turn.activities ?? []).map(toMutableConversationActivity),
      ...(turn.contextCompactions
        ? {
            contextCompactions: turn.contextCompactions.map((activity) => ({
              ...activity,
              ...(activity.outcome ? { outcome: { ...activity.outcome } } : {}),
            })),
          }
        : {}),
      ...(turn.workspaceRead
        ? {
            workspaceRead: {
              ...turn.workspaceRead,
              ...(turn.workspaceRead.result
                ? {
                    result: {
                      ...turn.workspaceRead.result,
                      outcome: { ...turn.workspaceRead.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceList
        ? {
            workspaceList: {
              ...turn.workspaceList,
              ...(turn.workspaceList.result
                ? {
                    result: {
                      ...turn.workspaceList.result,
                      outcome: { ...turn.workspaceList.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceSearch
        ? {
            workspaceSearch: {
              ...turn.workspaceSearch,
              ...(turn.workspaceSearch.result
                ? {
                    result: {
                      ...turn.workspaceSearch.result,
                      outcome: { ...turn.workspaceSearch.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.fileChange
        ? {
            fileChange: cloneFileChangeActivity(turn.fileChange),
          }
        : {}),
      ...(turn.commandApproval
        ? {
            commandApproval: {
              ...turn.commandApproval,
              ...(turn.commandApproval.decision
                ? { decision: { ...turn.commandApproval.decision } }
                : {}),
              ...(turn.commandApproval.executionAttempt
                ? {
                    executionAttempt: {
                      ...turn.commandApproval.executionAttempt,
                    },
                  }
                : {}),
              ...(turn.commandApproval.executionResult
                ? {
                    executionResult: {
                      ...turn.commandApproval.executionResult,
                      outcome: {
                        ...turn.commandApproval.executionResult.outcome,
                      },
                    },
                  }
                : {}),
              argumentSignature: '',
            },
          }
        : {}),
      ...(turn.mcpActivities
        ? {
            mcpActivities: turn.mcpActivities.map(
              (activity): MutableMcpActivity => ({
                ...activity,
                argumentSignature: '',
                ...(activity.decision
                  ? { decision: { ...activity.decision } }
                  : {}),
                ...(activity.executionAttempt
                  ? { executionAttempt: { ...activity.executionAttempt } }
                  : {}),
                ...(activity.result
                  ? {
                      result: {
                        ...activity.result,
                        receipt: { ...activity.result.receipt },
                      },
                    }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
    }));
  };

  private createSnapshot = (): ConversationStateSnapshot => ({
    revision: this.revision,
    phase: this.phase,
    ...(this.threadId ? { threadId: this.threadId } : {}),
    ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    turns: this.turns.map((turn): ConversationTurn => ({
      id: turn.id,
      status: turn.status,
      messages: turn.messages.map((message) => ({ ...message })),
      ...(turn.activities.length > 0
        ? {
            activities: turn.activities.map((activity): ConversationActivity =>
              toConversationActivity(activity),
            ),
          }
        : {}),
      ...(turn.contextCompactions
        ? {
            contextCompactions: turn.contextCompactions.map(
              (activity): ConversationContextCompactionActivity => ({
                ...activity,
                ...(activity.outcome
                  ? { outcome: { ...activity.outcome } }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.workspaceRead
        ? {
            workspaceRead: {
              ...turn.workspaceRead,
              ...(turn.workspaceRead.result
                ? {
                    result: {
                      ...turn.workspaceRead.result,
                      outcome: { ...turn.workspaceRead.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceList
        ? {
            workspaceList: {
              ...turn.workspaceList,
              ...(turn.workspaceList.result
                ? {
                    result: {
                      ...turn.workspaceList.result,
                      outcome: { ...turn.workspaceList.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceSearch
        ? {
            workspaceSearch: {
              ...turn.workspaceSearch,
              ...(turn.workspaceSearch.result
                ? {
                    result: {
                      ...turn.workspaceSearch.result,
                      outcome: { ...turn.workspaceSearch.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.fileChange
        ? {
            fileChange: cloneFileChangeActivity(turn.fileChange),
          }
        : {}),
      ...(turn.commandApproval
        ? {
            commandApproval: {
              callItemId: turn.commandApproval.callItemId,
              id: turn.commandApproval.id,
              callId: turn.commandApproval.callId,
              approvalId: turn.commandApproval.approvalId,
              command: turn.commandApproval.command,
              argumentCount: turn.commandApproval.argumentCount,
              requestStatus: turn.commandApproval.requestStatus,
              ...(turn.commandApproval.decision
                ? { decision: { ...turn.commandApproval.decision } }
                : {}),
              ...(turn.commandApproval.executionAttempt
                ? {
                    executionAttempt: {
                      ...turn.commandApproval.executionAttempt,
                    },
                  }
                : {}),
              ...(turn.commandApproval.executionResult
                ? {
                    executionResult: {
                      ...turn.commandApproval.executionResult,
                      outcome: {
                        ...turn.commandApproval.executionResult.outcome,
                      },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.mcpActivities
        ? {
            mcpActivities: turn.mcpActivities.map(
              (activity): ConversationMcpActivity => ({
                callItemId: activity.callItemId,
                id: activity.id,
                callId: activity.callId,
                approvalId: activity.approvalId,
                serverId: activity.serverId,
                name: activity.name,
                argumentsBytes: activity.argumentsBytes,
                argumentsSha256: activity.argumentsSha256,
                inventorySha256: activity.inventorySha256,
                callStatus: activity.callStatus,
                requestStatus: activity.requestStatus,
                ...(activity.decision
                  ? { decision: { ...activity.decision } }
                  : {}),
                ...(activity.executionAttempt
                  ? {
                      executionAttempt: {
                        ...activity.executionAttempt,
                      },
                    }
                  : {}),
                ...(activity.result
                  ? {
                      result: {
                        ...activity.result,
                        receipt: { ...activity.result.receipt },
                      },
                    }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
    })),
    navigator: snapshotThreadNavigator(this.navigator),
    ...(this.notice ? { notice: { ...this.notice } } : {}),
  });

  private publish = (): void => {
    this.revision += 1;
    const snapshot = this.createSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  };
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const toFileChangeProposal = (
  item: WorkspacePatchChangeItem,
): ConversationFileChangeProposal => ({
  id: item.id,
  status: item.status,
  path: item.path,
  kind: item.kind,
  diff: item.diff,
  beforeSha256: item.beforeSha256,
  afterSha256: item.afterSha256,
  beforeBytes: item.beforeBytes,
  afterBytes: item.afterBytes,
  newlineStyle: item.newlineStyle,
  finalNewline: item.finalNewline,
});

const patchResultMatchesChange = (
  outcome: WorkspacePatchResultItem['outcome'],
  change: ConversationFileChangeProposal | undefined,
): boolean =>
  outcome.type === 'error' ||
  Boolean(
    change?.status === 'completed' &&
    outcome.path === change.path &&
    outcome.beforeSha256 === change.beforeSha256 &&
    outcome.afterSha256 === change.afterSha256 &&
    outcome.beforeBytes === change.beforeBytes &&
    outcome.afterBytes === change.afterBytes,
  );

const fileChangeProposalsEqual = (
  left: ConversationFileChangeProposal,
  right: ConversationFileChangeProposal,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const fileChangeResultsEqual = (
  left: ConversationFileChangeResultOutcome,
  right: WorkspacePatchResultItem['outcome'],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const cloneFileChangeActivity = (
  activity: MutableFileChangeActivity | ConversationFileChangeActivity,
): ConversationFileChangeActivity => ({
  id: activity.id,
  callId: activity.callId,
  path: activity.path,
  callStatus: activity.callStatus,
  ...(activity.change
    ? {
        change: { ...activity.change },
      }
    : {}),
  ...(activity.result
    ? {
        result: {
          ...activity.result,
          outcome: { ...activity.result.outcome },
        },
      }
    : {}),
});

const toConversationActivity = (
  entry: MutableConversationActivity,
): ConversationActivity => {
  switch (entry.type) {
    case 'commentary':
      return {
        type: entry.type,
        activity: { ...entry.activity },
      };
    case 'contextCompaction':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.outcome
            ? { outcome: { ...entry.activity.outcome } }
            : {}),
        },
      };
    case 'workspaceRead':
    case 'workspaceList':
    case 'workspaceSearch':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      } as ConversationActivity;
    case 'fileChange':
      return {
        type: entry.type,
        activity: cloneFileChangeActivity(entry.activity),
      };
    case 'commandApproval': {
      const { argumentSignature, ...activity } = entry.activity;
      void argumentSignature;
      return {
        type: entry.type,
        activity: {
          ...activity,
          ...(activity.decision ? { decision: { ...activity.decision } } : {}),
          ...(activity.executionAttempt
            ? { executionAttempt: { ...activity.executionAttempt } }
            : {}),
          ...(activity.executionResult
            ? {
                executionResult: {
                  ...activity.executionResult,
                  outcome: { ...activity.executionResult.outcome },
                },
              }
            : {}),
        },
      };
    }
    case 'mcp': {
      const { argumentSignature, ...activity } = entry.activity;
      void argumentSignature;
      return {
        type: entry.type,
        activity: {
          ...activity,
          ...(activity.decision ? { decision: { ...activity.decision } } : {}),
          ...(activity.executionAttempt
            ? { executionAttempt: { ...activity.executionAttempt } }
            : {}),
          ...(activity.result
            ? {
                result: {
                  ...activity.result,
                  receipt: { ...activity.result.receipt },
                },
              }
            : {}),
        },
      };
    }
    case 'orchestration':
      return {
        type: entry.type,
        activity: {
          id: entry.activity.id,
          tasks: entry.activity.tasks.map((task) => ({
            ...task,
            dependsOn: [...task.dependsOn],
            amendments: task.amendments.map((amendment) => ({
              ...amendment,
            })),
            ...(task.result ? { result: { ...task.result } } : {}),
          })),
        },
      };
  }
};

const toMutableConversationActivity = (
  entry: ConversationActivity,
): MutableConversationActivity => {
  switch (entry.type) {
    case 'commentary':
      return {
        type: entry.type,
        activity: { ...entry.activity },
      };
    case 'contextCompaction':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.outcome
            ? { outcome: { ...entry.activity.outcome } }
            : {}),
        },
      };
    case 'workspaceRead':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'workspaceList':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'workspaceSearch':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'fileChange':
      return {
        type: entry.type,
        activity: cloneFileChangeActivity(
          entry.activity,
        ) as MutableFileChangeActivity,
      };
    case 'commandApproval':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          argumentSignature: '',
        },
      };
    case 'mcp':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          argumentSignature: '',
        },
      };
    case 'orchestration':
      return {
        type: entry.type,
        activity: {
          id: entry.activity.id,
          tasks: entry.activity.tasks.map((task) => ({
            ...task,
            dependsOn: [...task.dependsOn],
            amendments: task.amendments.map((amendment) => ({
              ...amendment,
            })),
            ...(task.result ? { result: { ...task.result } } : {}),
          })),
        },
      };
  }
};

const outcomesEqual = (
  left: ConversationWorkspaceReadOutcome,
  right: ConversationWorkspaceReadOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.bytes === right.bytes
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

const listOutcomesEqual = (
  left: ConversationWorkspaceListOutcome,
  right: ConversationWorkspaceListOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.entries === right.entries
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

const searchOutcomesEqual = (
  left: ConversationWorkspaceSearchOutcome,
  right: ConversationWorkspaceSearchOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.matches === right.matches && left.truncated === right.truncated
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

const commandExecutionOutcomesEqual = (
  left: ConversationCommandExecutionResultOutcome,
  right: ConversationCommandExecutionResultOutcome,
): boolean => JSON.stringify(left) === JSON.stringify(right);
