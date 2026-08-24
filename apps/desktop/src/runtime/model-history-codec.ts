import type { Content, Part } from '@google/genai';

import {
  RuntimeProtocolError,
  protocolProviderError,
  protocolShapeSha256,
} from './protocol-error.ts';
import {
  OPENAI_RESPONSES_REPLAY_METADATA_KEY,
  type OpenAiResponsesPartReplay,
  type OpenAiResponsesReplayBlock,
  type OpenAiResponsesReplayEnvelope,
  isOpenAiResponsesReplayEnvelope,
  readOpenAiResponsesPartReplay,
  withOpenAiResponsesPartReplay,
  withoutOpenAiResponsesPartReplay,
} from './models/openai-responses-replay.ts';

export type StoredHistoryPart =
  | Readonly<{
      type: 'text';
      text: string;
      reasoning: boolean;
      metadata?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'media';
      mediaType: string;
      data: string;
      name?: string;
    }>
  | Readonly<{
      type: 'toolCall';
      id: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      type: 'toolResult';
      id: string;
      name: string;
      result: Readonly<Record<string, unknown>>;
    }>;

export type StoredModelHistoryV2 = Readonly<{
  version: 2;
  role: 'assistant' | 'user';
  parts: readonly StoredHistoryPart[];
  replay?: OpenAiResponsesReplayEnvelope;
  replayDegrade?: Readonly<{
    reason: 'invalidEnvelope' | 'blockMismatch';
    shapeSha256: string;
  }>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKnownInternalMetadata = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean =>
  isRecord(metadata?.openaiCompaction) ||
  metadata?.[OPENAI_RESPONSES_REPLAY_METADATA_KEY] !== undefined;

const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

const isSemanticallyEmptyPart = (part: Part): boolean =>
  Object.entries(part as Record<string, unknown>).every(([key, value]) =>
    ['partMetadata', 'thought', 'thoughtSignature'].includes(key) ||
    isEmptyValue(value),
  );

const historyProtocolError = (
  message: string,
  code: 'invalidEventShape' | 'malformedToolCall',
  value: unknown,
): RuntimeProtocolError =>
  new RuntimeProtocolError(protocolProviderError(message, {
    stage: 'outputNormalization',
    code,
    value,
    eventType: 'history.encode',
  }));

const invalidStoredHistory = (value: unknown): never => {
  throw new RuntimeProtocolError(protocolProviderError(
    'Stored model history is invalid.',
    {
      stage: 'outputNormalization',
      code: 'invalidEventShape',
      value,
      eventType: 'history.restore',
    },
  ));
};

const encodePart = (part: Part): StoredHistoryPart | undefined => {
  const metadata = isRecord(part.partMetadata)
    ? part.partMetadata
    : undefined;
  if (typeof part.text === 'string') {
    if (
      part.text.length === 0 &&
      !isKnownInternalMetadata(metadata)
    ) {
      return undefined;
    }
    const storedMetadata = withoutOpenAiResponsesPartReplay(metadata);
    return {
      type: 'text',
      text: part.text,
      reasoning: part.thought === true,
      ...(storedMetadata ? { metadata: storedMetadata } : {}),
    };
  }
  if (part.inlineData?.mimeType && part.inlineData.data) {
    return {
      type: 'media',
      mediaType: part.inlineData.mimeType,
      data: part.inlineData.data,
      ...(part.inlineData.displayName
        ? { name: part.inlineData.displayName }
        : {}),
    };
  }
  if (part.functionCall) {
    if (!part.functionCall.id || !part.functionCall.name) {
      throw historyProtocolError(
        'Model history contains a malformed tool call.',
        'malformedToolCall',
        part.functionCall,
      );
    }
    return {
      type: 'toolCall',
      id: part.functionCall.id,
      name: part.functionCall.name,
      arguments: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    if (!part.functionResponse.id || !part.functionResponse.name) {
      throw historyProtocolError(
        'Model history contains a malformed tool result.',
        'malformedToolCall',
        part.functionResponse,
      );
    }
    return {
      type: 'toolResult',
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      result: part.functionResponse.response ?? {},
    };
  }
  if (isSemanticallyEmptyPart(part)) {
    return undefined;
  }
  throw historyProtocolError(
    'Model history contains an unsupported content-bearing Part.',
    'invalidEventShape',
    part,
  );
};

const replayEligible = (part: StoredHistoryPart): boolean =>
  part.type === 'toolCall' ||
  (part.type === 'text' && !isRecord(part.metadata?.openaiCompaction));

const replayMatchesPart = (
  block: OpenAiResponsesReplayBlock,
  part: StoredHistoryPart,
): boolean =>
  (block.type === 'reasoning' &&
    part.type === 'text' &&
    part.reasoning) ||
  (block.type === 'text' &&
    part.type === 'text' &&
    !part.reasoning) ||
  (block.type === 'toolCall' &&
    part.type === 'toolCall' &&
    block.callId === part.id);

const replayEnvelope = (
  role: StoredModelHistoryV2['role'],
  entries: readonly Readonly<{
    part: StoredHistoryPart;
    replay?: OpenAiResponsesPartReplay;
  }>[],
): OpenAiResponsesReplayEnvelope | undefined => {
  if (role !== 'assistant') {
    return undefined;
  }
  const eligible = entries.filter(({ part }) => replayEligible(part));
  if (eligible.length === 0 || eligible.some(({ replay }) => !replay)) {
    return undefined;
  }
  const first = eligible[0]?.replay;
  if (
    !first ||
    eligible.some(
      ({ replay }) =>
        replay?.compatibilityKey !== first.compatibilityKey ||
        replay.responseId !== first.responseId,
    )
  ) {
    return undefined;
  }
  const blocks = eligible.map(({ replay }) => replay?.block).filter(
    (block): block is OpenAiResponsesReplayBlock => block !== undefined,
  );
  if (
    blocks.length !== eligible.length ||
    blocks.some((block, index) => {
      const entry = eligible[index];
      return !entry || !replayMatchesPart(block, entry.part);
    })
  ) {
    return undefined;
  }
  return {
    kind: 'openaiResponses',
    version: 1,
    compatibilityKey: first.compatibilityKey,
    ...(first.responseId ? { responseId: first.responseId } : {}),
    blocks,
  };
};

export const encodeModelHistory = (content: Content): StoredModelHistoryV2 => {
  const entries = (content.parts ?? []).flatMap((part) => {
    const stored = encodePart(part);
    return stored
      ? [{
          part: stored,
          replay: readOpenAiResponsesPartReplay(
            isRecord(part.partMetadata) ? part.partMetadata : undefined,
          ),
        }]
      : [];
  });
  const role = content.role === 'model' ? 'assistant' : 'user';
  const replay = replayEnvelope(role, entries);
  return {
    version: 2,
    role,
    parts: entries.map(({ part }) => part),
    ...(replay ? { replay } : {}),
  };
};

const parsePart = (part: unknown): StoredHistoryPart => {
  if (!isRecord(part) || typeof part.type !== 'string') {
    return invalidStoredHistory(part);
  }
  if (
    part.type === 'text' &&
    typeof part.text === 'string' &&
    typeof part.reasoning === 'boolean'
  ) {
    if (part.metadata !== undefined && !isRecord(part.metadata)) {
      return invalidStoredHistory(part);
    }
    return {
      type: 'text',
      text: part.text,
      reasoning: part.reasoning,
      ...(isRecord(part.metadata) ? { metadata: part.metadata } : {}),
    };
  }
  if (
    part.type === 'media' &&
    typeof part.mediaType === 'string' &&
    typeof part.data === 'string' &&
    (part.name === undefined || typeof part.name === 'string')
  ) {
    return {
      type: 'media',
      mediaType: part.mediaType,
      data: part.data,
      ...(typeof part.name === 'string' ? { name: part.name } : {}),
    };
  }
  if (
    part.type === 'toolCall' &&
    typeof part.id === 'string' &&
    typeof part.name === 'string' &&
    isRecord(part.arguments)
  ) {
    return {
      type: 'toolCall',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
    };
  }
  if (
    part.type === 'toolResult' &&
    typeof part.id === 'string' &&
    typeof part.name === 'string' &&
    isRecord(part.result)
  ) {
    return {
      type: 'toolResult',
      id: part.id,
      name: part.name,
      result: part.result,
    };
  }
  return invalidStoredHistory(part);
};

const validatedReplay = (
  replay: unknown,
  parts: readonly StoredHistoryPart[],
): Readonly<{
  replay?: OpenAiResponsesReplayEnvelope;
  replayDegrade?: StoredModelHistoryV2['replayDegrade'];
}> => {
  if (replay === undefined) {
    return {};
  }
  if (!isOpenAiResponsesReplayEnvelope(replay)) {
    return {
      replayDegrade: {
        reason: 'invalidEnvelope',
        shapeSha256: protocolShapeSha256(replay),
      },
    };
  }
  const eligible = parts.filter(replayEligible);
  if (
    eligible.length !== replay.blocks.length ||
    replay.blocks.some((block, index) => {
      const part = eligible[index];
      return !part || !replayMatchesPart(block, part);
    })
  ) {
    return {
      replayDegrade: {
        reason: 'blockMismatch',
        shapeSha256: protocolShapeSha256(replay),
      },
    };
  }
  return { replay };
};

export const parseStoredModelHistory = (
  value: unknown,
): StoredModelHistoryV2 => {
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== 2) ||
    (value.role !== 'assistant' && value.role !== 'user') ||
    !Array.isArray(value.parts)
  ) {
    return invalidStoredHistory(value);
  }
  const parts = value.parts.map(parsePart);
  return {
    version: 2,
    role: value.role,
    parts,
    ...validatedReplay(value.replay, parts),
  };
};

