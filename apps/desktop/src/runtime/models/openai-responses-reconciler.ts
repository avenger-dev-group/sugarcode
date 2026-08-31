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
import {
  toolCallConflictFields,
  toolCallContentKey,
  toolCallSemanticKey,
  validToolArguments,
} from './openai-responses-tool-call.ts';
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
      return toolCallSemanticKey({
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
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

  private uniqueSlot = (
    candidates: readonly OutputSlot[],
    value: Readonly<Record<string, unknown>>,
    eventType: string,
  ): OutputSlot | undefined => {
    if (candidates.length <= 1) {
      return candidates[0];
    }
    throw this.protocolError(
      'OpenAI Responses matched more than one existing output item.',
      'ambiguousOutputReconciliation',
      {
        ...value,
        candidateTypes: candidates.map((candidate) => candidate.type),
      },
      eventType,
    );
  };

  private slotByIdentity = (
    expectedType: OutputSlot['type'],
    observedItemId: string,
    eventType: string,
  ): OutputSlot | undefined =>
    this.uniqueSlot(
      [...this.slots.values()].filter(
        (slot) =>
          slot.type === expectedType &&
          (slot.itemId === observedItemId || slot.aliases.has(observedItemId)),
      ),
      { expectedType, identityKind: 'itemId' },
      eventType,
    );

  private streamSlot = (
    outputIndex: number,
    expectedType: OutputSlot['type'],
    observedItemId: string,
    eventType: string,
  ): OutputSlot | undefined => {
    const indexed = this.slots.get(outputIndex);
    if (indexed?.type === expectedType) {
      return indexed;
    }
    if (indexed) {
      throw this.protocolError(
        'OpenAI Responses reused an output index for a different item type.',
        'outputIndexMismatch',
        { outputIndex, expectedType, observedItemId, indexedType: indexed.type },
        eventType,
      );
    }
    return observedItemId
      ? this.slotByIdentity(expectedType, observedItemId, eventType)
      : undefined;
  };

  private slotSemanticKey = (slot: OutputSlot): string | undefined => {
    if (slot.type === 'text') {
      return `text:${slot.text}`;
    }
    if (slot.type === 'reasoning') {
      return `reasoning:${reasoningText(slot.item)}`;
    }
    return toolCallSemanticKey(slot);
  };

  private terminalSlot = (
    terminalIndex: number,
    item: ResponseOutputItem,
    expectedType: OutputSlot['type'],
    originalSlotIndexes: ReadonlySet<number>,
    eventType: 'response.completed' | 'response.incomplete',
  ): OutputSlot | undefined => {
    const observedItemId = item.id ?? '';
    if (observedItemId) {
      const identified = this.slotByIdentity(
        expectedType,
        observedItemId,
        eventType,
      );
      if (identified) {
        return identified;
      }
    }
    if (item.type === 'function_call' && item.call_id) {
      const callIdMatch = this.uniqueSlot(
        [...this.slots.values()].filter(
          (slot) => slot.type === 'toolCall' && slot.callId === item.call_id,
        ),
        { expectedType, identityKind: 'callId' },
        eventType,
      );
      if (callIdMatch) {
        return callIdMatch;
      }
    }
    const semantic = semanticKey(item);
    if (semantic !== undefined) {
      const semanticMatch = this.uniqueSlot(
        [...this.slots.values()].filter(
          (slot) =>
            slot.type === expectedType &&
            this.slotSemanticKey(slot) === semantic,
        ),
        { expectedType, identityKind: 'semantic' },
        eventType,
      );
      if (semanticMatch) {
        return semanticMatch;
      }
    }
    if (item.type === 'function_call') {
      const contentKey = toolCallContentKey({
        name: item.name,
        arguments: item.arguments,
      });
      if (contentKey !== undefined) {
        const contentMatch = this.uniqueSlot(
          [...this.slots.values()].filter(
            (slot) =>
              slot.type === 'toolCall' &&
              toolCallContentKey(slot) === contentKey,
          ),
          { expectedType, identityKind: 'toolContent' },
          eventType,
        );
        if (contentMatch) {
          return contentMatch;
        }
      }
    }
    const indexed = originalSlotIndexes.has(terminalIndex)
      ? this.slots.get(terminalIndex)
      : undefined;
    if (indexed?.type === expectedType) {
      return indexed;
    }
    return undefined;
  };

  private availableOutputIndex = (preferred: number): number => {
    if (!this.slots.has(preferred)) {
      return preferred;
    }
    let candidate = Math.max(preferred, ...this.slots.keys()) + 1;
    while (this.slots.has(candidate)) {
      candidate += 1;
    }
    return candidate;
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
      const existing = this.streamSlot(
        outputIndex,
        'text',
        item.id,
        'response.output_item.added',
      );
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
      const existing = this.streamSlot(
        outputIndex,
        'reasoning',
        item.id,
        'response.output_item.added',
      );
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
      const existing = this.streamSlot(
        outputIndex,
        'toolCall',
        observedId,
        'response.output_item.added',
      );
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
    const existing = this.streamSlot(
      outputIndex,
      'text',
      observedItemId,
      'response.output_text.delta',
    );
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
    const existing = this.streamSlot(
      outputIndex,
      'reasoning',
      observedItemId,
      kind === 'summary'
        ? 'response.reasoning_summary_text.delta'
        : 'response.reasoning_text.delta',
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
    const existing = this.streamSlot(
      event.outputIndex,
      'toolCall',
      event.itemId,
      'response.function_call_arguments.done',
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
    eventType:
      | 'response.output_item.done'
      | 'response.completed'
      | 'response.incomplete',
    originalSlotIndexes?: ReadonlySet<number>,
  ): void => {
    const terminal = eventType !== 'response.output_item.done';
    if (item.type === 'message') {
      const existing = terminal
        ? this.terminalSlot(
            outputIndex,
            item,
            'text',
            originalSlotIndexes ?? new Set(),
            eventType,
          )
        : this.streamSlot(outputIndex, 'text', item.id, eventType);
      if (existing?.type === 'text') {
        const incomingText = messageText(item);
        if (
          existing.done &&
          existing.text.length > 0 &&
          incomingText.length > 0 &&
          existing.text !== incomingText &&
          !terminal
        ) {
          throw this.protocolError(
            'OpenAI Responses returned conflicting completed message content.',
            'ambiguousOutputReconciliation',
            { outputIndex, existing, item },
            eventType,
          );
        }
        this.rememberAlias(existing, item.id);
        if (!existing.done) {
          existing.text = incomingText || existing.text;
          existing.phase = phaseFromProvider(item.phase);
        } else {
          // Some Responses-compatible gateways omit message content from
          // either output_item.done or response.completed, and some rewrite
          // non-executable visible text in the terminal response. Preserve a
          // non-empty done item when the terminal omits text; otherwise the
          // terminal response is the provider's authoritative representation.
          if (terminal && incomingText.length > 0) {
            existing.text = incomingText;
          } else {
            existing.text ||= incomingText;
          }
          if (
            existing.phase === 'provisional' &&
            phaseFromProvider(item.phase) !== 'provisional'
          ) {
            existing.phase = phaseFromProvider(item.phase);
          }
        }
        existing.refused ||= messageRefused(item);
        existing.done = true;
        return;
      }
      const resolvedIndex = terminal
        ? this.availableOutputIndex(outputIndex)
        : outputIndex;
      this.slots.set(resolvedIndex, {
        type: 'text',
        outputIndex: resolvedIndex,
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
      const existing = terminal
        ? this.terminalSlot(
            outputIndex,
            item,
            'reasoning',
            originalSlotIndexes ?? new Set(),
            eventType,
          )
        : this.streamSlot(outputIndex, 'reasoning', item.id, eventType);
      if (existing?.type === 'reasoning') {
        const normalized = normalizedReasoningItem(item);
        const existingContent = (existing.item.content ?? [])
          .map((part) => part.text)
          .join('\n');
        const existingSummary = existing.item.summary
          .map((part) => part.text)
          .join('\n');
        this.rememberAlias(existing, item.id);
        // Responses-compatible gateways sometimes serialize the same reasoning
        // item differently in output_item.done and response.completed. Reasoning
        // is not executable output, so keep the first completed representation
        // and only backfill fields that it omitted. Visible text and tool-call
        // conflicts remain strict in their respective branches.
        existing.item = existing.done
          ? {
              ...existing.item,
              ...(!existingContent && (normalized.content ?? []).length > 0
                ? { content: normalized.content }
                : {}),
              ...(!existingSummary && normalized.summary.length > 0
                ? { summary: normalized.summary }
                : {}),
              encrypted_content:
                existing.item.encrypted_content ?? normalized.encrypted_content,
            }
          : {
              ...normalized,
              id: existing.itemId || item.id,
              encrypted_content:
                normalized.encrypted_content ?? existing.item.encrypted_content,
            };
        existing.done = true;
        return;
      }
      const resolvedIndex = terminal
        ? this.availableOutputIndex(outputIndex)
        : outputIndex;
      this.slots.set(resolvedIndex, {
        type: 'reasoning',
        outputIndex: resolvedIndex,
        itemId: item.id,
        aliases: new Set(),
        done: true,
        item: normalizedReasoningItem(item),
      });
      return;
    }
    if (item.type === 'function_call') {
      const observedId = item.id ?? '';
      const existing = terminal
        ? this.terminalSlot(
            outputIndex,
            item,
            'toolCall',
            originalSlotIndexes ?? new Set(),
            eventType,
          )
        : this.streamSlot(outputIndex, 'toolCall', observedId, eventType);
      if (existing?.type === 'toolCall') {
        const conflicts = existing.done
          ? toolCallConflictFields(existing, item)
          : [];
        const semanticConflicts = conflicts.filter(
          (field) => field !== 'callId',
        );
        if (semanticConflicts.length > 0) {
          const conflictShape = Object.fromEntries(
            conflicts.map((field) => [field, true]),
          );
          throw this.protocolError(
            `OpenAI Responses returned conflicting completed tool call fields: ${conflicts.join(', ')}.`,
            'ambiguousOutputReconciliation',
            { conflicts: conflictShape },
            eventType,
          );
        }
        this.rememberAlias(existing, observedId);
        if (!existing.done) {
          existing.callId = item.call_id || existing.callId;
          existing.name = item.name || existing.name;
          existing.arguments = item.arguments || existing.arguments;
        }
        existing.done = true;
        return;
      }
      const resolvedIndex = terminal
        ? this.availableOutputIndex(outputIndex)
        : outputIndex;
      this.slots.set(resolvedIndex, {
        type: 'toolCall',
        outputIndex: resolvedIndex,
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
    const originalSlotIndexes = new Set(this.slots.keys());
    for (const [outputIndex, item] of (response.output ?? []).entries()) {
      this.reconcileDoneItem(
        outputIndex,
        item,
        eventType,
        originalSlotIndexes,
      );
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
