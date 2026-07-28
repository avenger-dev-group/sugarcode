import type {
  ConversationActionResult,
  ConversationMessage,
  ConversationStateListener,
  ConversationStateSnapshot,
  ConversationTurn,
  ConversationTurnError,
  ConversationTurnStatus,
} from '@/shared/conversation';
import { isValidConversationInput } from '@/shared/conversation';

import {
  type ConversationLifecycle,
  type ConversationRpc,
  parseConversationLifecycle,
} from './conversation-rpc';
import {
  ConnectionClosedError,
  RpcResponseError,
} from './jsonl-client';
import type { ServerMessage } from './runtime-validation';

const MAX_BUFFERED_LIFECYCLE = 64;

type MutableMessage = {
  id: string;
  role: ConversationMessage['role'];
  text: string;
  status: ConversationMessage['status'];
};

type MutableTurn = {
  id: string;
  status: ConversationTurnStatus;
  messages: MutableMessage[];
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
        if (
          turn.messages.some(
            (message) => message.id === lifecycle.params.item.id,
          )
        ) {
          throw new Error('Duplicate conversation Item ID.');
        }
        turn.messages.push({
          id: lifecycle.params.item.id,
          role:
            lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent',
          text: lifecycle.params.item.text,
          status: 'inProgress',
        });
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
        const message = this.requireMessage(turn, lifecycle.params.item.id);
        const role =
          lifecycle.params.item.type === 'userMessage' ? 'user' : 'agent';
        if (message.role !== role || message.status !== 'inProgress') {
          throw new Error('Completed Item did not match its started Item.');
        }
        message.text = lifecycle.params.item.text;
        message.status = 'completed';
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