export const contentFromStoredModelHistory = (
  history: StoredModelHistoryV2,
): Content => {
  let replayIndex = 0;
  const parts = history.parts.map((part): Part => {
    const replayBlock = replayEligible(part)
      ? history.replay?.blocks[replayIndex++]
      : undefined;
    const replay: OpenAiResponsesPartReplay | undefined =
      replayBlock && history.replay
        ? {
            kind: 'openaiResponses',
            version: 1,
            compatibilityKey: history.replay.compatibilityKey,
            ...(history.replay.responseId
              ? { responseId: history.replay.responseId }
              : {}),
            block: replayBlock,
          }
        : undefined;
    switch (part.type) {
      case 'text': {
        const metadata = replay
          ? withOpenAiResponsesPartReplay(part.metadata, replay)
          : part.metadata;
        return {
          text: part.text,
          thought: part.reasoning,
          ...(metadata ? { partMetadata: metadata } : {}),
        };
      }
      case 'media':
        return {
          inlineData: {
            mimeType: part.mediaType,
            data: part.data,
            ...(part.name ? { displayName: part.name } : {}),
          },
        };
      case 'toolCall':
        return {
          functionCall: {
            id: part.id,
            name: part.name,
            args: part.arguments,
          },
          ...(replay
            ? { partMetadata: withOpenAiResponsesPartReplay(undefined, replay) }
            : {}),
        };
      case 'toolResult':
        return {
          functionResponse: {
            id: part.id,
            name: part.name,
            response: part.result,
          },
        };
    }
  });
  if (history.replayDegrade && parts[0]) {
    parts[0] = {
      ...parts[0],
      partMetadata: {
        ...(isRecord(parts[0].partMetadata) ? parts[0].partMetadata : {}),
        sugarcodeReplayDegraded: history.replayDegrade,
      },
    };
  }
  return {
    role: history.role === 'assistant' ? 'model' : 'user',
    parts,
  };
};
