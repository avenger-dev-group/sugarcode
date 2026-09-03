import { randomUUID } from 'node:crypto';

import {
  type ConversationGoalMutation,
  type GoalPauseReason,
  type GoalSnapshot,
} from '../../../../shared/conversation.ts';
import type { RuntimeSupervisor } from '../../connection/supervisor.ts';

export type GoalQueueOutcome =
  | 'queueDispatched'
  | 'queueBlocked'
  | 'queueDrained';

type GoalTurnStarter = (
  goal: GoalSnapshot,
  reconciliation: boolean,
) => void;

/** Owns Goal state and scheduling decisions; ConversationController owns Turns. */
export class GoalCoordinator {
  private readonly runtime: RuntimeSupervisor;
  private readonly startTurn: GoalTurnStarter;
  private readonly goals = new Map<string, GoalSnapshot>();
  private readonly scheduledThreads = new Set<string>();

  constructor(runtime: RuntimeSupervisor, startTurn: GoalTurnStarter) {
    this.runtime = runtime;
    this.startTurn = startTurn;
  }

  get = (threadId: string): GoalSnapshot | undefined =>
    this.goals.get(threadId);

  apply = (threadId: string, goal: GoalSnapshot | undefined): void => {
    if (goal) this.goals.set(threadId, goal);
    else this.goals.delete(threadId);
  };

  forget = (threadId: string): void => {
    this.goals.delete(threadId);
    this.scheduledThreads.delete(threadId);
  };

  mutate = async (
    workspaceId: string,
    threadId: string,
    goalId: string,
    mutation: ConversationGoalMutation,
  ): Promise<GoalSnapshot | undefined> => {
    const event = await this.runtime.request(
      {
        type: 'goal.mutate',
        requestId: randomUUID(),
        workspaceId,
        threadId,
        goalId,
        mutation,
      },
      'goal.changed',
    );
    this.apply(threadId, event.goal);
    return event.goal;
  };

  pause = async (
    workspaceId: string,
    threadId: string,
    reason: GoalPauseReason,
  ): Promise<GoalSnapshot | undefined> => {
    const goal = this.goals.get(threadId);
    if (!goal || goal.status !== 'active') return goal;
    return this.mutate(workspaceId, threadId, goal.id, {
      action: 'pause',
      threadId,
      goalId: goal.id,
      expectedRevision: goal.revision,
      pauseReason: reason,
    });
  };

  schedule = (
    threadId: string,
    outcome: GoalQueueOutcome,
    turnActive: boolean,
    reconciliation = false,
  ): boolean => {
    const goal = this.goals.get(threadId);
    if (
      outcome !== 'queueDrained' ||
      turnActive ||
      !goal ||
      goal.status !== 'active' ||
      goal.activeTurnId ||
      this.scheduledThreads.has(threadId)
    ) {
      return false;
    }
    this.scheduledThreads.add(threadId);
    try {
      this.startTurn(goal, reconciliation);
      return true;
    } finally {
      this.scheduledThreads.delete(threadId);
    }
  };
}
