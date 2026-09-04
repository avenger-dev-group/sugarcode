import type { RuntimeThreadSnapshot } from '../../../../runtime/contracts/protocol.ts';
import type { ConversationServices } from '../services.ts';
import { initialTurnContent } from './content.ts';
import { randomUUID } from 'node:crypto';

type Context = Pick<ConversationServices, 'state' | 'runtime' | 'publish' | 'publishThreadProjection' | 'refreshNavigator' | 'applyRuntimeQueue'>;

/** Registers and runs an independent task without changing foreground selection. */
export class ConversationBackgroundTurns {
  private readonly context: Context;
  constructor(context: Context) { this.context = context; }

  hide = (threadId: string): void => {
    this.hideAll([threadId]);
  };

  hideAll = (threadIds: readonly string[]): void => {
    let changed = false;
    for (const threadId of threadIds) {
      if (this.context.state.scheduledThreadIds.has(threadId)) continue;
      changed = true;
      this.context.state.scheduledThreadIds.add(threadId);
      this.context.state.unreadThreadStatuses.delete(threadId);
    }
    if (!changed) return;
    this.context.refreshNavigator();
    this.context.publish();
  };

  forget = (threadId: string): void => {
    if (!this.context.state.scheduledThreadIds.delete(threadId)) return;
    this.context.refreshNavigator();
    this.context.publish();
  };

  start = (snapshot: RuntimeThreadSnapshot, turnId: string, input: string, modelProfileId?: string): void => {
    const { state } = this.context;
    const { id: threadId, workspaceId } = snapshot.thread;
    if (state.activeTurnsByThread.has(threadId)) throw new Error('此任务已经在运行。');
    state.scheduledThreadIds.add(threadId);
    state.threadRecords.set(threadId, snapshot.thread);
    this.context.applyRuntimeQueue(threadId, snapshot.queue);
    state.turnsByThread.set(threadId, [{
      id: turnId, status: 'inProgress',
      messages: [{ id: `${turnId}:user`, role: 'user', text: input, status: 'inProgress' }],
    }]);
    state.activeTurnsByThread.set(threadId, { workspaceId, turnId, phase: 'starting' });
    this.context.refreshNavigator();
    this.context.publishThreadProjection(threadId, true);
    this.context.publish();
    try {
      this.context.runtime.send({
        type: 'turn.start', requestId: randomUUID(), workspaceId, threadId, turnId,
        ...(modelProfileId ? { modelProfileId } : {}), content: initialTurnContent(input),
      });
    } catch (error) {
      state.activeTurnsByThread.delete(threadId);
      state.turnsByThread.set(threadId, []);
      this.context.refreshNavigator();
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
      throw error;
    }
  };
}
