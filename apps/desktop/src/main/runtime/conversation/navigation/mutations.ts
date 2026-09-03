import { randomUUID } from 'node:crypto';
import {
  isValidConversationTitle,
  type ConversationActionResult,
} from '../../../../shared/conversation.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
} from '../action-result.ts';
import { withoutNavigatorFields } from './state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'publish'
  | 'runtime'
  | 'refreshNavigator'
  | 'goals'
  | 'projections'
>;

export class ConversationThreadMutations {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  deleteThread = async (threadId: unknown): Promise<ConversationActionResult> =>
    this.deleteThreadRecord(threadId);

  renameThread = async (
    threadId: unknown,
    title: unknown,
  ): Promise<ConversationActionResult> => {
    if (
      typeof threadId !== 'string' ||
      !isValidConversationTitle(title) ||
      !this.state.threadRecords.has(threadId)
    ) {
      return rejected('invalidInput');
    }
    const thread = this.state.threadRecords.get(threadId);
    if (
      !thread ||
      thread.workspaceId !== this.state.workspaceId ||
      !this.state.workspaceId ||
      this.state.navigator.pendingMutation
    ) {
      return rejected('unavailable');
    }
    const workspaceId = this.state.workspaceId;
    const normalizedTitle = title.trim();
    this.state.navigator = {
      ...this.state.navigator,
      pendingMutation: { kind: 'rename', threadId },
    };
    this.context.publish();
    try {
      const event = await this.context.runtime.request(
        {
          type: 'thread.rename',
          requestId: randomUUID(),
          workspaceId,
          threadId,
          title: normalizedTitle,
        },
        'thread.mutated',
      );
      if (
        event.operation !== 'rename' ||
        event.workspaceId !== workspaceId ||
        !event.snapshot
      ) {
        throw new Error('Thread rename returned a mismatched snapshot.');
      }
      this.state.threadRecords.set(threadId, event.snapshot.thread);
      if (this.state.workspaceId === workspaceId) {
        this.state.navigator = withoutNavigatorFields(this.state.navigator, [
          'pendingMutation',
          'mutationNotice',
        ]);
        this.context.refreshNavigator();
        this.context.publish();
      }
      return accepted();
    } catch {
      if (this.state.workspaceId === workspaceId) {
        this.state.navigator = {
          ...withoutNavigatorFields(this.state.navigator, ['pendingMutation']),
          mutationNotice: '会话名称修改失败，请重试。',
        };
        this.context.publish();
      }
      return rejected('unavailable');
    }
  };

  private deleteThreadRecord = async (
    threadId: unknown,
  ): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || !this.state.threadRecords.has(threadId)) {
      return rejected('unknownThread');
    }
    if (
      !this.state.workspaceId ||
      this.state.pendingTurnStartWorkspaces.has(this.state.workspaceId) ||
      this.state.activeTurnsByThread.has(threadId) ||
      this.state.navigator.pendingMutation
    ) {
      return rejected(
        this.state.pendingTurnStartWorkspaces.has(this.state.workspaceId) ||
          this.state.activeTurnsByThread.has(threadId)
          ? 'turnActive'
          : 'unavailable',
      );
    }
    const workspaceId = this.state.workspaceId;
    this.state.navigator = {
      ...this.state.navigator,
      pendingMutation: { kind: 'delete', threadId },
    };
    this.context.publish();
    try {
      const event = await this.context.runtime.request(
        {
          type: 'thread.delete',
          requestId: randomUUID(),
          workspaceId,
          threadId,
        },
        'thread.mutated',
      );
      if (event.workspaceId !== workspaceId) {
        throw new Error('Thread mutation crossed workspace ownership.');
      }
      if (this.state.workspaceId !== workspaceId) {
        return accepted();
      }
      if (event.operation !== 'delete' || event.deleted !== true) {
        throw new Error('The runtime did not confirm Thread deletion.');
      }
      this.state.threadRecords.delete(threadId);
      this.state.turnsByThread.delete(threadId);
      this.context.goals.forget(threadId);
      this.state.queuesByThread.delete(threadId);
      this.state.runtimeQueuesByThread.delete(threadId);
      this.context.projections.forgetThread(threadId);
      this.state.unreadThreadStatuses.delete(threadId);
      if (this.state.threadId === threadId) {
        this.state.threadSelectionGeneration += 1;
        this.state.threadId = null;
      }
      this.state.navigator = withoutNavigatorFields(this.state.navigator, [
        'pendingMutation',
      ]);
      this.context.refreshNavigator();
      this.context.publish();
      return accepted();
    } catch {
      if (this.state.workspaceId !== workspaceId) {
        return accepted();
      }
      this.state.navigator = {
        ...withoutNavigatorFields(this.state.navigator, ['pendingMutation']),
        mutationNotice: 'The Thread deletion was rejected.',
      };
      this.context.publish();
      return rejected('unavailable');
    }
  };
}
