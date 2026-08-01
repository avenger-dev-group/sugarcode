const TOKEN_ESTIMATE_BYTES = 3;
const MAX_OUTPUT_RESERVE_TOKENS = 16_384;
const MIN_OUTPUT_RESERVE_TOKENS = 4_096;

export type ContextBudget = Readonly<{
  contextWindowTokens: number;
  compactionTargetTokens: number;
  outputReserveTokens: number;
  recoveryReserveTokens: number;
}>;

export const contextBudget = (
  contextWindowTokens: number,
): ContextBudget => {
  const outputReserveTokens = Math.min(
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.max(
      MIN_OUTPUT_RESERVE_TOKENS,
      Math.floor(contextWindowTokens / 4),
    ),
  );
  const inputTargetTokens = Math.max(
    0,
    contextWindowTokens - outputReserveTokens,
  );
  const recoveryReserveTokens = Math.min(
    outputReserveTokens,
    Math.floor(inputTargetTokens / 2),
  );

  return {
    contextWindowTokens,
    compactionTargetTokens: Math.max(
      0,
      inputTargetTokens - recoveryReserveTokens,
    ),
    outputReserveTokens,
    recoveryReserveTokens,
  };
};

export const estimatedTokensFromContextBytes = (bytes: number): number =>
  Math.ceil(bytes / TOKEN_ESTIMATE_BYTES);

export const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  return new Intl.NumberFormat(undefined, {
    notation: tokens >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 0,
  }).format(tokens);
};

export const formatTokenUsageHint = (usage: {
  lastRequest: { inputTokens?: number };
  turnTotal: { inputTokens?: number };
  requestCount: number;
  contextWindowTokens: number;
  source: 'provider' | 'estimated';
}): string =>
  `${usage.source === 'estimated' ? '≈ ' : ''}${formatTokenCount(usage.lastRequest.inputTokens ?? 0)} / ${formatTokenCount(usage.contextWindowTokens)} current · ${formatTokenCount(usage.turnTotal.inputTokens ?? 0)} Turn total across ${usage.requestCount} request${usage.requestCount === 1 ? '' : 's'}`;
