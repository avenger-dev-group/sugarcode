import { randomUUID } from 'node:crypto';
import {
  isConversationReviseTurnRequest,
  type ConversationActionResult,
} from '../../../../shared/conversation.ts';
import { projectThread } from '../projection/project-thread.ts';
import { revisedTurnContent } from './content.ts';
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
  | 'publish'
  | 'runtime'
  | 'applyRuntimeQueue'
  | 'goals'
  | 'refreshNavigator'
  | 'publishThreadProjection'
>;

export class ConversationTurnRevision {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  reviseTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationReviseTurnRequest(input)) {
      return rejected('invalidInput');
    }
    if (!this.state.workspaceId || !this.state.available) {
      return rejected('unavailable');
    }
    if (!this.state.threadId || input.threadId !== this.state.threadId) {
      return rejected('unknownThread');
    }
    const workspaceId = this.state.workspaceId;
    const turns = this.state.turnsByThread.get(input.threadId) ?? [];
    const latestTurn = turns.at(-1);
    if (!latestTurn || latestTurn.id !== input.turnId) {
      return rejected('notLatestTurn');
    }
    if (
      latestTurn.status === 'inProgress' ||
      this.state.pendingTurnStartWorkspaces.has(workspaceId) ||
      this.state.activeTurnsByThread.has(input.threadId) ||
      this.state.navigator.pendingMutation
    ) {
      return rejected('turnActive');
    }
    const userMessage = latestTurn.messages.find(
      (message) => message.role === 'user',
    );
    if (!userMessage) {
      return rejected('notLatestTurn');
    }
    const content = revisedTurnContent(userMessage, input.text);
    if (!content) {
      return rejected('invalidInput');
    }
    const turnId = createUuidV7();
    this.state.pendingTurnStartWorkspaces.add(workspaceId);
    this.state.notice = undefined;
    this.context.publish();
    try {
      await this.context.runtime.request(
        {
          type: 'turn.revise',
          requestId: randomUUID(),
          workspaceId,
          threadId: input.threadId,
          turnId,
          replacedTurnId: input.turnId,
          ...(input.modelProfileId
            ? { modelProfileId: input.modelProfileId }
            : {}),
          ...(input.modelRequest ? { modelRequest: input.modelRequest } : {}),
          content,
        },
        'turn.revised',
      );
      return accepted();
    } catch {
      const reconciliation = await this.reconcileTurnRevision({
        workspaceId,
        threadId: input.threadId,
        replacedTurnId: input.turnId,
        turnId,
      });
      if (reconciliation === 'committed') {
        return accepted();
      }
      this.state.notice = {
        kind: 'requestFailed',
        summary: 'The last Turn could not be revised safely.',
      };
      return rejected('unavailable');
    } finally {
      this.state.pendingTurnStartWorkspaces.delete(workspaceId);
      this.context.publish();
    }
  };

  private reconcileTurnRevision = async ({
    workspaceId,
    threadId,
    replacedTurnId,
    turnId,
  }: Readonly<{
    workspaceId: string;
    threadId: string;
    replacedTurnId: string;
    turnId: string;
  }>): Promise<'committed' | 'notCommitted' | 'unavailable'> => {
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
        event.workspaceId !== workspaceId ||
        event.snapshot.thread.id !== threadId ||
        event.snapshot.thread.workspaceId !== workspaceId
      ) {
        return 'unavailable';
      }
      const turns = [...projectThread(event.snapshot)];
      this.state.threadRecords.set(threadId, event.snapshot.thread);
      this.state.turnsByThread.set(threadId, turns);
      this.context.applyRuntimeQueue(threadId, event.snapshot.queue);
      this.context.goals.apply(threadId, event.snapshot.goal);
      this.state.activeTurnsByThread.delete(threadId);
      this.context.refreshNavigator();
      if (this.state.threadId === threadId) {
        this.context.publishThreadProjection(threadId, true);
      }
      this.context.publish();
      if (turns.some((turn) => turn.id === turnId)) {
        this.state.notice = undefined;
        return 'committed';
      }
      return turns.at(-1)?.id === replacedTurnId
        ? 'notCommitted'
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
}
