import assert from 'node:assert/strict';
import test from 'node:test';

import {
  globalSearchScore,
  parseRecentGlobalSearchItems,
  rankGlobalSearchCandidates,
  recordRecentGlobalSearchItem,
  startGlobalSearchLoads,
} from '../../../src/renderer/components/search/global-search-model.ts';

const items = [
  { id: 'knowledge:1', label: '产品规范', description: '产品需求与发布流程' },
  { id: 'project:1', label: 'SugarCode Desktop', description: '本地桌面项目' },
  { id: 'skill:1', label: 'test-driven-development', description: '测试驱动开发' },
] as const;

test('global search ranks exact, normalized, keyword, and fuzzy matches', () => {
  assert.equal(rankGlobalSearchCandidates(items, '产品规范', {})[0]?.id, 'knowledge:1');
  assert.equal(rankGlobalSearchCandidates(items, 'sugar code', {})[0]?.id, 'project:1');
  assert.equal(rankGlobalSearchCandidates(items, 'tdd', {})[0]?.id, 'skill:1');
  assert.equal(rankGlobalSearchCandidates(items, 'tstddevelopment', {})[0]?.id, 'skill:1');
  assert.equal(globalSearchScore(items[0], '无关查询'), Number.NEGATIVE_INFINITY);
});

test('global search recency is bounded and breaks otherwise equal results', () => {
  const equal = [
    { id: 'project:old', label: 'Alpha', description: 'project' },
    { id: 'project:new', label: 'Alpha', description: 'project' },
  ];
  const ranked = rankGlobalSearchCandidates(equal, '', {
    'project:old': Date.now() - 10 * 86_400_000,
    'project:new': Date.now(),
  });
  assert.equal(ranked[0]?.id, 'project:new');
});

test('recent global search storage rejects malformed values and keeps a bounded history', () => {
  assert.deepEqual(parseRecentGlobalSearchItems('{'), {});
  assert.deepEqual(parseRecentGlobalSearchItems('{"bad":-1,"ok":42}'), { ok: 42 });
  let recent = {};
  for (let index = 0; index < 120; index += 1) {
    recent = recordRecentGlobalSearchItem(recent, `item:${index}`, index + 1);
  }
  assert.equal(Object.keys(recent).length, 100);
  assert.equal('item:119' in recent, true);
  assert.equal('item:0' in recent, false);
});

test('global search applies ready sources without waiting for slower sources', async () => {
  let resolveSlow: ((apply: () => void) => void) | undefined;
  const applied: string[] = [];
  const progress: { failed: number; pending: number; total: number }[] = [];
  const slow = new Promise<() => void>((resolve) => {
    resolveSlow = resolve;
  });

  const cancel = startGlobalSearchLoads([
    () => slow,
    async () => () => applied.push('ready'),
  ], (value) => progress.push(value));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(applied, ['ready']);
  assert.deepEqual(progress, [{ failed: 0, pending: 1, total: 2 }]);

  cancel();
  resolveSlow?.(() => applied.push('late'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(applied, ['ready']);
});
