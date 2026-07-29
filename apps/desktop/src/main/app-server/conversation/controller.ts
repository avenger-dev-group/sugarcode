import type {
  ConversationActionResult,
  ConversationCommandApprovalDecision,
  ConversationCommandExecutionResultOutcome,
  ConversationFileChangeActivity,
  ConversationFileChangeProposal,
  ConversationFileChangeResultOutcome,
  ConversationMessage,
  ConversationStateListener,
  ConversationStateSnapshot,
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
import {
  recoverConversation,
  type RecoveredConversation,
} from './recovery';
import type { ConversationRpc } from './rpc-client';
import {
  createThreadNavigator,
  isKnownThread,
  type MutableThreadNavigator,
  recordActiveThread,
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

type MutableTurn = {
  id: string;
  status: ConversationTurnStatus;
  messages: MutableMessage[];
  workspaceRead?: MutableWorkspaceReadActivity;
  workspaceList?: MutableWorkspaceListActivity;
  workspaceSearch?: MutableWorkspaceSearchActivity;
  fileChange?: MutableFileChangeActivity;
  pendingCommandCall?: MutableCommandCall;
  commandApproval?: MutableCommandApprovalActivity;
  error?: ConversationTurnError;
};

type ConversationControllerOptions = Readonly<{
  getRpc: () => ConversationRpc | null;
  onProtocolFailure: () => void;
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
  private searchGeneration = 0;
  private selectionGeneration = 0;
  private readonly navigator: MutableThreadNavigator =
    createThreadNavigator();

  constructor(options: ConversationControllerOptions) {
    this.getRpc = options.getRpc;
    this.onProtocolFailure = options.onProtocolFailure;
  }

  getSnapshot = (): ConversationStateSnapshot => this.createSnapshot();

  subscribe = (listener: ConversationStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restoreLatestActiveThread = async (): Promise<boolean> => {
    const rpc = this.getRpc();
    if (
      !rpc ||
      this.phase !== 'unavailable' ||
      this.threadId ||
      this.turns.length > 0
    ) {
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
      const threadId = listed?.data[0]?.id ?? fallbackThreadId ?? undefined;
      if (!threadId) {
        return true;
      }
      const snapshot = await rpc.resumeThread(
        threadId,
        abortController.signal,
      );
      const recovered = recoverConversation(threadId, snapshot);
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

  transportClosed = (): void => {
    this.actionAbortController?.abort();
    this.actionAbortController = null;
    this.searchAbortController?.abort();
    this.searchAbortController = null;
    this.selectionAbortController?.abort();
    this.selectionAbortController = null;
    this.searchGeneration += 1;
    this.selectionGeneration += 1;
    this.navigator.status = 'unavailable';
    this.navigator.pendingThreadId = undefined;
    this.awaitingTurnResponse = false;
    this.bufferedLifecycle = [];
    if (this.phase === 'unavailable') {
      return;
    }
    this.phase = 'unavailable';
    this.notice = {
      kind: 'connectionLost',
      summary: 'The local Agent connection is unavailable.',
    };
    this.publish();
  };

  searchThreads = async (
    query: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isValidThreadSearchInput(query)) {
      return rejected('invalidSearch');
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
      const snapshot = await rpc.resumeThread(
        threadId,
        abortController.signal,
      );
      const recovered = recoverConversation(threadId, snapshot);
      if (generation !== this.selectionGeneration) {
        return accepted();
      }
      this.replaceRecoveredConversation(recovered);
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

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isValidConversationInput(input)) {
      return rejected('invalidInput');
    }
    if (
      this.phase === 'starting' ||
      this.phase === 'inProgress' ||
      this.phase === 'stopping' ||
      this.navigator.pendingThreadId
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
    if (
      this.phase !== 'inProgress' ||
      !this.threadId ||
      !this.activeTurnId
    ) {
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
        } else if (lifecycle.params.item.type === 'workspaceReadCall') {
          if (
            turn.workspaceRead ||
            turn.workspaceList ||
            turn.workspaceSearch ||
            turn.fileChange ||
            turn.pendingCommandCall ||
            turn.commandApproval
          ) {
            throw new Error('Duplicate workspace/read activity.');
          }
          turn.workspaceRead = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
        } else if (
          lifecycle.params.item.type === 'workspaceReadResult'
        ) {
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
          if (
            turn.workspaceList ||
            turn.workspaceRead ||
            turn.workspaceSearch ||
            turn.fileChange ||
            turn.pendingCommandCall ||
            turn.commandApproval
          ) {
            throw new Error('Duplicate workspace/list activity.');
          }
          turn.workspaceList = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
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
          if (
            turn.workspaceSearch ||
            turn.workspaceRead ||
            turn.workspaceList ||
            turn.fileChange ||
            turn.pendingCommandCall ||
            turn.commandApproval
          ) {
            throw new Error('Duplicate workspace/search activity.');
          }
          turn.workspaceSearch = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            query: lifecycle.params.item.query,
            callStatus: 'inProgress',
          };
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
          if (
            turn.workspaceRead ||
            turn.workspaceList ||
            turn.workspaceSearch ||
            turn.fileChange ||
            turn.pendingCommandCall ||
            turn.commandApproval
          ) {
            throw new Error('Duplicate workspace/apply-patch activity.');
          }
          turn.fileChange = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
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
        } else if (lifecycle.params.item.type === 'commandCall') {
          if (
            turn.workspaceRead ||
            turn.workspaceList ||
            turn.workspaceSearch ||
            turn.fileChange ||
            turn.pendingCommandCall ||
            turn.commandApproval
          ) {
            throw new Error('Duplicate command approval activity.');
          }
          turn.pendingCommandCall = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            command: lifecycle.params.item.command,
            arguments: [...lifecycle.params.item.arguments],
            status: 'inProgress',
          };
        } else if (
          lifecycle.params.item.type === 'commandApprovalRequest'
        ) {
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
          turn.commandApproval = {
            callItemId: call.id,
            id: lifecycle.params.item.id,
            callId: call.callId,
            approvalId: lifecycle.params.item.approvalId,
            command: call.command,
            argumentCount: call.arguments.length,
            requestStatus: 'inProgress',
            argumentSignature: JSON.stringify(call.arguments),
          };
          turn.pendingCommandCall = undefined;
        } else if (
          lifecycle.params.item.type === 'commandApprovalDecision'
        ) {
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
        } else if (
          lifecycle.params.item.type === 'commandExecutionAttempt'
        ) {
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
        } else if (
          lifecycle.params.item.type === 'workspaceReadResult'
        ) {
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
            !listOutcomesEqual(
              result.outcome,
              lifecycle.params.item.outcome,
            )
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
            !searchOutcomesEqual(
              result.outcome,
              lifecycle.params.item.outcome,
            )
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
            throw new Error('Completed command call did not match its started Item.');
          }
          call.status = 'completed';
        } else if (
          lifecycle.params.item.type === 'commandApprovalRequest'
        ) {
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
            throw new Error('Completed command approval request did not match its started Item.');
          }
          activity.requestStatus = 'completed';
        } else if (
          lifecycle.params.item.type === 'commandApprovalDecision'
        ) {
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
            throw new Error('Completed command approval decision did not match its started Item.');
          }
          decision.status = 'completed';
        } else if (
          lifecycle.params.item.type === 'commandExecutionAttempt'
        ) {
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
          turn.workspaceRead &&
          (turn.workspaceRead.callStatus !== 'completed' ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.workspaceRead.result?.status !== 'completed') ||
            (turn.workspaceRead.result &&
              turn.workspaceRead.result.status !== 'completed'))
        ) {
          throw new Error(
            'Turn completed before workspace/read activity completed.',
          );
        }
        if (
          turn.workspaceList &&
          (turn.workspaceList.callStatus !== 'completed' ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.workspaceList.result?.status !== 'completed') ||
            (turn.workspaceList.result &&
              turn.workspaceList.result.status !== 'completed'))
        ) {
          throw new Error(
            'Turn completed before workspace/list activity completed.',
          );
        }
        if (
          turn.workspaceSearch &&
          (turn.workspaceSearch.callStatus !== 'completed' ||
            (lifecycle.params.turn.status !== 'interrupted' &&
              turn.workspaceSearch.result?.status !== 'completed') ||
            (turn.workspaceSearch.result &&
              turn.workspaceSearch.result.status !== 'completed'))
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
    if (!turn.workspaceRead || turn.workspaceRead.callId !== callId) {
      throw new Error('Workspace read lifecycle referenced another call.');
    }
    return turn.workspaceRead;
  };

  private requireWorkspaceList = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceListActivity => {
    if (!turn.workspaceList || turn.workspaceList.callId !== callId) {
      throw new Error('Workspace list lifecycle referenced another call.');
    }
    return turn.workspaceList;
  };

  private requireWorkspaceSearch = (
    turn: MutableTurn,
    callId: string,
  ): MutableWorkspaceSearchActivity => {
    if (!turn.workspaceSearch || turn.workspaceSearch.callId !== callId) {
      throw new Error('Workspace search lifecycle referenced another call.');
    }
    return turn.workspaceSearch;
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

  private hasItemId = (turn: MutableTurn, itemId: string): boolean =>
    Boolean(
      turn.messages.some((message) => message.id === itemId) ||
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
      turn.commandApproval?.executionResult?.id === itemId,
    );

  private replaceRecoveredConversation = (
    recovered: RecoveredConversation,
  ): void => {
    this.threadId = recovered.threadId;
    this.activeTurnId = null;
    this.turns = recovered.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      messages: turn.messages.map((message) => ({ ...message })),
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
      ...(turn.error ? { error: { ...turn.error } } : {}),
    }));
  };

  private createSnapshot = (): ConversationStateSnapshot => ({
    revision: this.revision,
    phase: this.phase,
    ...(this.threadId ? { threadId: this.threadId } : {}),
    ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    turns: this.turns.map(
      (turn): ConversationTurn => ({
        id: turn.id,
        status: turn.status,
        messages: turn.messages.map((message) => ({ ...message })),
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
        ...(turn.error ? { error: { ...turn.error } } : {}),
      }),
    ),
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
