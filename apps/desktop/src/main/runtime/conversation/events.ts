import {
  type RuntimeContentPart,
  type RuntimeEvent,
} from '../../../runtime/contracts/protocol.ts';
import {
  knowledgeReferencesFromParts,
  reduceConversationTurn,
  withoutUserInputRequest,
} from './turns/reducer.ts';
import { visibleRuntimeError } from './projection/project-thread.ts';
import { uuidV7TimestampMs } from './id.ts';
import type { ConversationServices } from './services.ts';
import type { ConversationState } from './state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'reconcileGoalAfterRuntimeRestart'
  | 'applyRuntimeQueue'
  | 'publishThreadProjection'
  | 'publish'
  | 'appendSteeredUserMessage'
  | 'refreshNavigator'
  | 'goals'
  | 'powerSave'
  | 'finishQueueAfterTurn'
  | 'publishThreadDelta'
>;

export class ConversationEvents {
  private readonly state: ConversationState;
  private readonly context: Context;
  private readonly outputDeltaTimers = new Map<
    string,
    Readonly<{ timer: NodeJS.Timeout; turnId: string }>
  >();

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  handleRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'runtime.ready') {
      for (const threadId of this.state.goalReconciliationThreads) {
        void this.context.reconcileGoalAfterRuntimeRestart(threadId);
      }
      return;
    }
    if (event.type === 'queue.changed') {
      const thread = this.state.threadRecords.get(event.threadId);
      if (thread?.workspaceId === event.workspaceId) {
        if (this.context.applyRuntimeQueue(event.threadId, event.queue)) {
          this.context.publishThreadProjection(event.threadId, true);
          if (this.state.workspaceId === event.workspaceId) {
            this.context.publish();
          }
        }
      }
      return;
    }
    if (event.type === 'turn.steered') {
      const thread = this.state.threadRecords.get(event.threadId);
      if (thread?.workspaceId === event.workspaceId) {
        const changed = this.context.applyRuntimeQueue(event.threadId, event.queue);
        const appended = this.context.appendSteeredUserMessage(event);
        if (changed || appended) {
          this.context.publishThreadProjection(event.threadId, true);
          if (this.state.workspaceId === event.workspaceId) {
            this.context.publish();
          }
        }
      }
      return;
    }
    if (
      event.type === 'thread.mutated' &&
      (event.operation === 'rename' || event.operation === 'generateTitle') &&
      event.snapshot
    ) {
      const current = this.state.threadRecords.get(event.threadId);
      if (current?.workspaceId === event.workspaceId) {
        this.state.threadRecords.set(event.threadId, event.snapshot.thread);
        if (this.state.workspaceId === event.workspaceId) {
          this.context.refreshNavigator();
          this.context.publish();
        }
      }
      return;
    }
    if (event.type === 'goal.changed') {
      const thread = this.state.threadRecords.get(event.threadId);
      if (thread?.workspaceId !== event.workspaceId) return;
      this.context.goals.apply(event.threadId, event.goal);
      this.context.publishThreadProjection(event.threadId, true);
      if (this.state.workspaceId === event.workspaceId) this.context.publish();
      return;
    }
    if (
      (!event.type.startsWith('turn.') &&
        !event.type.startsWith('agent.') &&
        !event.type.startsWith('approval.') &&
        !event.type.startsWith('operation.')) ||
      !('threadId' in event) ||
      !('turnId' in event)
    ) {
      return;
    }
    const activeTurn = this.state.activeTurnsByThread.get(event.threadId);
    const thread = this.state.threadRecords.get(event.threadId);
    if (
      !('workspaceId' in event) ||
      (activeTurn?.workspaceId ?? thread?.workspaceId) !== event.workspaceId
    ) {
      return;
    }
    const turns = [...(this.state.turnsByThread.get(event.threadId) ?? [])];
    if (event.type === 'turn.revised') {
      const replacedIndex = turns.findIndex(
        (turn) => turn.id === event.replacedTurnId,
      );
      const replacedTurn = turns[replacedIndex];
      const previousUserMessage = replacedTurn?.messages.find(
        (message) => message.role === 'user',
      );
      if (
        replacedIndex < 0 ||
        replacedIndex !== turns.length - 1 ||
        !previousUserMessage
      ) {
        return;
      }
      const text = event.content
        .filter(
          (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
            part.type === 'text',
        )
        .map((part) => part.text)
        .join('\n');
      const knowledgeReferences = knowledgeReferencesFromParts(event.content);
      turns[replacedIndex] = {
        id: event.turnId,
        status: 'inProgress',
        model: event.model,
        messages: [
          {
            id: `${event.turnId}:user`,
            role: 'user',
            text,
            ...(previousUserMessage.attachments?.length
              ? { attachments: previousUserMessage.attachments }
              : {}),
            ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
            status: 'inProgress',
          },
        ],
      };
      this.state.turnsByThread.set(event.threadId, turns);
      this.state.activeTurnsByThread.set(event.threadId, {
        workspaceId: event.workspaceId,
        turnId: event.turnId,
        phase: 'starting',
      });
      this.state.unreadThreadStatuses.delete(event.threadId);
      this.context.refreshNavigator();
      this.context.publishThreadProjection(event.threadId, true);
      this.context.publish();
      return;
    }
    const index = turns.findIndex((turn) => turn.id === event.turnId);
    if (index < 0) {
      return;
    }
    const turn = turns[index];
    switch (event.type) {
      case 'turn.started':
        if (event.goalId) this.context.powerSave?.startTurn(event.turnId);
        turns[index] = { ...turn, model: event.model };
        if (
          this.state.activeTurnsByThread.get(event.threadId)?.turnId === event.turnId
        ) {
          this.state.activeTurnsByThread.set(event.threadId, {
            workspaceId: event.workspaceId,
            turnId: event.turnId,
            phase: 'inProgress',
            ...(event.goalId ? { goalId: event.goalId } : {}),
          });
          this.context.refreshNavigator();
        }
        break;
      case 'turn.completed': {
        this.context.powerSave?.finishTurn(event.turnId);
        const completingActiveTurn = this.state.activeTurnsByThread.get(
          event.threadId,
        );
        if (
          completingActiveTurn?.goalId &&
          event.error?.kind === 'connection' &&
          event.error.message.includes('runtime exited')
        ) {
          this.state.goalReconciliationThreads.add(event.threadId);
        }
        const promotingItemId = this.state.promotingQueueItemsByThread.get(
          event.threadId,
        );
        const promotionFailedBeforeCommit =
          event.status === 'failed' &&
          promotingItemId !== undefined &&
          this.state.runtimeQueuesByThread
            .get(event.threadId)
            ?.messages.some((message) => message.id === promotingItemId);
        if (promotionFailedBeforeCommit) {
          turns.splice(index, 1);
          this.state.promotingQueueItemsByThread.delete(event.threadId);
          if (
            this.state.activeTurnsByThread.get(event.threadId)?.turnId ===
            event.turnId
          ) {
            this.state.activeTurnsByThread.delete(event.threadId);
          }
          this.context.refreshNavigator();
          this.state.notice = {
            kind: 'warning',
            summary: event.error?.message.includes('modelUnavailable')
              ? 'The queued message is paused because its saved model is unavailable.'
              : 'The queued message could not start and remains safely paused.',
          };
          void this.context.finishQueueAfterTurn(event.threadId, 'failed');
          break;
        }
        const messages = turn.messages.map((message) => ({
          ...message,
          status: 'completed' as const,
        }));
        const activities = turn.activities?.map((activity) => {
          if (activity.type === 'commentary' || activity.type === 'reasoning' || activity.type === 'reasoningSummary') {
            return {
              type: activity.type,
              activity: { ...activity.activity, status: 'completed' as const },
            };
          }
          if (
            activity.type === 'orchestration' &&
            event.status !== 'completed'
          ) {
            return {
              type: 'orchestration' as const,
              activity: {
                ...activity.activity,
                tasks: activity.activity.tasks.map((task) =>
                  ['queued', 'running', 'waitingApproval'].includes(task.status)
                    ? { ...task, status: 'interrupted' as const }
                    : task,
                ),
              },
            };
          }
          return activity;
        });
        const completedTurn = withoutUserInputRequest(turn);
        const startedAtMs = uuidV7TimestampMs(event.turnId);
        const durationMs =
          startedAtMs === undefined
            ? undefined
            : Math.max(0, Date.now() - startedAtMs);
        turns[index] = {
          ...completedTurn,
          status: event.status,
          ...(durationMs === undefined ? {} : { durationMs }),
          messages,
          ...(activities ? { activities } : {}),
          ...(event.error
            ? (() => {
                const error = visibleRuntimeError(event.error, event.status);
                return error ? { error } : {};
              })()
            : {}),
        };
        if (
          this.state.activeTurnsByThread.get(event.threadId)?.turnId === event.turnId
        ) {
          this.state.activeTurnsByThread.delete(event.threadId);
        }
        if (event.threadId === this.state.threadId) {
          this.state.unreadThreadStatuses.delete(event.threadId);
        } else {
          this.state.unreadThreadStatuses.set(event.threadId, event.status);
        }
        this.context.refreshNavigator();
        void this.context.finishQueueAfterTurn(event.threadId, event.status);
        break;
      }
      default: {
        const projected = reduceConversationTurn(turn, event);
        if (!projected) return;
        turns[index] = projected;
        break;
      }
    }
    this.state.turnsByThread.set(event.threadId, turns);
    if (
      event.type === 'turn.userInputRequested' ||
      event.type === 'turn.userInputResolved'
    ) {
      this.context.refreshNavigator();
    }
    if (event.type === 'operation.output') {
      this.scheduleOutputDelta(event.threadId, event.turnId);
    } else {
      this.cancelOutputDelta(event.threadId);
      this.context.publishThreadDelta(event.threadId, event.turnId, event.type);
    }
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.userInputRequested' ||
      event.type === 'turn.userInputResolved'
    ) {
      this.context.publish(event.type);
    }
  };

  private scheduleOutputDelta = (threadId: string, turnId: string): void => {
    if (this.outputDeltaTimers.has(threadId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.outputDeltaTimers.delete(threadId);
      this.context.publishThreadDelta(threadId, turnId, 'operation.output');
    }, 50);
    timer.unref();
    this.outputDeltaTimers.set(threadId, { timer, turnId });
  };

  private cancelOutputDelta = (threadId: string): void => {
    const pending = this.outputDeltaTimers.get(threadId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.outputDeltaTimers.delete(threadId);
  };
}
