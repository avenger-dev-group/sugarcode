import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTokenUsageHint,
  latestTurnUsage,
} from '../../../src/renderer/components/thread/context-budget.ts';

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
