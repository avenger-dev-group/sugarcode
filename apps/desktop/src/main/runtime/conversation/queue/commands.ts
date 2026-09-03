import { randomUUID } from 'node:crypto';
import {
  isConversationQueuedMessageMutationRequest,
  isConversationQueuedMessageUpdateRequest,
  isConversationSteerQueuedMessageRequest,
  type ConversationActionResult,
} from '../../../../shared/conversation.ts';
import type { RuntimeContentPart } from '../../../../runtime/contracts/protocol.ts';
import { initialTurnContent } from '../turns/content.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
} from '../action-result.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'acquireQueueOperation'
  | 'runtime'
  | 'applyRuntimeQueue'
  | 'publishThreadProjection'
  | 'publish'
  | 'queueErrorReason'
  | 'refreshRuntimeQueue'
  | 'appendSteeredUserMessage'
  | 'dispatchQueuedMessage'
>;

export class ConversationQueueCommands {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  updateQueuedMessage = async (
    input: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isConversationQueuedMessageUpdateRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.state.workspaceId;
    const thread = this.state.threadRecords.get(input.threadId);
    if (
      !workspaceId ||
      !this.state.available ||
      thread?.workspaceId !== workspaceId
    ) {
      return rejected('unknownThread');
    }
    const existing = this.state.runtimeQueuesByThread
      .get(input.threadId)
      ?.messages.find((message) => message.id === input.queueItemId);
    if (!existing) {
      return rejected('queueItemNotFound');
    }
    if (
      this.state.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId
    ) {
      return rejected('turnActive');
    }
    const content: RuntimeContentPart[] = [
      ...initialTurnContent(input.input),
      ...existing.content.filter(
        (part) => part.type === 'asset' || part.type === 'knowledgeReferences',
      ),
    ];
    const releaseQueueOperation = await this.context.acquireQueueOperation(
      input.threadId,
    );
    try {
      const event = await this.context.runtime.request(
        {
          type: 'queue.messageUpdate',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
          content,
          ...(input.modelProfileId
            ? { modelProfileId: input.modelProfileId }
            : {}),
          ...(input.modelRequest ? { modelRequest: input.modelRequest } : {}),
        },
        'queue.changed',
      );
      if (this.context.applyRuntimeQueue(input.threadId, event.queue)) {
        this.context.publishThreadProjection(input.threadId, true);
        this.context.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.context.queueErrorReason(error);
      if (
        reason === 'queueRevisionMismatch' ||
        reason === 'queueItemNotFound'
      ) {
        await this.context.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  deleteQueuedMessage = async (
    input: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isConversationQueuedMessageMutationRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.state.workspaceId;
    const thread = this.state.threadRecords.get(input.threadId);
    if (
      !workspaceId ||
      !this.state.available ||
      thread?.workspaceId !== workspaceId
    ) {
      return rejected('unknownThread');
    }
    if (
      this.state.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId
    ) {
      return rejected('turnActive');
    }
    const releaseQueueOperation = await this.context.acquireQueueOperation(
      input.threadId,
    );
    try {
      const event = await this.context.runtime.request(
        {
          type: 'queue.messageDelete',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
        },
        'queue.changed',
      );
      if (this.context.applyRuntimeQueue(input.threadId, event.queue)) {
        this.context.publishThreadProjection(input.threadId, true);
        this.context.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.context.queueErrorReason(error);
      if (
        reason === 'queueRevisionMismatch' ||
        reason === 'queueItemNotFound'
      ) {
        await this.context.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  steerQueuedMessage = async (
    input: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isConversationSteerQueuedMessageRequest(input)) {
      return rejected('invalidInput');
    }
    const workspaceId = this.state.workspaceId;
    const active = this.state.activeTurnsByThread.get(input.threadId);
    if (!workspaceId || !active || active.turnId !== input.expectedTurnId) {
      return rejected('turnMismatch');
    }
    if (active.phase !== 'inProgress') {
      return rejected('notSteerable');
    }
    if (
      this.state.promotingQueueItemsByThread.get(input.threadId) === input.queueItemId
    ) {
      return rejected('turnActive');
    }
    const releaseQueueOperation = await this.context.acquireQueueOperation(
      input.threadId,
    );
    try {
      const event = await this.context.runtime.request(
        {
          type: 'turn.steerQueued',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          expectedTurnId: input.expectedTurnId,
          queueItemId: input.queueItemId,
          expectedRevision: input.expectedRevision,
        },
        'turn.steered',
      );
      const changed = this.context.applyRuntimeQueue(input.threadId, event.queue);
      const appended = this.context.appendSteeredUserMessage(event);
      if (changed || appended) {
        this.context.publishThreadProjection(input.threadId, true);
        this.context.publish();
      }
      return accepted();
    } catch (error) {
      const reason = this.context.queueErrorReason(error);
      if (
        reason === 'queueRevisionMismatch' ||
        reason === 'queueItemNotFound'
      ) {
        await this.context.refreshRuntimeQueue(input.threadId, workspaceId);
      }
      return rejected(reason);
    } finally {
      releaseQueueOperation();
    }
  };

  resumeQueue = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string') {
      return rejected('unknownThread');
    }
    const workspaceId = this.state.workspaceId;
    if (
      !workspaceId ||
      this.state.threadRecords.get(threadId)?.workspaceId !== workspaceId
    ) {
      return rejected('unknownThread');
    }
    const releaseQueueOperation = await this.context.acquireQueueOperation(threadId);
    try {
      const event = await this.context.runtime.request(
        {
          type: 'queue.resume',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'queue.changed',
      );
      if (this.context.applyRuntimeQueue(threadId, event.queue)) {
        this.context.publishThreadProjection(threadId, true);
        this.context.publish();
      }
    } catch (error) {
      return rejected(this.context.queueErrorReason(error));
    } finally {
      releaseQueueOperation();
    }
    await this.context.dispatchQueuedMessage(threadId);
    return accepted();
  };
}
