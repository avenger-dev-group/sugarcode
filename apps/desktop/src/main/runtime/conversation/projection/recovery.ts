import { randomUUID } from 'node:crypto';
import type { ConversationProjectionFault } from './publisher.ts';
import { projectThread } from './project-thread.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'runtime'
  | 'publishThreadProjection'
  | 'refreshNavigator'
  | 'publish'
>;

export class ConversationProjectionRecovery {
  private readonly state: ConversationState;
  private readonly context: Context;
  private readonly projectionRecoveries = new Set<string>();

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  handleProjectionFault = (fault: ConversationProjectionFault): void => {
    const diagnostic = JSON.stringify(fault).slice(0, 2_048);
    process.stderr.write(`[SugarCode projection fault] ${diagnostic}\n`);
    if (
      fault.needsRecovery &&
      fault.threadId &&
      !this.state.activeTurnsByThread.has(fault.threadId) &&
      !this.projectionRecoveries.has(fault.threadId)
    ) {
      this.projectionRecoveries.add(fault.threadId);
      void this.recoverThreadProjection(fault.threadId);
    }
  };

  private recoverThreadProjection = async (threadId: string): Promise<void> => {
    try {
      const thread = this.state.threadRecords.get(threadId);
      if (!thread) return;
      const originalTurns = new Set(this.state.turnsByThread.get(threadId) ?? []);
      const event = await this.context.runtime.request(
        {
          type: 'thread.load',
          requestId: randomUUID(),
          workspaceId: thread.workspaceId,
          threadId,
        },
        'thread.loaded',
      );
      if (
        event.workspaceId !== thread.workspaceId ||
        event.snapshot.thread.id !== threadId ||
        event.snapshot.thread.workspaceId !== thread.workspaceId
      ) {
        throw new Error('Projection recovery crossed Thread ownership.');
      }
      // Streaming text is deliberately not durable. Only restore terminal Turns,
      // and never overwrite updates (or a queued Turn) received during the load.
      if (this.state.threadRecords.get(threadId)?.workspaceId !== thread.workspaceId) {
        return;
      }
      const restored = new Map(
        projectThread(event.snapshot).map((turn) => [turn.id, turn]),
      );
      const currentTurns = this.state.turnsByThread.get(threadId) ?? [];
      this.state.turnsByThread.set(threadId, currentTurns.map((turn) => {
        if (turn.status === 'inProgress' || !originalTurns.has(turn)) {
          return turn;
        }
        const replacement = restored.get(turn.id);
        return replacement?.status !== 'inProgress' ? (replacement ?? turn) : turn;
      }));
      this.context.publishThreadProjection(threadId, true, 'projectionRecovery');
      if (this.state.workspaceId === thread.workspaceId) {
        this.context.refreshNavigator();
        this.context.publish('projectionRecovery');
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .replaceAll(/[\r\n]+/gu, ' ')
        .slice(0, 1_024);
      process.stderr.write(
        `[SugarCode projection recovery failed] thread=${threadId} ${message}\n`,
      );
    } finally {
      this.projectionRecoveries.delete(threadId);
    }
  };
}
