import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextBudget,
  estimatedTokensFromContextBytes,
  formatTokenCount,
  formatTokenUsageHint,
  latestTurnUsage,
} from '../../../src/renderer/components/thread/context-budget.ts';

test('128K context preserves output and recovery reserves before compaction', () => {
  assert.deepEqual(contextBudget(131_072), {
    contextWindowTokens: 131_072,
    compactionTargetTokens: 98_304,
    outputReserveTokens: 16_384,
    recoveryReserveTokens: 16_384,
  });
});

test('small context windows retain the minimum output reserve', () => {
  assert.deepEqual(contextBudget(8_192), {
    contextWindowTokens: 8_192,
    compactionTargetTokens: 2_048,
    outputReserveTokens: 4_096,
    recoveryReserveTokens: 2_048,
  });
});

test('context byte estimates and compact labels match runtime policy', () => {
  assert.equal(estimatedTokensFromContextBytes(294_912), 98_304);
  assert.equal(formatTokenCount(131_072), '128K');
});

test('current request stays distinct from cumulative Turn usage', () => {
  assert.equal(
    formatTokenUsageHint({
      lastRequest: { inputTokens: 60_000 },
      turnTotal: { inputTokens: 175_318 },
      requestCount: 2,
      source: 'provider',
    }),
    '60K current · 175K Turn total across 2 requests',
  );
  assert.equal(
    formatTokenUsageHint({
      lastRequest: {},
      turnTotal: {},
      requestCount: 1,
      source: 'estimated',
    }),
    '≈ 0 current · 0 Turn total across 1 request',
  );
});

test('composer usage never leaks forward from an earlier Turn', () => {
  const previousUsage = {
    lastRequest: { inputTokens: 30_000 },
    turnTotal: { inputTokens: 210_000 },
    requestCount: 7,
    contextWindowTokens: 200_000,
    source: 'provider' as const,
  };

  assert.equal(latestTurnUsage([{ usage: previousUsage }, {}]), undefined);
  assert.equal(latestTurnUsage([{ usage: previousUsage }]), previousUsage);
});
