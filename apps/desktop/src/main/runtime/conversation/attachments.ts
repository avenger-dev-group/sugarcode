import { randomUUID } from 'node:crypto';
import {
  isConversationAttachmentPreviewRequest,
  type ConversationAttachmentPreviewResult,
} from '../../../shared/conversation.ts';
import type { ConversationServices } from './services.ts';
import type { ConversationState } from './state.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'runtime'
>;

export class ConversationAttachments {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  getAttachmentPreview = async (
    request: unknown,
  ): Promise<ConversationAttachmentPreviewResult> => {
    if (!isConversationAttachmentPreviewRequest(request)) {
      return { available: false, reason: 'invalid' };
    }
    const thread = this.state.threadRecords.get(request.threadId);
    if (!thread || thread.workspaceId !== this.state.workspaceId) {
      return { available: false, reason: 'notFound' };
    }
    const attachment = (this.state.turnsByThread.get(request.threadId) ?? [])
      .flatMap((turn) => turn.messages)
      .flatMap((message) => message.attachments ?? [])
      .find((candidate) => candidate.assetId === request.assetId);
    if (!attachment) {
      return { available: false, reason: 'notFound' };
    }
    if (attachment.kind !== 'image') {
      return { available: false, reason: 'unsupported' };
    }
    try {
      const event = await this.context.runtime.request(
        {
          type: 'asset.preview',
          requestId: randomUUID(),
          assetId: attachment.assetId,
        },
        'asset.preview',
      );
      if (event.preview.available === false) {
        return { available: false, reason: event.preview.reason };
      }
      if (
        event.preview.asset.assetId !== attachment.assetId ||
        event.preview.asset.sha256 !== attachment.sha256 ||
        event.preview.asset.mediaType !== attachment.mediaType ||
        !/^image\/[A-Za-z0-9.+-]+$/u.test(event.preview.asset.mediaType)
      ) {
        return { available: false, reason: 'unavailable' };
      }
      return {
        available: true,
        assetId: attachment.assetId,
        previewUrl: `data:${event.preview.asset.mediaType};base64,${event.preview.data}`,
      };
    } catch {
      return { available: false, reason: 'unavailable' };
    }
  };
}
