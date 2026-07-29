import type {
  ConversationActionResult,
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
} from '@/shared/conversation';
import { isValidConversationInput } from '@/shared/conversation';

import {
  type ConversationLifecycle,
  parseConversationLifecycle,
} from './protocol';
import { recoverConversation } from './recovery';
import type { ConversationRpc } from './rpc-client';
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

type MutableTurn = {
  id: string;
  status: ConversationTurnStatus;
  messages: MutableMessage[];
  workspaceRead?: MutableWorkspaceReadActivity;
  workspaceList?: MutableWorkspaceListActivity;
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
      const threadId = await rpc.findLatestActiveThread(
        abortController.signal,
      );
      if (!threadId) {
        return true;
      }
      const snapshot = await rpc.resumeThread(
        threadId,
        abortController.signal,
      );
      const recovered = recoverConversation(threadId, snapshot);
      this.threadId = recovered.threadId;
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
        ...(turn.error ? { error: { ...turn.error } } : {}),
      }));
      return true;
    } catch (error) {
      if (error instanceof ConnectionClosedError || isAbortError(error)) {
        throw error;
      }
      if (error instanceof RpcResponseError) {
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
    this.notice = undefined;
    this.publish();
  };

  transportClosed = (): void => {
    this.actionAbortController?.abort();
    this.actionAbortController = null;
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

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isValidConversationInput(input)) {
      return rejected('invalidInput');
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
          if (turn.workspaceRead || turn.workspaceList) {
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
          if (turn.workspaceList || turn.workspaceRead) {
            throw new Error('Duplicate workspace/list activity.');
          }
          turn.workspaceList = {
            id: lifecycle.params.item.id,
            callId: lifecycle.params.item.callId,
            path: lifecycle.params.item.path,
            callStatus: 'inProgress',
          };
        } else {
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
        } else {
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

  private hasItemId = (turn: MutableTurn, itemId: string): boolean =>
    Boolean(
      turn.messages.some((message) => message.id === itemId) ||
        turn.workspaceRead?.id === itemId ||
        turn.workspaceRead?.result?.id === itemId ||
        turn.workspaceList?.id === itemId ||
        turn.workspaceList?.result?.id === itemId,
    );

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
        ...(turn.error ? { error: { ...turn.error } } : {}),
      }),
    ),
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
