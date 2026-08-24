import type { ResponseReasoningItem } from 'openai/resources/responses/responses';

import type { ModelTextPhase } from './types.ts';

export const OPENAI_RESPONSES_REPLAY_METADATA_KEY =
  'sugarcodeOpenAiResponsesReplay';

export type ReplayableReasoningItem = Readonly<
  Pick<
    ResponseReasoningItem,
    'id' | 'type' | 'summary' | 'content' | 'encrypted_content' | 'status'
  >
>;

export type OpenAiResponsesReplayBlock =
  | Readonly<{
      type: 'reasoning';
      item: ReplayableReasoningItem;
    }>
  | Readonly<{
      type: 'text';
      itemId: string;
      phase?: ModelTextPhase;
    }>
  | Readonly<{
      type: 'toolCall';
      itemId?: string;
      callId: string;
    }>;

export type OpenAiResponsesReplayEnvelope = Readonly<{
  kind: 'openaiResponses';
  version: 1;
  compatibilityKey: string;
  responseId?: string;
  blocks: readonly OpenAiResponsesReplayBlock[];
}>;

export type OpenAiResponsesPartReplay = Readonly<{
  kind: 'openaiResponses';
  version: 1;
  compatibilityKey: string;
  responseId?: string;
  block: OpenAiResponsesReplayBlock;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPhase = (value: unknown): value is ModelTextPhase =>
  value === 'commentary' || value === 'final' || value === 'provisional';

const isReasoningItem = (value: unknown): value is ReplayableReasoningItem =>
  isRecord(value) &&
  value.type === 'reasoning' &&
  typeof value.id === 'string' &&
  Array.isArray(value.summary) &&
  value.summary.every(
    (part) =>
      isRecord(part) &&
      part.type === 'summary_text' &&
      typeof part.text === 'string',
  ) &&
  (value.content === undefined ||
    (Array.isArray(value.content) &&
      value.content.every(
        (part) =>
          isRecord(part) &&
          part.type === 'reasoning_text' &&
          typeof part.text === 'string',
      ))) &&
  (value.encrypted_content === undefined ||
    value.encrypted_content === null ||
    typeof value.encrypted_content === 'string') &&
  (value.status === undefined ||
    value.status === 'in_progress' ||
    value.status === 'completed' ||
    value.status === 'incomplete');

export const isOpenAiResponsesReplayBlock = (
  value: unknown,
): value is OpenAiResponsesReplayBlock => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'reasoning') {
    return isReasoningItem(value.item);
  }
  if (value.type === 'text') {
    return (
      typeof value.itemId === 'string' &&
      (value.phase === undefined || isPhase(value.phase))
    );
  }
  return (
    value.type === 'toolCall' &&
    (value.itemId === undefined || typeof value.itemId === 'string') &&
    typeof value.callId === 'string'
  );
};

export const isOpenAiResponsesReplayEnvelope = (
  value: unknown,
): value is OpenAiResponsesReplayEnvelope =>
  isRecord(value) &&
  value.kind === 'openaiResponses' &&
  value.version === 1 &&
  typeof value.compatibilityKey === 'string' &&
  (value.responseId === undefined || typeof value.responseId === 'string') &&
  Array.isArray(value.blocks) &&
  value.blocks.every(isOpenAiResponsesReplayBlock);

export const openAiResponsesPartReplay = (
  compatibilityKey: string,
  responseId: string | undefined,
  block: OpenAiResponsesReplayBlock,
): Readonly<Record<string, unknown>> => ({
  [OPENAI_RESPONSES_REPLAY_METADATA_KEY]: {
    kind: 'openaiResponses',
    version: 1,
    compatibilityKey,
    ...(responseId ? { responseId } : {}),
    block,
  } satisfies OpenAiResponsesPartReplay,
});

export const readOpenAiResponsesPartReplay = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): OpenAiResponsesPartReplay | undefined => {
  const value = metadata?.[OPENAI_RESPONSES_REPLAY_METADATA_KEY];
  if (
    !isRecord(value) ||
    value.kind !== 'openaiResponses' ||
    value.version !== 1 ||
    typeof value.compatibilityKey !== 'string' ||
    (value.responseId !== undefined && typeof value.responseId !== 'string') ||
    !isOpenAiResponsesReplayBlock(value.block)
  ) {
    return undefined;
  }
  return value as OpenAiResponsesPartReplay;
};

export const withOpenAiResponsesPartReplay = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  replay: OpenAiResponsesPartReplay,
): Readonly<Record<string, unknown>> => ({
  ...metadata,
  [OPENAI_RESPONSES_REPLAY_METADATA_KEY]: replay,
});

export const withoutOpenAiResponsesPartReplay = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined => {
  if (!metadata || !(OPENAI_RESPONSES_REPLAY_METADATA_KEY in metadata)) {
    return metadata;
  }
  const rest = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== OPENAI_RESPONSES_REPLAY_METADATA_KEY,
    ),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
};

export const openAiResponsesCompatibilityKey = (
  baseUrl: string,
  model: string,
): string => {
  const parsed = new URL(baseUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return `openaiResponses:${parsed.toString().replace(/\/+$/u, '')}:${model}`;
};
