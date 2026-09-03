import { randomUUID } from 'node:crypto';
import {
  isConversationGoalMutation,
  type ConversationActionResult,
  type ConversationStateSnapshot,
} from '../../../../shared/conversation.ts';
import { projectThread } from '../projection/project-thread.ts';
import { createUuidV7 } from '../id.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
} from '../action-result.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'ensureSelectedThread'
  | 'goals'
  | 'runtime'
  | 'publishThreadProjection'
  | 'publish'
  | 'dispatchQueuedMessage'
  | 'applyRuntimeQueue'
  | 'refreshNavigator'
>;

export class ConversationGoalActions {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  mutateGoal = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationGoalMutation(input)) return rejected('invalidInput');
    if (!this.state.workspaceId || !this.state.available) return rejected('unavailable');
    const workspaceId = this.state.workspaceId;
    try {
      let threadId = input.action === 'create' ? this.state.threadId : input.threadId;
      if (input.action === 'create') {
        threadId = threadId ?? (await this.context.ensureSelectedThread(workspaceId));
      }
      if (!threadId || this.state.threadRecords.get(threadId)?.workspaceId !== workspaceId) {
        return rejected('unknownThread');
      }
      const goalId = input.action === 'create' ? createUuidV7() : input.goalId;
      const previousGoal = this.context.goals.get(threadId);
      let goal = await this.context.goals.mutate(
        workspaceId,
        threadId,
        goalId,
        input,
      );
      if (
        input.action === 'edit' &&
        input.modelProfileId &&
        previousGoal?.pauseReason === 'modelUnavailable' &&
        goal?.status === 'paused'
      ) {
        goal = await this.context.goals.mutate(workspaceId, threadId, goal.id, {
          action: 'resume',
          threadId,
          goalId: goal.id,
          expectedRevision: goal.revision,
        });
      }
      const activeGoalTurn = this.state.activeTurnsByThread.get(threadId);
      if (
        activeGoalTurn?.goalId === goalId &&
        (input.action === 'pause' || input.action === 'clear')
      ) {
        this.context.runtime.send({
          type: 'turn.cancel',
          requestId: randomUUID(),
          workspaceId,
          threadId,
          turnId: activeGoalTurn.turnId,
          source: 'stopButton',
        });
      }
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
      if (goal?.status === 'active') {
        const queue = this.state.runtimeQueuesByThread.get(threadId);
        if (queue?.paused && queue.messages.length > 0) {
          await this.context.goals.pause(workspaceId, threadId, 'queueBlocked');
        } else if (
          queue?.messages.length &&
          !this.state.activeTurnsByThread.has(threadId)
        ) {
          await this.context.dispatchQueuedMessage(threadId);
        } else {
          this.context.goals.schedule(
            threadId,
            'queueDrained',
            this.state.activeTurnsByThread.has(threadId),
          );
        }
      }
      return accepted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const reason of [
        'goalConflict',
        'goalRevisionMismatch',
        'goalNotFound',
        'modelUnavailable',
      ] as const) {
        if (message.includes(reason)) return rejected(reason);
      }
      return rejected('unavailable');
    }
  };

  reconcileGoalAfterRuntimeRestart = async (
    threadId: string,
  ): Promise<void> => {
    const thread = this.state.threadRecords.get(threadId);
    if (!thread || this.state.activeTurnsByThread.has(threadId)) return;
    try {
      const loaded = await this.context.runtime.request(
        {
          type: 'thread.load',
          requestId: randomUUID(),
          workspaceId: thread.workspaceId,
          threadId,
        },
        'thread.loaded',
      );
      this.context.goals.apply(threadId, loaded.snapshot.goal);
      this.state.turnsByThread.set(threadId, [...projectThread(loaded.snapshot)]);
      this.context.applyRuntimeQueue(threadId, loaded.snapshot.queue);
      let goal = loaded.snapshot.goal;
      if (goal?.status === 'paused' && goal.pauseReason === 'restart') {
        goal = await this.context.goals.mutate(
          thread.workspaceId,
          threadId,
          goal.id,
          {
            action: 'resume',
            threadId,
            goalId: goal.id,
            expectedRevision: goal.revision,
            preserveActivation: true,
          },
        );
      }
      this.state.goalReconciliationThreads.delete(threadId);
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
      if (goal?.status === 'active') {
        this.context.goals.schedule(
          threadId,
          'queueDrained',
          this.state.activeTurnsByThread.has(threadId),
          true,
        );
      }
    } catch {
      // Keep the Goal paused; a later runtime-ready signal can retry safely.
    }
  };

  startGoalTurn = (
    goal: NonNullable<ConversationStateSnapshot['goal']>,
    reconciliation: boolean,
  ): void => {
    const thread = this.state.threadRecords.get(goal.threadId);
    if (!thread || this.state.activeTurnsByThread.has(goal.threadId)) return;
    const turnId = createUuidV7();
    const firstGoalTurn = goal.lifetimeUsage.turns === 0;
    this.state.turnsByThread.set(goal.threadId, [
      ...(this.state.turnsByThread.get(goal.threadId) ?? []),
      {
        id: turnId,
        status: 'inProgress',
        messages: firstGoalTurn
          ? [
              {
                id: `${turnId}:goal-objective`,
                role: 'user',
                text: goal.objective,
                status: 'inProgress',
              },
            ]
          : [],
        origin: 'goal',
      },
    ]);
    this.state.activeTurnsByThread.set(goal.threadId, {
      workspaceId: thread.workspaceId,
      turnId,
      phase: 'starting',
      goalId: goal.id,
    });
    this.state.unreadThreadStatuses.delete(goal.threadId);
    this.context.runtime.send({
      type: 'turn.startGoal',
      requestId: randomUUID(),
      workspaceId: thread.workspaceId,
      threadId: goal.threadId,
      turnId,
      goalId: goal.id,
      expectedRevision: goal.revision,
      modelProfileId: goal.model.profileId,
      modelRequest: goal.model.request,
      ...(firstGoalTurn && thread.title === null
        ? { generateTitle: true }
        : {}),
      ...(reconciliation ? { reconciliation: true } : {}),
      content: [{ type: 'text', text: goal.objective }],
    });
    this.context.refreshNavigator();
    this.context.publishThreadProjection(goal.threadId, true);
    this.context.publish();
  };
}
