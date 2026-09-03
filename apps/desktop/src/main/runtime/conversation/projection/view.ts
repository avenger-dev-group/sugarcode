import {
  type ConversationStateSnapshot,
  type ConversationThreadProjectionSnapshot,
} from '../../../../shared/conversation.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'projections'
  | 'goals'
>;

export class ConversationView {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  getSnapshot = (): ConversationStateSnapshot =>
    this.buildStateSnapshot(this.context.projections.revision);

  buildStateSnapshot = (
    revision: number,
  ): ConversationStateSnapshot => {
    const activeTurn = this.state.threadId
      ? this.state.activeTurnsByThread.get(this.state.threadId)
      : undefined;
    const phase: ConversationStateSnapshot['phase'] = !this.state.available
      ? 'unavailable'
      : this.state.workspaceId &&
          this.state.pendingTurnStartWorkspaces.has(this.state.workspaceId)
        ? 'starting'
        : (activeTurn?.phase ?? (this.state.threadId ? 'ready' : 'idle'));
    return {
      revision,
      ...(this.state.workspaceId ? { workspaceId: this.state.workspaceId } : {}),
      phase,
      ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      ...(activeTurn ? { activeTurnId: activeTurn.turnId } : {}),
      turns: this.state.threadId ? (this.state.turnsByThread.get(this.state.threadId) ?? []) : [],
      ...(this.state.threadId
        ? {
            queue: this.state.queuesByThread.get(this.state.threadId) ?? {
              paused: false,
              messages: [],
            },
          }
        : {}),
      ...(this.state.threadId && this.context.goals.get(this.state.threadId)
        ? { goal: this.context.goals.get(this.state.threadId) }
        : {}),
      navigator: this.state.navigator,
      ...(this.state.notice ? { notice: this.state.notice } : {}),
    };
  };

  getThreadProjection = (
    threadId: unknown,
  ): ConversationThreadProjectionSnapshot | null =>
    typeof threadId === 'string' ? this.buildThreadProjection(threadId) : null;

  buildThreadProjection = (
    threadId: string,
    revision = this.context.projections.threadRevision(threadId),
  ): ConversationThreadProjectionSnapshot | null => {
    const thread = this.state.threadRecords.get(threadId);
    const turns = this.state.turnsByThread.get(threadId);
    if (!thread || !turns) {
      return null;
    }
    const activeTurn = this.state.activeTurnsByThread.get(threadId);
    return {
      revision,
      workspaceId: thread.workspaceId,
      threadId,
      phase: activeTurn?.phase ?? 'ready',
      ...(activeTurn ? { activeTurnId: activeTurn.turnId } : {}),
      turns,
      queue: this.state.queuesByThread.get(threadId) ?? {
        paused: false,
        messages: [],
      },
      ...(this.context.goals.get(threadId) ? { goal: this.context.goals.get(threadId) } : {}),
    };
  };

  publishThreadProjection = (
    threadId: string,
    changed = false,
    source = 'controller',
  ): void => {
    this.context.projections.publishThreadSnapshot(threadId, changed, source);
  };

  publishThreadDelta = (
    threadId: string,
    turnId: string,
    source = 'runtimeEvent',
  ): void => {
    this.context.projections.publishThreadDelta(threadId, turnId, source);
  };

  publish = (source = 'controller'): void => {
    this.context.projections.publishState(source);
  };
}
