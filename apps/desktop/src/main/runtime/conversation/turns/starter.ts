import { randomUUID } from 'node:crypto';
import { parseComposerSubmission } from '../../../../shared/composer.ts';
import {
  isConversationSendRequest,
  type ConversationActionResult,
  type ConversationAttachment,
} from '../../../../shared/conversation.ts';
import { attachmentFromPart } from '../projection/project-thread.ts';
import { initialTurnContent } from './content.ts';
import { createUuidV7 } from '../id.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
  attachmentImportFailure,
} from '../action-result.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'acquireQueueOperation'
  | 'runtime'
  | 'refreshNavigator'
  | 'publishThreadProjection'
  | 'publish'
  | 'ensureSelectedThread'
  | 'applyRuntimeQueue'
  | 'finishQueueAfterTurn'
>;

export class ConversationTurnStarter {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  startTurn = async (input: unknown): Promise<ConversationActionResult> => {
    if (!isConversationSendRequest(input)) {
      return rejected('invalidInput');
    }
    if (!this.state.workspaceId || !this.state.available) {
      return rejected('unavailable');
    }
    const workspaceId = this.state.workspaceId;
    let threadId = this.state.threadId;
    const submission = parseComposerSubmission(input.input);
    const compactCommand = submission.references.some(
      (reference) =>
        reference.kind === 'command' && reference.target === 'compact',
    );
    let generateTitle = threadId
      ? this.state.threadRecords.get(threadId)?.title === null
      : true;
    const pendingStart = this.state.pendingTurnStartWorkspaces.has(workspaceId);
    if ((pendingStart && !threadId) || this.state.navigator.pendingMutation) {
      return rejected('turnActive');
    }
    const currentQueue = threadId
      ? this.state.queuesByThread.get(threadId)
      : undefined;
    const shouldQueue = Boolean(
      threadId &&
      (pendingStart ||
        this.state.activeTurnsByThread.has(threadId) ||
        currentQueue?.paused ||
        (currentQueue?.messages.length ?? 0) > 0),
    );
    const releaseQueueOperation =
      shouldQueue && threadId
        ? await this.context.acquireQueueOperation(threadId)
        : undefined;
    if (compactCommand && !shouldQueue) {
      if (!threadId || (input.attachments?.length ?? 0) > 0) {
        return rejected('invalidInput');
      }
      const turnId = createUuidV7();
      this.state.turnsByThread.set(threadId, [
        ...(this.state.turnsByThread.get(threadId) ?? []),
        { id: turnId, status: 'inProgress', messages: [] },
      ]);
      this.state.activeTurnsByThread.set(threadId, {
        workspaceId,
        turnId,
        phase: 'starting',
      });
      this.state.unreadThreadStatuses.delete(threadId);
      this.context.runtime.send({
        type: 'context.compact',
        requestId: randomUUID(),
        workspaceId,
        threadId,
        turnId,
        ...(input.modelProfileId
          ? { modelProfileId: input.modelProfileId }
          : {}),
        ...(input.modelRequest ? { modelRequest: input.modelRequest } : {}),
        ...(submission.text.trim() ? { focus: submission.text.trim() } : {}),
      });
      this.context.refreshNavigator();
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
      return accepted({ disposition: 'started' });
    }
    if (!shouldQueue) {
      this.state.pendingTurnStartWorkspaces.add(workspaceId);
    }
    this.state.notice = undefined;
    this.context.publish();
    let optimisticTurn:
      Readonly<{ threadId: string; turnId: string }> | undefined;
    let importingAttachment = false;
    try {
      const content = initialTurnContent(input.input);
      const attachments: ConversationAttachment[] = [];
      for (const attachment of input.attachments ?? []) {
        importingAttachment = true;
        const imported = await this.context.runtime.request(
          {
            type: 'asset.import',
            requestId: randomUUID(),
            fileName: attachment.fileName,
            ...(attachment.mediaType
              ? { mediaType: attachment.mediaType }
              : {}),
            ...('localPath' in attachment
              ? { localPath: attachment.localPath }
              : { data: attachment.data }),
          },
          'asset.imported',
        );
        content.push({ type: 'asset', asset: imported.asset });
        attachments.push({
          ...attachmentFromPart({ type: 'asset', asset: imported.asset }),
          ...(imported.asset.kind === 'image' && 'data' in attachment
            ? {
                previewUrl: `data:${imported.asset.mediaType};base64,${attachment.data}`,
              }
            : {}),
        });
        importingAttachment = false;
      }
      if (!threadId) {
        threadId = await this.context.ensureSelectedThread(workspaceId);
        generateTitle = true;
      }
      if (shouldQueue) {
        const queueItemId = createUuidV7();
        const event = await this.context.runtime.request(
          {
            type: 'queue.messageCreate',
            requestId: randomUUID(),
            workspaceId,
            threadId,
            queueItemId,
            content,
            ...(input.modelProfileId
              ? { modelProfileId: input.modelProfileId }
              : {}),
            ...(input.modelRequest ? { modelRequest: input.modelRequest } : {}),
          },
          'queue.changed',
        );
        if (this.context.applyRuntimeQueue(threadId, event.queue)) {
          this.context.publishThreadProjection(threadId, true);
          this.context.publish();
        }
        releaseQueueOperation?.();
        if (!this.state.activeTurnsByThread.has(threadId)) {
          const terminalStatus = this.state.turnsByThread
            .get(threadId)
            ?.at(-1)?.status;
          if (
            terminalStatus === 'completed' ||
            terminalStatus === 'failed' ||
            terminalStatus === 'interrupted'
          ) {
            await this.context.finishQueueAfterTurn(threadId, terminalStatus);
          }
        }
        return accepted({ disposition: 'queued', queueItemId });
      }
      const turnId = createUuidV7();
      const userMessage = {
        id: `${turnId}:user`,
        role: 'user' as const,
        text: input.input,
        ...(attachments.length > 0 ? { attachments } : {}),
        status: 'inProgress' as const,
      };
      this.state.turnsByThread.set(threadId, [
        ...(this.state.turnsByThread.get(threadId) ?? []),
        { id: turnId, status: 'inProgress', messages: [userMessage] },
      ]);
      this.state.activeTurnsByThread.set(threadId, {
        workspaceId,
        turnId,
        phase: 'starting',
      });
      this.state.unreadThreadStatuses.delete(threadId);
      optimisticTurn = { threadId, turnId };
      this.state.pendingTurnStartWorkspaces.delete(workspaceId);
      this.context.refreshNavigator();
      this.context.runtime.send({
        type: 'turn.start',
        requestId: randomUUID(),
        workspaceId,
        threadId,
        turnId,
        ...(input.modelProfileId
          ? { modelProfileId: input.modelProfileId }
          : {}),
        ...(input.modelRequest ? { modelRequest: input.modelRequest } : {}),
        ...(generateTitle ? { generateTitle: true } : {}),
        content,
      });
      this.context.publishThreadProjection(threadId, true);
      this.context.publish();
      return accepted({ disposition: 'started' });
    } catch (error) {
      const attachmentUnavailable = importingAttachment;
      const importFailure = attachmentUnavailable
        ? attachmentImportFailure(error)
        : undefined;
      releaseQueueOperation?.();
      this.state.pendingTurnStartWorkspaces.delete(workspaceId);
      if (
        optimisticTurn &&
        this.state.activeTurnsByThread.get(optimisticTurn.threadId)?.turnId ===
          optimisticTurn.turnId
      ) {
        this.state.activeTurnsByThread.delete(optimisticTurn.threadId);
        this.state.turnsByThread.set(
          optimisticTurn.threadId,
          (this.state.turnsByThread.get(optimisticTurn.threadId) ?? []).filter(
            (turn) => turn.id !== optimisticTurn.turnId,
          ),
        );
        this.context.refreshNavigator();
      }
      if (this.state.workspaceId === workspaceId) {
        this.state.notice = {
          kind: 'requestFailed',
          summary: attachmentUnavailable
            ? 'The attachment could not be imported.'
            : 'The local Agent could not start this Turn.',
        };
      }
      this.context.publish();
      return rejected(
        attachmentUnavailable ? 'attachmentUnavailable' : 'unavailable',
        importFailure,
      );
    }
  };
}
