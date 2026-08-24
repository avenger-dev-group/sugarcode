import type {
  Response,
  ResponseCompactionItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

import {
  RuntimeProtocolError,
  protocolProviderError,
} from '../protocol-error.ts';
import type { ModelTextPhase } from './types.ts';

type SlotBase = {
  outputIndex: number;
  itemId: string;
  aliases: Set<string>;
  done: boolean;
};

type TextSlot = SlotBase & {
  type: 'text';
  phase: ModelTextPhase;
  text: string;
  refused: boolean;
};

type ReasoningSlot = SlotBase & {
  type: 'reasoning';
  item: ResponseReasoningItem;
};

type ToolCallSlot = SlotBase & {
  type: 'toolCall';
  callId: string;
  name: string;
  arguments: string;
};

type OutputSlot = TextSlot | ReasoningSlot | ToolCallSlot;

export type ReconciledResponsesBlock =
  | Readonly<{
      type: 'text';
      outputIndex: number;
      itemId: string;
      phase: ModelTextPhase;
      text: string;
    }>
  | Readonly<{
      type: 'reasoning';
      outputIndex: number;
      item: ResponseReasoningItem;
    }>
  | Readonly<{
      type: 'toolCall';
      outputIndex: number;
      itemId?: string;
      callId: string;
      name: string;
      arguments: string;
    }>;

export type ReconciledResponsesTerminal = Readonly<{
  responseId: string;
  status: Response['status'];
  usage: Response['usage'];
  refused: boolean;
  blocks: readonly ReconciledResponsesBlock[];
  compactions: readonly ResponseCompactionItem[];
}>;

const phaseFromProvider = (value: unknown): ModelTextPhase =>
  value === 'commentary'
    ? 'commentary'
    : value === 'final_answer'
      ? 'final'
      : 'provisional';

const messageText = (item: ResponseOutputMessage): string =>
  (Array.isArray(item.content) ? item.content : [])
    .flatMap((part) => part.type === 'output_text' ? [part.text] : [])
    .join('');

const messageRefused = (item: ResponseOutputMessage): boolean =>
  (Array.isArray(item.content) ? item.content : []).some(
    (part) => part.type === 'refusal',
  );

const normalizedReasoningItem = (
  item: ResponseReasoningItem,
): ResponseReasoningItem => ({
  ...item,
  summary: Array.isArray(item.summary) ? item.summary : [],
  ...(Array.isArray(item.content) ? { content: item.content } : {}),
});

const reasoningText = (item: ResponseReasoningItem): string =>
  [
    ...(Array.isArray(item.content) ? item.content : []).map(
      (part) => part.text,
    ),
    ...(Array.isArray(item.summary) ? item.summary : []).map(
      (part) => part.text,
    ),
  ].join('\n');

const semanticKey = (item: ResponseOutputItem): string | undefined => {
  switch (item.type) {
    case 'message':
      return `text:${messageText(item)}`;
    case 'reasoning':
      return `reasoning:${reasoningText(item)}`;
    case 'function_call':
      return `tool:${item.call_id}:${item.name}:${item.arguments}`;
    default:
      return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasSemanticUnknownContent = (item: ResponseOutputItem): boolean =>
  Object.entries(item as unknown as Record<string, unknown>).some(
    ([key, value]) => {
      if (['id', 'type', 'status', 'created_by'].includes(key)) {
        return false;
      }
      if (value === undefined || value === null || value === '') {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      if (isRecord(value)) {
        return Object.keys(value).length > 0;
      }
      return true;
    },
  );

const validToolArguments = (value: string): boolean => {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
};

export class OpenAiResponsesReconciler {
  private readonly slots = new Map<number, OutputSlot>();
  private terminated = false;

  private protocolError = (
    message: string,
    code:
      | 'invalidEventShape'
      | 'ambiguousOutputReconciliation'
      | 'malformedToolCall'
      | 'terminalLifecycleViolation'
      | 'outputIndexMismatch',
    value: unknown,
    eventType: string,
    stage:
      | 'streamEvent'
      | 'responseAssembly'
      | 'outputNormalization' = 'responseAssembly',
  ): RuntimeProtocolError =>
    new RuntimeProtocolError(protocolProviderError(message, {
      stage,
      code,
      value,
      eventType,
    }));

  private ensureOpen = (eventType: string, value: unknown): void => {
    if (this.terminated) {
      throw this.protocolError(
        'OpenAI Responses emitted an event after a terminal event.',
        'terminalLifecycleViolation',
        value,
        eventType,
        'streamEvent',
      );
    }
  };

  private slotByIdentity = (
    expectedType: OutputSlot['type'],
    observedItemId: string,
  ): OutputSlot | undefined =>
    [...this.slots.values()].find(
      (slot) =>
        slot.type === expectedType &&
        (slot.itemId === observedItemId || slot.aliases.has(observedItemId)),
    );

  private compatibleSlot = (
    outputIndex: number,
    expectedType: OutputSlot['type'],
    observedItemId: string,
    semantic?: string,
  ): OutputSlot | undefined => {
    const indexed = this.slots.get(outputIndex);
    if (indexed?.type === expectedType) {
      return indexed;
    }
    if (observedItemId) {
      const identified = this.slotByIdentity(expectedType, observedItemId);
      if (identified) {
        return identified;
      }
    }
    if (semantic !== undefined) {
      const candidates = [...this.slots.values()].filter((slot) => {
        if (slot.type !== expectedType) {
          return false;
        }
        if (slot.type === 'text') {
          return `text:${slot.text}` === semantic;
        }
        if (slot.type === 'reasoning') {
          return `reasoning:${reasoningText(slot.item)}` === semantic;
        }
        return `tool:${slot.callId}:${slot.name}:${slot.arguments}` === semantic;
      });
      if (candidates.length === 1) {
        return candidates[0];
      }
      if (candidates.length > 1) {
        throw this.protocolError(
          'OpenAI Responses terminal output matched more than one streamed item.',
          'ambiguousOutputReconciliation',
          { outputIndex, expectedType, observedItemId, candidates },
          'response.completed',
        );
      }
    }
    if (indexed) {
      throw this.protocolError(
        'OpenAI Responses reused an output index for a different item type.',
        'outputIndexMismatch',
        { outputIndex, expectedType, observedItemId, indexed },
        'response.output_item.done',
      );
    }
    return undefined;
  };

  private rememberAlias = (slot: OutputSlot, observedItemId: string): void => {
    if (observedItemId && observedItemId !== slot.itemId) {
      slot.aliases.add(observedItemId);
    }
  };

  onOutputItemAdded = (
    outputIndex: number,
    item: ResponseOutputItem,
  ): void => {
    this.ensureOpen('response.output_item.added', { outputIndex, item });
    if (item.type === 'message') {
      const existing = this.compatibleSlot(outputIndex, 'text', item.id);
      if (existing?.type === 'text') {
        this.rememberAlias(existing, item.id);
        existing.phase = phaseFromProvider(item.phase);
        return;
      }
      this.slots.set(outputIndex, {
        type: 'text',
        outputIndex,
        itemId: item.id,
        aliases: new Set(),
        done: false,
        phase: phaseFromProvider(item.phase),
        text: messageText(item),
        refused: messageRefused(item),
      });
      return;
    }
    if (item.type === 'reasoning') {
      const existing = this.compatibleSlot(outputIndex, 'reasoning', item.id);
      if (existing?.type === 'reasoning') {
        this.rememberAlias(existing, item.id);
        return;
      }
      this.slots.set(outputIndex, {
        type: 'reasoning',
        outputIndex,
        itemId: item.id,
        aliases: new Set(),
        done: false,
        item: normalizedReasoningItem(item),
      });
      return;
    }
    if (item.type === 'function_call') {
      const observedId = item.id ?? '';
      const existing = this.compatibleSlot(outputIndex, 'toolCall', observedId);
      if (existing?.type === 'toolCall') {
        this.rememberAlias(existing, observedId);
        existing.callId ||= item.call_id;
        existing.name ||= item.name;
        existing.arguments ||= item.arguments;
        return;
      }
      this.slots.set(outputIndex, {
        type: 'toolCall',
        outputIndex,
        itemId: observedId,
        aliases: new Set(),
        done: false,
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
      return;
    }
    if (item.type === 'compaction' || !hasSemanticUnknownContent(item)) {
      return;
    }
    throw this.protocolError(
      `OpenAI Responses returned unsupported output item type ${item.type}.`,
      'invalidEventShape',
      item,
      'response.output_item.added',
      'outputNormalization',
    );
  };

  onTextDelta = (
    outputIndex: number,
    observedItemId: string,
    delta: string,
  ): string => {
    this.ensureOpen('response.output_text.delta', {
      outputIndex,
      item_id: observedItemId,
      delta,
    });
    const existing = this.compatibleSlot(outputIndex, 'text', observedItemId);
    const slot: TextSlot = existing?.type === 'text'
      ? existing
      : {
          type: 'text',
          outputIndex,
          itemId: observedItemId,
          aliases: new Set(),
          done: false,
          phase: 'provisional',
          text: '',
          refused: false,
        };
    this.rememberAlias(slot, observedItemId);
    slot.text += delta;
    this.slots.set(slot.outputIndex, slot);
    return slot.itemId;
  };

  onReasoningDelta = (
    kind: 'summary' | 'content',
    outputIndex: number,
    observedItemId: string,
    delta: string,
  ): string | undefined => {
    this.ensureOpen(
      kind === 'summary'
        ? 'response.reasoning_summary_text.delta'
        : 'response.reasoning_text.delta',
      { outputIndex, item_id: observedItemId, delta },
    );
    if (delta.length === 0) {
      return undefined;
    }
    const existing = this.compatibleSlot(
      outputIndex,
      'reasoning',
      observedItemId,
    );
    const slot: ReasoningSlot = existing?.type === 'reasoning'
      ? existing
      : {
          type: 'reasoning',
          outputIndex,
          itemId: observedItemId,
          aliases: new Set(),
          done: false,
          item: {
            id: observedItemId,
            type: 'reasoning',
            summary: [],
            content: [],
            status: 'in_progress',
          },
        };
    this.rememberAlias(slot, observedItemId);
    if (kind === 'summary') {
      const parts: ResponseReasoningItem.Summary[] = [...slot.item.summary];
      const nextPart = {
        type: 'summary_text' as const,
        text: (parts[0]?.text ?? '') + delta,
      };
      if (parts.length === 0) {
        parts.push(nextPart);
      } else {
        parts[0] = nextPart;
      }
      slot.item = { ...slot.item, summary: parts };
    } else {
      const parts: ResponseReasoningItem.Content[] = [
        ...(slot.item.content ?? []),
      ];
      const nextPart = {
        type: 'reasoning_text' as const,
        text: (parts[0]?.text ?? '') + delta,
      };
      if (parts.length === 0) {
        parts.push(nextPart);
      } else {
        parts[0] = nextPart;
      }
      slot.item = { ...slot.item, content: parts };
    }
    this.slots.set(slot.outputIndex, slot);
    return slot.itemId;
  };

  onFunctionCallArgumentsDone = (event: Readonly<{
    outputIndex: number;
    itemId: string;
    name: string;
    arguments: string;
  }>): void => {
    this.ensureOpen('response.function_call_arguments.done', event);
    const existing = this.compatibleSlot(
      event.outputIndex,
      'toolCall',
      event.itemId,
    );
    const slot: ToolCallSlot = existing?.type === 'toolCall'
      ? existing
      : {
          type: 'toolCall',
          outputIndex: event.outputIndex,
          itemId: event.itemId,
          aliases: new Set(),
          done: false,
          callId: '',
          name: '',
          arguments: '',
        };
    this.rememberAlias(slot, event.itemId);
    slot.name = event.name;
    slot.arguments = event.arguments;
    this.slots.set(slot.outputIndex, slot);
  };

  private reconcileDoneItem = (
    outputIndex: number,
    item: ResponseOutputItem,
    eventType: 'response.output_item.done' | 'response.completed' | 'response.incomplete',
  ): void => {
    const semantic = semanticKey(item);
    if (item.type === 'message') {
      const existing = this.compatibleSlot(
        outputIndex,
        'text',
        item.id,
        semantic,
      );
      if (existing?.type === 'text') {
        if (existing.done && existing.text !== messageText(item)) {
          throw this.protocolError(
            'OpenAI Responses returned conflicting completed message content.',
            'ambiguousOutputReconciliation',
            { outputIndex, existing, item },
            eventType,
          );
        }
        this.rememberAlias(existing, item.id);
        existing.text = messageText(item) || existing.text;
        existing.phase = phaseFromProvider(item.phase);
        existing.refused ||= messageRefused(item);
        existing.done = true;
        return;
      }
      this.slots.set(outputIndex, {
        type: 'text',
        outputIndex,
        itemId: item.id,
        aliases: new Set(),
        done: true,
        phase: phaseFromProvider(item.phase),
        text: messageText(item),
        refused: messageRefused(item),
      });
      return;
    }
    if (item.type === 'reasoning') {
      const existing = this.compatibleSlot(
        outputIndex,
        'reasoning',
        item.id,
        semantic,
      );
      if (existing?.type === 'reasoning') {
        if (
          existing.done &&
          reasoningText(existing.item) !== reasoningText(item)
        ) {
          throw this.protocolError(
            'OpenAI Responses returned conflicting completed reasoning content.',
            'ambiguousOutputReconciliation',
            { outputIndex, existing: existing.item, item },
            eventType,
          );
        }
        this.rememberAlias(existing, item.id);
        existing.item = {
          ...normalizedReasoningItem(item),
          id: existing.itemId || item.id,
          encrypted_content:
            item.encrypted_content ?? existing.item.encrypted_content,
        };
        existing.done = true;
        return;
      }
      this.slots.set(outputIndex, {
        type: 'reasoning',
        outputIndex,
        itemId: item.id,
        aliases: new Set(),
        done: true,
        item: normalizedReasoningItem(item),
      });
      return;
    }
    if (item.type === 'function_call') {
      const observedId = item.id ?? '';
      const existing = this.compatibleSlot(
        outputIndex,
        'toolCall',
        observedId,
        semantic,
      );
      if (existing?.type === 'toolCall') {
        if (
          existing.done &&
          (existing.callId !== item.call_id ||
            existing.name !== item.name ||
            existing.arguments !== item.arguments)
        ) {
          throw this.protocolError(
            'OpenAI Responses returned conflicting completed tool calls.',
            'ambiguousOutputReconciliation',
            { outputIndex, existing, item },
            eventType,
          );
        }
        this.rememberAlias(existing, observedId);
        existing.callId = item.call_id || existing.callId;
        existing.name = item.name || existing.name;
        existing.arguments = item.arguments || existing.arguments;
        existing.done = true;
        return;
      }
      this.slots.set(outputIndex, {
        type: 'toolCall',
        outputIndex,
        itemId: observedId,
        aliases: new Set(),
        done: true,
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
      return;
    }
    if (item.type === 'compaction' || !hasSemanticUnknownContent(item)) {
      return;
    }
    throw this.protocolError(
      `OpenAI Responses returned unsupported output item type ${item.type}.`,
      'invalidEventShape',
      item,
      eventType,
      'outputNormalization',
    );
  };

  onOutputItemDone = (
    outputIndex: number,
    item: ResponseOutputItem,
  ): void => {
    this.ensureOpen('response.output_item.done', { outputIndex, item });
    this.reconcileDoneItem(outputIndex, item, 'response.output_item.done');
  };

  finish = (
    response: Response,
    eventType: 'response.completed' | 'response.incomplete',
  ): ReconciledResponsesTerminal => {
    this.ensureOpen(eventType, response);
    for (const [outputIndex, item] of (response.output ?? []).entries()) {
      this.reconcileDoneItem(outputIndex, item, eventType);
    }
    this.terminated = true;

    const blocks = [...this.slots.values()]
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .flatMap((slot): readonly ReconciledResponsesBlock[] => {
        if (slot.type === 'text') {
          return slot.text.length > 0
            ? [{
                type: 'text',
                outputIndex: slot.outputIndex,
                itemId: slot.itemId,
                phase: slot.phase,
                text: slot.text,
              }]
            : [];
        }
        if (slot.type === 'reasoning') {
          const hasReasoning = reasoningText(slot.item).length > 0 ||
            typeof slot.item.encrypted_content === 'string';
          return hasReasoning
            ? [{
                type: 'reasoning',
                outputIndex: slot.outputIndex,
                item: slot.item,
              }]
            : [];
        }
        if (
          !slot.callId ||
          !slot.name ||
          !slot.arguments ||
          !validToolArguments(slot.arguments)
        ) {
          throw this.protocolError(
            'OpenAI Responses returned a malformed function call; no tool was executed.',
            'malformedToolCall',
            slot,
            eventType,
            'outputNormalization',
          );
        }
        return [{
          type: 'toolCall',
          outputIndex: slot.outputIndex,
          ...(slot.itemId ? { itemId: slot.itemId } : {}),
          callId: slot.callId,
          name: slot.name,
          arguments: slot.arguments,
        }];
      });

    return {
      responseId: response.id,
      status: response.status,
      usage: response.usage,
      refused: [...this.slots.values()].some(
        (slot) => slot.type === 'text' && slot.refused,
      ),
      blocks,
      compactions: (response.output ?? []).filter(
        (item): item is ResponseCompactionItem => item.type === 'compaction',
      ),
    };
  };

  assertTerminated = (): void => {
    if (!this.terminated) {
      throw this.protocolError(
        'OpenAI Responses stream ended without a terminal event.',
        'terminalLifecycleViolation',
        { slots: [...this.slots.values()] },
        'stream.end',
        'streamEvent',
      );
    }
  };
}
