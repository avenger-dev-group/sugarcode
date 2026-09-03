import { parseComposerSubmission } from '../../../../shared/composer.ts';
import {
  MAX_CONVERSATION_INPUT_BYTES,
  type ConversationMessage,
} from '../../../../shared/conversation.ts';
import type { RuntimeContentPart } from '../../../../runtime/contracts/protocol.ts';

export const initialTurnContent = (input: string): RuntimeContentPart[] =>
  input.length > 0 ? [{ type: 'text', text: input }] : [];

export const revisedTurnContent = (
  userMessage: Pick<ConversationMessage, 'text' | 'attachments' | 'knowledgeReferences'>,
  text: string,
): RuntimeContentPart[] | undefined => {
  const references = parseComposerSubmission(userMessage.text).references;
  const revisedInput = [
    ...references.map((reference) => reference.value),
    text,
  ].join('\n');
  if (
    new TextEncoder().encode(revisedInput).byteLength >
      MAX_CONVERSATION_INPUT_BYTES ||
    (revisedInput.trim().length === 0 &&
      (userMessage.attachments?.length ?? 0) === 0)
  ) {
    return undefined;
  }

  const content: RuntimeContentPart[] = revisedInput.length > 0
    ? [{ type: 'text', text: revisedInput }]
    : [];
  if (userMessage.knowledgeReferences?.length) {
    content.push({
      type: 'knowledgeReferences',
      references: userMessage.knowledgeReferences,
    });
  }
  for (const attachment of userMessage.attachments ?? []) {
    content.push({
      type: 'asset',
      asset: {
        assetId: attachment.assetId,
        sha256: attachment.sha256,
        mediaType: attachment.mediaType,
        originalName: attachment.originalName,
        sizeBytes: attachment.sizeBytes,
        kind: attachment.kind,
        ...(attachment.pdfPages === undefined
          ? {}
          : { pdfPages: attachment.pdfPages }),
      },
    });
  }
  return content;
};
