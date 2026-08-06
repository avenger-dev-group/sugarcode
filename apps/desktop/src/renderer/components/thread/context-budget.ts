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
  source: 'provider' | 'estimated';
}): string =>
  `${usage.source === 'estimated' ? '≈ ' : ''}${formatTokenCount(usage.lastRequest.inputTokens ?? 0)} current · ${formatTokenCount(usage.turnTotal.inputTokens ?? 0)} Turn total across ${usage.requestCount} request${usage.requestCount === 1 ? '' : 's'}`;

export const latestTurnUsage = <Usage>(
  turns: readonly Readonly<{ usage?: Usage }>[],
): Usage | undefined => turns[turns.length - 1]?.usage;
