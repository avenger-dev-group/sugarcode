import type { Part } from '@google/genai';

import type {
  ModelItemMetadata,
  ModelStepOutcome,
  ModelTextPhase,
} from './types.ts';

const METADATA_KEY = 'sugarcodeModelItem';
const FUNCTION_CALL_ARGUMENTS_METADATA_KEY =
  'sugarcodeFunctionCallArguments';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type ModelFunctionCallArgumentsMetadata = Readonly<{
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
}>;

export const modelFunctionCallArgumentsMetadata = (
  value: ModelFunctionCallArgumentsMetadata,
): Readonly<Record<string, unknown>> => ({
  [FUNCTION_CALL_ARGUMENTS_METADATA_KEY]: value,
});

export const readModelFunctionCallArgumentsMetadata = (
  value: unknown,
): ModelFunctionCallArgumentsMetadata | undefined => {
  const metadata = isRecord(value)
    ? value[FUNCTION_CALL_ARGUMENTS_METADATA_KEY]
    : undefined;
  if (
    !isRecord(metadata) ||
    typeof metadata.itemId !== 'string' ||
    typeof metadata.callId !== 'string' ||
    typeof metadata.name !== 'string' ||
    typeof metadata.arguments !== 'string'
  ) {
    return undefined;
  }
  return {
    itemId: metadata.itemId,
    callId: metadata.callId,
    name: metadata.name,
    arguments: metadata.arguments,
  };
};

export const modelItemMetadata = (
  itemId: string,
  options: Readonly<{
    phase?: ModelTextPhase;
    outcome?: ModelStepOutcome;
    reasoningVisibility?: ModelItemMetadata['reasoningVisibility'];
  }> = {},
): Readonly<Record<string, unknown>> => ({
  [METADATA_KEY]: {
    itemId,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.reasoningVisibility
      ? { reasoningVisibility: options.reasoningVisibility }
      : {}),
  } satisfies ModelItemMetadata,
});

export const readModelItemMetadata = (
  part: Part,
): ModelItemMetadata | undefined => {
  const metadata = isRecord(part.partMetadata)
    ? part.partMetadata[METADATA_KEY]
    : undefined;
  if (!isRecord(metadata) || typeof metadata.itemId !== 'string') {
    return undefined;
  }
  const phase = metadata.phase;
  const outcome = metadata.outcome;
  const reasoningVisibility = metadata.reasoningVisibility;
  return {
    itemId: metadata.itemId,
    ...(phase === 'commentary' || phase === 'final' || phase === 'provisional'
      ? { phase }
      : {}),
    ...(isModelStepOutcome(outcome) ? { outcome } : {}),
    ...(reasoningVisibility === 'internal' || reasoningVisibility === 'summary' || reasoningVisibility === 'provider'
      ? { reasoningVisibility }
      : {}),
  };
};

export const readModelStepOutcome = (
  parts: readonly Part[],
): ModelStepOutcome | undefined => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const outcome = readModelItemMetadata(parts[index] as Part)?.outcome;
    if (outcome) {
      return outcome;
    }
  }
  return undefined;
};

const isModelStepOutcome = (value: unknown): value is ModelStepOutcome => {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }
  if (value.kind === 'toolCalls' || value.kind === 'final') {
    return true;
  }
  if (value.kind === 'continue') {
    return ['commentaryOnly', 'pauseTurn', 'maxOutputTokens'].includes(
      String(value.reason),
    );
  }
  return (
    value.kind === 'failed' &&
    ['protocol', 'filtered', 'unsupportedToolArguments'].includes(
      String(value.errorKind),
    ) &&
    typeof value.message === 'string'
  );
};
