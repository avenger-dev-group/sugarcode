import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextBudget,
  estimatedTokensFromContextBytes,
  formatTokenCount,
  formatTokenUsageHint,
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
      contextWindowTokens: 200_000,
      source: 'provider',
    }),
    '60K / 200K current · 175K Turn total across 2 requests',
  );
  assert.equal(
    formatTokenUsageHint({
      lastRequest: {},
      turnTotal: {},
      requestCount: 1,
      contextWindowTokens: 128 * 1024,
      source: 'estimated',
    }),
    '≈ 0 / 128K current · 0 Turn total across 1 request',
  );
});
