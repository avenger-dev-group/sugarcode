import { randomUUID } from 'node:crypto';
import type { ConversationActionResult } from '../../../../shared/conversation.ts';
import {
  type RuntimeContentPart,
  type RuntimeEvent,
  type RuntimeThreadQueue as NativeThreadQueue,
} from '../../../../runtime/contracts/protocol.ts';
import { knowledgeReferencesFromParts } from '../turns/reducer.ts';
import {
  attachmentFromPart,
  projectThreadQueue,
} from '../projection/project-thread.ts';
import type { GoalQueueOutcome } from '../goals/coordinator.ts';
import { createUuidV7 } from '../id.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'runtime'
  | 'goals'
  | 'publishThreadProjection'
  | 'publish'
  | 'refreshNavigator'
>;

export class ConversationQueueCoordinator {
  private readonly state: ConversationState;
  private readonly context: Context;
  private readonly queueOperationTails = new Map<string, Promise<void>>();

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  applyRuntimeQueue = (
    threadId: string,
    queue: NativeThreadQueue,
  ): boolean => {
    if (this.state.runtimeQueuesByThread.get(threadId) === queue) {
      return false;
    }
    this.state.runtimeQueuesByThread.set(threadId, queue);
    this.state.queuesByThread.set(threadId, projectThreadQueue(queue));
    const promoting = this.state.promotingQueueItemsByThread.get(threadId);
    if (
      promoting &&
      !queue.messages.some((message) => message.id === promoting)
    ) {
      this.state.promotingQueueItemsByThread.delete(threadId);
    }
    return true;
  };

  acquireQueueOperation = async (
    threadId: string,
  ): Promise<() => void> => {
    const previous =
      this.queueOperationTails.get(threadId) ?? Promise.resolve();
    let releaseCurrent = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch((): void => undefined).then(() => current);
    this.queueOperationTails.set(threadId, tail);
    await previous.catch((): void => undefined);
    return () => {
      releaseCurrent();
      if (this.queueOperationTails.get(threadId) === tail) {
        this.queueOperationTails.delete(threadId);
      }
    };
  };

  queueErrorReason = (
    error: unknown,
  ): Exclude<ConversationActionResult['reason'], 'accepted'> => {
    const message = error instanceof Error ? error.message : String(error);
    for (const reason of [
      'queueFull',
      'queueItemNotFound',
      'queueRevisionMismatch',
      'turnMismatch',
      'notSteerable',
      'modelUnavailable',
    ] as const) {
      if (message.includes(reason)) {
        return reason;
      }
    }
    return 'unavailable';
  };

