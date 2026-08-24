import type { ResponseOutputItem } from 'openai/resources/responses/responses';

type ResponseFunctionToolCall = Extract<
  ResponseOutputItem,
  { type: 'function_call' }
>;

export type ReconciledToolCallValue = Readonly<{
  callId: string;
  name: string;
  arguments: string;
}>;

export type ToolCallConflictField = 'callId' | 'name' | 'arguments';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
};

export const canonicalToolArguments = (value: string): string | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed)
      ? JSON.stringify(canonicalJsonValue(parsed))
      : undefined;
  } catch {
    return undefined;
  }
};

export const validToolArguments = (value: string): boolean =>
  canonicalToolArguments(value) !== undefined;

export const toolArgumentsEquivalent = (
  left: string,
  right: string,
): boolean => {
  if (left === right) {
    return true;
  }
  const canonicalLeft = canonicalToolArguments(left);
  const canonicalRight = canonicalToolArguments(right);
  return canonicalLeft !== undefined && canonicalLeft === canonicalRight;
};

export const toolCallSemanticKey = (
  value: ReconciledToolCallValue,
): string | undefined => {
  const contentKey = toolCallContentKey(value);
  return value.callId && contentKey !== undefined
    ? JSON.stringify([value.callId, contentKey])
    : undefined;
};

export const toolCallContentKey = (
  value: Pick<ReconciledToolCallValue, 'name' | 'arguments'>,
): string | undefined => {
  const canonicalArguments = canonicalToolArguments(value.arguments);
  return value.name && canonicalArguments !== undefined
    ? JSON.stringify([value.name, canonicalArguments])
    : undefined;
};

export const toolCallConflictFields = (
  existing: ReconciledToolCallValue,
  incoming: ResponseFunctionToolCall,
): readonly ToolCallConflictField[] => {
  const conflicts: ToolCallConflictField[] = [];
  if (
    existing.callId &&
    incoming.call_id &&
    existing.callId !== incoming.call_id
  ) {
    conflicts.push('callId');
  }
  if (existing.name && incoming.name && existing.name !== incoming.name) {
    conflicts.push('name');
  }
  if (
    existing.arguments &&
    incoming.arguments &&
    !toolArgumentsEquivalent(existing.arguments, incoming.arguments)
  ) {
    conflicts.push('arguments');
  }
  return conflicts;
};