  refreshRuntimeQueue = async (
    threadId: string,
    workspaceId: string,
  ): Promise<void> => {
    try {
      const event = await this.context.runtime.request(
        {
          type: 'thread.load',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'thread.loaded',
      );
      if (
        event.snapshot.thread.id === threadId &&
        event.snapshot.thread.workspaceId === workspaceId
      ) {
        const previousGoal = this.context.goals.get(threadId);
        this.context.goals.apply(threadId, event.snapshot.goal);
        const queueChanged = this.applyRuntimeQueue(
          threadId,
          event.snapshot.queue,
        );
        if (!queueChanged && previousGoal === event.snapshot.goal) return;
        this.context.publishThreadProjection(threadId, true);
        if (this.state.workspaceId === workspaceId) {
          this.context.publish();
        }
      }
    } catch {
      // Keep the local draft; the next durable projection can still reconcile it.
    }
  };

  appendSteeredUserMessage = (
    event: Extract<RuntimeEvent, { type: 'turn.steered' }>,
  ): boolean => {
    const turns = [...(this.state.turnsByThread.get(event.threadId) ?? [])];
    const index = turns.findIndex((turn) => turn.id === event.turnId);
    const turn = turns[index];
    if (turn?.messages.some((message) => message.id === event.itemId)) {
      return false;
    }
    if (!turn) {
      return false;
    }
    const text = event.content
      .filter(
        (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('\n');
    const attachments = event.content.flatMap((part) =>
      part.type === 'asset' ? [attachmentFromPart(part)] : [],
    );
    const knowledgeReferences = knowledgeReferencesFromParts(event.content);
    turns[index] = {
      ...turn,
      messages: [
        ...turn.messages,
        {
          id: event.itemId,
          role: 'user',
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(knowledgeReferences.length > 0 ? { knowledgeReferences } : {}),
          status: 'completed',
        },
      ],
    };
    this.state.turnsByThread.set(event.threadId, turns);
    return true;
  };

  dispatchQueuedMessage = async (threadId: string): Promise<void> => {
    const releaseQueueOperation = await this.acquireQueueOperation(threadId);
    try {
      const active = this.state.activeTurnsByThread.get(threadId);
      const queue = this.state.runtimeQueuesByThread.get(threadId);
      const head = queue?.messages[0];
      const thread = this.state.threadRecords.get(threadId);
      if (active || !queue || queue.paused || !head || !thread) {
        return;
      }
      const turnId = createUuidV7();
      const text = head.content
        .filter(
          (part): part is Extract<RuntimeContentPart, { type: 'text' }> =>
            part.type === 'text',
        )
        .map((part) => part.text)
        .join('\n');
      const attachments = head.content.flatMap((part) =>
        part.type === 'asset' ? [attachmentFromPart(part)] : [],
      );
      const knowledgeReferences = knowledgeReferencesFromParts(head.content);
      this.state.turnsByThread.set(threadId, [
        ...(this.state.turnsByThread.get(threadId) ?? []),
        {
          id: turnId,
          status: 'inProgress',
          messages: [
            {
              id: `${turnId}:user`,
              role: 'user',
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(knowledgeReferences.length > 0
                ? { knowledgeReferences }
                : {}),
              status: 'inProgress',
            },
          ],
        },
      ]);
      this.state.activeTurnsByThread.set(threadId, {
        workspaceId: thread.workspaceId,
        turnId,
        phase: 'starting',
      });
      this.state.unreadThreadStatuses.delete(threadId);
      this.state.promotingQueueItemsByThread.set(threadId, head.id);
      this.context.refreshNavigator();
      this.context.runtime.send({
        type: 'turn.startQueued',
        requestId: randomUUID(),
        workspaceId: thread.workspaceId,
        threadId,
        turnId,
        queueItemId: head.id,
        expectedRevision: head.revision,
        ...(head.modelProfileId ? { modelProfileId: head.modelProfileId } : {}),
        ...(head.modelRequest ? { modelRequest: head.modelRequest } : {}),
        content: head.content,
      });
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
    } finally {
      releaseQueueOperation();
    }
  };

  finishQueueAfterTurn = async (
    threadId: string,
    status: 'completed' | 'failed' | 'interrupted',
  ): Promise<GoalQueueOutcome> => {
    await Promise.resolve();
    this.state.promotingQueueItemsByThread.delete(threadId);
    const queue = this.state.runtimeQueuesByThread.get(threadId);
    if (!queue || queue.messages.length === 0) {
      this.context.goals.schedule(
        threadId,
        'queueDrained',
        this.state.activeTurnsByThread.has(threadId),
      );
      return 'queueDrained';
    }
    if (status === 'completed' && !queue.paused) {
      await this.dispatchQueuedMessage(threadId);
      return 'queueDispatched';
    }
    const thread = this.state.threadRecords.get(threadId);
    if (!thread || queue.paused) {
      if (thread) {
        await this.context.goals.pause(thread.workspaceId, threadId, 'queueBlocked');
      }
      return 'queueBlocked';
    }
    const releaseQueueOperation = await this.acquireQueueOperation(threadId);
    try {
      const event = await this.context.runtime.request(
        {
          type: 'queue.pause',
          requestId: randomUUID(),
          workspaceId: thread.workspaceId,
          threadId,
        },
        'queue.changed',
      );
      if (this.applyRuntimeQueue(threadId, event.queue)) {
        this.context.publishThreadProjection(threadId, true);
        if (this.state.workspaceId === thread.workspaceId) {
          this.context.publish();
        }
      }
      await this.context.goals.pause(thread.workspaceId, threadId, 'queueBlocked');
    } catch {
      this.state.notice = {
        kind: 'warning',
        summary: 'The queued messages could not be paused safely.',
      };
      this.context.publish();
    } finally {
      releaseQueueOperation();
    }
    return 'queueBlocked';
  };
}
